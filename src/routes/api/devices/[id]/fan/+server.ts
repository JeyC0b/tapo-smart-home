import { json, error } from '@sveltejs/kit';
import { commandFan } from '$lib/server/poller';
import { deviceError } from '$lib/server/api_error';

export async function POST({ params, request }) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) throw error(400, 'invalid device id');
  const b = await request.json().catch(() => ({}));
  if (typeof b.speed !== 'number') throw error(400, 'speed:number required');
  try { await commandFan(id, b.speed); return json({ ok: true }); }
  catch (e: any) { await deviceError(e, 'fan'); }
}
