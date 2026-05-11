import { json, error } from '@sveltejs/kit';
import { q } from '$lib/server/db';
import { commandSetState } from '$lib/server/poller';

// POST /api/groups/:id/toggle - if any device on -> turn all off, else turn all on.
// Body { on: boolean } forces a target state instead of toggle.
// Guest-allowed (see auth.ts whitelist).
export async function POST({ params, request }: any) {
  const id = Number(params.id);
  const b = await request.json().catch(() => ({}));
  const members = await q<{ device_id: number; state: 0 | 1 | null; guest_control: 0 | 1 }>(
    `SELECT m.device_id, d.state, d.guest_control
       FROM app_device_group_members m JOIN app_devices d ON d.id = m.device_id
      WHERE m.group_id = ?`,
    [id]
  );
  if (!members.length) throw error(400, 'group has no members');

  const target: boolean = typeof b.on === 'boolean'
    ? b.on
    : !members.some(m => m.state === 1);

  const errs: string[] = [];
  await Promise.all(members.map(async m => {
    try { await commandSetState(m.device_id, target); }
    catch (e: any) { errs.push(`${m.device_id}: ${e.message || e}`); }
  }));
  if (errs.length === members.length) throw error(500, errs.join('; '));
  return json({ ok: true, state: target, partial_errors: errs });
}
