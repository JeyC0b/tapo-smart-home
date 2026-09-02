import { json } from '@sveltejs/kit';
import { q } from '$lib/server/db';
import { discoverNetwork, statusOf } from '$lib/server/kasa';
import { getDefaultCredentials } from '$lib/server/settings';
import { fail } from '$lib/server/api_error';
import { log } from '$lib/server/logger';

/**
 * POST /api/discover
 * Body: { ip?, username?, password?, target?, timeout?, includeKnown? }
 *
 * Filters out already-added devices by IP:
 *   - excludeIps = union of app_hubs.ip + parent IPs of app_devices (via hub_id→hub.ip)
 *   - this keeps already-known devices out of the scan output
 *   - can be overridden with `includeKnown:true`
 *
 * For IP-change re-pair: when scan finds a device_id we already have in DB
 * but with a different IP, it is reported as `existing_hub_id` (UI offers an IP update).
 */
export async function POST({ request }) {
  const b = await request.json().catch(() => ({} as any));
  let username = b.username, password = b.password;

  if (!username || !password) {
    const def = await getDefaultCredentials();
    if (def) { username = def.username; password = def.password; }
  }
  if (!username || !password) {
    const h = await q<{ username: string; password: string }>(
      `SELECT username, password FROM app_hubs WHERE enabled = 1 LIMIT 1`
    );
    if (h[0]) { username = h[0].username; password = h[0].password; }
  }
  if (!username || !password) {
    fail(400, 'credentials_missing',
      'Tapo credentials are missing. Add them in Settings or create a hub.');
  }

  // Existing devices indexed by device_id and IP
  type ExistingRow = { hub_id: number; device_id: string; hub_ip: string };
  const existing = await q<ExistingRow>(
    `SELECT d.hub_id, d.device_id, h.ip AS hub_ip
       FROM app_devices d
       LEFT JOIN app_hubs h ON h.id = d.hub_id`
  );
  const knownIps = new Set<string>();
  const knownDeviceIds = new Map<string, ExistingRow>();
  for (const r of existing) {
    if (r.hub_ip) knownIps.add(r.hub_ip);
    if (r.device_id) knownDeviceIds.set(r.device_id, r);
  }

  if (b.ip) {
    try {
      const r = await statusOf({ ip: b.ip, username, password });
      return json({ found: r.devices.map(d => ({ ...d, ip: b.ip })), unsupported: [] });
    } catch (e: any) {
      await log('warn', 'api', `discover: cannot reach ${b.ip}`, { err: String(e?.message ?? e) });
      fail(400, 'hub_unreachable',
        'Could not connect to the device. Check the IP address and credentials.');
    }
  }

  try {
    const excludeIps = b.includeKnown ? [] : Array.from(knownIps);
    const r = await discoverNetwork({
      username, password,
      target: b.target,
      timeoutSec: b.timeout,
      excludeIps,
    });

    // Annotate each found item with existing/IP-change info, drop ones that
    // are already imported under the same IP (defensive — the bridge already
    // skipped excluded IPs but children of a hub may surface here).
    const annotated = (r.found || []).map(f => {
      const did = (f as any).device_id as string | undefined;
      const fip = (f as any).ip as string | undefined;
      if (!did) return f;
      const e = knownDeviceIds.get(did);
      if (!e) return f;
      // already added; surface as ip-change candidate if IP differs
      if (e.hub_ip && fip && e.hub_ip !== fip) {
        return { ...f, ip_change: { hub_id: e.hub_id, old_ip: e.hub_ip } };
      }
      return { ...f, already_imported: true };
    }).filter((f: any) => !f.already_imported);

    return json({ ...r, found: annotated });
  } catch (e: any) {
    await log('error', 'api', 'network discover failed', { err: String(e?.message ?? e) });
    fail(502, 'discover_failed', 'Network scan failed.');
  }
}
