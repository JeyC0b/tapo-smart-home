import { json, error } from '@sveltejs/kit';
import { exec, tx } from '$lib/server/db';

// PATCH /api/groups/:id - update name/icon/room/enabled/config or replace member list (device_ids)
export async function PATCH({ params, request }: any) {
  const id = Number(params.id);
  const b = await request.json().catch(() => ({}));
  // One transaction: the field UPDATE and the DELETE-then-INSERT member replace
  // commit together. A failure after the DELETE would otherwise wipe membership.
  await tx(async (c) => {
    const fields: string[] = []; const vals: any[] = [];
    for (const k of ['name', 'icon', 'room', 'enabled'] as const) {
      if (k in b) { fields.push(`${k} = ?`); vals.push(b[k]); }
    }
    if ('config' in b) {
      fields.push('config = ?');
      vals.push(b.config && typeof b.config === 'object' ? JSON.stringify(b.config) : null);
    }
    if (fields.length) {
      vals.push(id);
      await c.execute(`UPDATE app_device_groups SET ${fields.join(', ')} WHERE id = ?`, vals);
    }
    if (Array.isArray(b.device_ids)) {
      await c.execute(`DELETE FROM app_device_group_members WHERE group_id = ?`, [id]);
      let pos = 0;
      for (const did of b.device_ids) {
        const dev = Number(did);
        if (!Number.isFinite(dev)) continue;
        await c.execute(
          `INSERT IGNORE INTO app_device_group_members (group_id, device_id, position) VALUES (?,?,?)`,
          [id, dev, pos++]
        );
      }
    }
  });
  return json({ ok: true });
}

export async function DELETE({ params }: any) {
  await exec(`DELETE FROM app_device_groups WHERE id = ?`, [Number(params.id)]);
  return json({ ok: true });
}

