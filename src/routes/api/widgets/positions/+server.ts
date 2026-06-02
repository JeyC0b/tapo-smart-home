import { json, error } from '@sveltejs/kit';
import { tx } from '$lib/server/db';

/** Bulk update of widget positions. Body: { positions: [{id, pos_x, pos_y, width, height}, ...] } */
export async function PATCH({ request }: any) {
  const b = await request.json().catch(() => ({}));
  if (!Array.isArray(b.positions)) throw error(400, 'positions[] required');
  await tx(async (c) => {
    for (const p of b.positions) {
      if (!p || !p.id) continue;
      await c.execute(
        `UPDATE app_widgets SET pos_x=?, pos_y=?, width=?, height=? WHERE id=?`,
        [Number(p.pos_x)|0, Number(p.pos_y)|0, Math.max(1, Number(p.width)|0), Math.max(1, Number(p.height)|0), Number(p.id)]
      );
    }
  });
  return json({ ok: true });
}
