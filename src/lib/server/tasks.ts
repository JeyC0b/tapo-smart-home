import { q, exec } from './db';
import { log } from './logger';
import { getSetting } from './settings';
import { commandSetState } from './poller';

export type TimerAction = 'on' | 'off' | 'toggle' | 'on_for' | 'off_for';
export type RepeatKind = 'once' | 'minutely' | 'hourly' | 'daily' | 'weekly' | 'monthly';

/** One device plus the concrete state it must end up in. */
interface TaskTarget { d: number; on: boolean }

export interface ScheduledTaskRow {
  id: number;
  device_id: number;
  device_ids: string | null;     // JSON array (string from MySQL)
  retry_targets: string | null;  // JSON TaskTarget[] — devices still to switch
  action: TimerAction;
  run_at: Date;
  retry_at: Date | null;
  status: 'pending' | 'done' | 'failed' | 'cancelled';
  attempt_count: number;
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
  is_revert:           0 | 1;
  next_created:        0 | 1;
  error_message:       string | null;
  // Vacation mode (presence simulation while away).
  vacation_min_per_day: number | null;
  vacation_max_per_day: number | null;
  vacation_min_duration_min: number | null;
  vacation_max_duration_min: number | null;
  vacation_pick_one: 0 | 1;
  vacation_dim_chance: number | null; // 0..100
}

// Backoff between attempts, in seconds. The last value repeats for every
// further attempt, so a device that is off the network for hours is polled
// every 5 minutes rather than hammered.
const RETRY_BACKOFF_SECS = [30, 60, 120, 300];
const DEFAULT_RETRY_MINUTES = 60;
const DEFAULT_REVERT_RETRY_MINUTES = 24 * 60;

function backoffSeconds(attempt: number): number {
  return RETRY_BACKOFF_SECS[Math.min(attempt, RETRY_BACKOFF_SECS.length) - 1];
}

/**
 * How many attempts fit into the configured retry window.
 *
 * The budget is counted in ATTEMPTS rather than as a `run_at + window`
 * deadline: a task that only starts running long after its scheduled time
 * (server was down, tick backlog) would otherwise be born with its window
 * already spent and give up on the first failure.
 */
function maxAttemptsFor(windowMs: number): number {
  if (windowMs <= 0) return 1;   // retrying disabled — the first attempt is the only one
  let elapsed = 0;
  let n = 1;
  while (n < 5000) {
    const wait = backoffSeconds(n) * 1000;
    if (elapsed + wait > windowMs) break;
    elapsed += wait;
    n++;
  }
  return n;
}

/** Configured retry window in ms for this task's class. 0 = no retrying. */
async function retryWindowMs(t: ScheduledTaskRow): Promise<number> {
  const key = t.is_revert ? 'task_revert_retry_minutes' : 'task_retry_minutes';
  const def = t.is_revert ? DEFAULT_REVERT_RETRY_MINUTES : DEFAULT_RETRY_MINUTES;
  const raw = Number(await getSetting(key, String(def)));
  const minutes = Number.isFinite(raw) && raw >= 0 ? raw : def;
  return minutes * 60_000;
}

