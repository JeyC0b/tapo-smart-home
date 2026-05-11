import { json, error } from '@sveltejs/kit';
import { q, exec } from '$lib/server/db';
import { scheduleAt } from '$lib/server/tasks';

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
      sets.push(`${k} = ?`);
      let v = b[k];
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
  if (sets.length === 0) throw error(400, 'No changes provided.');
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
  if (!t) throw error(404, 'Timer not found.');

  let runAt: Date;
  if (b.run_at) runAt = new Date(b.run_at);
  else runAt = new Date(Date.now() + (Number(b.in_seconds) || 60) * 1000);
  if (isNaN(runAt.getTime())) throw error(400, 'Invalid time.');

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
