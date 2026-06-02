import { json, error } from '@sveltejs/kit';
import { q, exec } from '$lib/server/db';
import { validateConditions, insertConditions, validateActions, insertActions } from '$lib/server/rule_validation';

export async function GET() {
  const rules = await q<any>('SELECT * FROM app_rules ORDER BY priority DESC, id');
  const conds = await q<any>('SELECT * FROM app_rule_conditions ORDER BY rule_id, position');
  const acts  = await q<any>('SELECT * FROM app_rule_actions    ORDER BY rule_id, position');
  const condByRule = new Map<number, any[]>();
  const actByRule  = new Map<number, any[]>();
  for (const c of conds) {
    const arr = condByRule.get(c.rule_id) || [];
    arr.push(c);
    condByRule.set(c.rule_id, arr);
  }
  for (const a of acts) {
    // mysql2 may hand JSON back as a string; normalize to object/null.
    if (a.action_value && typeof a.action_value === 'string') {
      try { a.action_value = JSON.parse(a.action_value); } catch { a.action_value = null; }
    }
    const arr = actByRule.get(a.rule_id) || [];
    arr.push(a);
    actByRule.set(a.rule_id, arr);
  }
  return json(rules.map(r => ({
    ...r,
    conditions: condByRule.get(r.id) || [],
    actions:    actByRule.get(r.id) || []
  })));
}

const NUM_OR_NULL = (v: any) => (v === '' || v == null ? null : Number(v));
const STR_OR_NULL = (v: any) => (v === '' || v == null ? null : String(v));

export async function POST({ request }) {
  const b = await request.json().catch(() => ({}));
  if (!b.name) throw error(400, 'name required');

  const trigger = b.trigger_type || 'sensor';
  const conditions: any[] = Array.isArray(b.conditions) ? b.conditions : [];
  const actions:    any[] = Array.isArray(b.actions)    ? b.actions    : [];

  if (trigger === 'sensor' || trigger === 'device_state') {
    if (conditions.length === 0)
      throw error(400, 'at least one condition required for trigger ' + trigger);
  }
  validateConditions(conditions);
  validateActions(actions);

  // Either the modern actions list, OR the legacy single-action fields.
  // We always keep the legacy columns populated too (as a 1:1 mirror of the
  // first non-wait action), so existing read paths and reports keep working.
  let firstTarget: number | null = null;
  let firstAction: string | null = null;
  let firstAv: any = null;
  let firstDurMin: number | null = null;
  if (actions.length) {
    const first = actions.find((a: any) => a.kind !== 'wait');
    if (!first) throw error(400, 'rule must contain at least one non-wait action');
    firstTarget  = Number(first.target_device_id);
    firstAction  = String(first.kind);
    firstAv      = first.action_value || null;
    firstDurMin  = (first.kind === 'on_for' || first.kind === 'off_for') && first.duration_seconds
                     ? Math.max(1, Math.round(Number(first.duration_seconds) / 60)) : null;
  } else {
    if (!b.target_device_id) throw error(400, 'target_device_id (or actions[]) required');
    if (!b.action) throw error(400, 'action (or actions[]) required');
    firstTarget = Number(b.target_device_id);
    firstAction = String(b.action);
    firstAv     = b.action_value ?? null;
    firstDurMin = NUM_OR_NULL(b.duration_minutes);
  }
  const av = firstAv == null ? null : (typeof firstAv === 'string' ? firstAv : JSON.stringify(firstAv));

  const r = await exec(
    `INSERT INTO app_rules
       (name, enabled, trigger_type,
        target_device_id, action, action_value, duration_minutes, cooldown_minutes,
        priority, start_time, end_time, days_mask)
     VALUES (?,1,?,?,?,?,?,?,?,?,?,?)`,
    [
      b.name, trigger,
      firstTarget, firstAction, av,
      firstDurMin, Number(b.cooldown_minutes ?? 0),
      Number(b.priority ?? 0),
      STR_OR_NULL(b.start_time), STR_OR_NULL(b.end_time),
      Number(b.days_mask ?? 127)
    ]
  );
  const ruleId = (r as any).insertId;
  await insertConditions(ruleId, conditions);
  await insertActions(ruleId, actions);
  return json({ id: ruleId });
}
