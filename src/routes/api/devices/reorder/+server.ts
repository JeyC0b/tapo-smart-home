import { json, error } from '@sveltejs/kit';
import { tx } from '$lib/server/db';

/**
 * POST /api/devices/reorder
 * Body: [{ id: number, sort_order: number }, ...]
 *
 * Bulk update of card order on the home page (atomic — all or nothing).
 */
export async function POST({ request }) {
  const b = await request.json().catch(() => null);
  if (!Array.isArray(b)) throw error(400, 'expected array of {id, sort_order}');

  // Validate before opening the transaction.
  const items = b.map((it: any) => ({ id: Number(it?.id), so: Number(it?.sort_order) }));
  for (const it of items) {
    if (!Number.isFinite(it.id) || !Number.isFinite(it.so)) throw error(400, 'invalid id/sort_order');
  }

  await tx(async (c) => {
    for (const it of items) {
      await c.execute('UPDATE app_devices SET sort_order = ? WHERE id = ?', [it.so, it.id]);
    }
  });
  return json({ ok: true, updated: items.length });
}
