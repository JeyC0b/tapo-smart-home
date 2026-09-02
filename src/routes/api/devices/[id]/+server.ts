import { json } from '@sveltejs/kit';
import { exec, q } from '$lib/server/db';
import { fail } from '$lib/server/api_error';

// Flags stored as TINYINT(1) and grid coordinates written straight into the
// dashboard layout — coerce them here rather than trusting whatever the client
// sends (a NaN width used to produce an invisible, undraggable tile).
const FLAGS = ['excluded', 'is_momentary', 'guest_control', 'on_home'] as const;
const GRID: Record<string, { min: number; max: number }> = {
  home_x: { min: 0, max: 11 },
  home_y: { min: 0, max: 999 },
  home_width: { min: 1, max: 12 },
  home_height: { min: 1, max: 100 }
};

export async function PATCH({ params, request }) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) fail(400, 'invalid_input', 'Invalid device id.');
  const b = await request.json().catch(() => ({}));
  const fields: string[] = [];
  const vals: any[] = [];
  for (const k of ['custom_name', 'room', 'excluded', 'is_momentary', 'guest_control',
                   'on_home', 'home_x', 'home_y', 'home_width', 'home_height',
                   'poll_interval_seconds'] as const) {
    if (!(k in b)) continue;
    let v: any = b[k] ?? null;
    if ((FLAGS as readonly string[]).includes(k)) {
      v = v ? 1 : 0;
    } else if (k in GRID) {
      const n = Number(v);
      if (!Number.isFinite(n)) fail(400, 'invalid_input', `Invalid value for ${k}.`);
      v = Math.round(Math.min(GRID[k].max, Math.max(GRID[k].min, n)));
    } else if (k === 'poll_interval_seconds') {
      // NULL = "follow the global interval"; anything else is clamped to a
      // value the scheduler will actually honour (its floor is 30 s).
      if (v !== null && v !== '') {
        const n = Number(v);
        if (!Number.isFinite(n)) fail(400, 'invalid_input', 'Invalid poll interval.');
        v = Math.round(Math.min(86_400, Math.max(30, n)));
      } else v = null;
    } else if (typeof v === 'string') {
      v = v.slice(0, 128) || null;
    }
    fields.push(`${k} = ?`);
    vals.push(v);
  }
  if (!fields.length) fail(400, 'no_changes', 'No changes provided.');
  vals.push(id);
  await exec(`UPDATE app_devices SET ${fields.join(', ')} WHERE id = ?`, vals);
  const [d] = await q('SELECT * FROM app_devices WHERE id = ?', [id]);
  return json(d);
}

export async function DELETE({ params }) {
  await exec('DELETE FROM app_devices WHERE id = ?', [Number(params.id)]);
  return json({ ok: true });
}
