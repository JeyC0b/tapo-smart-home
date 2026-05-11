import { error } from '@sveltejs/kit';
import { exec } from './db';

export const VALID_METRICS = new Set([
  'temperature','humidity','state','battery','energy_w','motion','http_value'
]);
export const VALID_OPS     = new Set(['lt','lte','gt','gte','eq','neq']);
export const VALID_SOURCES = new Set(['device','http']);
export const VALID_HTTP_METHODS = new Set(['GET','POST']);

// All action kinds + 'wait' for multi-step rule chains.
export const VALID_ACTION_KINDS = new Set([
  'on','off','toggle','on_for','off_for',
  'set_brightness','set_color','set_temp','set_effect',
  'wait'
]);

const STR_OR_NULL = (v: any) => (v === '' || v == null ? null : String(v));

export function validateConditions(conditions: any[]): void {
  for (let i = 0; i < conditions.length; i++) {
    const c = conditions[i];
    const src = c.source_type || 'device';
    if (!VALID_SOURCES.has(src)) throw error(400, `cond #${i+1}: invalid source_type`);
    if (!VALID_METRICS.has(c.metric)) throw error(400, `cond #${i+1}: invalid metric`);
    if (!VALID_OPS.has(c.operator))   throw error(400, `cond #${i+1}: invalid operator`);
    if (c.threshold == null || isNaN(Number(c.threshold)))
      throw error(400, `cond #${i+1}: threshold required`);
    if (i > 0 && !['AND','OR'].includes(c.combinator))
      throw error(400, `cond #${i+1}: combinator (AND/OR) required`);
    if (src === 'device') {
      if (!c.device_id) throw error(400, `cond #${i+1}: device_id required for device source`);
    } else {
      if (!c.http_url || typeof c.http_url !== 'string')
        throw error(400, `cond #${i+1}: http_url required`);
      try { new URL(c.http_url); } catch { throw error(400, `cond #${i+1}: http_url must be valid URL`); }
      if (c.http_method && !VALID_HTTP_METHODS.has(c.http_method))
        throw error(400, `cond #${i+1}: http_method must be GET/POST`);
    }
  }
}

export async function insertConditions(ruleId: number, conditions: any[]): Promise<void> {
  for (let i = 0; i < conditions.length; i++) {
    const c = conditions[i];
    const src = c.source_type || 'device';
    await exec(
      `INSERT INTO app_rule_conditions
         (rule_id, position, combinator, source_type, device_id,
          metric, operator, threshold,
          http_url, http_method, http_json_path, http_cache_seconds)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        ruleId, i,
        i === 0 ? null : (c.combinator || 'AND'),
        src,
        src === 'device' ? Number(c.device_id) : null,
        String(c.metric), String(c.operator), Number(c.threshold),
        src === 'http' ? String(c.http_url) : null,
        src === 'http' ? (c.http_method || 'GET') : 'GET',
        src === 'http' ? STR_OR_NULL(c.http_json_path) : null,
        src === 'http' ? Number(c.http_cache_seconds ?? 60) : 60,
      ]
    );
  }
}

// ---------------- Multi-step actions (v11) ----------------
export function validateActions(actions: any[]): void {
  if (!Array.isArray(actions) || !actions.length) return;
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    const kind = String(a?.kind || '');
    if (!VALID_ACTION_KINDS.has(kind))
      throw error(400, `action #${i+1}: invalid kind`);
    if (kind === 'wait') {
      const s = Number(a.duration_seconds);
      if (!Number.isFinite(s) || s <= 0)
        throw error(400, `action #${i+1}: wait needs duration_seconds > 0`);
      continue;
    }
    if (!a.target_device_id)
      throw error(400, `action #${i+1}: target_device_id required`);
    if (kind === 'on_for' || kind === 'off_for') {
      const s = Number(a.duration_seconds);
      if (!Number.isFinite(s) || s <= 0)
        throw error(400, `action #${i+1}: ${kind} needs duration_seconds > 0`);
    }
  }
}

export async function insertActions(ruleId: number, actions: any[]): Promise<void> {
  if (!Array.isArray(actions) || !actions.length) return;
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    const kind = String(a.kind);
    const av = (a.action_value && typeof a.action_value === 'object')
      ? JSON.stringify(a.action_value) : null;
    await exec(
      `INSERT INTO app_rule_actions
         (rule_id, position, kind, target_device_id, action_value, duration_seconds)
       VALUES (?,?,?,?,?,?)`,
      [
        ruleId, i, kind,
        kind === 'wait' ? null : Number(a.target_device_id),
        av,
        a.duration_seconds == null ? null : Number(a.duration_seconds)
      ]
    );
  }
}
