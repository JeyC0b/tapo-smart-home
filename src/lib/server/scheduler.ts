import { env } from '$env/dynamic/private';
import { q, exec } from './db';
import { pollOne } from './poller';
import { evaluateRules } from './rules';
import { runDueScheduledTasks } from './tasks';
import { refreshDueWidgets } from './widget_cache';
import { log } from './logger';

let started = false;
let pollRunning = new Set<number>();
let lastPoll: Date | null = null;
let lastTaskTick: Date | null = null;

const GLOBAL_FLOOR_SECS = 30; // absolute lower bound (protects rate-limited devices from DoS)

export function startScheduler() {
  if (started) return;
  started = true;

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
    try {
      await runDueScheduledTasks();
      lastTaskTick = new Date();
    } catch (e) {
      await log('error', 'scheduler', 'task tick failed', { err: String(e) });
    }
  };

  const widgetTick = async () => {
    try { await refreshDueWidgets(); }
    catch (e) { await log('error', 'scheduler', 'widget refresh failed', { err: String(e) }); }
  };

  // Initial poll after start (after 3 s) — acts as a "tick", so per-hub intervals are honoured.
  setTimeout(masterTick, 3_000);
  setInterval(masterTick, 10_000);
  setInterval(taskTick, 10_000);
  setInterval(widgetTick, 15_000);
}

export function schedulerStatus() {
  return {
    started,
    pollRunning: Array.from(pollRunning),
    lastPoll, lastTaskTick
  };
}
