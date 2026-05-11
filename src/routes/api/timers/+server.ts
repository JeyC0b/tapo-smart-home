import { json, error } from '@sveltejs/kit';
import { q, exec } from '$lib/server/db';
import type { TimerAction, RepeatKind } from '$lib/server/tasks';

const VALID_ACTIONS = new Set(['on','off','toggle','on_for','off_for']);
const VALID_REPEATS = new Set(['once','minutely','hourly','daily','weekly','monthly']);

export async function GET({ url }: any) {
  const view = url.searchParams.get('view') || 'pending';   // pending|history|all
  const page = Math.max(1, Number(url.searchParams.get('page') || '1') | 0);
  const pageSize = Math.min(200, Math.max(10, Number(url.searchParams.get('size') || '50') | 0));

  const where: string[] = [];
  if (view === 'pending') where.push("status = 'pending'");
  else if (view === 'history') where.push("status IN ('done','failed','cancelled')");
  // 'all' → bez WHERE
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalRows = await q<{ c: number }>(`SELECT COUNT(*) AS c FROM app_scheduled_tasks ${whereSql}`);
  const total = totalRows[0]?.c ?? 0;

  const rows = await q<any>(
    `SELECT t.*,
            d.custom_name, d.tapo_alias, d.device_id AS device_uid
       FROM app_scheduled_tasks t
       LEFT JOIN app_devices d ON d.id = t.device_id
       ${whereSql}
       ORDER BY ${view === 'pending' ? 't.run_at ASC' : 't.id DESC'}
       LIMIT ? OFFSET ?`,
    [pageSize, (page - 1) * pageSize]
  );
  return json({
    timers: rows,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    view
  });
}

export async function POST({ request }: any) {
  const b = await request.json().catch(() => ({}));

  const action = String(b.action || '');
  if (!VALID_ACTIONS.has(action)) throw error(400, 'Invalid action.');

  const ids: number[] = Array.isArray(b.device_ids)
    ? b.device_ids.map(Number).filter((n: number) => Number.isFinite(n) && n > 0)
    : (b.device_id ? [Number(b.device_id)] : []);
  if (ids.length === 0) throw error(400, 'Select at least one device.');

  const repeatKind: RepeatKind = VALID_REPEATS.has(b.repeat_kind) ? b.repeat_kind : 'once';
  const repeatInterval = Math.max(1, Number(b.repeat_interval || 1));
  const daysMask = Number(b.days_mask ?? 127) & 127;
  const isRandom = b.is_random ? 1 : 0;
  const dur = b.duration_minutes != null ? Math.max(1, Number(b.duration_minutes)) : null;

  let runAt: Date;
  if (b.run_at) {
    runAt = new Date(b.run_at);
    if (isNaN(runAt.getTime())) throw error(400, 'Invalid date/time.');
  } else if (b.in_seconds && Number(b.in_seconds) > 0) {
    runAt = new Date(Date.now() + Number(b.in_seconds) * 1000);
  } else if (isRandom && b.random_window_start && b.random_window_end) {
    // For random/vacation mode the runner computes the first instance at the start of the window
    const today = new Date();
    const [sh, sm] = String(b.random_window_start).split(':').map(Number);
    runAt = new Date(today); runAt.setHours(sh ?? 18, sm ?? 0, 0, 0);
    if (runAt <= new Date()) runAt.setDate(runAt.getDate() + 1);
  } else {
    throw error(400, 'Missing run_at, in_seconds, or random window.');
  }

  const repeatUntil = b.repeat_until ? new Date(b.repeat_until) : null;
  const title = b.title ? String(b.title).slice(0, 128) : null;
  const note  = b.note  ? String(b.note).slice(0, 255)  : null;

  // Multi-device: one row with device_id = first + JSON device_ids; the runner iterates.
  // (Keeps the UI clean — user sees 1 timer instead of N copies.)
  const deviceIdsJson = ids.length > 1 ? JSON.stringify(ids) : null;

  const r = await exec(
    `INSERT INTO app_scheduled_tasks
       (device_id, device_ids, action, run_at, status, note, title,
        repeat_kind, repeat_interval, repeat_until, days_mask,
        is_random, random_window_start, random_window_end,
        random_min_minutes, random_max_minutes, duration_minutes,
        vacation_min_per_day, vacation_max_per_day,
        vacation_min_duration_min, vacation_max_duration_min,
        vacation_pick_one, vacation_dim_chance)
     VALUES (?,?,?,?, 'pending', ?,?, ?,?,?,?, ?,?,?,?,?, ?, ?,?, ?,?, ?,?)`,
    [
      ids[0], deviceIdsJson, action, runAt, note, title,
      repeatKind, repeatInterval, repeatUntil, daysMask,
      isRandom,
      b.random_window_start || null, b.random_window_end || null,
      b.random_min_minutes != null ? Number(b.random_min_minutes) : null,
      b.random_max_minutes != null ? Number(b.random_max_minutes) : null,
      dur,
      b.vacation_min_per_day != null ? Number(b.vacation_min_per_day) : null,
      b.vacation_max_per_day != null ? Number(b.vacation_max_per_day) : null,
      b.vacation_min_duration_min != null ? Number(b.vacation_min_duration_min) : null,
      b.vacation_max_duration_min != null ? Number(b.vacation_max_duration_min) : null,
      b.vacation_pick_one ? 1 : 0,
      b.vacation_dim_chance != null ? Number(b.vacation_dim_chance) : null
    ]
  );
  return json({ ok: true, id: (r as any).insertId });
}
