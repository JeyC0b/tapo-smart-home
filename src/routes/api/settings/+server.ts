import { json, error } from '@sveltejs/kit';
import { getAllSettings, setSetting } from '$lib/server/settings';
import { invalidateLogLevelCache } from '$lib/server/logger';

export async function GET({ locals }: any) {
  const s = await getAllSettings();
  const isAdmin = !!locals?.isAdmin;
  // Password is never exposed; the Tapo account username is also admin-only
  // (this GET is reachable by unauthenticated guests).
  return json({
    poll_interval_seconds: s.poll_interval_seconds,
    rules_enabled: s.rules_enabled,
    offline_after_failures: s.offline_after_failures,
    verify_actions: s.verify_actions,
    default_username: isAdmin ? s.default_username : '',
    has_default_password: !!s.default_password,
    log_level: s.log_level,
    default_language: s.default_language,
    task_retry_minutes: s.task_retry_minutes,
    task_revert_retry_minutes: s.task_revert_retry_minutes
  });
}

const ALLOWED = new Set([
  'poll_interval_seconds', 'rules_enabled', 'offline_after_failures',
  'verify_actions', 'default_username', 'default_password', 'log_level',
  'default_language', 'task_retry_minutes', 'task_revert_retry_minutes'
]);

// Numeric settings, with the range the scheduler can actually honour.
const NUMERIC: Record<string, { min: number; max: number }> = {
  poll_interval_seconds:     { min: 30,  max: 86_400 },
  offline_after_failures:    { min: 1,   max: 100 },
  task_retry_minutes:        { min: 0,   max: 10_080 },   // up to 7 days
  task_revert_retry_minutes: { min: 0,   max: 10_080 }
};

export async function PATCH({ request }) {
  const b = await request.json().catch(() => ({}));
  for (const [k, v] of Object.entries(b)) {
    if (!ALLOWED.has(k)) continue;
    if (k === 'default_password' && (v === '' || v === null)) continue; // do not overwrite with empty value
    let str: string;
    if (k in NUMERIC) {
      // Clamp instead of trusting the client: an out-of-range poll interval or
      // retry window would otherwise be written straight into the scheduler.
      const n = Number(v);
      if (!Number.isFinite(n)) throw error(400, `Invalid value for ${k}.`);
      const { min, max } = NUMERIC[k];
      str = String(Math.round(Math.min(max, Math.max(min, n))));
    }
    else if (typeof v === 'boolean') str = v ? '1' : '0';
    else if (typeof v === 'number') str = String(v);
    else if (v == null) str = '';
    else str = String(v);
    await setSetting(k, str);
  }
  // Bump in-memory caches that depend on settings.
  invalidateLogLevelCache();
  return json({ ok: true });
}
