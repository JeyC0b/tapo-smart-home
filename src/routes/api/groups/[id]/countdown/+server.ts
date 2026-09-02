import { json, error } from '@sveltejs/kit';
import { q } from '$lib/server/db';
import { scheduleIn } from '$lib/server/tasks';
import { deviceError, fail } from '$lib/server/api_error';

// POST /api/groups/:id/countdown — schedule an app-side countdown for every member.
// Body: { seconds: number, action: 'on'|'off'|'toggle' }
// Native (device-side) countdown is intentionally not supported here: per-device
// timing would drift between members and confuse the user.
export async function POST({ params, request, locals }: any) {
  const id = Number(params.id);
  const isAdmin = !!locals?.isAdmin;
  const b = await request.json().catch(() => ({}));
  if (typeof b.seconds !== 'number' || b.seconds <= 0) throw error(400, 'seconds:>0');
  if (!['on', 'off', 'toggle'].includes(b.action)) throw error(400, 'action: on|off|toggle');

  const allMembers = await q<{ device_id: number; guest_control: 0 | 1 }>(
    `SELECT m.device_id, d.guest_control
       FROM app_device_group_members m JOIN app_devices d ON d.id = m.device_id
      WHERE m.group_id = ?`,
    [id]
  );
  if (!allMembers.length) fail(400, 'group_empty', 'The group has no members.');

  // Honour the per-device guest lock when fanning out through a group.
  const members = allMembers.filter(m => isAdmin || m.guest_control === 1);
  if (!members.length) {
    fail(403, 'group_not_allowed', 'This group has no devices you are allowed to control.');
  }

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
  if (!taskIds.length) await deviceError(new Error(errs.join('; ')), 'group countdown');
  return json({ ok: true, mode: 'app', task_ids: taskIds, failed: errs.length });
}
