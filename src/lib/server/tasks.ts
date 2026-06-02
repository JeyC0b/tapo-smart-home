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
      const switched = await executeTask(t);
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
      if (revertMin && revertMin > 0 && switched.length) {
        const reverse: TimerAction = (t.action === 'off' || t.action === 'off_for') ? 'on' : 'off';
        // Revert EXACTLY the devices that were switched (handles multi-device
        // on_for/off_for and vacation pick-one), not just device_id (= first device).
        await scheduleAt(
          switched[0], reverse,
          new Date(Date.now() + revertMin * 60_000),
          `auto-revert (${reverse})`,
          {
            parent_task_id: t.parent_task_id ?? t.id,
            device_ids: switched.length > 1 ? JSON.stringify(switched) : null
          }
        );
      }

      // 2) If the timer repeats, create the next instance.
      if (t.repeat_kind !== 'once' || t.is_random) {
        const next = await nextRunAt(t);
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

/** Switches all devices for a task and returns the device IDs actually acted on. */
async function executeTask(t: ScheduledTaskRow): Promise<number[]> {
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
  return deviceIds;
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
  opts?: { parent_task_id?: number | null; title?: string | null; device_ids?: string | null }
): Promise<number> {
  const r = await exec(
    `INSERT INTO app_scheduled_tasks
       (device_id, device_ids, action, run_at, note, title, parent_task_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [deviceId, opts?.device_ids ?? null, action, runAt, note ?? null, opts?.title ?? null, opts?.parent_task_id ?? null]
  );
  return (r as any).insertId;
}

/** Next run-time for repeating tasks. */
export async function nextRunAt(t: ScheduledTaskRow): Promise<Date | null> {
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
 * - The per-day target is DETERMINISTIC for a given chain+day so it is not
 *   re-rolled on every fire, and the number already fired today is read from
 *   the DB — together these cap the day at exactly `target` fires (the old
 *   code re-rolled and re-scheduled on every fire, producing dozens/day).
 * - If we still owe fires today, schedules the next after a random gap of
 *   random_min_minutes..random_max_minutes (clamped to the window end).
 *   Otherwise jumps to the next allowed day.
 * - Day-of-week mask is respected.
 */
async function nextRandomFire(t: ScheduledTaskRow): Promise<Date | null> {
  // Spacing between consecutive same-day fires comes from the advanced
  // random_min_minutes / random_max_minutes fields (fall back to 8..30 when
  // unset so legacy rows keep sensible spacing).
  const gapMin = Math.max(1, Number(t.random_min_minutes ?? 8));
  const gapMax = Math.max(gapMin, Number(t.random_max_minutes ?? Math.max(gapMin, 30)));
  const min = Math.max(1, Number(t.vacation_min_per_day ?? 1));
  const max = Math.max(min, Number(t.vacation_max_per_day ?? min));

  const now = new Date();
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  let wStart = parseHHMM(today, t.random_window_start!);
  let endToday = parseHHMM(today, t.random_window_end!);
  if (endToday <= wStart) {
    // Window crosses midnight: extend the end to the next day.
    endToday = new Date(endToday.getTime() + 24 * 60 * 60 * 1000);
    // If we're past midnight but before today's start, we're still inside the
    // window that opened yesterday — shift the counting window back one day so
    // the after-midnight fires are counted (otherwise the cap is defeated).
    if (now < wStart) {
      wStart = new Date(wStart.getTime() - 24 * 60 * 60 * 1000);
      endToday = new Date(endToday.getTime() - 24 * 60 * 60 * 1000);
    }
  }

  // Deterministic per-(chain, window-day) target so it stays stable for the
  // whole session, including overnight windows that span two calendar days.
  const windowDay = new Date(wStart); windowDay.setHours(0, 0, 0, 0);
  const parentId = t.parent_task_id ?? t.id;
  const target = min + (dayTargetHash(parentId, windowDay) % (max - min + 1));

  // Actual presence fires already completed in this window for this chain. Filter
  // by the chain's own action so the auto-revert (opposite action) is NOT counted
  // — otherwise each 'on' + its 'off' revert would count as two, halving the rate.
  const firedToday = await firesToday(parentId, t.action, wStart, endToday);

  const minutesRemaining = (endToday.getTime() - now.getTime()) / 60000;
  if (firedToday < target && minutesRemaining >= gapMin + 1 && isAllowedDay(now, t.days_mask)) {
    // Fire after a random gap of [gapMin, gapMax] minutes, clamped to window end.
    const gap = gapMin + Math.floor(Math.random() * (gapMax - gapMin + 1));
    const fire = new Date(now.getTime() + gap * 60000);
    return fire > endToday ? endToday : fire;
  }

  // Otherwise: first fire of the next allowed day.
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  for (let i = 0; i < 14; i++) {
    const day = new Date(tomorrow); day.setDate(day.getDate() + i);
    if (isAllowedDay(day, t.days_mask)) {
      return randomWithinWindow(day, t.random_window_start!, t.random_window_end!);
    }
  }
  return null;
}

/** Stable non-negative pseudo-random value for a (chain, calendar-day) pair. */
function dayTargetHash(parentId: number, day: Date): number {
  const key = (parentId * 100000)
    + (day.getFullYear() * 10000) + ((day.getMonth() + 1) * 100) + day.getDate();
  let h = (key ^ 0x9e3779b1) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Count completed fires of a vacation chain (of the given action) within a window. */
async function firesToday(parentId: number, action: string, from: Date, to: Date): Promise<number> {
  const rows = await q<{ c: number }>(
    `SELECT COUNT(*) AS c FROM app_scheduled_tasks
      WHERE (id = ? OR parent_task_id = ?)
        AND action = ?
        AND status = 'done'
        AND executed_at >= ? AND executed_at <= ?`,
    [parentId, parentId, action, from, to]
  );
  return Number(rows[0]?.c ?? 0);
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
