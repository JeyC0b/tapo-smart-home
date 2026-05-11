import { json } from '@sveltejs/kit';
import { q, exec } from '$lib/server/db';

export async function GET() {
  return json(await q('SELECT * FROM app_dependencies ORDER BY id'));
}

export async function POST({ request }) {
  const b = await request.json();
  const r = await exec(
    `INSERT INTO app_dependencies (name, enabled, source_device_id, source_state, target_device_id, required_state)
     VALUES (?,1,?,?,?,?)`,
    [b.name, b.source_device_id, b.source_state, b.target_device_id, b.required_state]
  );
  return json({ id: r.insertId });
}
