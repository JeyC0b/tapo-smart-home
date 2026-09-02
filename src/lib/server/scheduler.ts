import { env } from '$env/dynamic/private';
import { q, exec } from './db';
import { pollOne } from './poller';
import { evaluateRules } from './rules';
import { runDueScheduledTasks } from './tasks';
import { refreshDueWidgets } from './widget_cache';
import { log } from './logger';

let started = false;
// Timer handles of the PREVIOUS instance of this module, parked on globalThis.
// Under `vite dev` every HMR update re-evaluates the server modules; a
// module-local flag does not survive that, so each reload used to add another
// full set of intervals. Several schedulers then polled the hubs and fired the
// same timers side by side — with the old copies still running the old code.
const TIMER_REGISTRY = '__tapo_scheduler_timers__';
let pollRunning = new Set<number>();
let taskRunning = false;       // single-flight guard: a slow tick must not overlap the next
let lastPoll: Date | null = null;
let lastTaskTick: Date | null = null;

const GLOBAL_FLOOR_SECS = 30; // absolute lower bound (protects rate-limited devices from DoS)

/**
 * Delete history rows older than `days` from an append-only table, in batches
 * to avoid long row locks. `days <= 0` (or blank setting) means "keep forever".
 * table/column/extraWhere are hard-coded literals — never user input.
 */
async function prune(table: string, column: string, days: number, extraWhere = ''): Promise<void> {
  if (!Number.isFinite(days) || days <= 0) return;
  const cutoff = new Date(Date.now() - days * 86_400_000);
  let total = 0;
  for (let i = 0; i < 50; i++) {
    const r = await exec(
      `DELETE FROM ${table} WHERE ${column} < ?${extraWhere ? ' AND ' + extraWhere : ''} ORDER BY ${column} LIMIT 5000`,
      [cutoff]
    );
    const n = Number((r as any).affectedRows ?? 0);
    total += n;
    if (n < 5000) break;
  }
  // debug, not info: this runs hourly for four tables and its own log rows are
  // what the next sweep prunes — at info level it drowns the log viewer.
  if (total) await log('debug', 'scheduler', `retention: pruned ${total} rows from ${table}`);
}

