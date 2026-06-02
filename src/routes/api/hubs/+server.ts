import { json, error } from '@sveltejs/kit';
import { q, exec } from '$lib/server/db';
import { discover } from '$lib/server/kasa';

export async function GET() {
  const hubs = await q(`SELECT id, name, ip, username, enabled, kind FROM app_hubs ORDER BY name`);
  return json(hubs);
}

export async function POST({ request }) {
  const b = await request.json().catch(() => ({}));
  if (!b.name || !b.ip || !b.username || !b.password) throw error(400, 'name, ip, username, password required');
  const kind: 'hub' | 'single' = (b.kind === 'hub') ? 'hub' : 'single';
  // verify connection
  try {
    await discover({ ip: b.ip, username: b.username, password: b.password });
  } catch (e: any) {
    throw error(400, 'Discover selhal: ' + e.message);
  }
  const r = await exec(
    'INSERT INTO app_hubs (name, ip, username, password, enabled, kind) VALUES (?,?,?,?,1,?)',
    [b.name, b.ip, b.username, b.password, kind]
  );
  return json({ id: r.insertId, kind });
}
