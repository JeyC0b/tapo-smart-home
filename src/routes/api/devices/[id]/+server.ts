import { json, error } from '@sveltejs/kit';
import { exec, q } from '$lib/server/db';

export async function PATCH({ params, request }) {
  const id = Number(params.id);
  const b = await request.json().catch(() => ({}));
  const fields: string[] = [];
  const vals: any[] = [];
  for (const k of ['custom_name', 'room', 'excluded', 'is_momentary', 'guest_control',
                   'on_home', 'home_x', 'home_y', 'home_width', 'home_height',
                   'poll_interval_seconds'] as const) {
    if (k in b) { fields.push(`${k} = ?`); vals.push(b[k] ?? null); }
  }
  if (!fields.length) throw error(400, 'no fields');
  vals.push(id);
  await exec(`UPDATE app_devices SET ${fields.join(', ')} WHERE id = ?`, vals);
  const [d] = await q('SELECT * FROM app_devices WHERE id = ?', [id]);
  return json(d);
}

export async function DELETE({ params }) {
  await exec('DELETE FROM app_devices WHERE id = ?', [Number(params.id)]);
  return json({ ok: true });
}