export function startScheduler() {
  if (started) return;
  started = true;

  // Dispose the intervals a previous instance of this module registered.
  const g = globalThis as Record<string, any>;
  for (const h of (g[TIMER_REGISTRY] as any[] | undefined) ?? []) {
    clearInterval(h);
    clearTimeout(h);
  }
  const timers: any[] = [];
  g[TIMER_REGISTRY] = timers;

  const envInt = Number(env.POLL_INTERVAL_SECONDS || 0);
  log('info', 'scheduler', `start, env override=${envInt || '(off)'}`);

  // Main tick every 10s — picks hubs due for re-poll and polls them in parallel.
  const masterTick = async () => {
    try {
      // Global fallback from app_settings.
      // Priority: DB value (UI-controlled) > env override (server-only) > 180s default.
      // The previous version made env always win, which contradicted the user's settings.
      const sr = await q<{ v: string }>(`SELECT v FROM app_settings WHERE k='poll_interval_seconds'`);
      const dbSecs = Number(sr[0]?.v ?? 0);
      const globalSecs = Math.max(GLOBAL_FLOOR_SECS, dbSecs || envInt || 180);

      // Per hub: effective interval = MIN(hub.override, MIN(child.override)) or global.
      type HubDue = { id: number; secs: number; last: Date | null };
      const rows = await q<{ id: number; hub_pi: number | null; child_pi: number | null; last_polled_at: Date | null }>(
        `SELECT h.id,
                h.poll_interval_seconds AS hub_pi,
                MIN(d.poll_interval_seconds) AS child_pi,
                h.last_polled_at
           FROM app_hubs h
           LEFT JOIN app_devices d ON d.hub_id = h.id AND d.poll_interval_seconds IS NOT NULL
          WHERE h.enabled = 1
          GROUP BY h.id, h.poll_interval_seconds, h.last_polled_at`
      );
      const due: HubDue[] = [];
      const now = Date.now();
      for (const r of rows) {
        const overrides = [r.hub_pi, r.child_pi].filter((x): x is number => x != null && x > 0);
        const eff = Math.max(GLOBAL_FLOOR_SECS,
          overrides.length ? Math.min(...overrides, globalSecs) : globalSecs);
        const last = r.last_polled_at ? new Date(r.last_polled_at).getTime() : 0;
        if (now - last >= eff * 1000) due.push({ id: r.id, secs: eff, last: r.last_polled_at });
      }

      if (due.length) {
        await Promise.all(due.map(async hub => {
          if (pollRunning.has(hub.id)) return;
          pollRunning.add(hub.id);
          try {
            await pollOne(hub.id);
            await exec('UPDATE app_hubs SET last_polled_at = NOW() WHERE id = ?', [hub.id]);
          } catch (e) {
            await log('error', 'scheduler', `poll hub ${hub.id} failed`, { err: String(e) });
          } finally {
            pollRunning.delete(hub.id);
          }
        }));
        // Evaluate rules only when something actually updated.
        try { await evaluateRules(); } catch (e) {
          await log('error', 'scheduler', 'rules eval failed', { err: String(e) });
        }
        lastPoll = new Date();
      }
    } catch (e) {
      await log('error', 'scheduler', 'master tick failed', { err: String(e) });
    }
  };

  const taskTick = async () => {
    // A task's device commands can take longer than the 10s interval; without a
    // guard the next tick would re-SELECT and re-execute still-'pending' rows
    // (double switch / toggle flip-back). Single-process app → an in-flight flag
    // is sufficient.
    if (taskRunning) return;
    taskRunning = true;
    try {
      await runDueScheduledTasks();
      lastTaskTick = new Date();
    } catch (e) {
      await log('error', 'scheduler', 'task tick failed', { err: String(e) });
    } finally {
      taskRunning = false;
    }
  };

  const widgetTick = async () => {
    try { await refreshDueWidgets(); }
    catch (e) { await log('error', 'scheduler', 'widget refresh failed', { err: String(e) }); }
  };

  // Periodically prune append-only history tables so they don't grow forever.
  // Retention windows are read from app_settings (default 30 days; 0 = keep forever).
  const retentionTick = async () => {
    try {
      const getDays = async (k: string, def: number) => {
        const r = await q<{ v: string }>(`SELECT v FROM app_settings WHERE k = ?`, [k]);
        const n = Number(r[0]?.v);
        return Number.isFinite(n) ? n : def;
      };
      const logDays = await getDays('log_retention_days', 30);
      const readDays = await getDays('readings_retention_days', 30);
      const runDays = await getDays('task_runs_retention_days', 30);
      await prune('app_logs', 'created_at', logDays);
      await prune('app_readings', 'created_at', readDays);
      await prune('app_task_runs', 'ran_at', runDays);
      // Repeating/vacation timers append a row per fire — prune long-finished ones too.
      await prune('app_scheduled_tasks', 'created_at', runDays, "status IN ('done','failed','cancelled')");
    } catch (e) {
      await log('error', 'scheduler', 'retention sweep failed', { err: String(e) });
    }
  };

  // Initial poll after start (after 3 s) — acts as a "tick", so per-hub intervals are honoured.
  timers.push(
    setTimeout(masterTick, 3_000),
    setInterval(masterTick, 10_000),
    setInterval(taskTick, 10_000),
    setInterval(widgetTick, 15_000),
    setTimeout(retentionTick, 60_000),      // first sweep ~1 min after boot
    setInterval(retentionTick, 3_600_000)   // then hourly
  );
}

export function schedulerStatus() {
  return {
    started,
    pollRunning: Array.from(pollRunning),
    lastPoll, lastTaskTick
  };
}
