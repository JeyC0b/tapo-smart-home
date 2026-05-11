import { q } from '$lib/server/db';
import type { Device, Rule, Dependency, RuleCondition, RuleActionStep } from '$lib/types';

export async function load() {
  const devices = await q<Device>(
    `SELECT * FROM app_devices
       WHERE kind IN ('sensor','motion','contact','leak','switch','plug','bulb','fan','strip','button')
       ORDER BY kind, COALESCE(custom_name, tapo_alias, device_id)`
  );
  const rules = await q<Rule>('SELECT * FROM app_rules ORDER BY priority DESC, id');
  const conditions = await q<RuleCondition & { rule_id: number }>(
    'SELECT * FROM app_rule_conditions ORDER BY rule_id, position'
  );
  const condsByRule = new Map<number, RuleCondition[]>();
  for (const c of conditions) {
    const arr = condsByRule.get(c.rule_id) ?? [];
    arr.push(c);
    condsByRule.set(c.rule_id, arr);
  }

  // v11: load multi-step action chains; mysql2 returns JSON columns as
  // strings on some configs, so normalise to objects up front.
  const actionRows = await q<RuleActionStep & { rule_id: number }>(
    'SELECT * FROM app_rule_actions ORDER BY rule_id, position'
  );
  const actsByRule = new Map<number, RuleActionStep[]>();
  for (const a of actionRows) {
    if (a.action_value && typeof a.action_value === 'string') {
      try { a.action_value = JSON.parse(a.action_value); } catch { a.action_value = null; }
    }
    const arr = actsByRule.get(a.rule_id) ?? [];
    arr.push(a);
    actsByRule.set(a.rule_id, arr);
  }

  const rulesWithConds = rules.map(r => ({
    ...r,
    conditions: condsByRule.get(r.id) ?? [],
    actions:    actsByRule.get(r.id)  ?? []
  }));
  const deps = await q<Dependency>('SELECT * FROM app_dependencies ORDER BY id');
  return { devices, rules: rulesWithConds, deps };
}
