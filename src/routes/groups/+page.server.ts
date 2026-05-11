import { q } from '$lib/server/db';

export async function load() {
  const [groups, members, devices] = await Promise.all([
    q<any>(`SELECT id, name, icon, room, enabled, config FROM app_device_groups ORDER BY name`),
    q<any>(`SELECT m.group_id, m.device_id, m.position,
                   d.custom_name, d.tapo_alias, d.kind, d.state
              FROM app_device_group_members m
              JOIN app_devices d ON d.id = m.device_id
             ORDER BY m.position, m.device_id`),
    q<any>(`SELECT id, custom_name, tapo_alias, device_id, kind, room, excluded
              FROM app_devices
             WHERE excluded = 0
             ORDER BY room, custom_name, tapo_alias`)
  ]);
  // Parse the JSON appearance config so the editor can read render_as / overlay_icon.
  for (const g of groups) {
    if (g.config && typeof g.config === 'string') {
      try { g.config = JSON.parse(g.config); } catch { g.config = null; }
    }
  }
  const byGroup = new Map<number, any[]>();
  for (const m of members) {
    if (!byGroup.has(m.group_id)) byGroup.set(m.group_id, []);
    byGroup.get(m.group_id)!.push(m);
  }
  return {
    groups: groups.map(g => ({ ...g, members: byGroup.get(g.id) || [] })),
    devices
  };
}
