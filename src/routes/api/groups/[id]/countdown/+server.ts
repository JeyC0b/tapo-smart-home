import { json, error } from '@sveltejs/kit';
import { q } from '$lib/server/db';
import { scheduleIn } from '$lib/server/tasks';

// POST /api/groups/:id/countdown — schedule an app-side countdown for every member.
// Body: { seconds: number, action: 'on'|'off'|'toggle' }
// Native (device-side) countdown is intentionally not supported here: per-device
// timing would drift between members and confuse the user.
export async function POST({ params, request }: any) {
  const id = Number(params.id);
  const b = await request.json().catch(() => ({}));
  if (typeof b.seconds !== 'number' || b.seconds <= 0) throw error(400, 'seconds:>0');
  if (!['on', 'off', 'toggle'].includes(b.action)) throw error(400, 'action: on|off|toggle');

  const members = await q<{ device_id: number }>(
    `SELECT device_id FROM app_device_group_members WHERE group_id = ?`,
    [id]
  );
  if (!members.length) throw error(400, 'group has no members');

  const taskIds: number[] = [];
  const errs: string[] = [];
  await Promise.all(members.map(async (m: any) => {
    try {
      const tid = await scheduleIn(
        m.device_id, b.seconds, b.action,
        `group ${id} countdown ${b.action} ${b.seconds}s`
      );
      taskIds.push(tid);
    } catch (e: any) { errs.push(`${m.device_id}: ${e.message || e}`); }
  }));
  if (!taskIds.length) throw error(500, errs.join('; '));
  return json({ ok: true, mode: 'app', task_ids: taskIds, partial_errors: errs });
}
