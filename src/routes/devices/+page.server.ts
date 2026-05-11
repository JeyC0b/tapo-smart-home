import { q } from '$lib/server/db';
import type { Device, Hub } from '$lib/types';

export async function load() {
  const [rows, hubs] = await Promise.all([
    q<Device & { hub_name?: string }>(
      `SELECT d.*, h.name AS hub_name
         FROM app_devices d
         LEFT JOIN app_hubs h ON h.id = d.hub_id
         ORDER BY d.kind, COALESCE(d.custom_name, d.tapo_alias, d.device_id)`
    ),
    q<Hub & { child_count?: number }>(
      `SELECT h.id, h.name, h.ip, h.username, h.enabled, h.kind,
              (SELECT COUNT(*) FROM app_devices d WHERE d.hub_id = h.id) AS child_count
         FROM app_hubs h
         ORDER BY h.kind DESC, h.name`
    )
  ]);
  const devices = rows.map(d => ({
    ...d,
    capabilities: typeof d.capabilities === 'string' ? JSON.parse(d.capabilities as any) : d.capabilities
  }));
  return { devices, hubs };
}
