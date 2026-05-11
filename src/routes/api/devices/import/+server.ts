import { json, error } from '@sveltejs/kit';
import { q, exec } from '$lib/server/db';
import { getDefaultCredentials } from '$lib/server/settings';
import { pollAll, pollOne } from '$lib/server/poller';

/**
 * POST /api/devices/import
 * Body: {
 *   ip, alias?, username?, password?,
 *   device_id?,         // pro IP-change re-pair
 *   kind_hint?          // ze scanu: 'hub'|'plug'|'bulb'|... → app_hubs.kind
 * }
 *
 * - Pokud `device_id` existuje s jinou IP → re-pair (UPDATE app_hubs.ip).
 * - Otherwise insert a new row into app_hubs with kind='hub' (children are added via poll)
 *   or kind='single' (a stand-alone bulb / plug).
 * - After insert, perform a synchronous poll of that hub so the device and
 *   all its children appear in the list immediately.
 */
export async function POST({ request }) {
  const b = await request.json().catch(() => ({} as any));
  if (!b.ip) throw error(400, 'ip required');

  let username = b.username, password = b.password;
  if (!username || !password) {
    const def = await getDefaultCredentials();
    if (def) { username = def.username; password = def.password; }
  }
  if (!username || !password) throw error(400, 'Credentials are missing. Set defaults in Settings.');

  // ---- IP-change re-pair ----
  if (b.device_id) {
    const found = await q<{ hub_id: number | null; hub_ip: string | null }>(
      `SELECT d.hub_id, h.ip AS hub_ip
         FROM app_devices d
         LEFT JOIN app_hubs h ON h.id = d.hub_id
         WHERE d.device_id = ? LIMIT 1`,
      [b.device_id]
    );
    const ex = found[0];
    if (ex && ex.hub_id) {
      if (ex.hub_ip !== b.ip) {
        await exec('UPDATE app_hubs SET ip = ?, username = ?, password = ? WHERE id = ?',
          [b.ip, username, password, ex.hub_id]);
      }
      pollOne(ex.hub_id).catch(() => {});
      return json({
        ok: true, hub_id: ex.hub_id, repaired: ex.hub_ip !== b.ip,
        old_ip: ex.hub_ip, new_ip: b.ip,
      });
    }
  }

  // ---- New add ----
  const dup = await q<{ id: number }>('SELECT id FROM app_hubs WHERE ip = ?', [b.ip]);
  if (dup[0]) {
    pollOne(dup[0].id).catch(() => {});
    return json({ ok: true, hub_id: dup[0].id, existed: true });
  }

  const kind: 'hub' | 'single' = (b.kind_hint === 'hub') ? 'hub' : 'single';
  const name = b.alias || (kind === 'hub' ? `HUB ${b.ip}` : `Tapo ${b.ip}`);
  const r = await exec(
    'INSERT INTO app_hubs (name, ip, username, password, enabled, kind) VALUES (?,?,?,?,1,?)',
    [name, b.ip, username, password, kind]
  );
  const hubId = (r as any).insertId;
  // Synchronous poll of THIS hub only — children are written into app_devices immediately.
  try { await pollOne(hubId); } catch { /* already logged inside pollOne */ }
  return json({ ok: true, hub_id: hubId, kind });
}
