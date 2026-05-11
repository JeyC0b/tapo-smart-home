export type DeviceKind =
  | 'sensor' | 'motion' | 'contact' | 'leak'
  | 'switch' | 'plug' | 'bulb' | 'fan' | 'strip'
  | 'hub' | 'button' | 'unknown';

export interface Capabilities {
  modules?: string[];
  features?: string[];
  can_toggle?: boolean;
  is_momentary?: boolean;
  brightness?: boolean;
  color?: boolean;
  color_temp?: { range: [number, number] | null };
  light_effect?: { current?: string | null; list: string[] };
  light_preset?: { current?: string | null; list: string[] };
  fan?: boolean;
  energy?: boolean;
  countdown_native?: boolean;
  battery?: boolean;
  motion?: boolean;
  contact?: boolean;
  water_leak?: boolean;
}

export interface Device {
  id: number;
  hub_id: number | null;
  device_id: string;
  parent_device_id: string | null;
  kind: DeviceKind;
  device_type: string | null;
  tapo_alias: string | null;
  custom_name: string | null;
  room: string | null;
  model: string | null;
  mac: string | null;
  rssi: number | null;
  capabilities: Capabilities | null;
  is_momentary: 0 | 1;
  online: 0 | 1;
  fail_count: number;
  excluded: 0 | 1;
  sort_order: number;
  on_home?: 0 | 1;
  home_x?: number;
  home_y?: number;
  home_width?: number;
  home_height?: number;
  guest_control?: 0 | 1;
  poll_interval_seconds?: number | null;
  temperature: number | null;
  humidity: number | null;
  state: 0 | 1 | null;
  brightness: number | null;
  hsv: string | null;
  color_temp: number | null;
  fan_speed: number | null;
  battery: number | null;
  motion: 0 | 1 | null;
  energy_w: number | null;
  energy_today: number | null;
  energy_month: number | null;
  last_seen_at: string | null;
}

export interface Hub {
  id: number;
  name: string;
  ip: string;
  username: string;
  password?: string;
  enabled: 0 | 1;
  kind: 'hub' | 'single';
}

export type RuleTrigger = 'sensor' | 'time' | 'device_state';
export type RuleMetric =
  | 'temperature' | 'humidity' | 'state' | 'battery' | 'energy_w' | 'motion'
  | 'http_value';
export type RuleOp = 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'neq';
export type RuleAction =
  | 'on' | 'off' | 'toggle' | 'on_for' | 'off_for'
  | 'set_brightness' | 'set_color' | 'set_temp' | 'set_effect';

// v11: action-step kinds. `wait` is a chain-only sentinel; not a top-level
// rule action. Used inside `Rule.actions[]` (multi-step chains).
export type RuleStepKind = RuleAction | 'wait';

export interface RuleActionStep {
  id?: number;
  rule_id?: number;
  position: number;
  kind: RuleStepKind;
  target_device_id: number | null;
  action_value: any;
  duration_seconds: number | null;
}

export type RuleCondSource = 'device' | 'http';

export interface RuleCondition {
  id?: number;
  rule_id?: number;
  position: number;
  combinator: 'AND' | 'OR' | null;
  source_type: RuleCondSource;
  device_id: number | null;
  metric: RuleMetric;
  operator: RuleOp;
  threshold: number;
  http_url?: string | null;
  http_method?: 'GET' | 'POST';
  http_json_path?: string | null;
  http_cache_seconds?: number;
}

export interface Rule {
  id: number;
  name: string;
  enabled: 0 | 1;
  trigger_type: RuleTrigger;
  target_device_id: number;
  action: RuleAction;
  action_value: any;
  duration_minutes: number | null;
  cooldown_minutes: number;
  priority: number;
  start_time: string | null;
  end_time: string | null;
  days_mask: number;
  last_fired_at: string | null;
  fire_count: number;
  conditions: RuleCondition[];
  // v11: ordered multi-step action chain. Empty = legacy single-action mode.
  actions?: RuleActionStep[];
}

export interface Dependency {
  id: number;
  name: string;
  enabled: 0 | 1;
  source_device_id: number;
  source_state: 0 | 1;
  target_device_id: number;
  required_state: 0 | 1;
}

export interface ScheduledTask {
  id: number;
  device_id: number;
  action: 'on' | 'off' | 'toggle';
  run_at: string;
  status: 'pending' | 'done' | 'failed' | 'cancelled';
  note: string | null;
  created_at: string;
  executed_at: string | null;
}

export const OP_LABEL: Record<RuleOp, string> = {
  lt: '<', lte: '≤', gt: '>', gte: '≥', eq: '=', neq: '≠'
};
// Values are i18n keys; consumers should wrap with `$t(...)` to render.
export const ACTION_LABEL: Record<RuleAction, string> = {
  on: 'action.on',
  off: 'action.off',
  toggle: 'action.toggle',
  on_for: 'action.on_for',
  off_for: 'action.off_for',
  set_brightness: 'action.set_brightness',
  set_color: 'action.set_color',
  set_temp: 'action.set_temp',
  set_effect: 'action.set_effect'
};
export const METRIC_LABEL: Record<RuleMetric, string> = {
  temperature: 'metric.temperature',
  humidity: 'metric.humidity',
  state: 'metric.state',
  battery: 'metric.battery',
  energy_w: 'metric.energy_w',
  motion: 'metric.motion',
  http_value: 'metric.http_value',
};

// Metrics where the user picks 0/1 instead of typing a number
export const BOOL_METRICS = new Set<RuleMetric>(['state', 'motion']);

export function isBoolMetric(m: RuleMetric | null | undefined): boolean {
  return !!m && BOOL_METRICS.has(m);
}

// Values are i18n keys (e.g. 'days.mon'); consumers wrap with `$t(...)`.
export const DAYS = ['days.mon', 'days.tue', 'days.wed', 'days.thu', 'days.fri', 'days.sat', 'days.sun'];

export function daysMaskToList(mask: number): boolean[] {
  return DAYS.map((_, i) => Boolean(mask & (1 << i)));
}
export function listToDaysMask(list: boolean[]): number {
  return list.reduce((a, b, i) => a | (b ? 1 << i : 0), 0);
}

// ---- HSV / HEX conversions for color picker ----

export function hsvToHex(h: number, s: number, v: number): string {
  const sat = s / 100, val = v / 100;
  const c = val * sat;
  const hh = (h % 360) / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hh < 1) [r, g, b] = [c, x, 0];
  else if (hh < 2) [r, g, b] = [x, c, 0];
  else if (hh < 3) [r, g, b] = [0, c, x];
  else if (hh < 4) [r, g, b] = [0, x, c];
  else if (hh < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = val - c;
  const to255 = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
  return `#${to255(r)}${to255(g)}${to255(b)}`;
}

export function hexToHsv(hex: string): [number, number, number] {
  const s = hex.replace('#', '');
  const r = parseInt(s.slice(0, 2), 16) / 255;
  const g = parseInt(s.slice(2, 4), 16) / 255;
  const b = parseInt(s.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  h = Math.round(h * 60);
  if (h < 0) h += 360;
  const sat = max === 0 ? 0 : Math.round((d / max) * 100);
  const val = Math.round(max * 100);
  return [h, sat, val];
}
