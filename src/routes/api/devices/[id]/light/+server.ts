import { json, error } from '@sveltejs/kit';
import { commandLight } from '$lib/server/poller';

export async function POST({ params, request }) {
  const id = Number(params.id);
  const b = await request.json().catch(() => ({}));
  const p: any = {};
  if (typeof b.brightness === 'number') p.brightness = b.brightness;
  if (Array.isArray(b.hsv) && b.hsv.length === 3) p.hsv = b.hsv;
  if (typeof b.color_temp === 'number') p.color_temp = b.color_temp;
  if (typeof b.effect === 'string') p.effect = b.effect;
  if (!Object.keys(p).length) throw error(400, 'no light parameters');
  try { await commandLight(id, p); return json({ ok: true }); }
  catch (e: any) { throw error(500, e.message); }
}
