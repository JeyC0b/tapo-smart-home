import { q } from '$lib/server/db';
import type { Device } from '$lib/types';

export async function load() {
  // Returns ALL active devices (no excluded ones). The client filters by
  // on_home, so "Add device" can show those not yet on the home screen.
  const rows = await q<Device>(`
    SELECT d.* FROM app_devices d
    WHERE d.kind IN ('sensor','motion','contact','leak','switch','plug','bulb','fan','strip','button','hub')
      AND d.excluded = 0
    ORDER BY d.home_y, d.home_x, d.sort_order, d.id
  `);
  const devices = rows.map(d => ({
    ...d,
    capabilities: typeof d.capabilities === 'string' ? JSON.parse(d.capabilities as any) : d.capabilities
  }));

  const widgets = await q<any>(`
    SELECT id, kind, title, config, on_home, home_x, home_y, home_width, home_height, enabled
      FROM app_widgets
     WHERE enabled = 1
     ORDER BY home_y, home_x, id
  `);
  for (const w of widgets) {
    if (w.config && typeof w.config === 'string') {
      try { w.config = JSON.parse(w.config); } catch { w.config = {}; }
    }
    w.config ??= {};
  }

  // Device groups + their member states for "group" widgets and the home stack.
  const groups = await q<any>(
    `SELECT id, name, icon, room, enabled, config FROM app_device_groups WHERE enabled = 1`
  );
  for (const g of groups) {
    if (g.config && typeof g.config === 'string') {
      try { g.config = JSON.parse(g.config); } catch { g.config = null; }
    }
  }
  const groupMembers = await q<{ group_id: number; device_id: number; state: 0|1|null }>(
    `SELECT m.group_id, m.device_id, d.state
       FROM app_device_group_members m JOIN app_devices d ON d.id = m.device_id`
  );
  const groupStates: Record<number, { on: number; total: number; any_on: boolean; all_on: boolean }> = {};
  for (const g of groups) {
    groupStates[g.id] = { on: 0, total: 0, any_on: false, all_on: false };
    g.members = [] as number[];
  }
  for (const m of groupMembers) {
    const s = groupStates[m.group_id];
    if (!s) continue;
    s.total++;
    if (m.state === 1) s.on++;
    const grp = groups.find((g: any) => g.id === m.group_id);
    if (grp) grp.members.push(m.device_id);
  }
  for (const id of Object.keys(groupStates)) {
    const s = groupStates[Number(id)];
    s.any_on = s.on > 0;
    s.all_on = s.total > 0 && s.on === s.total;
  }

  return { devices, widgets, groups, groupStates };
}