function parseJsonArray<T>(v: string | null): T[] {
  if (!v) return [];
  try {
    const parsed = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch { return []; }
}

/**
 * Runs scheduled tasks whose run time (or retry time) has arrived.
 *
 * A task that cannot reach its device is NOT failed outright: it stays
 * 'pending' with a later `retry_at`, so the command lands as soon as the
 * device is back. Independently of that, a repeating task enqueues its next
 * occurrence exactly once — a temporary outage must never break the schedule.
 */
export async function runDueScheduledTasks(): Promise<void> {
  const due = await q<ScheduledTaskRow>(
    `SELECT * FROM app_scheduled_tasks
      WHERE status = 'pending' AND COALESCE(retry_at, run_at) <= NOW()
      ORDER BY COALESCE(retry_at, run_at) LIMIT 50`
  );
  // A command to an unreachable device can sit in the bridge for up to a
  // minute. Cap one pass so a batch of dead devices cannot hold the tick (and
  // with it every other due task) for an unbounded time — the rows stay
  // 'pending' and the next tick picks up where this one stopped.
  const deadline = Date.now() + 5 * 60_000;
  for (const t of due) {
    if (Date.now() > deadline) {
      await log('warn', 'scheduler',
        'task tick hit its time budget — remaining tasks continue on the next tick');
      break;
    }
    try {
      await runOneTask(t);
    } catch (e) {
      // Only bookkeeping can land here — the device calls are handled inside.
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

async function runOneTask(t: ScheduledTaskRow): Promise<void> {
  const attempt = Number(t.attempt_count || 0) + 1;
  const targets = await resolveTargets(t);
  const { switched, failed, errors } = await executeTargets(t, targets);

  // 1) Keep the repeating chain alive FIRST — before any early return — so a
  //    device outage can never silently end a daily/weekly schedule.
  await enqueueNextOccurrence(t);

  // 2) Auto-revert ("on for N minutes") for the devices that really switched
  //    in THIS attempt; the countdown starts when the device actually obeyed.
  if (switched.length) {
    await supersedeStaleReverts(t);
    await scheduleRevert(t, switched);
  }

  if (!failed.length) {
    await exec(
      `UPDATE app_scheduled_tasks
          SET status='done', executed_at=NOW(), attempt_count=?,
              retry_at=NULL, retry_targets=NULL, error_message=NULL
        WHERE id = ?`,
      [attempt, t.id]
    );
    await log('info', 'scheduler',
      `task #${t.id} executed (${t.action})${attempt > 1 ? ` after ${attempt} attempts` : ''}`,
      { note: t.note });
    return;
  }

  // 3) Something did not answer — retry until the attempt budget is spent.
  const errText = errors.join(' | ').slice(0, 500);
  const maxAttempts = maxAttemptsFor(await retryWindowMs(t));
  const nextAt = new Date(Date.now() + backoffSeconds(attempt) * 1000);

  if (attempt < maxAttempts) {
    await exec(
      `UPDATE app_scheduled_tasks
          SET attempt_count=?, retry_at=?, retry_targets=?, error_message=?
        WHERE id = ?`,
      [attempt, nextAt, JSON.stringify(failed), errText, t.id]
    );
    await log('warn', 'scheduler',
      `task #${t.id} (${t.action}) attempt ${attempt}/${maxAttempts} failed — retrying at ${nextAt.toLocaleString()}`,
      { err: errText, devices: failed.map(f => f.d) });
    return;
  }

  await exec(
    `UPDATE app_scheduled_tasks
        SET status='failed', executed_at=NOW(), attempt_count=?,
            retry_at=NULL, error_message=?
      WHERE id = ?`,
    [attempt, errText, t.id]
  );
  await log('error', 'scheduler',
    `task #${t.id} (${t.action}) gave up after ${attempt} ${attempt === 1 ? 'attempt' : 'attempts'}`,
    { err: errText, devices: failed.map(f => f.d) });
}

/**
 * Which devices this run has to switch, and to which state.
 *
 * On a retry the pinned list from the previous attempt is reused, so
 * `toggle` cannot flip a device back and forth and vacation's "pick one
 * random device" keeps chasing the same device it started with.
 */
async function resolveTargets(t: ScheduledTaskRow): Promise<TaskTarget[]> {
  const pinned = parseJsonArray<TaskTarget>(t.retry_targets)
    .map(x => ({ d: Number(x.d), on: !!x.on }))
    .filter(x => Number.isFinite(x.d) && x.d > 0);
  if (pinned.length) return pinned;

  // Multi-device task carries a JSON device_ids list which replaces device_id.
  let deviceIds = parseJsonArray<any>(t.device_ids).map(Number).filter(Boolean);
  if (deviceIds.length === 0 && t.device_id) deviceIds = [t.device_id];

  // Vacation: pick one random device instead of all (more realistic presence simulation).
  if (t.is_random && t.vacation_pick_one && deviceIds.length > 1) {
    deviceIds = [deviceIds[Math.floor(Math.random() * deviceIds.length)]];
  }

  const targets: TaskTarget[] = [];
  for (const d of deviceIds) {
    let on: boolean;
    if (t.action === 'toggle') {
      const cur = await q<{ state: 0 | 1 | null }>('SELECT state FROM app_devices WHERE id = ?', [d]);
      on = !cur[0]?.state;
    } else {
      on = t.action === 'on' || t.action === 'on_for';
    }
    targets.push({ d, on });
  }
  return targets;
}

/** Switches every target, collecting successes and failures separately. */
async function executeTargets(
  t: ScheduledTaskRow, targets: TaskTarget[]
): Promise<{ switched: TaskTarget[]; failed: TaskTarget[]; errors: string[] }> {
  const switched: TaskTarget[] = [];
  const failed: TaskTarget[] = [];
  const errors: string[] = [];

  for (const target of targets) {
    try {
      await commandSetState(target.d, target.on);

      // Vacation: optional brightness "dimming" for bulbs on turn-on.
      if (target.on && t.is_random && t.vacation_dim_chance &&
          Math.random() * 100 < t.vacation_dim_chance) {
        try {
          const dev = await q<{ kind: string }>('SELECT kind FROM app_devices WHERE id = ?', [target.d]);
          if (dev[0]?.kind === 'bulb' || dev[0]?.kind === 'strip') {
            const { commandLight } = await import('./poller');
            const dim = 20 + Math.floor(Math.random() * 60); // 20..79 %
            await commandLight(target.d, { brightness: dim });
          }
        } catch { /* dim is best-effort */ }
      }

      switched.push(target);
      await exec(
        `INSERT INTO app_task_runs (task_id, device_id, action, result) VALUES (?,?,?, 'ok')`,
        [t.id, target.d, t.action]
      );
    } catch (e: any) {
      const msg = String(e?.message || e).slice(0, 500);
      failed.push(target);
      errors.push(`${target.d}: ${msg}`);
      await exec(
        `INSERT INTO app_task_runs (task_id, device_id, action, result, error_message) VALUES (?,?,?, 'error', ?)`,
        [t.id, target.d, t.action, msg]
      );
    }
  }
  return { switched, failed, errors };
}

/**
 * Drop an auto-revert of the SAME timer that is already overdue and still
 * chasing its device.
 *
 * It can only be overdue because the device stopped answering, and the run
 * that just succeeded has re-established the state the stale revert wanted to
 * undo — letting it through would switch the device off seconds after the new
 * cycle switched it on. A fresh revert for this cycle is queued right after.
 * Reverts that are not due yet belong to a window still in progress and are
 * left alone.
 */
async function supersedeStaleReverts(t: ScheduledTaskRow): Promise<void> {
  if (t.is_revert) return;                       // a revert never supersedes another
  const chain = t.parent_task_id ?? t.id;
  const r = await exec(
    `UPDATE app_scheduled_tasks
        SET status='cancelled', executed_at=NOW(),
            retry_at=NULL, retry_targets=NULL,
            error_message='superseded by a newer run of the same timer'
      WHERE status='pending' AND is_revert = 1 AND id <> ?
        AND (id = ? OR parent_task_id = ?)
        AND run_at <= NOW()`,
    [t.id, chain, chain]
  );
  const n = Number((r as any).affectedRows ?? 0);
  if (n) {
    await log('info', 'scheduler',
      `task #${t.id}: superseded ${n} overdue auto-revert(s) of the same timer`);
  }
}

/**
 * "On/off for N minutes" (and vacation's random light duration) — queue the
 * counter-action for exactly the devices that switched, marked `is_revert` so
 * it gets the long retry window: a plug left ON must eventually go OFF, even
 * if the network only comes back hours later.
 */
async function scheduleRevert(t: ScheduledTaskRow, switched: TaskTarget[]): Promise<void> {
  let revertMin: number | null =
    (t.action === 'on_for' || t.action === 'off_for') && t.duration_minutes && t.duration_minutes > 0
      ? t.duration_minutes
      : null;
  // Vacation: when "on" with a random duration window, auto-turn-off after
  // a random number of minutes.
  if (
    t.is_random && t.action === 'on' &&
    t.vacation_min_duration_min && t.vacation_max_duration_min &&
    t.vacation_max_duration_min >= t.vacation_min_duration_min
  ) {
    revertMin =
      t.vacation_min_duration_min +
      Math.floor(Math.random() * (t.vacation_max_duration_min - t.vacation_min_duration_min + 1));
  }
  if (!revertMin || revertMin <= 0) return;

  const ids = switched.map(s => s.d);
  const reverse: TimerAction = (t.action === 'off' || t.action === 'off_for') ? 'on' : 'off';
  await scheduleAt(
    ids[0], reverse,
    new Date(Date.now() + revertMin * 60_000),
    `auto-revert (${reverse})`,
    {
      parent_task_id: t.parent_task_id ?? t.id,
      device_ids: ids.length > 1 ? JSON.stringify(ids) : null,
      is_revert: true
    }
  );
}

/**
 * Create the follow-up occurrence of a repeating task — once per row, and
 * regardless of whether this run succeeded. Marked via `next_created` so a
 * task that is retried several times does not enqueue several successors.
 */
async function enqueueNextOccurrence(t: ScheduledTaskRow): Promise<void> {
  if (t.next_created) return;
  if (t.repeat_kind === 'once' && !t.is_random) return;

  // Claim the slot first: the UPDATE is the lock, so even an unexpected
  // second pass over the same row cannot duplicate the occurrence.
  const claim = await exec(
    `UPDATE app_scheduled_tasks SET next_created = 1 WHERE id = ? AND next_created = 0`,
    [t.id]
  );
  if (Number((claim as any).affectedRows ?? 0) === 0) return;

  const next = await nextRunAt(t);
  if (!next) return;
  if (t.repeat_until && next > new Date(t.repeat_until)) return;

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

/** Schedule on/off in N seconds (countdown via the app, not the device). */
export async function scheduleIn(
  deviceId: number, seconds: number, action: TimerAction, note?: string,
  opts?: { is_revert?: boolean; parent_task_id?: number | null }
): Promise<number> {
  return scheduleAt(deviceId, action, new Date(Date.now() + seconds * 1000), note, opts);
}

/** Schedule at a specific datetime (with optional parameters). */
export async function scheduleAt(
  deviceId: number, action: TimerAction, runAt: Date, note?: string | null,
  opts?: {
    parent_task_id?: number | null;
    title?: string | null;
    device_ids?: string | null;
    is_revert?: boolean;
  }
): Promise<number> {
  const r = await exec(
    `INSERT INTO app_scheduled_tasks
       (device_id, device_ids, action, run_at, note, title, parent_task_id, is_revert)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      deviceId, opts?.device_ids ?? null, action, runAt, note ?? null,
      opts?.title ?? null, opts?.parent_task_id ?? null, opts?.is_revert ? 1 : 0
    ]
  );
  return (r as any).insertId;
}

/** Add `n` months, clamping to the last day of the target month (31 Jan + 1 → 28/29 Feb). */
function addMonths(d: Date, n: number): Date {
  const day = d.getDate();
  const out = new Date(d);
  out.setDate(1);
  out.setMonth(out.getMonth() + n);
  const lastDay = new Date(out.getFullYear(), out.getMonth() + 1, 0).getDate();
  out.setDate(Math.min(day, lastDay));
  return out;
}

/** Monday-based start of the week containing `d`, at 00:00 local. */
function weekStart(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  out.setDate(out.getDate() - ((out.getDay() + 6) % 7));
  return out;
}

/** Next run-time for repeating tasks. */
export async function nextRunAt(t: ScheduledTaskRow): Promise<Date | null> {
  const base = new Date(t.run_at);
  const interval = Math.max(1, Number(t.repeat_interval || 1));
  const mask = Number(t.days_mask ?? 127) & 127;

  // Vacation/random mode: pick a random time in the next valid window.
  // Honours min_per_day/max_per_day by deciding whether to fire again today
  // or jump to tomorrow's window.
  if (t.is_random && t.random_window_start && t.random_window_end) {
    return nextRandomFire(t);
  }

  if (t.repeat_kind === 'once') return null;

  const now = Date.now();

  // Weekly with a day-of-week selection means "fire on each selected day",
  // with `interval` counting whole weeks between blocks. Walking day by day
  // is the only way to hit several weekdays inside the same week — adding
  // 7 × interval days first would always land back on the same weekday.
  if (t.repeat_kind === 'weekly' && mask !== 127) {
    const cursor = new Date(base);
    // Jump whole interval-blocks first when the base is long past (server was
    // down for weeks): that preserves both the weekday and the week parity and
    // keeps the day-by-day walk below inside its bound.
    const blockMs = 7 * interval * 86_400_000;
    while (cursor.getTime() < now - blockMs) cursor.setDate(cursor.getDate() + 7 * interval);
    const anchor = weekStart(cursor).getTime();
    for (let i = 0; i < 7 * interval * 4; i++) {
      cursor.setDate(cursor.getDate() + 1);
      const weeksAway = Math.round((weekStart(cursor).getTime() - anchor) / (7 * 86_400_000));
      if (weeksAway % interval !== 0) continue;
      if (!isAllowedDay(cursor, mask)) continue;
      if (cursor.getTime() <= now) continue;   // skip missed slots
      return new Date(cursor);
    }
    return null;
  }

  // Catch-up: after a server outage (or a long retry) the next slot can still
  // be in the past. Jump straight to the next FUTURE slot instead of firing
  // once per missed interval — a daily heating timer that was offline for a
  // week must not switch the plug seven times in a row.
  let next: Date;
  if (t.repeat_kind === 'minutely' || t.repeat_kind === 'hourly') {
    // Fixed-length intervals: compute the number of missed slots directly
    // rather than stepping (a minutely timer can miss thousands of them).
    const stepMs = interval * (t.repeat_kind === 'minutely' ? 60_000 : 3_600_000);
    const behind = now - base.getTime();
    const jumps = behind > 0 ? Math.floor(behind / stepMs) + 1 : 1;
    next = new Date(base.getTime() + jumps * stepMs);
  } else {
    // Calendar intervals must step so they keep their wall-clock time across
    // DST and month lengths. The bound covers ~5 years of downtime.
    const step = (d: Date): Date => {
      switch (t.repeat_kind) {
        case 'daily':   { const n = new Date(d); n.setDate(n.getDate() + interval);     return n; }
        case 'weekly':  { const n = new Date(d); n.setDate(n.getDate() + 7 * interval); return n; }
        case 'monthly': return addMonths(d, interval);
        default:        return d;
      }
    };
    next = step(base);
    for (let i = 0; next.getTime() <= now && i < 2000; i++) next = step(next);
  }

  // For daily with a day-of-week mask, jump to the first allowed day.
  if (t.repeat_kind === 'daily' && mask !== 127) {
    for (let i = 0; i < 14; i++) {
      if (isAllowedDay(next, mask)) break;
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
