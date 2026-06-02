import { json, error } from '@sveltejs/kit';
import { exec } from '$lib/server/db';
import {
  validateConditions, insertConditions,
  validateActions, insertActions
} from '$lib/server/rule_validation';

const ALLOWED = new Set([
  'name', 'enabled', 'trigger_type',
  'target_device_id', 'action', 'action_value', 'duration_minutes', 'cooldown_minutes',
  'priority', 'start_time', 'end_time', 'days_mask'
]);

export async function PATCH({ params, request }) {
  const id = Number(params.id);
  const b = await request.json().catch(() => ({}));

  const fields: string[] = []; const vals: any[] = [];
  for (const [k, v] of Object.entries(b)) {
    if (!ALLOWED.has(k)) continue;
    fields.push(`${k} = ?`);
    if (k === 'action_value') vals.push(v == null ? null : (typeof v === 'string' ? v : JSON.stringify(v)));
    else vals.push(v === '' ? null : v);
  }

  // If a fresh actions[] is provided, also mirror its first non-wait action
  // into the legacy app_rules.* columns (kept in sync for back-compat).
  if (Array.isArray(b.actions) && b.actions.length) {
    const first = b.actions.find((a: any) => a?.kind && a.kind !== 'wait');
    if (first) {
      const av = first.action_value == null
        ? null
        : (typeof first.action_value === 'string'
            ? first.action_value
            : JSON.stringify(first.action_value));
      const dur = (first.kind === 'on_for' || first.kind === 'off_for') && first.duration_seconds
        ? Math.max(1, Math.round(Number(first.duration_seconds) / 60))
        : null;
      const map: Record<string, any> = {
        target_device_id: Number(first.target_device_id),
        action: String(first.kind),
        action_value: av,
        duration_minutes: dur
      };
      for (const [k, v] of Object.entries(map)) {
        // Only add keys that aren't already set by the caller, to avoid double-set.
        if (!(k in b)) { fields.push(`${k} = ?`); vals.push(v); }
      }
    }
  }

  if (fields.length) {
    vals.push(id);
    await exec(`UPDATE app_rules SET ${fields.join(', ')} WHERE id = ?`, vals);
  }

  if (Array.isArray(b.conditions)) {
    validateConditions(b.conditions);
    await exec('DELETE FROM app_rule_conditions WHERE rule_id = ?', [id]);
    await insertConditions(id, b.conditions);
  }
  if (Array.isArray(b.actions)) {
    validateActions(b.actions);
    await exec('DELETE FROM app_rule_actions WHERE rule_id = ?', [id]);
    await insertActions(id, b.actions);
  }

  if (!fields.length && !Array.isArray(b.conditions) && !Array.isArray(b.actions))
    throw error(400, 'no fields');
  return json({ ok: true });
}

export async function DELETE({ params }) {
  await exec('DELETE FROM app_rules WHERE id = ?', [Number(params.id)]);
  return json({ ok: true });
}
