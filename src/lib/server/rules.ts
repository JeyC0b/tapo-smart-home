/**
 * Rule Engine v5 — N conditions, decimal thresholds, boolean metrics,
 * mixed AND/OR (left-to-right by `position`).
 * **HTTP zdroj** a **offline-skip**.
 *
 * KEY CHANGES vs v4:
 *  - When a condition cannot be evaluated (offline device / HTTP error),
 *    it is SKIPPED (as if it didn't exist). Other conditions can still
 *    fire the rule. The rule does not fire only when no condition was
 *    evaluated, OR when the resulting logic is false.
 *  - HTTP zdroj: condition.source_type='http' s URL, JSON pathem a cache.
 *    The value is parsed as a number and compared with the operator (gt/lt/eq…).
 *
 * Evaluation (after filtering out skipped conditions):
 *   acc = c1.value
 *   acc = acc <combinator2> c2.value
 *   acc = acc <combinator3> c3.value ...
 */

import { q, exec } from './db';
import { log } from './logger';
import { commandSetState, commandLight } from './poller';
import { scheduleIn } from './tasks';
import { getSetting } from './settings';

type Metric = 'temperature' | 'humidity' | 'state' | 'battery' | 'energy_w' | 'motion' | 'http_value';
type Op = 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'neq';
type ActionKind =
  | 'on' | 'off' | 'toggle'
  | 'on_for' | 'off_for'
  | 'set_brightness' | 'set_color' | 'set_temp' | 'set_effect';

interface DeviceRow {
  id: number; device_id: string; kind: string;
  online: number; excluded: number;
  temperature: number | null; humidity: number | null;
  state: 0 | 1 | null; battery: number | null;
  energy_w: number | null; motion: 0 | 1 | null;
  custom_name: string | null; tapo_alias: string | null;
}

interface RuleRow {
  id: number; name: string; enabled: number;
  trigger_type: 'sensor' | 'time' | 'device_state';
  target_device_id: number;
  action: ActionKind;
  action_value: any | string | null;
  duration_minutes: number | null;
  cooldown_minutes: number;
  priority: number;
  start_time: string | null; end_time: string | null; days_mask: number;
  last_fired_at: string | null; fire_count: number;
}

interface CondRow {
  id: number; rule_id: number; position: number;
  combinator: 'AND' | 'OR' | null;
  source_type: 'device' | 'http';
  device_id: number | null; metric: Metric; operator: Op; threshold: number;
  http_url: string | null; http_method: 'GET' | 'POST';
  http_json_path: string | null; http_cache_seconds: number;
}

// v11: rows from app_rule_actions. When a rule has at least one row here,
// it overrides the legacy single-action columns.
type ActionStepKind = ActionKind | 'wait';
interface ActionRow {
  id: number; rule_id: number; position: number;
  kind: ActionStepKind;
  target_device_id: number | null;
  action_value: any | string | null;
  duration_seconds: number | null;
}

interface DepRow {
  id: number; enabled: number; name: string;
  source_device_id: number; source_state: 0 | 1;
  target_device_id: number; required_state: 0 | 1;
}

const opEval: Record<Op, (a: number, b: number) => boolean> = {
  lt:  (a, b) => a <  b,
  lte: (a, b) => a <= b,
  gt:  (a, b) => a >  b,
  gte: (a, b) => a >= b,
  eq:  (a, b) => a === b,
  neq: (a, b) => a !== b,
};

function inTimeWindow(now: Date, r: Pick<RuleRow, 'start_time' | 'end_time' | 'days_mask'>): boolean {
  const jsDay = now.getDay();
  const idx = jsDay === 0 ? 6 : jsDay - 1;
  if (!((r.days_mask ?? 127) & (1 << idx))) return false;
  if (!r.start_time && !r.end_time) return true;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const toMin = (t: string | null) => {
    if (!t) return null;
    const [h, m] = t.split(':').map(Number);
    return h * 60 + (m || 0);
  };
  const s = toMin(r.start_time), e = toMin(r.end_time);
  if (s != null && e != null) {
    if (s === e) return true;
    if (s < e) return minutes >= s && minutes < e;
    return minutes >= s || minutes < e;
  }
  if (s != null) return minutes >= s;
  if (e != null) return minutes < e;
  return true;
}

