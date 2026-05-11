import { q } from '$lib/server/db';

export async function load() {
  const widgets = await q<any>(
    `SELECT id, kind, title, config, on_home, enabled, created_at
       FROM app_widgets
      ORDER BY id DESC`
  );
  for (const w of widgets) {
    if (w.config && typeof w.config === 'string') {
      try { w.config = JSON.parse(w.config); } catch { w.config = {}; }
    }
    w.config ??= {};
  }
  const devices = await q<any>(
    `SELECT id, kind, custom_name, tapo_alias, device_id, room,
            state, brightness, temperature, humidity, battery, energy_w
       FROM app_devices
      WHERE excluded = 0
      ORDER BY room, COALESCE(custom_name, tapo_alias, device_id)`
  );
  const groups = await q<any>(
    `SELECT id, name, icon, room, config FROM app_device_groups WHERE enabled = 1 ORDER BY name`
  );
  for (const g of groups) {
    if (g.config && typeof g.config === 'string') {
      try { g.config = JSON.parse(g.config); } catch { g.config = null; }
    }
  }
  return { widgets, devices, groups };
}
