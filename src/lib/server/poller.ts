import { q, exec } from './db';
import { log } from './logger';
import {
  statusOf, setState, setLight, setFan, setNativeCountdown,
  type KasaDeviceSnapshot, type LightArgs
} from './kasa';

export interface HubRow {
  id: number; name: string; ip: string;
  username: string; password: string; enabled: number;
}

export interface DeviceRow {
  id: number; hub_id: number | null; device_id: string;
  parent_device_id: string | null; kind: string; device_type: string | null;
  tapo_alias: string | null; custom_name: string | null;
  room: string | null; model: string | null;
  online: number; fail_count: number; excluded: number;
  is_momentary: number;
  temperature: number | null; humidity: number | null; state: 0 | 1 | null;
  brightness: number | null; hsv: string | null; color_temp: number | null;
  fan_speed: number | null; battery: number | null;
  capabilities: any;
}

async function getSetting(key: string, fallback: string): Promise<string> {
  const r = await q<{ v: string }>(`SELECT v FROM app_settings WHERE k = ?`, [key]);
  return r[0]?.v ?? fallback;
}

/** Polls all enabled hubs in parallel. */
export async function pollAll(): Promise<void> {
  const t0 = Date.now();
  const hubs = await q<HubRow>('SELECT * FROM app_hubs WHERE enabled = 1');
  const offlineAfter = Number(await getSetting('offline_after_failures', '3'));
  await log('debug', 'poll', `pollAll start (${hubs.length} hubs)`);
  await Promise.all(hubs.map(h =>
    pollHub(h, offlineAfter).catch(e =>
      log('error', 'poll', `hub ${h.name}`, { err: String(e) })
    )
  ));
  await log('debug', 'poll', `pollAll done in ${Date.now() - t0} ms`);
}

/** Polls one specific hub (after import). */
export async function pollOne(hubId: number): Promise<void> {
  const hubs = await q<HubRow>('SELECT * FROM app_hubs WHERE id = ?', [hubId]);
  if (!hubs[0]) return;
  const offlineAfter = Number(await getSetting('offline_after_failures', '3'));
  try {
    await pollHub(hubs[0], offlineAfter);
  } catch (e) {
    await log('error', 'poll', `hub ${hubs[0].name}`, { err: String(e) });
  }
}

async function pollHub(h: HubRow, offlineAfter: number) {
  const t0 = Date.now();
  let s;
  try {
    s = await statusOf({ ip: h.ip, username: h.username, password: h.password });
  } catch (e) {
    // Sticky offline: increment fail_count but do not flip online=0 immediately
    await exec(
      `UPDATE app_devices
         SET fail_count = fail_count + 1,
             online = CASE WHEN fail_count + 1 >= ? THEN 0 ELSE online END
         WHERE hub_id = ?`,
      [offlineAfter, h.id]
    );
    await log('warn', 'poll', `HUB ${h.name} (${h.ip}) error`, { err: String(e) });
    return;
  }

  for (const d of s.devices) {
    if (!d.device_id) continue;
    await upsertDevice(h.id, d);
  }
  await log('debug', 'poll', `hub ${h.name}: ${s.devices.length} devices in ${Date.now() - t0} ms`);
}

async function upsertDevice(hubId: number, d: KasaDeviceSnapshot) {
  await exec(
    `INSERT INTO app_devices
       (hub_id, device_id, parent_device_id, kind, device_type, tapo_alias, model, mac, rssi,
        capabilities, is_momentary, online, fail_count, temperature, humidity, state,
        brightness, hsv, color_temp, fan_speed, battery, motion,
        energy_w, energy_today, energy_month, last_seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?, 1, 0, ?,?,?, ?,?,?,?,?,?, ?,?,?, NOW())
     ON DUPLICATE KEY UPDATE
       hub_id = VALUES(hub_id),
       parent_device_id = VALUES(parent_device_id),
       kind = VALUES(kind),
       device_type = VALUES(device_type),
       tapo_alias = COALESCE(app_devices.tapo_alias, VALUES(tapo_alias)),
       model = VALUES(model),
       mac = VALUES(mac),
       rssi = VALUES(rssi),
       capabilities = VALUES(capabilities),
       is_momentary = GREATEST(app_devices.is_momentary, VALUES(is_momentary)),
       online = 1,
       fail_count = 0,
       temperature = VALUES(temperature),
       humidity = VALUES(humidity),
       state = VALUES(state),
       brightness = VALUES(brightness),
       hsv = VALUES(hsv),
       color_temp = VALUES(color_temp),
       fan_speed = VALUES(fan_speed),
       battery = VALUES(battery),
       motion = VALUES(motion),
       energy_w = VALUES(energy_w),
       energy_today = VALUES(energy_today),
       energy_month = VALUES(energy_month),
       last_seen_at = NOW()`,
    [
      hubId, d.device_id, d.parent_device_id, d.kind, d.device_type,
      d.tapo_alias, d.model, d.mac, d.rssi,
      d.capabilities ? JSON.stringify(d.capabilities) : null,
      d.capabilities?.is_momentary ? 1 : 0,
      d.temperature, d.humidity, d.state,
      d.brightness, d.hsv ? d.hsv.join(',') : null, d.color_temp,
      d.fan_speed, d.battery, d.motion == null ? null : (d.motion ? 1 : 0),
      d.energy?.power_w ?? null, d.energy?.today_kwh ?? null, d.energy?.month_kwh ?? null
    ]
  );
  // historie
  const idRow = await q<{ id: number }>('SELECT id FROM app_devices WHERE device_id = ?', [d.device_id]);
  if (idRow[0]) {
    await exec(
      'INSERT INTO app_readings (device_id, temperature, humidity, state, energy_w) VALUES (?,?,?,?,?)',
      [idRow[0].id, d.temperature, d.humidity, d.state, d.energy?.power_w ?? null]
    );
  }
}