function metricValue(d: DeviceRow, m: Metric): number | null {
  switch (m) {
    case 'temperature': return d.temperature == null ? null : Number(d.temperature);
    case 'humidity':    return d.humidity == null    ? null : Number(d.humidity);
    case 'state':       return d.state == null       ? null : Number(d.state);
    case 'battery':     return d.battery == null     ? null : Number(d.battery);
    case 'energy_w':    return d.energy_w == null    ? null : Number(d.energy_w);
    case 'motion':      return d.motion == null      ? null : Number(d.motion);
    case 'http_value':  return null;
  }
}

// ---------------- HTTP source with TTL cache ----------------
type CacheEntry = { value: number | null; at: number };
const httpCache = new Map<string, CacheEntry>();

function getJsonPath(obj: any, path: string | null): any {
  if (!path) return obj;
  const parts = path.split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return null;
    // support [n] index
    const m = /^([^\[]+)?(\[(\d+)\])?$/.exec(p);
    if (!m) return null;
    if (m[1]) cur = cur[m[1]];
    if (m[3] != null) cur = cur?.[Number(m[3])];
  }
  return cur;
}

async function fetchHttpValue(c: CondRow): Promise<number | null> {
  if (!c.http_url) return null;
  const now = Date.now();
  const ttlMs = Math.max(0, (c.http_cache_seconds ?? 60) * 1000);
  const key = `${c.http_method || 'GET'} ${c.http_url} :: ${c.http_json_path || ''}`;
  const hit = httpCache.get(key);
  if (hit && (now - hit.at) < ttlMs) {
    await log('debug', 'rules', `HTTP cond #${c.id} cache HIT (age ${Math.round((now-hit.at)/1000)}s) → ${hit.value}`);
    return hit.value;
  }
  await log('debug', 'rules', `HTTP cond #${c.id} fetch ${c.http_method || 'GET'} ${c.http_url}`);

  let value: number | null = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8_000);
    const r = await fetch(c.http_url, { method: c.http_method || 'GET', signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) {
      await log('warn', 'rules', `HTTP cond #${c.id}: ${r.status} ${c.http_url}`);
    } else {
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        const j = await r.json();
        const raw = getJsonPath(j, c.http_json_path);
        const n = Number(raw);
        value = Number.isFinite(n) ? n : null;
      } else {
        const txt = (await r.text()).trim();
        const n = Number(txt);
        value = Number.isFinite(n) ? n : null;
      }
    }
  } catch (e) {
    await log('warn', 'rules', `HTTP cond #${c.id} fetch failed`, { err: String(e), url: c.http_url });
  }
  httpCache.set(key, { value, at: now });
  return value;
}

async function condValue(byId: Map<number, DeviceRow>, c: CondRow): Promise<number | null> {
  if (c.source_type === 'http') return fetchHttpValue(c);
  // device source
  if (!c.device_id) return null;
  const s = byId.get(c.device_id);
  if (!s || !s.online) return null;            // offline → skip
  return metricValue(s, c.metric);
}

async function condEval(byId: Map<number, DeviceRow>, c: CondRow): Promise<boolean | null> {
  const v = await condValue(byId, c);
  if (v == null) return null;
  return opEval[c.operator](v, Number(c.threshold));
}

/**
 * Evaluate N conditions left-to-right. Skip conditions that cannot be
 * evaluated (offline/HTTP fail). Returns:
 *   null  — no condition was evaluated (completely empty)
 *   true  — the combined ANDed/ORed result of valid conditions is satisfied
 *   false — valid conditions existed but are not satisfied
 */
