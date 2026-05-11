import { json, error } from '@sveltejs/kit';
import { commandFan } from '$lib/server/poller';

export async function POST({ params, request }) {
  const b = await request.json();
  if (typeof b.speed !== 'number') throw error(400, 'speed:number required');
  try { await commandFan(Number(params.id), b.speed); return json({ ok: true }); }
  catch (e: any) { throw error(500, e.message); }
}
