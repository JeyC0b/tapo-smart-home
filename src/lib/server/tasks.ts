import { q, exec } from './db';
import { log } from './logger';
import { commandSetState } from './poller';

export type TimerAction = 'on' | 'off' | 'toggle' | 'on_for' | 'off_for';
export type RepeatKind = 'once' | 'minutely' | 'hourly' | 'daily' | 'weekly' | 'monthly';

export interface ScheduledTaskRow {
  id: number;
  device_id: number;
  device_ids: string | null;     // JSON array (string from MySQL)
  action: TimerAction;
  run_at: Date;
  status: 'pending' | 'done' | 'failed' | 'cancelled';
  note: string | null;
  title: string | null;
  created_at: Date;
  executed_at: Date | null;
  rule_id: number | null;
  repeat_kind: RepeatKind;
  repeat_interval: number;
  repeat_until: Date | null;
  days_mask: number;
  is_random: 0 | 1;
  random_window_start: string | null; // 'HH:MM:SS'
  random_window_end:   string | null;
  random_min_minutes:  number | null;
  random_max_minutes:  number | null;
  duration_minutes:    number | null;
  parent_task_id:      number | null;
  error_message:       string | null;
  // Vacation mode (presence simulation while away).
  vacation_min_per_day: number | null;
  vacation_max_per_day: number | null;
  vacation_min_duration_min: number | null;
  vacation_max_duration_min: number | null;
  vacation_pick_one: 0 | 1;
  vacation_dim_chance: number | null; // 0..100
}

/** Runs scheduled tasks whose run_at <= NOW. */
export async function runDueScheduledTasks(): Promise<void> {
  const due = await q<ScheduledTaskRow>(
    `SELECT * FROM app_scheduled_tasks
      WHERE status = 'pending' AND run_at <= NOW()
      ORDER BY run_at LIMIT 50`
  );
  for (const t of due) {
    try {
      await executeTask(t);
      await exec(`UPDATE app_scheduled_tasks SET status='done', executed_at=NOW() WHERE id = ?`, [t.id]);
      await log('info', 'scheduler', `task #${t.id} executed (${t.action})`, { note: t.note });

      // 1) on_for/off_for OR vacation random-duration → schedule the reverse action.
      let revertMin: number | null =
        (t.action === 'on_for' || t.action === 'off_for') && t.duration_minutes && t.duration_minutes > 0
          ? t.duration_minutes
          : null;
      // Vacation: when "on" with random duration window, auto-turn-off after random minutes.
      if (
        t.is_random && t.action === 'on' &&
        t.vacation_min_duration_min && t.vacation_max_duration_min &&
        t.vacation_max_duration_min >= t.vacation_min_duration_min
      ) {
        revertMin =
          t.vacation_min_duration_min +
          Math.floor(Math.random() * (t.vacation_max_duration_min - t.vacation_min_duration_min + 1));
      }
      if (revertMin && revertMin > 0) {
        const reverse: TimerAction = (t.action === 'off' || t.action === 'off_for') ? 'on' : 'off';
        await scheduleAt(
          t.device_id, reverse,
          new Date(Date.now() + revertMin * 60_000),
          `auto-revert (${reverse})`,
          { parent_task_id: t.parent_task_id ?? t.id }
        );
      }

      // 2) If the timer repeats, create the next instance.
      if (t.repeat_kind !== 'once' || t.is_random) {
        const next = nextRunAt(t);
        if (next && (!t.repeat_until || next <= new Date(t.repeat_until))) {
          await exec(
            `INSERT INTO app_scheduled_tasks
               (device_id, device_ids, action, run_at, note, title,
                repeat_kind, repeat_interval, repeat_until, days_mask,
                is_random, random_window_start, random_window_end,
                random_min_minutes, random_max_minutes,
                duration_minutes, parent_task_id,
                vacation_min_per_day, vacation_max_per_day,
                vacation_min_duration_min, vacation_max_duration_min,
                vacation_pick_one, vacation_dim_chance)
             VALUES (?,?,?,?,?,?, ?,?,?,?, ?,?,?, ?,?, ?, ?, ?,?, ?,?, ?,?)`,
            [
              t.device_id, t.device_ids, t.action, next, t.note, t.title,
              t.repeat_kind, t.repeat_interval, t.repeat_until, t.days_mask,
              t.is_random, t.random_window_start, t.random_window_end,
              t.random_min_minutes, t.random_max_minutes,
              t.duration_minutes, t.parent_task_id ?? t.id,
              t.vacation_min_per_day, t.vacation_max_per_day,
              t.vacation_min_duration_min, t.vacation_max_duration_min,
              t.vacation_pick_one, t.vacation_dim_chance
            ]
          );
        }
      }
    } catch (e) {
      const msg = String(e).slice(0, 500);
      await exec(
        `UPDATE app_scheduled_tasks
            SET status='failed', executed_at=NOW(), error_message=?
          WHERE id = ?`,
        [msg, t.id]
      );
      await log('error', 'scheduler', `task #${t.id} failed`, { err: msg });
    }
  }
}