async function evalConditions(byId: Map<number, DeviceRow>, conds: CondRow[]): Promise<boolean | null> {
  if (!conds.length) return null;
  const sorted = [...conds].sort((a, b) => a.position - b.position);

  // Resolve per-cond bool|null in document order
  const resolved: { cond: CondRow; v: boolean | null }[] = [];
  for (const c of sorted) {
    resolved.push({ cond: c, v: await condEval(byId, c) });
  }
  // Filter out skipped (null), preserving order
  const valid = resolved.filter(x => x.v !== null) as { cond: CondRow; v: boolean }[];
  if (!valid.length) return null;

  // First valid cond ignores its combinator (it becomes the seed).
  let acc: boolean = valid[0].v;
  for (let i = 1; i < valid.length; i++) {
    const cmb = valid[i].cond.combinator || 'AND';
    acc = cmb === 'AND' ? (acc && valid[i].v) : (acc || valid[i].v);
  }
  return acc;
}

function parseActionValue(av: any): Record<string, any> {
  if (!av) return {};
  if (typeof av === 'string') {
    try { return JSON.parse(av) || {}; } catch { return {}; }
  }
  return av;
}

function withinCooldown(r: RuleRow, now: Date): boolean {
  if (!r.cooldown_minutes || !r.last_fired_at) return false;
  const last = new Date(r.last_fired_at).getTime();
  return now.getTime() - last < r.cooldown_minutes * 60_000;
}

const TOGGLE_KINDS: ReadonlySet<ActionKind> = new Set(['on', 'off', 'toggle', 'on_for', 'off_for']);

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// Rules whose (detached) multi-step chain is still running. Prevents a new tick
// from launching a second overlapping chain when the chain's waits outlast the
// rule cooldown (which would interleave/contradict device commands).
const runningChains = new Set<number>();

/**
 * Run a chain of actions sequentially in a detached async context.
 * Errors in individual steps are logged but do NOT abort the chain.
 * `wait` steps pause in-process — fine for minute-scale chains, but they
 * are NOT persisted across server restarts. For long pauses prefer
 * scheduling via the timers system instead.
 */
async function runActionSequence(rule: RuleRow, steps: ActionRow[]): Promise<void> {
  const sorted = [...steps].sort((a, b) => a.position - b.position);
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    try {
      if (s.kind === 'wait') {
        const sec = Math.max(0, Number(s.duration_seconds || 0));
        await log('info', 'rules', `#${rule.id} ${rule.name}: wait ${sec}s (step ${i+1}/${sorted.length})`);
        await sleep(sec * 1000);
        continue;
      }
      const tid = Number(s.target_device_id);
      if (!tid) { await log('warn', 'rules', `#${rule.id} step ${i+1}: missing target`); continue; }
      // Re-read the device on every step so toggles use the freshest state.
      const rows = await q<DeviceRow>('SELECT * FROM app_devices WHERE id = ? LIMIT 1', [tid]);
      const dev = rows[0];
      if (!dev) { await log('warn', 'rules', `#${rule.id} step ${i+1}: device ${tid} not found`); continue; }
      if (dev.excluded || !dev.online) {
        await log('warn', 'rules', `#${rule.id} step ${i+1}: ${nameOf(dev)} offline/excluded — skip`);
        continue;
      }
      const av = parseActionValue(s.action_value);
      switch (s.kind) {
        case 'on':     await commandSetState(tid, true);  break;
        case 'off':    await commandSetState(tid, false); break;
        case 'toggle': await commandSetState(tid, dev.state !== 1); break;
        case 'on_for': {
          await commandSetState(tid, true);
          const sec = Math.max(1, Number(s.duration_seconds || 0));
          if (sec > 0) await scheduleIn(tid, sec, 'off', `auto-revert (rule #${rule.id} step ${i+1})`);
          break;
        }
        case 'off_for': {
          await commandSetState(tid, false);
          const sec = Math.max(1, Number(s.duration_seconds || 0));
          if (sec > 0) await scheduleIn(tid, sec, 'on', `auto-revert (rule #${rule.id} step ${i+1})`);
          break;
        }
        case 'set_brightness': await commandLight(tid, { brightness: Number(av.brightness) }); break;
        case 'set_color':      await commandLight(tid, { hsv: av.hsv as [number, number, number] }); break;
        case 'set_temp':       await commandLight(tid, { color_temp: Number(av.color_temp) }); break;
        case 'set_effect':     await commandLight(tid, { effect: String(av.effect) }); break;
      }
      await log('info', 'rules', `#${rule.id} step ${i+1}/${sorted.length}: ${nameOf(dev)} ${s.kind}`, { rule: rule.id });
    } catch (e) {
      await log('error', 'rules', `#${rule.id} step ${i+1} failed`, { err: String(e), kind: s.kind });
    }
  }
}

