import { json, error } from '@sveltejs/kit';
import { commandSetState } from '$lib/server/poller';
import { deviceError } from '$lib/server/api_error';

export async function POST({ params, request }) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) throw error(400, 'invalid device id');
  const body = await request.json().catch(() => ({}));
  if (typeof body.on !== 'boolean') throw error(400, 'on:boolean required');
  try {
    await commandSetState(id, body.on);
    return json({ ok: true });
  } catch (e: any) {
    await deviceError(e, 'set state');
  }
}
