import { json } from '@sveltejs/kit';
import { q } from '$lib/server/db';
import { commandSetState } from '$lib/server/poller';
import { deviceError, fail } from '$lib/server/api_error';

// POST /api/groups/:id/toggle - if any device on -> turn all off, else turn all on.
// Body { on: boolean } forces a target state instead of toggle.
// Guest-allowed (see auth.ts whitelist).
export async function POST({ params, request, locals }: any) {
  const id = Number(params.id);
  const isAdmin = !!locals?.isAdmin;
  const b = await request.json().catch(() => ({}));
  const allMembers = await q<{ device_id: number; state: 0 | 1 | null; guest_control: 0 | 1 }>(
    `SELECT m.device_id, d.state, d.guest_control
       FROM app_device_group_members m JOIN app_devices d ON d.id = m.device_id
      WHERE m.group_id = ?`,
    [id]
  );
  if (!allMembers.length) fail(400, 'group_empty', 'The group has no members.');

  // Per-device guest lock also applies through groups: a guest may only act on
  // members the admin left unlocked (guest_control=1). Otherwise the group
  // fan-out would silently bypass the device lock enforced for /api/devices.
  const members = allMembers.filter(m => isAdmin || m.guest_control === 1);
  if (!members.length) {
    fail(403, 'group_not_allowed', 'This group has no devices you are allowed to control.');
  }

  const target: boolean = typeof b.on === 'boolean'
    ? b.on
    : !members.some(m => m.state === 1);

  const errs: string[] = [];
  await Promise.all(members.map(async m => {
    try { await commandSetState(m.device_id, target); }
    catch (e: any) { errs.push(`${m.device_id}: ${e.message || e}`); }
  }));
  // Redact raw device/bridge/DB errors (this endpoint is guest-reachable): log
  // the detail server-side and return a mapped status / count, never the text.
  if (errs.length === members.length) await deviceError(new Error(errs.join('; ')), 'group toggle');
  return json({ ok: true, state: target, failed: errs.length });
}
