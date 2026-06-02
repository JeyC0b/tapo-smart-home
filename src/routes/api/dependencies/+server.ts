import { json, error } from '@sveltejs/kit';
import { q, exec } from '$lib/server/db';

export async function GET() {
  return json(await q('SELECT * FROM app_dependencies ORDER BY id'));
}

export async function POST({ request }) {
  const b = await request.json().catch(() => ({}));
  const name = String(b.name ?? '').trim();
  const src = Number(b.source_device_id);
  const tgt = Number(b.target_device_id);
  if (!name) throw error(400, 'name required');
  if (!Number.isFinite(src) || !Number.isFinite(tgt)) throw error(400, 'source/target device id required');
  const r = await exec(
    `INSERT INTO app_dependencies (name, enabled, source_device_id, source_state, target_device_id, required_state)
     VALUES (?,1,?,?,?,?)`,
    [name, src, b.source_state ? 1 : 0, tgt, b.required_state ? 1 : 0]
  );
  return json({ id: r.insertId });
}