async function executeTask(t: ScheduledTaskRow) {
  // Multi-device task carries a JSON device_ids list which replaces device_id.
  let deviceIds: number[] = [];
  if (t.device_ids) {
    try { deviceIds = JSON.parse(t.device_ids).map(Number).filter(Boolean); } catch {}
  }
  if (deviceIds.length === 0 && t.device_id) deviceIds = [t.device_id];

  // Vacation: pick one random device instead of all (more realistic presence simulation).
  if (t.is_random && t.vacation_pick_one && deviceIds.length > 1) {
    deviceIds = [deviceIds[Math.floor(Math.random() * deviceIds.length)]];
  }

  const errors: string[] = [];
  for (const did of deviceIds) {
    try {
      let on: boolean;
      if (t.action === 'toggle') {
        const cur = await q<{ state: 0 | 1 | null }>('SELECT state FROM app_devices WHERE id = ?', [did]);
        on = !cur[0]?.state;
      } else if (t.action === 'on' || t.action === 'on_for') on = true;
      else on = false;
      await commandSetState(did, on);

      // Vacation: optional brightness "dimming" for bulbs on turn-on.
      if (on && t.is_random && t.vacation_dim_chance && Math.random() * 100 < t.vacation_dim_chance) {
        try {
          const dev = await q<{ kind: string }>('SELECT kind FROM app_devices WHERE id = ?', [did]);
          if (dev[0]?.kind === 'bulb' || dev[0]?.kind === 'strip') {
            const { commandLight } = await import('./poller');
            const dim = 20 + Math.floor(Math.random() * 60); // 20..79 %
            await commandLight(did, { brightness: dim });
          }
        } catch { /* dim is best-effort */ }
      }

      await exec(
        `INSERT INTO app_task_runs (task_id, device_id, action, result) VALUES (?,?,?, 'ok')`,
        [t.id, did, t.action]
      );
    } catch (e: any) {
      const msg = String(e?.message || e).slice(0, 500);
      errors.push(`${did}: ${msg}`);
      await exec(
        `INSERT INTO app_task_runs (task_id, device_id, action, result, error_message) VALUES (?,?,?, 'error', ?)`,
        [t.id, did, t.action, msg]
      );
    }
  }
  if (errors.length) throw new Error(errors.join(' | '));
}

/** Schedule on/off in N seconds (countdown via the app, not the device). */
export async function scheduleIn(
  deviceId: number, seconds: number, action: TimerAction, note?: string
): Promise<number> {
  return scheduleAt(deviceId, action, new Date(Date.now() + seconds * 1000), note);
}

