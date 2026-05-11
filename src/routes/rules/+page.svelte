<script lang="ts">
  import type { Device, Rule, Dependency, RuleAction, RuleMetric, RuleOp, RuleTrigger, RuleCondition, RuleCondSource, RuleActionStep } from '$lib/types';
  import { OP_LABEL, ACTION_LABEL, METRIC_LABEL, DAYS, listToDaysMask, hexToHsv, hsvToHex, isBoolMetric } from '$lib/types';
  import { invalidateAll } from '$app/navigation';
  import Icon from '$lib/ui/Icon.svelte';
  import { t, tr } from '$lib/i18n';

  let { data }: { data: { devices: Device[]; rules: Rule[]; deps: Dependency[] } } = $props();

  const SENSOR_KINDS: string[] = ['sensor','motion','contact','leak'];
  const TARGET_KINDS: string[] = ['switch','plug','bulb','fan','strip'];
  // Devices that can serve as a *source* for a rule condition. Sensors
  // expose temperature/humidity/etc.; switches/plugs/bulbs/etc. expose at
  // least their on/off `state` (and possibly energy_w). All of them are
  // valid choices in the condition device picker.
  const COND_SOURCE_KINDS: string[] = [
    'sensor','motion','contact','leak',
    'switch','plug','bulb','fan','strip'
  ];

  const sensors = $derived(data.devices.filter(d => SENSOR_KINDS.includes(d.kind)));
  const targets = $derived(data.devices.filter(d => TARGET_KINDS.includes(d.kind)));
  const condSources = $derived(data.devices.filter(d => COND_SOURCE_KINDS.includes(d.kind)));
  const allRefs = $derived(data.devices);

  // Which metrics make sense for a given device. Sensor kinds keep their
  // historical behaviour; controllable kinds (switch/plug/bulb/...) only
  // expose `state` plus, when the device reports power, `energy_w`.
  function metricsForDevice(d: Device | null | undefined): RuleMetric[] {
    if (!d) return ['temperature','humidity','state','battery','energy_w','motion'];
    switch (d.kind) {
      case 'sensor':  return ['temperature','humidity','battery'];
      case 'motion':  return ['motion','battery'];
      case 'contact': return ['state','battery'];
      case 'leak':    return ['state','battery'];
      case 'switch':
      case 'plug':
      case 'fan':
      case 'strip':
      case 'bulb': {
        const out: RuleMetric[] = ['state'];
        if (d.capabilities?.energy) out.push('energy_w');
        return out;
      }
      default: return ['state'];
    }
  }

  function dname(id: number | null | undefined) {
    if (!id) return '—';
    const d = data.devices.find(x => x.id === id);
    return d ? (d.custom_name || d.tapo_alias || d.device_id) : `#${id}`;
  }
  function findDevice(id: number | null | undefined) {
    return id ? data.devices.find(d => d.id === id) : null;
  }

  // ---------- New rule form ----------
  type FormCond = {
    combinator: 'AND' | 'OR';   // ignored on i=0
    source_type: RuleCondSource;
    device_id: number | '';
    metric: RuleMetric;
    operator: RuleOp;
    threshold: number;
    bool_value: 0 | 1;          // for bool metrics (state/motion)
    http_url: string;
    http_method: 'GET' | 'POST';
    http_json_path: string;
    http_cache_seconds: number;
  };

  // v11: multi-step actions per rule. `wait` is a sentinel kind that pauses
  // the chain in-process (not persisted across server restarts).
  type ActionStepKind = RuleAction | 'wait';
  type FormAction = {
    kind: ActionStepKind;
    target_device_id: number | '';
    duration_minutes: number;     // for on_for/off_for
    wait_minutes: number;         // for wait
    wait_seconds: number;         // for wait (additive to wait_minutes)
    av_brightness: number;
    av_color_hex: string;
    av_temp: number;
    av_effect: string;
  };

  // Labels for the action-kind selector. Values are i18n keys; render with $t.
  const ACTION_KIND_LABEL: Record<ActionStepKind, string> = {
    ...ACTION_LABEL,
    wait: 'rules.wait'
  } as Record<ActionStepKind, string>;

  const blankAction = (): FormAction => ({
    kind: 'on',
    target_device_id: '',
    duration_minutes: 30,
    wait_minutes: 3,
    wait_seconds: 0,
    av_brightness: 80,
    av_color_hex: '#ff8800',
    av_temp: 4000,
    av_effect: ''
  });

  const blankCond = (): FormCond => ({
    combinator: 'AND', source_type: 'device', device_id: '', metric: 'temperature',
    operator: 'lt', threshold: 22, bool_value: 1,
    http_url: '', http_method: 'GET', http_json_path: '', http_cache_seconds: 60
  });

  const blank = () => ({
    name: '',
    enabled: true,
    trigger_type: 'sensor' as RuleTrigger,
    conditions: [blankCond()] as FormCond[],
    actions: [blankAction()] as FormAction[],
    cooldown_minutes: 5,
    priority: 0,
    use_window: false,
    start_time: '20:00',
    end_time: '23:00',
    days: [true,true,true,true,true,true,true]
  });
  let f = $state(blank());
  let editingId = $state<number | null>(null);

  /**
 * Loads the state of an existing rule into the form and switches to edit mode.
 * Conservative mapping: when DB contains an unexpected key, the default is kept.
   */
  function startEdit(r: Rule) {
    const b = blank();

    // Time window
    const useWin = !!(r.start_time && r.end_time);
    const days = [false,false,false,false,false,false,false];
    const mask = (r.days_mask ?? 127) & 127;
    for (let i = 0; i < 7; i++) days[i] = (mask & (1 << i)) !== 0;

    // Conditions -> FormCond[]
    const sortedConds = [...(r.conditions || [])].sort((a, b2) => a.position - b2.position);
    const formConds: FormCond[] = sortedConds.map((c, idx): FormCond => {
      if (c.source_type === 'http') {
        return {
          combinator: (c.combinator as 'AND' | 'OR') || 'AND',
          source_type: 'http',
          device_id: '',
          metric: 'http_value' as RuleMetric,
          operator: c.operator,
          threshold: Number(c.threshold),
          bool_value: 1,
          http_url: c.http_url || '',
          http_method: (c.http_method as 'GET' | 'POST') || 'GET',
          http_json_path: c.http_json_path || '',
          http_cache_seconds: Number(c.http_cache_seconds) || 60
        };
      }
      const isBool = isBoolMetric(c.metric);
      return {
        combinator: (c.combinator as 'AND' | 'OR') || 'AND',
        source_type: 'device',
        device_id: c.device_id ?? '',
        metric: c.metric,
        operator: c.operator,
        threshold: isBool ? 0 : Number(c.threshold),
        bool_value: isBool ? (Number(c.threshold) === 1 ? 1 : 0) : 1,
        http_url: '',
        http_method: 'GET',
        http_json_path: '',
        http_cache_seconds: 60
      };
    });

    // Actions: prefer multi-step `r.actions[]` (v11). Fall back to legacy
    // single action stored on the rule row when chain is empty.
    let formActions: FormAction[] = [];
    const chain = [...(r.actions || [])].sort((a, b2) => a.position - b2.position);
    if (chain.length) {
      formActions = chain.map((s) => stepToForm(s));
    } else {
      // Legacy single action -> 1-step chain.
      const legacy = blankAction();
      legacy.kind = r.action;
      legacy.target_device_id = r.target_device_id;
      if (r.duration_minutes) legacy.duration_minutes = r.duration_minutes;
      let av: any = null;
      try { av = typeof r.action_value === 'string' ? JSON.parse(r.action_value) : (r.action_value || null); } catch {}
      if (av) {
        if (av.brightness != null) legacy.av_brightness = Number(av.brightness);
        if (av.color_temp != null) legacy.av_temp = Number(av.color_temp);
        if (av.effect != null) legacy.av_effect = String(av.effect);
        if (av.hsv && Array.isArray(av.hsv) && av.hsv.length === 3) {
          const [h, s, v] = av.hsv;
          try { legacy.av_color_hex = hsvToHex(Number(h), Number(s), Number(v)); } catch {}
          legacy.av_brightness = Number(v);
        }
      }
      formActions = [legacy];
    }

    f = {
      ...b,
      name: r.name,
      enabled: !!r.enabled,
      trigger_type: r.trigger_type,
      conditions: formConds.length ? formConds : [blankCond()],
      actions: formActions.length ? formActions : [blankAction()],
      cooldown_minutes: r.cooldown_minutes ?? 0,
      priority: r.priority ?? 0,
      use_window: useWin,
      start_time: r.start_time || '20:00',
      end_time: r.end_time || '23:00',
      days
    };
    editingId = r.id;
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Convert a server-side action step row to the form-side shape.
  function stepToForm(s: RuleActionStep): FormAction {
    const fa = blankAction();
    fa.kind = s.kind;
    if (s.kind === 'wait') {
      const total = Math.max(0, Number(s.duration_seconds || 0));
      fa.wait_minutes = Math.floor(total / 60);
      fa.wait_seconds = total % 60;
      return fa;
    }
    fa.target_device_id = s.target_device_id ?? '';
    if (s.kind === 'on_for' || s.kind === 'off_for') {
      const sec = Math.max(0, Number(s.duration_seconds || 0));
      fa.duration_minutes = Math.max(1, Math.round(sec / 60));
    }
    let av: any = null;
    try { av = typeof s.action_value === 'string' ? JSON.parse(s.action_value) : (s.action_value || null); } catch {}
    if (av) {
      if (av.brightness != null) fa.av_brightness = Number(av.brightness);
      if (av.color_temp != null) fa.av_temp = Number(av.color_temp);
      if (av.effect != null) fa.av_effect = String(av.effect);
      if (av.hsv && Array.isArray(av.hsv) && av.hsv.length === 3) {
        const [h, sa, v] = av.hsv;
        try { fa.av_color_hex = hsvToHex(Number(h), Number(sa), Number(v)); } catch {}
        fa.av_brightness = Number(v);
      }
    }
    return fa;
  }

  function cancelEdit() {
    editingId = null;
    f = blank();
  }

  function addCond() {
    f.conditions = [...f.conditions, blankCond()];
  }

  // Called from the device <select>'s on:change. If the freshly-picked
  // device cannot expose the currently-selected metric, fall back to the
  // first valid metric for that device — otherwise the user would be
  // silently writing impossible conditions (e.g. `temperature` on a plug).
  function onCondDeviceChange(c: FormCond) {
    const dev = findDevice(Number(c.device_id));
    const allowed = metricsForDevice(dev);
    if (!allowed.includes(c.metric)) {
      c.metric = allowed[0];
      // Reset numeric threshold to a sane default when switching domains.
      if (isBoolMetric(c.metric)) c.bool_value = 1;
      else c.threshold = 0;
    }
    f.conditions = f.conditions; // trigger reactivity for nested mutation
  }
  function removeCond(i: number) {
    f.conditions = f.conditions.filter((_, idx) => idx !== i);
    if (f.conditions.length === 0) f.conditions = [blankCond()];
  }
  function moveCond(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= f.conditions.length) return;
    const arr = [...f.conditions];
    [arr[i], arr[j]] = [arr[j], arr[i]];
    f.conditions = arr;
  }

  // ---- Action chain helpers (mirror of conditions UX) ----
  function addAction() {
    if (f.actions.length >= 20) { alert(tr('rules.max_actions')); return; }
    f.actions = [...f.actions, blankAction()];
  }
  function removeAction(i: number) {
    f.actions = f.actions.filter((_, idx) => idx !== i);
    if (f.actions.length === 0) f.actions = [blankAction()];
  }
  function moveAction(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= f.actions.length) return;
    const arr = [...f.actions];
    [arr[i], arr[j]] = [arr[j], arr[i]];
    f.actions = arr;
  }

  function actionValuePayloadFor(a: FormAction): any | null {
    switch (a.kind) {
      case 'set_brightness': return { brightness: Number(a.av_brightness) };
      case 'set_color': {
        const [h, s] = hexToHsv(a.av_color_hex);
        return { hsv: [h, s, Number(a.av_brightness)] };
      }
      case 'set_temp': return { color_temp: Number(a.av_temp) };
      case 'set_effect': return { effect: a.av_effect || null };
      default: return null;
    }
  }

  function buildConditionsPayload(): any[] {
    return f.conditions.map((c, idx) => {
      if (c.source_type === 'http') {
        return {
          position: idx,
          combinator: idx === 0 ? null : c.combinator,
          source_type: 'http',
          device_id: null,
          metric: 'http_value',
          operator: c.operator,
          threshold: Number(c.threshold),
          http_url: c.http_url.trim(),
          http_method: c.http_method,
          http_json_path: c.http_json_path.trim() || null,
          http_cache_seconds: Number(c.http_cache_seconds) || 60,
        };
      }
      const isBool = isBoolMetric(c.metric);
      return {
        position: idx,
        combinator: idx === 0 ? null : c.combinator,
        source_type: 'device',
        device_id: Number(c.device_id),
        metric: c.metric,
        operator: isBool ? 'eq' : c.operator,
        threshold: isBool ? Number(c.bool_value) : Number(c.threshold),
      };
    });
  }

  let busy = $state(false);
  async function submit() {
    if (!f.name.trim()) { alert(tr('rules.name_required')); return; }
    // Validate that the action chain has at least one non-wait step with a target.
    const nonWait = f.actions.filter(a => a.kind !== 'wait');
    if (!nonWait.length) { alert(tr('rules.must_have_action')); return; }
    for (let i = 0; i < f.actions.length; i++) {
      const a = f.actions[i];
      if (a.kind === 'wait') {
        const sec = Math.max(0, Math.round(Number(a.wait_minutes || 0) * 60 + Number(a.wait_seconds || 0)));
        if (sec <= 0) { alert(tr('rules.wait_needs_time', { n: i + 1 })); return; }
      } else if (!a.target_device_id) {
        alert(tr('rules.action_needs_target', { n: i + 1 })); return;
      }
    }

    let conditions: any[] = [];
    if (f.trigger_type !== 'time') {
      for (let i = 0; i < f.conditions.length; i++) {
        const c = f.conditions[i];
        if (c.source_type === 'http') {
          if (!c.http_url.trim()) { alert(tr('rules.cond_url_required', { n: i + 1 })); return; }
          try { new URL(c.http_url.trim()); } catch { alert(tr('rules.cond_url_invalid', { n: i + 1 })); return; }
        } else {
          if (!c.device_id) { alert(tr('rules.cond_device_required', { n: i + 1 })); return; }
        }
      }
      conditions = buildConditionsPayload();
    }

    const actions = f.actions.map((a, idx) => {
      if (a.kind === 'wait') {
        const sec = Math.max(1, Math.round(Number(a.wait_minutes || 0) * 60 + Number(a.wait_seconds || 0)));
        return {
          position: idx,
          kind: 'wait',
          target_device_id: null,
          action_value: null,
          duration_seconds: sec
        };
      }
      const dur = (a.kind === 'on_for' || a.kind === 'off_for')
        ? Math.max(60, Number(a.duration_minutes) * 60)
        : null;
      return {
        position: idx,
        kind: a.kind,
        target_device_id: Number(a.target_device_id),
        action_value: actionValuePayloadFor(a),
        duration_seconds: dur
      };
    });

    busy = true;
    try {
      const body: any = {
        name: f.name.trim(),
        enabled: f.enabled,
        trigger_type: f.trigger_type,
        cooldown_minutes: Number(f.cooldown_minutes) || 0,
        priority: Number(f.priority) || 0,
        days_mask: f.use_window ? listToDaysMask(f.days) : 127,
        start_time: f.use_window ? f.start_time : null,
        end_time:   f.use_window ? f.end_time : null,
        conditions,
        actions
      };
      const url = editingId != null ? `/api/rules/${editingId}` : '/api/rules';
      const method = editingId != null ? 'PATCH' : 'POST';
      const r = await fetch(url, {
        method, headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!r.ok) { alert(await r.text()); return; }
      editingId = null;
      f = blank();
      await invalidateAll();
    } finally { busy = false; }
  }

  async function patch(id: number, p: Partial<Rule> | any) {
    const r = await fetch(`/api/rules/${id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(p)
    });
    if (!r.ok) alert(await r.text());
    await invalidateAll();
  }
  async function del(id: number) {
    if (!confirm(tr('rules.delete_confirm'))) return;
    await fetch(`/api/rules/${id}`, { method: 'DELETE' });
    await invalidateAll();
  }

  function condText(c: RuleCondition): string {
    if (c.source_type === 'http') {
      const path = c.http_json_path ? `.${c.http_json_path}` : '';
      const op = OP_LABEL[c.operator] || c.operator;
      const url = (c.http_url || '').replace(/^https?:\/\//, '').slice(0, 40);
      return `HTTP(${url}${path}) ${op} ${c.threshold}`;
    }
    const dev = dname(c.device_id);
    const m = METRIC_LABEL[c.metric] || c.metric;
    if (isBoolMetric(c.metric)) {
      const yes = Number(c.threshold) === 1;
      const lbl = c.metric === 'motion'
        ? (yes ? tr('rules.motion_detected') : tr('rules.motion_none'))
        : (yes ? tr('common.on') : tr('common.off'));
      return `${dev}.${tr(m)} = ${lbl}`;
    }
    const op = OP_LABEL[c.operator] || c.operator;
    return `${dev}.${tr(m)} ${op} ${c.threshold}`;
  }

  function ruleSummary(r: Rule): string {
    const conds = r.conditions || [];
    let condStr = '';
    if (r.trigger_type === 'time') {
      condStr = tr('rules.summary_time');
    } else if (conds.length === 0) {
      condStr = tr('rules.summary_no_conditions');
    } else {
      const sorted = [...conds].sort((a, b) => a.position - b.position);
      condStr = sorted.map((c, i) =>
        i === 0 ? condText(c) : `${c.combinator || 'AND'} ${condText(c)}`
      ).join(' ');
    }

    // v11: prefer the multi-step chain summary when present.
    const chain = [...(r.actions || [])].sort((a, b) => a.position - b.position);
    if (chain.length) {
      const parts = chain.map((s, i) => {
        if (s.kind === 'wait') {
          const sec = Math.max(0, Number(s.duration_seconds || 0));
          const m = Math.floor(sec / 60);
          const sx = sec % 60;
          const minU = tr('common.minutes_short');
          const secU = tr('common.seconds_short');
          const txt = m && sx ? `${m} ${minU} ${sx} ${secU}` : (m ? `${m} ${minU}` : `${sx} ${secU}`);
          return `⏱ ${txt}`;
        }
        return `${i+1}. ${dname(s.target_device_id)}: ${tr(ACTION_KIND_LABEL[s.kind] || s.kind)}`;
      });
      return `${condStr} → ${parts.join(' → ')}`;
    }

    let av = '';
    if (r.action_value) {
      try {
        const v = typeof r.action_value === 'string' ? JSON.parse(r.action_value) : r.action_value;
        if (v.brightness != null) av = ` (${v.brightness}%)`;
        else if (v.hsv) av = ` (HSV ${v.hsv.join(',')})`;
        else if (v.color_temp) av = ` (${v.color_temp}K)`;
        else if (v.effect) av = ` (${tr('rules.effect_label')}: ${v.effect})`;
      } catch {}
    }
    const dur = r.duration_minutes ? ` ${tr('rules.on_for_label', { n: r.duration_minutes })}` : '';
    return `${condStr} → ${dname(r.target_device_id)}: ${tr(ACTION_LABEL[r.action])}${av}${dur}`;
  }

  // ---- Dependencies ----
  let depForm = $state({ name: '', source_device_id: '' as number | '', source_state: 1, target_device_id: '' as number | '', required_state: 1 });
  async function addDep() {
    if (!depForm.source_device_id || !depForm.target_device_id) return;
    await fetch('/api/dependencies', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: depForm.name || `dep-${Date.now()}`,
        enabled: true,
        source_device_id: Number(depForm.source_device_id),
        source_state: Number(depForm.source_state),
        target_device_id: Number(depForm.target_device_id),
        required_state: Number(depForm.required_state)
      })
    });
    depForm = { name: '', source_device_id: '', source_state: 1, target_device_id: '', required_state: 1 };
    await invalidateAll();
  }
  async function delDep(id: number) {
    if (!confirm(tr('rules.deps_delete_confirm'))) return;
    await fetch(`/api/dependencies/${id}`, { method: 'DELETE' });
    await invalidateAll();
  }
</script>

<h1 class="mb-4 text-2xl font-bold">{$t('rules.title')}</h1>

<!-- New rule editor -->
<details class="card mb-4" open>
  <summary class="flex cursor-pointer items-center gap-2 font-semibold">
    {#if editingId != null}
      <Icon name="edit" size={16} />{$t('rules.editing_rule', { id: editingId })}
    {:else}
      <Icon name="plus" size={16} />{$t('rules.new_rule')}
    {/if}
  </summary>
  <div class="mt-4 space-y-4">
    <div class="grid gap-3 sm:grid-cols-2">
      <div>
        <div class="label">{$t('rules.name')}</div>
        <input class="input" bind:value={f.name} placeholder={$t('rules.name_placeholder')}/>
      </div>
      <div>
        <div class="label">{$t('rules.trigger')}</div>
        <select class="input" bind:value={f.trigger_type}>
          <option value="sensor">{$t('rules.trigger_sensor')}</option>
          <option value="device_state">{$t('rules.trigger_device_state')}</option>
          <option value="time">{$t('rules.trigger_time')}</option>
        </select>
      </div>
    </div>

    {#if f.trigger_type !== 'time'}
      <div class="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
        <div class="mb-2 flex items-center justify-between">
          <div class="text-xs font-semibold text-slate-500">{$t('rules.conditions')} ({f.conditions.length})</div>
          <button type="button" class="btn-ghost inline-flex items-center gap-1 text-xs" onclick={addCond}>
            <Icon name="plus" size={12} />{$t('rules.add_condition')}
          </button>
        </div>

        {#each f.conditions as c, i}
          <div class="mb-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
            <div class="mb-2 flex items-center justify-between">
              <div class="text-xs font-semibold text-slate-500">#{i+1}</div>
              <div class="flex gap-1">
                <button type="button" class="btn-ghost text-xs" onclick={() => moveCond(i,-1)} disabled={i===0} aria-label="↑"><Icon name="arrow-up" size={12} /></button>
                <button type="button" class="btn-ghost text-xs" onclick={() => moveCond(i, 1)} disabled={i===f.conditions.length-1} aria-label="↓"><Icon name="arrow-down" size={12} /></button>
                <button type="button" class="btn-danger text-xs" onclick={() => removeCond(i)} disabled={f.conditions.length===1} aria-label={$t('common.delete')}><Icon name="x" size={12} /></button>
              </div>
            </div>

            {#if i > 0}
              <div class="mb-2">
                <div class="label">{$t('rules.combinator')}</div>
                <select class="input" bind:value={c.combinator}>
                  <option value="AND">{$t('rules.combinator_and')}</option>
                  <option value="OR">{$t('rules.combinator_or')}</option>
                </select>
              </div>
            {/if}

            <div class="mb-2">
              <div class="label">{$t('rules.value_source')}</div>
              <div class="flex gap-2">
                <label class="flex flex-1 cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white p-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100
                               {c.source_type === 'device' ? '!border-brand-500 dark:!bg-brand-900/20 dark:!border-brand-400' : ''}">
                  <input type="radio" bind:group={c.source_type} value="device"/>
                  <Icon name="devices" size={14} />{$t('rules.source_device')}
                </label>
                <label class="flex flex-1 cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white p-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100
                               {c.source_type === 'http' ? '!border-brand-500 dark:!bg-brand-900/20 dark:!border-brand-400' : ''}">
                  <input type="radio" bind:group={c.source_type} value="http"/>
                  <Icon name="globe" size={14} />{$t('rules.source_http')}
                </label>
              </div>
            </div>

            {#if c.source_type === 'device'}
              {@const condDev = findDevice(Number(c.device_id))}
              {@const allowedMetrics = metricsForDevice(condDev)}
              <div class="grid gap-2 sm:grid-cols-3">
                <div class="sm:col-span-2">
                  <div class="label">{$t('rules.device')}</div>
                  <select class="input" bind:value={c.device_id} onchange={() => onCondDeviceChange(c)}>
                    <option value="">{$t('common.select_placeholder')}</option>
                    {#each condSources as d}
                      <option value={d.id}>{d.custom_name || d.tapo_alias} ({d.kind})</option>
                    {/each}
                  </select>
                </div>
                <div>
                  <div class="label">{$t('rules.metric')}</div>
                  <select class="input" bind:value={c.metric}>
                    {#each allowedMetrics as k}
                      <option value={k}>{$t(METRIC_LABEL[k])}</option>
                    {/each}
                  </select>
                </div>
              </div>

              {#if isBoolMetric(c.metric)}
                <div class="mt-2">
                  <div class="label">{$t('rules.state')}</div>
                  <select class="input" bind:value={c.bool_value}>
                    {#if c.metric === 'motion'}
                      <option value={1}>{$t('rules.state_motion_detected')}</option>
                      <option value={0}>{$t('rules.state_motion_none')}</option>
                    {:else}
                      <option value={1}>{$t('rules.state_on')}</option>
                      <option value={0}>{$t('rules.state_off')}</option>
                    {/if}
                  </select>
                </div>
              {:else}
                <div class="mt-2 grid gap-2 sm:grid-cols-2">
                  <div>
                    <div class="label">{$t('rules.operator')}</div>
                    <select class="input" bind:value={c.operator}>
                      {#each Object.entries(OP_LABEL) as [k, v]}<option value={k}>{v}</option>{/each}
                    </select>
                  </div>
                  <div>
                    <div class="label">{$t('rules.value')}</div>
                    <input class="input" type="number" step="0.1" bind:value={c.threshold}/>
                  </div>
                </div>
              {/if}
            {:else}
              <!-- HTTP source -->
              <div class="grid gap-2">
                <div>
                  <div class="label">{$t('rules.url')}</div>
                  <input class="input" type="url"
                         placeholder="https://api.openweathermap.org/data/2.5/weather?q=Praha&appid=…&units=metric"
                         bind:value={c.http_url}/>
                </div>
                <div class="grid gap-2 sm:grid-cols-3">
                  <div>
                    <div class="label">{$t('rules.method')}</div>
                    <select class="input" bind:value={c.http_method}>
                      <option value="GET">GET</option>
                      <option value="POST">POST</option>
                    </select>
                  </div>
                  <div class="sm:col-span-2">
                    <div class="label">{$t('rules.json_path')}</div>
                    <input class="input" placeholder={$t('rules.json_path_placeholder')} bind:value={c.http_json_path}/>
                  </div>
                </div>
                <div class="grid gap-2 sm:grid-cols-3">
                  <div>
                    <div class="label">{$t('rules.operator')}</div>
                    <select class="input" bind:value={c.operator}>
                      {#each Object.entries(OP_LABEL) as [k, v]}<option value={k}>{v}</option>{/each}
                    </select>
                  </div>
                  <div>
                    <div class="label">{$t('rules.value_simple')}</div>
                    <input class="input" type="number" step="0.1" bind:value={c.threshold}/>
                  </div>
                  <div>
                    <div class="label">{$t('rules.cache_seconds')}</div>
                    <input class="input" type="number" min="0" bind:value={c.http_cache_seconds}/>
                  </div>
                </div>
                <div class="text-xs text-slate-500">{$t('rules.http_hint')}</div>
              </div>
            {/if}
          </div>
        {/each}

        <div class="text-xs text-slate-500">{$t('rules.offline_hint')}</div>
      </div>
    {/if}

    <!-- ACTIONS (multiple steps in order; the last step may be "Wait") -->
    <div class="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
      <div class="mb-2 flex items-center justify-between">
        <div class="text-xs font-semibold text-slate-500">{$t('rules.actions')}</div>
        <button type="button" class="btn-ghost inline-flex items-center gap-1 text-xs" onclick={addAction}>
          <Icon name="plus" size={12} />{$t('rules.add_action')}
        </button>
      </div>

      <div class="flex flex-col gap-3">
        {#each f.actions as a, i (i)}
          <div class="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
            <div class="mb-2 flex flex-wrap items-center gap-2">
              <div class="text-xs font-semibold text-slate-500">#{i + 1}</div>
              <select class="input w-auto text-sm" bind:value={a.kind}>
                {#each Object.entries(ACTION_KIND_LABEL) as [k, v]}
                  <option value={k}>{$t(v)}</option>
                {/each}
              </select>
              <div class="ml-auto flex items-center gap-1">
                <button type="button" class="btn-ghost h-7 w-7 p-0" title="↑"
                        onclick={() => moveAction(i, -1)} disabled={i === 0}>
                  <Icon name="arrow-up" size={14} />
                </button>
                <button type="button" class="btn-ghost h-7 w-7 p-0" title="↓"
                        onclick={() => moveAction(i, 1)} disabled={i === f.actions.length - 1}>
                  <Icon name="arrow-down" size={14} />
                </button>
                <button type="button" class="btn-ghost h-7 w-7 p-0" title={$t('common.remove')}
                        onclick={() => removeAction(i)} disabled={f.actions.length === 1}>
                  <Icon name="x" size={14} />
                </button>
              </div>
            </div>

            {#if a.kind === 'wait'}
              <!-- WAIT: pure delay; no device. -->
              <div class="grid gap-2 sm:grid-cols-2">
                <div>
                  <div class="label">{$t('common.minutes')}</div>
                  <input class="input" type="number" min="0" bind:value={a.wait_minutes}/>
                </div>
                <div>
                  <div class="label">{$t('common.seconds')}</div>
                  <input class="input" type="number" min="0" max="59" bind:value={a.wait_seconds}/>
                </div>
              </div>
              <div class="mt-1 text-xs text-slate-500">
                {$t('rules.wait_warning')}
              </div>
            {:else}
              <div class="grid gap-2 sm:grid-cols-2">
                <div>
                  <div class="label">{$t('rules.target_device')}</div>
                  <select class="input" bind:value={a.target_device_id}>
                    <option value="">{$t('common.select_placeholder')}</option>
                    {#each targets as d}
                      <option value={d.id}>{d.custom_name || d.tapo_alias} ({d.kind})</option>
                    {/each}
                  </select>
                </div>
                {#if a.kind === 'on_for' || a.kind === 'off_for'}
                  <div>
                    <div class="label">{$t('rules.duration_minutes')}</div>
                    <input class="input" type="number" min="1" bind:value={a.duration_minutes}/>
                  </div>
                {/if}
              </div>

              {#if a.kind === 'set_brightness'}
                <div class="mt-2">
                  <div class="label flex justify-between">{$t('rules.brightness_label')} <span>{a.av_brightness}%</span></div>
                  <input type="range" min="1" max="100" bind:value={a.av_brightness} class="w-full"/>
                </div>
              {/if}

              {#if a.kind === 'set_color'}
                <div class="mt-2 grid gap-2 sm:grid-cols-2">
                  <div>
                    <div class="label">{$t('rules.color_label')}</div>
                    <input type="color" bind:value={a.av_color_hex}
                           class="h-10 w-20 rounded-lg border border-slate-300 dark:border-slate-700"/>
                  </div>
                  <div>
                    <div class="label flex justify-between">{$t('rules.brightness_label')} <span>{a.av_brightness}%</span></div>
                    <input type="range" min="1" max="100" bind:value={a.av_brightness} class="w-full"/>
                  </div>
                </div>
              {/if}

              {#if a.kind === 'set_temp'}
                <div class="mt-2">
                  <div class="label flex justify-between">{$t('rules.white_temp_label')} <span>{a.av_temp}</span></div>
                  <input type="range" min="2500" max="6500" step="100" bind:value={a.av_temp} class="w-full"/>
                </div>
              {/if}

              {#if a.kind === 'set_effect'}
                {@const tgt = findDevice(Number(a.target_device_id))}
                <div class="mt-2">
                  <div class="label">{$t('rules.effect')}</div>
                  {#if tgt?.capabilities?.light_effect?.list?.length}
                    <select class="input" bind:value={a.av_effect}>
                      <option value="">{$t('rules.effect_none')}</option>
                      {#each tgt.capabilities.light_effect.list as e}<option>{e}</option>{/each}
                    </select>
                  {:else}
                    <input class="input" bind:value={a.av_effect} placeholder={$t('rules.effect_placeholder')}/>
                  {/if}
                </div>
              {/if}
            {/if}
          </div>
        {/each}
      </div>
    </div>

    <!-- Time window + cooldown + priority -->
    <div class="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
      <label class="flex items-center gap-2 text-sm">
        <input type="checkbox" bind:checked={f.use_window}/> {$t('rules.only_in_window')}
      </label>
      {#if f.use_window}
        <div class="mt-2 grid gap-2 sm:grid-cols-2">
          <div>
            <div class="label">{$t('rules.from')}</div>
            <input class="input" type="time" bind:value={f.start_time}/>
          </div>
          <div>
            <div class="label">{$t('rules.to')}</div>
            <input class="input" type="time" bind:value={f.end_time}/>
          </div>
        </div>
        <div class="mt-2 flex flex-wrap gap-2">
          {#each DAYS as day, i}
            <label class="flex items-center gap-1 text-xs">
              <input type="checkbox" bind:checked={f.days[i]}/> {$t(day)}
            </label>
          {/each}
        </div>
      {/if}
      <div class="mt-2 grid gap-2 sm:grid-cols-2">
        <div>
          <div class="label">{$t('rules.cooldown_minutes')}</div>
          <input class="input" type="number" min="0" bind:value={f.cooldown_minutes}/>
        </div>
        <div>
          <div class="label">{$t('rules.priority')}</div>
          <input class="input" type="number" bind:value={f.priority}/>
        </div>
      </div>
    </div>

    <label class="flex items-center gap-2 text-sm">
      <input type="checkbox" bind:checked={f.enabled}/> {$t('rules.active')}
    </label>

    <div class="flex flex-wrap items-center gap-2">
      <button class="btn-primary inline-flex items-center gap-1" onclick={submit} disabled={busy}>
        {#if editingId != null}
          <Icon name="check" size={14} />{busy ? $t('common.saving') : $t('rules.save_changes')}
        {:else}
          <Icon name="plus" size={14} />{busy ? $t('common.saving') : $t('rules.create_rule')}
        {/if}
      </button>
      {#if editingId != null}
        <button type="button" class="btn-ghost inline-flex items-center gap-1" onclick={cancelEdit} disabled={busy}>
          <Icon name="x" size={14} />{$t('rules.cancel_edit')}
        </button>
      {/if}
    </div>
  </div>
</details>

<!-- Rules list -->
<div class="space-y-2">
  {#each data.rules as r (r.id)}
    <div class="card">
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-semibold">{r.name}</span>
            <span class={r.enabled ? 'badge-on' : 'badge-off'}>{r.enabled ? $t('common.on') : $t('common.off')}</span>
            {#if r.cooldown_minutes > 0}<span class="badge-warn">cooldown {r.cooldown_minutes}m</span>{/if}
            {#if r.start_time}<span class="badge-off">{r.start_time}–{r.end_time}</span>{/if}
            {#if r.fire_count > 0}<span class="badge-off">{r.fire_count}×</span>{/if}
          </div>
          <div class="mt-1 text-sm text-slate-600 dark:text-slate-300">{ruleSummary(r)}</div>
          {#if r.last_fired_at}
            <div class="mt-1 text-xs text-slate-500">{new Date(r.last_fired_at).toLocaleString()}</div>
          {/if}
        </div>
        <div class="flex flex-col gap-1">
          <button class="btn-ghost inline-flex items-center gap-1 text-xs" onclick={() => startEdit(r)} disabled={editingId === r.id}>
            <Icon name="edit" size={12} />{editingId === r.id ? $t('common.saving') : $t('common.edit')}
          </button>
          <button class="btn-ghost inline-flex items-center gap-1 text-xs" onclick={() => patch(r.id, { enabled: r.enabled ? 0 : 1 })}>
            {#if r.enabled}<Icon name="pause" size={12} />{$t('common.off')}{:else}<Icon name="play" size={12} />{$t('common.on')}{/if}
          </button>
          <button class="btn-danger inline-flex items-center gap-1 text-xs" onclick={() => del(r.id)}>
            <Icon name="trash" size={12} />{$t('common.delete')}
          </button>
        </div>
      </div>
    </div>
  {:else}
    <div class="text-sm text-slate-500">{$t('rules.empty_existing')}</div>
  {/each}
</div>

<!-- Dependencies -->
<h2 class="mb-3 mt-8 text-xl font-bold">{$t('rules.deps_title')}</h2>
<p class="mb-3 text-xs text-slate-500">
  {$t('rules.deps_intro')}
</p>

<div class="card mb-4 grid gap-2 sm:grid-cols-5">
  <input class="input sm:col-span-1" placeholder={$t('rules.deps_name')} bind:value={depForm.name}/>
  <select class="input sm:col-span-1" bind:value={depForm.source_device_id}>
    <option value="">{$t('rules.deps_source')}…</option>
    {#each targets as d}<option value={d.id}>{d.custom_name || d.tapo_alias}</option>{/each}
  </select>
  <select class="input" bind:value={depForm.source_state}>
    <option value={1}>= ON</option><option value={0}>= OFF</option>
  </select>
  <select class="input" bind:value={depForm.target_device_id}>
    <option value="">{$t('rules.deps_target')}…</option>
    {#each targets as d}<option value={d.id}>{d.custom_name || d.tapo_alias}</option>{/each}
  </select>
  <div class="flex gap-2">
    <select class="input flex-1" bind:value={depForm.required_state}>
      <option value={1}>⇒ ON</option><option value={0}>⇒ OFF</option>
    </select>
    <button class="btn-primary" onclick={addDep}>{$t('rules.deps_add')}</button>
  </div>
</div>

<div class="space-y-1">
  {#each data.deps as d}
    <div class="card flex items-center justify-between">
      <div class="text-sm">
        <b>{d.name}</b> — {dname(d.source_device_id)} = {d.source_state ? 'ON' : 'OFF'}
        ⇒ {dname(d.target_device_id)} = {d.required_state ? 'ON' : 'OFF'}
      </div>
    <button class="btn-danger inline-flex items-center gap-1 text-xs" onclick={() => delDep(d.id)}><Icon name="trash" size={12} />{$t('common.delete')}</button>
    </div>
  {:else}
    <div class="text-sm text-slate-500">{$t('rules.deps_empty')}</div>
  {/each}
</div>
