import { json, error } from '@sveltejs/kit';
import { exec } from '$lib/server/db';

export async function PATCH({ params, request }) {
  const b = await request.json();
  const fields: string[] = []; const vals: any[] = [];
  for (const k of ['name', 'ip', 'username', 'password', 'enabled', 'poll_interval_seconds'] as const) {
    if (k in b) { fields.push(`${k} = ?`); vals.push(b[k]); }
  }
  if (!fields.length) throw error(400, 'no fields');
  vals.push(Number(params.id));
  await exec(`UPDATE app_hubs SET ${fields.join(', ')} WHERE id = ?`, vals);
  return json({ ok: true });
}

export async function DELETE({ params }) {
  await exec('DELETE FROM app_hubs WHERE id = ?', [Number(params.id)]);
  return json({ ok: true });
}
