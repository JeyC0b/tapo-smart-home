import { json, error } from '@sveltejs/kit';
import { q, exec } from '$lib/server/db';

// GET /api/groups - list all groups with their members + computed state.
export async function GET() {
  const groups = await q<any>(
    `SELECT id, name, icon, room, enabled, config, created_at FROM app_device_groups ORDER BY name`
  );
  const members = await q<any>(
    `SELECT m.group_id, m.device_id, m.position,
            d.custom_name, d.tapo_alias, d.kind, d.state, d.online
       FROM app_device_group_members m
       JOIN app_devices d ON d.id = m.device_id
      ORDER BY m.position, m.device_id`
  );
  const byGroup = new Map<number, any[]>();
  for (const m of members) {
    if (!byGroup.has(m.group_id)) byGroup.set(m.group_id, []);
    byGroup.get(m.group_id)!.push(m);
  }
  return json({
    groups: groups.map(g => {
      const ms = byGroup.get(g.id) || [];
      const total = ms.length;
      const on = ms.filter(m => m.state === 1).length;
      let cfg: any = g.config;
      if (cfg && typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch { cfg = null; } }
      return { ...g, config: cfg, members: ms, total, on, any_on: on > 0, all_on: total > 0 && on === total };
    })
  });
}

export async function POST({ request }: any) {
  const b = await request.json().catch(() => ({}));
  const name = String(b.name || '').trim().slice(0, 128);
  if (!name) throw error(400, 'name required');
  const cfg = b.config && typeof b.config === 'object' ? JSON.stringify(b.config) : null;
  const r = await exec(
    `INSERT INTO app_device_groups (name, icon, room, enabled, config) VALUES (?,?,?,1,?)`,
    [name, b.icon || null, b.room || null, cfg]
  );
  return json({ ok: true, id: (r as any).insertId });
}