async function loadDeviceWithHub(deviceId: number) {
  const rows = await q<DeviceRow & { hub_ip: string; hub_user: string; hub_pass: string }>(
    `SELECT d.*, h.ip AS hub_ip, h.username AS hub_user, h.password AS hub_pass
       FROM app_devices d
       LEFT JOIN app_hubs h ON h.id = d.hub_id
       WHERE d.id = ?`,
    [deviceId]
  );
  const d = rows[0];
  if (!d) throw new Error('device not found');
  if (!d.hub_ip) throw new Error('device has no hub');
  return d;
}

/**
 * Toggle a device with post-action verification of the actual state.
 * For momentary devices (Tapo S200B etc.) the verify step is skipped — they have no stable state.
 */
export async function commandSetState(deviceId: number, on: boolean): Promise<void> {
  const d = await loadDeviceWithHub(deviceId);
  const verifySetting = (await getSetting('verify_actions', '1')) === '1';
  const isMomentary = !!d.is_momentary;
  const verify = verifySetting && !isMomentary;
  await log('debug', 'cmd', `commandSetState ${nameOf(d)} on=${on} verify=${verify} momentary=${isMomentary}`);

  const r = await setState(
    { ip: d.hub_ip, username: d.hub_user, password: d.hub_pass },
    d.device_id, on,
    { verify, allowMomentary: isMomentary }
  );
  if (!r.ok) throw new Error(r.error || 'set failed');

  if (verify && r.verified === false) {
    await log('error', 'cmd', `Set FAILED to verify ${nameOf(d)} → ${on ? 'ON' : 'OFF'} (actual=${r.actual})`);
    throw new Error(`Verification failed: device did not switch (actual=${r.actual})`);
  }

  if (!isMomentary) {
    await exec('UPDATE app_devices SET state = ? WHERE id = ?', [on ? 1 : 0, deviceId]);
  }
  await log(
    'info', 'cmd',
    `${nameOf(d)} → ${on ? 'ON' : 'OFF'}${verify ? ' (verified)' : isMomentary ? ' (momentary)' : ''}`
  );
}

export async function commandLight(deviceId: number, params: LightArgs): Promise<void> {
  const d = await loadDeviceWithHub(deviceId);
  const r = await setLight({ ip: d.hub_ip, username: d.hub_user, password: d.hub_pass }, d.device_id, params);
  if (!r.ok) throw new Error(r.error || 'light failed');

  const upd: string[] = []; const vals: any[] = [];
  if (params.brightness != null) { upd.push('brightness = ?'); vals.push(params.brightness); }
  if (params.hsv) { upd.push('hsv = ?'); vals.push(params.hsv.join(',')); }
  if (params.color_temp != null) { upd.push('color_temp = ?'); vals.push(params.color_temp); }
  if (upd.length) { vals.push(deviceId); await exec(`UPDATE app_devices SET ${upd.join(', ')} WHERE id = ?`, vals); }
  await log('info', 'cmd', `${nameOf(d)} light`, params as any);
}

export async function commandFan(deviceId: number, speed: number): Promise<void> {
  const d = await loadDeviceWithHub(deviceId);
  const r = await setFan({ ip: d.hub_ip, username: d.hub_user, password: d.hub_pass }, d.device_id, speed);
  if (!r.ok) throw new Error(r.error || 'fan failed');
  await exec('UPDATE app_devices SET fan_speed = ? WHERE id = ?', [speed, deviceId]);
  await log('info', 'cmd', `${nameOf(d)} fan = ${speed}`);
}

export async function commandNativeCountdown(deviceId: number, seconds: number, action: 'on' | 'off') {
  const d = await loadDeviceWithHub(deviceId);
  const r = await setNativeCountdown({ ip: d.hub_ip, username: d.hub_user, password: d.hub_pass }, d.device_id, seconds, action);
  if (!r.ok) throw new Error(r.error || 'countdown failed');
  await log('info', 'cmd', `${nameOf(d)} native countdown ${action} in ${seconds}s`);
}

function nameOf(d: { custom_name: string | null; tapo_alias: string | null; device_id: string }) {
  return d.custom_name || d.tapo_alias || d.device_id;
}
