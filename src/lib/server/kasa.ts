import { spawn } from 'node:child_process';
import { env } from '$env/dynamic/private';
import path from 'node:path';

const PYTHON = env.PYTHON_BIN || 'python3';
const SCRIPT = env.KASA_BRIDGE
  ? path.resolve(env.KASA_BRIDGE)
  : path.resolve('./scripts/kasa_bridge.py');

export interface KasaDeviceSnapshot {
  device_id: string;
  parent_device_id: string | null;
  kind: 'sensor' | 'motion' | 'contact' | 'leak' | 'switch' | 'plug' | 'bulb' | 'fan' | 'strip' | 'hub' | 'button' | 'unknown';
  tapo_alias: string | null;
  model: string | null;
  device_type: string | null;
  mac: string | null;
  rssi: number | null;
  temperature: number | null;
  humidity: number | null;
  state: 0 | 1 | null;
  brightness: number | null;
  hsv: number[] | null;
  color_temp: number | null;
  fan_speed: number | null;
  battery: number | null;
  motion: boolean | null;
  energy: { power_w: number | null; today_kwh: number | null; month_kwh: number | null } | null;
  capabilities: Record<string, any> | null;
}

export interface KasaStatus { ok: true; ip: string; devices: KasaDeviceSnapshot[]; }
export interface KasaDiscoverNetwork {
  ok: true;
  found: (KasaDeviceSnapshot & { ip?: string; error?: string })[];
  unsupported: { info: string }[];
}
export interface KasaError { ok: false; type?: string; error: string; host?: string }

interface ConnArgs { ip: string; username: string; password: string; }

// Credentials are passed to the bridge via the child's ENVIRONMENT, never argv,
// so they don't appear in the host process listing (/proc/<pid>/cmdline, Task
// Manager). The bridge reads KASA_USER/KASA_PASS (falling back to --user/--pass
// for manual debugging).
function run(args: string[], creds?: { user: string; password: string }, timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const env2 = { ...process.env };
    if (env.PYTHON_LIBS) env2.PYTHON_LIBS = path.resolve(env.PYTHON_LIBS);
    if (creds) { env2.KASA_USER = creds.user; env2.KASA_PASS = creds.password; }
    const child = spawn(PYTHON, [SCRIPT, ...args], { env: env2 });
    let stdout = '';
    let stderr = '';
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('kasa_bridge timeout')); }, timeoutMs);
    child.stdout.on('data', d => (stdout += d.toString()));
    child.stderr.on('data', d => (stderr += d.toString()));
    child.on('close', code => {
      clearTimeout(t);
      // exit 1 but stdout JSON is valid → return stdout, parser below understands it
      if (stdout) return resolve(stdout);
      if (code === 0) return resolve(stdout);
      reject(new Error(`kasa_bridge exit=${code} stderr=${stderr}`));
    });
    child.on('error', reject);
  });
}

function parse<T>(out: string): T {
  try { return JSON.parse(out) as T; }
  catch { throw new Error('kasa_bridge: invalid JSON: ' + out.slice(0, 500)); }
}

function ensureOk<T extends { ok: boolean }>(r: T): T {
  if (!r.ok) {
    const e = r as unknown as KasaError;
    const err = new Error(e.error || 'kasa_bridge failed');
    (err as any).kasaType = e.type;
    throw err;
  }
  return r;
}

export async function statusOf(c: ConnArgs): Promise<KasaStatus> {
  const out = await run(['status', '--ip', c.ip], { user: c.username, password: c.password });
  return ensureOk(parse<KasaStatus | KasaError>(out) as any);
}

export async function discover(c: ConnArgs): Promise<KasaStatus> {
  const out = await run(['discover', '--ip', c.ip], { user: c.username, password: c.password });
  return ensureOk(parse<KasaStatus | KasaError>(out) as any);
}

export async function discoverNetwork(args: { username: string; password: string; target?: string; timeoutSec?: number; excludeIps?: string[] }): Promise<KasaDiscoverNetwork> {
  const params = ['discover-network'];
  if (args.target) params.push('--target', args.target);
  if (args.timeoutSec) params.push('--timeout', String(args.timeoutSec));
  if (args.excludeIps && args.excludeIps.length) {
    params.push('--exclude-ip', args.excludeIps.join(','));
  }
  const out = await run(params, { user: args.username, password: args.password }, 90_000);
  return ensureOk(parse<KasaDiscoverNetwork | KasaError>(out) as any);
}

export async function setState(
  c: ConnArgs,
  deviceId: string,
  on: boolean,
  opts: { verify?: boolean; allowMomentary?: boolean } = {}
): Promise<{ ok: boolean; verified?: boolean | null; actual?: 0 | 1 | null; is_momentary?: boolean; error?: string }> {
  const args = ['set', '--ip', c.ip, '--device-id', deviceId, '--state', on ? 'on' : 'off'];
  if (opts.verify) args.push('--verify');
  if (opts.allowMomentary) args.push('--allow-momentary');
  const out = await run(args, { user: c.username, password: c.password });
  return parse(out);
}

export interface LightArgs { brightness?: number; hsv?: [number, number, number]; color_temp?: number; effect?: string; }
export async function setLight(c: ConnArgs, deviceId: string, p: LightArgs): Promise<{ ok: boolean; applied?: any; error?: string }> {
  const args = ['light', '--ip', c.ip, '--device-id', deviceId];
  if (p.brightness != null) args.push('--brightness', String(p.brightness));
  if (p.hsv) args.push('--hsv', p.hsv.join(','));
  if (p.color_temp != null) args.push('--color-temp', String(p.color_temp));
  if (p.effect) args.push('--effect', p.effect);
  const out = await run(args, { user: c.username, password: c.password });
  return parse(out);
}

export async function setFan(c: ConnArgs, deviceId: string, speed: number) {
  const out = await run(['fan', '--ip', c.ip, '--device-id', deviceId, '--speed', String(speed)], { user: c.username, password: c.password });
  return parse<{ ok: boolean; speed?: number; error?: string }>(out);
}

export async function setNativeCountdown(c: ConnArgs, deviceId: string, seconds: number, action: 'on' | 'off') {
  const out = await run(['countdown', '--ip', c.ip, '--device-id', deviceId, '--seconds', String(seconds), '--action', action], { user: c.username, password: c.password });
  return parse<{ ok: boolean; error?: string }>(out);
}
