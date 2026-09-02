import { json } from '@sveltejs/kit';
import { q, exec } from '$lib/server/db';
import { fail } from '$lib/server/api_error';

// Enum columns must be validated on PATCH too (the POST/create route does);
// otherwise a client can write an unknown action/status/repeat_kind that the
// scheduler then mishandles (e.g. an unknown status orphans the row).
const TIMER_ACTIONS = new Set(['on', 'off', 'toggle', 'on_for', 'off_for']);
const TIMER_REPEATS = new Set(['once', 'minutely', 'hourly', 'daily', 'weekly', 'monthly']);
const TIMER_STATUSES = new Set(['pending', 'done', 'failed', 'cancelled']);

export async function PATCH({ params, request }: any) {
  const id = Number(params.id);
  const b = await request.json().catch(() => ({}));
  const allowed = [
    'status','run_at','note','title','action','device_id',
    'repeat_kind','repeat_interval','repeat_until','days_mask',
    'duration_minutes','is_random','random_window_start','random_window_end',
    'random_min_minutes','random_max_minutes',
    'vacation_min_per_day','vacation_max_per_day',
    'vacation_min_duration_min','vacation_max_duration_min',
    'vacation_pick_one','vacation_dim_chance'
  ];
  const sets: string[] = [];
  const args: any[] = [];
  for (const k of allowed) {
    if (k in b) {
      let v = b[k];
      if (k === 'action' && !TIMER_ACTIONS.has(v)) fail(400, 'invalid_input', 'Invalid action.');
      if (k === 'repeat_kind' && !TIMER_REPEATS.has(v)) fail(400, 'invalid_input', 'Invalid repeat_kind.');
      if (k === 'status' && !TIMER_STATUSES.has(v)) fail(400, 'invalid_input', 'Invalid status.');
      sets.push(`${k} = ?`);
      if (v === '') v = null;
      if (k === 'run_at' && v) v = new Date(v);
      if (k === 'repeat_until' && v) v = new Date(v);
      args.push(v);
    }
  }
  // device_ids: handled separately (JSON column)
  if ('device_ids' in b) {
    const ids = Array.isArray(b.device_ids)
      ? b.device_ids.map(Number).filter((n: number) => Number.isFinite(n) && n > 0)
      : [];
    sets.push('device_ids = ?');
    args.push(ids.length > 1 ? JSON.stringify(ids) : null);
    if (ids.length >= 1) {
      sets.push('device_id = ?');
      args.push(ids[0]);
    }
  }
  if (sets.length === 0) fail(400, 'no_changes', 'No changes provided.');

  // Editing the schedule (or re-activating a timer) clears the retry
  // bookkeeping: the pinned per-device targets, the backoff timestamp and the
  // "successor already queued" flag all describe the PREVIOUS run and would
  // otherwise make the edited timer either skip its next occurrence or resume
  // switching the devices from the old attempt.
  if ('run_at' in b || 'status' in b || 'device_ids' in b || 'action' in b) {
    sets.push('attempt_count = 0', 'retry_at = NULL', 'retry_targets = NULL',
              'next_created = 0', 'error_message = NULL');
  }

  args.push(id);
  await exec(`UPDATE app_scheduled_tasks SET ${sets.join(', ')} WHERE id = ?`, args);
  return json({ ok: true });
}

export async function DELETE({ params }: any) {
  const id = Number(params.id);
  await exec('DELETE FROM app_scheduled_tasks WHERE id = ?', [id]);
  return json({ ok: true });
}

/**
 * POST = re-run / duplicate a finished timer.
 * Body: { in_seconds?: number, run_at?: string }   (default: za 1 minutu)
 */
export async function POST({ params, request }: any) {
  const id = Number(params.id);
  const b = await request.json().catch(() => ({}));
  const rows = await q<any>('SELECT * FROM app_scheduled_tasks WHERE id = ?', [id]);
  const t = rows[0];
  if (!t) fail(404, 'not_found', 'Timer not found.');

  let runAt: Date;
  if (b.run_at) runAt = new Date(b.run_at);
  else runAt = new Date(Date.now() + (Number(b.in_seconds) || 60) * 1000);
  if (isNaN(runAt.getTime())) fail(400, 'timer_bad_time', 'Invalid date/time.');

  await exec(
    `INSERT INTO app_scheduled_tasks
       (device_id, device_ids, action, run_at, status, note, title,
        repeat_kind, repeat_interval, repeat_until, days_mask,
        is_random, random_window_start, random_window_end,
        random_min_minutes, random_max_minutes, duration_minutes, parent_task_id)
     VALUES (?,?,?,?, 'pending', ?,?, 'once',1,NULL,127, 0,NULL,NULL,NULL,NULL,?, ?)`,
    [
      t.device_id, t.device_ids, t.action, runAt,
      `replay #${t.id}`, t.title,
      t.duration_minutes, t.parent_task_id ?? t.id
    ]
  );
  return json({ ok: true });
}
