import { json, error } from '@sveltejs/kit';
import { commandSetState } from '$lib/server/poller';

export async function POST({ params, request }) {
  const id = Number(params.id);
  const body = await request.json().catch(() => ({}));
  if (typeof body.on !== 'boolean') throw error(400, 'on:boolean required');
  try {
    await commandSetState(id, body.on);
    return json({ ok: true });
  } catch (e: any) {
    throw error(500, e.message || 'failed');
  }
}