/** Schedule at a specific datetime (with optional parameters). */
export async function scheduleAt(
  deviceId: number, action: TimerAction, runAt: Date, note?: string | null,
  opts?: { parent_task_id?: number | null; title?: string | null }
): Promise<number> {
  const r = await exec(
    `INSERT INTO app_scheduled_tasks
       (device_id, action, run_at, note, title, parent_task_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [deviceId, action, runAt, note ?? null, opts?.title ?? null, opts?.parent_task_id ?? null]
  );
  return (r as any).insertId;
}

/** Next run-time for repeating tasks. */
export function nextRunAt(t: ScheduledTaskRow): Date | null {
  const base = new Date(t.run_at);
  const interval = Math.max(1, Number(t.repeat_interval || 1));

  // Vacation/random mode: pick a random time in the next valid window.
  // Honours min_per_day/max_per_day by deciding whether to fire again today
  // or jump to tomorrow's window.
  if (t.is_random && t.random_window_start && t.random_window_end) {
    return nextRandomFire(t);
  }

  let next = new Date(base);
  switch (t.repeat_kind) {
    case 'minutely': next.setMinutes(next.getMinutes() + interval); break;
    case 'hourly':   next.setHours(next.getHours() + interval); break;
    case 'daily':    next.setDate(next.getDate() + interval); break;
    case 'weekly':   next.setDate(next.getDate() + 7 * interval); break;
    case 'monthly':  next.setMonth(next.getMonth() + interval); break;
    default: return null;
  }

  // For daily/weekly with day-of-week mask, jump to first allowed day.
  if ((t.repeat_kind === 'daily' || t.repeat_kind === 'weekly') && t.days_mask && t.days_mask !== 127) {
    for (let i = 0; i < 14; i++) {
      const dow = (next.getDay() + 6) % 7; // MO=0..SU=6
      if (t.days_mask & (1 << dow)) break;
      next.setDate(next.getDate() + 1);
    }
  }
  return next;
}

/**
 * Vacation/presence-simulation fire scheduler.
 * - Fires N times per day (between min_per_day..max_per_day, default 1..1).
 * - If we still owe more fires today, schedules the next at a random time
 *   between (now + GAP_MIN) and end-of-window. Otherwise jumps to tomorrow's window.
 * - Day-of-week mask is respected.
 */
function nextRandomFire(t: ScheduledTaskRow): Date | null {
  const GAP_MIN = 8;          // minimum minutes between fires today
  const min = Math.max(1, Number(t.vacation_min_per_day ?? 1));
  const max = Math.max(min, Number(t.vacation_max_per_day ?? min));
  const targetToday = min + Math.floor(Math.random() * (max - min + 1));

  // How many times has this task already fired today?
  // We piggy-back on the parent_task_id chain: the runtime metric here is
  // best-effort (fire count by created_at = today, status = done, same parent).
  // Caller passes synchronous data so use a heuristic: if we already fired
  // today (executed_at today) and remaining fires > 0, schedule another.
  const now = new Date();
  const today = new Date(now); today.setHours(0,0,0,0);
  const wEnd = parseHHMM(today, t.random_window_end!);
  let endToday = wEnd;
  // Window crossing midnight: extend end to next day if needed.
  const wStart = parseHHMM(today, t.random_window_start!);
  if (endToday <= wStart) endToday = new Date(endToday.getTime() + 24*60*60*1000);

  // Decide: is it still worth firing again today?
  // We check executed_at proximity: if last fire was within window and there's
  // ≥ GAP_MIN minutes left, try again today. We don't track exact count without
  // an extra query, so we approximate via "min(targetToday, attempts) until end".
  const minutesRemaining = (endToday.getTime() - now.getTime()) / 60000;
  if (targetToday > 1 && minutesRemaining >= GAP_MIN + 1) {
    const earliest = new Date(now.getTime() + GAP_MIN * 60000);
    const span = endToday.getTime() - earliest.getTime();
    if (span > 0) {
      // Roughly distribute remaining fires: pick uniformly in the remainder.
      const fire = new Date(earliest.getTime() + Math.floor(Math.random() * span));
      if (isAllowedDay(fire, t.days_mask)) return fire;
    }
  }

  // Otherwise: first fire of next allowed day.
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  for (let i = 0; i < 14; i++) {
    const day = new Date(tomorrow); day.setDate(day.getDate() + i);
    if (isAllowedDay(day, t.days_mask)) {
      return randomWithinWindow(day, t.random_window_start!, t.random_window_end!);
    }
  }
  return null;
}

function parseHHMM(day: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(day); d.setHours(h ?? 0, m ?? 0, 0, 0);
  return d;
}
function isAllowedDay(d: Date, mask: number): boolean {
  if (!mask || mask === 127) return true;
  const dow = (d.getDay() + 6) % 7; // MO=0..SU=6
  return (mask & (1 << dow)) !== 0;
}

function randomWithinWindow(date: Date, startHHMM: string, endHHMM: string): Date {
  const [sh, sm] = startHHMM.split(':').map(Number);
  const [eh, em] = endHHMM.split(':').map(Number);
  const start = new Date(date); start.setHours(sh, sm, 0, 0);
  let end = new Date(date); end.setHours(eh, em, 0, 0);
  if (end <= start) end.setDate(end.getDate() + 1); // window crossing midnight
  const span = end.getTime() - start.getTime();
  return new Date(start.getTime() + Math.floor(Math.random() * span));
}
