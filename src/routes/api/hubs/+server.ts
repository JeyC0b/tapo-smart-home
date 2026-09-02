import { json } from '@sveltejs/kit';
import { q, exec } from '$lib/server/db';
import { discover } from '$lib/server/kasa';
import { fail } from '$lib/server/api_error';
import { log } from '$lib/server/logger';

export async function GET() {
  const hubs = await q(`SELECT id, name, ip, username, enabled, kind FROM app_hubs ORDER BY name`);
  return json(hubs);
}

export async function POST({ request }) {
  const b = await request.json().catch(() => ({}));
  if (!b.name || !b.ip || !b.username || !b.password) {
    fail(400, 'invalid_input', 'name, ip, username and password are required.');
  }
  const kind: 'hub' | 'single' = (b.kind === 'hub') ? 'hub' : 'single';
  // Verify the connection before storing anything. The raw python-kasa message
  // goes to the log only — it can carry protocol/credential details.
  try {
    await discover({ ip: b.ip, username: b.username, password: b.password });
  } catch (e: any) {
    await log('warn', 'api', `hub add: cannot reach ${b.ip}`, { err: String(e?.message ?? e) });
    fail(400, 'hub_unreachable',
      'Could not connect to the device. Check the IP address and credentials.');
  }
  const r = await exec(
    'INSERT INTO app_hubs (name, ip, username, password, enabled, kind) VALUES (?,?,?,?,1,?)',
    [b.name, b.ip, b.username, b.password, kind]
  );
  return json({ id: r.insertId, kind });
}