export async function evaluateRules(): Promise<void> {
  if ((await getSetting('rules_enabled', '1')) !== '1') return;

  const t0 = Date.now();
  const now = new Date();
  const devices = await q<DeviceRow>('SELECT * FROM app_devices');
  const byId = new Map<number, DeviceRow>(devices.map(d => [d.id, d]));

  const rules = await q<RuleRow>(
    'SELECT * FROM app_rules WHERE enabled = 1 ORDER BY priority DESC, id'
  );
  await log('debug', 'rules', `eval start (${rules.length} active rules)`);
  const allConds = await q<CondRow>('SELECT * FROM app_rule_conditions');
  const condsByRule = new Map<number, CondRow[]>();
  for (const c of allConds) {
    const arr = condsByRule.get(c.rule_id) || [];
    arr.push(c);
    condsByRule.set(c.rule_id, arr);
  }
  // v11: load multi-step action chains (overrides legacy single action when present).
  const allActs = await q<ActionRow>('SELECT * FROM app_rule_actions');
  const actsByRule = new Map<number, ActionRow[]>();
  for (const a of allActs) {
    const arr = actsByRule.get(a.rule_id) || [];
    arr.push(a);
    actsByRule.set(a.rule_id, arr);
  }
  const deps = await q<DepRow>('SELECT * FROM app_dependencies WHERE enabled = 1 ORDER BY id');

  const toggleVotes = new Map<number, {
    desired: 0 | 1; rule?: RuleRow; reasons: string[]; duration?: number;
  }>();
  const directActions: { rule: RuleRow; target: DeviceRow }[] = [];

  for (const r of rules) {
    if (!inTimeWindow(now, r)) continue;
    if (withinCooldown(r, now)) continue;

    let condResult: boolean | null = true;
    if (r.trigger_type !== 'time') {
      condResult = await evalConditions(byId, condsByRule.get(r.id) || []);
    }
    await log('debug', 'rules', `#${r.id} ${r.name}: cond=${condResult}`);
    if (condResult !== true) continue;

    // ---- v11: prefer multi-step action chain when present.
    const chain = actsByRule.get(r.id);
    if (chain && chain.length) {
      // Single-flight: never start a second chain for a rule whose previous
      // chain (possibly mid-`wait`) is still running.
      if (runningChains.has(r.id)) continue;
      runningChains.add(r.id);
      // Mark fired now (cooldown applies during the chain run).
      try {
        await exec(
          'UPDATE app_rules SET last_fired_at = NOW(), fire_count = fire_count + 1 WHERE id = ?',
          [r.id]
        );
      } catch (e) {
        await log('error', 'rules', `mark fired failed #${r.id}`, { err: String(e) });
      }
      // Detach so a long `wait` doesn't block other rules in this tick.
      void runActionSequence(r, chain)
        .catch(async (e) => {
          await log('error', 'rules', `chain crashed #${r.id}`, { err: String(e) });
        })
        .finally(() => { runningChains.delete(r.id); });
      continue;
    }

    // ---- legacy single-action path (back-compat) ----
    const tgt = byId.get(r.target_device_id);
    if (!tgt || !tgt.online || tgt.excluded) continue;

    if (TOGGLE_KINDS.has(r.action)) {
      let desired: 0 | 1 = 0;
      let dur: number | undefined;
      if (r.action === 'on' || r.action === 'on_for') desired = 1;
      else if (r.action === 'off' || r.action === 'off_for') desired = 0;
      else if (r.action === 'toggle') desired = tgt.state === 1 ? 0 : 1;
      if (r.action === 'on_for' || r.action === 'off_for') dur = r.duration_minutes ?? undefined;

      const cur = toggleVotes.get(r.target_device_id);
      if (!cur) {
        toggleVotes.set(r.target_device_id, {
          desired, rule: r, reasons: [`#${r.id} ${r.name}`], duration: dur
        });
      } else {
        if (desired === 1 && cur.desired === 0) {
          cur.desired = 1; cur.rule = r; cur.duration = dur;
        }
        cur.reasons.push(`#${r.id} ${r.name}`);
      }
    } else {
      directActions.push({ rule: r, target: tgt });
    }
  }

  for (const d of deps) {
    const src = byId.get(d.source_device_id);
    if (!src || !src.online || src.state == null) continue;
    if (src.state !== d.source_state) continue;
    // Dependencies are authoritative: they FORCE the target into required_state,
    // overriding rule votes (e.g. safety interlocks). But preserve any existing
    // vote entry so the rule that also targeted this device keeps its
    // last_fired/cooldown bookkeeping, and append the reason instead of dropping it.
    const cur = toggleVotes.get(d.target_device_id);
    if (cur) {
      cur.desired = d.required_state;
      cur.duration = undefined; // a forced dependency has no auto-revert window
      cur.reasons.push(`dep #${d.id} ${d.name}`);
    } else {
      toggleVotes.set(d.target_device_id, {
        desired: d.required_state,
        reasons: [`dep #${d.id} ${d.name}`],
      });
    }
  }

  for (const [tid, v] of toggleVotes) {
    const dev = byId.get(tid);
    if (!dev || dev.state === v.desired) continue;
    try {
      await commandSetState(tid, v.desired === 1);
      await log('info', 'rules',
        `${nameOf(dev)} → ${v.desired ? 'ON' : 'OFF'}`,
        { reason: v.reasons.join(' | ') }
      );
      if (v.duration && v.duration > 0) {
        const reverseAction: 'on' | 'off' = v.desired === 1 ? 'off' : 'on';
        await scheduleIn(tid, v.duration * 60, reverseAction,
          `auto-revert from rule (${v.duration} min)`);
      }
      if (v.rule) {
        await exec(
          'UPDATE app_rules SET last_fired_at = NOW(), fire_count = fire_count + 1 WHERE id = ?',
          [v.rule.id]
        );
      }
    } catch (e) {
      await log('error', 'rules', `toggle failed ${nameOf(dev)}`, { err: String(e), reason: v.reasons.join(' | ') });
    }
  }

  for (const { rule, target } of directActions) {
    try {
      const av = parseActionValue(rule.action_value);
      switch (rule.action) {
        case 'set_brightness':
          await commandLight(target.id, { brightness: Number(av.brightness) });
          break;
        case 'set_color':
          await commandLight(target.id, { hsv: av.hsv as [number, number, number] });
          break;
        case 'set_temp':
          await commandLight(target.id, { color_temp: Number(av.color_temp) });
          break;
        case 'set_effect':
          await commandLight(target.id, { effect: String(av.effect) });
          break;
      }
      await exec(
        'UPDATE app_rules SET last_fired_at = NOW(), fire_count = fire_count + 1 WHERE id = ?',
        [rule.id]
      );
      await log('info', 'rules', `${nameOf(target)} ${rule.action}`, { rule: rule.id, value: av });
    } catch (e) {
      await log('error', 'rules', `${rule.action} failed ${nameOf(target)}`, { err: String(e), rule: rule.id });
    }
  }
  await log('debug', 'rules', `eval done v ${Date.now() - t0} ms`);
}

function nameOf(d: { custom_name: string | null; tapo_alias: string | null; device_id: string }) {
  return d.custom_name || d.tapo_alias || d.device_id;
}
