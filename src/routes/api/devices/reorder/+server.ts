import { json, error } from '@sveltejs/kit';
import { exec } from '$lib/server/db';

/**
 * POST /api/devices/reorder
 * Body: [{ id: number, sort_order: number }, ...]
 *
 * Bulk update of card order on the home page.
 */
export async function POST({ request }) {
  const b = await request.json().catch(() => null);
  if (!Array.isArray(b)) throw error(400, 'expected array of {id, sort_order}');

  for (const it of b) {
    const id = Number(it?.id);
    const so = Number(it?.sort_order);
    if (!Number.isFinite(id) || !Number.isFinite(so)) {
      throw error(400, 'invalid id/sort_order');
    }
    await exec('UPDATE app_devices SET sort_order = ? WHERE id = ?', [so, id]);
  }
  return json({ ok: true, updated: b.length });
}
