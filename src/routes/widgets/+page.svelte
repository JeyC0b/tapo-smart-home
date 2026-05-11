<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/stores';
  import Icon from '$lib/ui/Icon.svelte';
  import { onMount, onDestroy } from 'svelte';
  import WidgetTile from '$lib/ui/WidgetTile.svelte';
  import { t, tr } from '$lib/i18n';

  type Widget = {
    id: number;
    kind: 'device' | 'sensor' | 'http' | 'label' | 'spacer' | 'group' | 'line';
    title: string | null;
    config: any;
    on_home: 0 | 1;
    enabled: 0 | 1;
  };

  let { data }: { data: { widgets: Widget[]; devices: any[]; groups: any[] } } = $props();
  let isAdmin = $derived(!!$page.data.isAdmin);

  // ---------- live HTTP widget preview (from DB cache) ----------
  let httpData = $state<Record<number, any>>({});
  let pullTimer: ReturnType<typeof setInterval> | null = null;

  async function pullValue(id: number) {
    try {
      const r = await fetch(`/api/widgets/${id}/value`);
      if (!r.ok) return;
      const j = await r.json();
      httpData[id] = j;
    } catch { /* ignore */ }
  }
  function pullAll() {
    for (const w of data.widgets) {
      if (w.kind === 'http' && w.enabled) pullValue(w.id);
    }
  }
  onMount(() => {
    pullAll();
    // The client polls the value every 30 s — the server refreshes it
    // itself based on widget.config.refresh_seconds via the scheduler.
    pullTimer = setInterval(pullAll, 30_000);
  });
  onDestroy(() => { if (pullTimer) clearInterval(pullTimer); });

  // ---------- editor ----------
  let editing = $state<Widget | null>(null);

  function blank(): any {
    return {
      id: 0, kind: 'label', title: '',
      config: defaultConfig('label'),
      enabled: 1, on_home: 0
    };
  }
  function defaultConfig(kind: string): any {
    const base: any = {
      show_title: true,
      title_size: 'sm',
      title_align: 'left',
      title_weight: 'bold',
      title_color: 'default',
      align: 'center',
      vertical_align: 'top',
      value_size: '3xl',
      value_weight: 'bold',
      value_color: 'default'
    };
    if (kind === 'device') {
      return { ...base, state_display: 'icon', show_meta: true };
    } else if (kind === 'group') {
      return { ...base, state_display: 'icon', show_meta: true };
    } else if (kind === 'sensor') {
      return { ...base, primary: 'temperature', show_meta: true, value_size: '4xl' };
    } else if (kind === 'http') {
      return {
        ...base,
        method: 'GET',
        refresh_seconds: 60,
        decimals: 1,
        show_refresh_time: false,
        layout: 'inline',
        show_name: false,
        prefix_size: 'md', prefix_weight: 'normal', prefix_color: 'muted',
        suffix_size: 'md', suffix_weight: 'normal', suffix_color: 'muted'
      };
    } else if (kind === 'label') {
      return {
        ...base,
        items: [
          { type: 'text', text: tr('widgets.sample_text'), size: '2xl', weight: 'bold', align: 'center', color: 'default' }
        ]
      };
    } else if (kind === 'line') {
      return { ...base, line_color: 'default', line_thickness: 'thin' };
    }
    return base;
  }

  let draft = $state<any>(blank());

  function startCreate() {
    draft = blank();
    editing = draft as any;
  }
  function startEdit(w: Widget) {
    draft = JSON.parse(JSON.stringify(w));
    draft.config ??= {};
    // fill in defaults (preserves everything existing)
    const def = defaultConfig(w.kind);
    for (const k in def) if (!(k in draft.config)) draft.config[k] = def[k];
    editing = w;
  }
  function cancelEdit() { editing = null; draft = blank(); }
  function changeKind(k: string) {
    draft.kind = k;
    draft.config = { ...defaultConfig(k), ...{ device_id: draft.config?.device_id, url: draft.config?.url, group_id: draft.config?.group_id } };
  }

  // label items helpers
  function addItem(type: 'text' | 'spacer' | 'divider') {
    draft.config.items ??= [];
    if (type === 'text')
      draft.config.items = [...draft.config.items, { type: 'text', text: tr('widgets.new_text'), size: 'lg', weight: 'normal', align: 'left', color: 'default' }];
    else
      draft.config.items = [...draft.config.items, { type, size: 'sm' }];
  }
  function removeItem(idx: number) {
    draft.config.items = draft.config.items.filter((_: any, i: number) => i !== idx);
  }
  function moveItem(idx: number, dir: -1 | 1) {
    const a = [...draft.config.items];
    const j = idx + dir;
    if (j < 0 || j >= a.length) return;
    [a[idx], a[j]] = [a[j], a[idx]];
    draft.config.items = a;
  }

  async function save() {
    const isNew = !draft.id;
    const body: any = {
      kind: draft.kind, title: draft.title || null,
      config: draft.config || {}, enabled: draft.enabled ? 1 : 0
    };
    const url = isNew ? '/api/widgets' : `/api/widgets/${draft.id}`;
    const r = await fetch(url, {
      method: isNew ? 'POST' : 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) { alert(await r.text()); return; }
    cancelEdit();
    await invalidateAll();
    pullAll();
  }
  async function del(w: Widget) {
    if (!confirm(tr('widgets.delete_confirm', { name: w.title || w.kind }))) return;
    await fetch(`/api/widgets/${w.id}`, { method: 'DELETE' });
    await invalidateAll();
  }
  async function toggleHome(w: Widget) {
    const r = await fetch(`/api/widgets/${w.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ on_home: w.on_home ? 0 : 1 })
    });
    if (!r.ok) { alert(await r.text()); return; }
    await invalidateAll();
  }

  // Synthetic group-state for previews on /widgets (we don't fetch live group state here
  // — show 0/total since members are not loaded; the home page renders the real state).
  function previewGroupState(cfg: any) {
    const gid = Number(cfg?.group_id);
    if (!gid) return undefined;
    const g = data.groups.find(x => x.id === gid);
    if (!g) return undefined;
    return { on: 0, total: 0, any_on: false, all_on: false };
  }
  function previewGroupConfig(cfg: any) {
    const gid = Number(cfg?.group_id);
    if (!gid) return null;
    return data.groups.find(x => x.id === gid)?.config ?? null;
  }

  // original helper option arrays for selects
  let SIZE_OPTS = $derived<[string, string][]>([
    ['sm', $t('widgets.size_sm')],
    ['md', $t('widgets.size_md')],
    ['lg', $t('widgets.size_lg')],
    ['xl', $t('widgets.size_xl')],
    ['2xl', $t('widgets.size_2xl')],
    ['3xl', $t('widgets.size_3xl')],
    ['4xl', $t('widgets.size_4xl')],
    ['5xl', $t('widgets.size_5xl')]
  ]);
  let ALIGN_OPTS = $derived<[string, string][]>([
    ['left', $t('widgets.align_left')],
    ['center', $t('widgets.align_center')],
    ['right', $t('widgets.align_right')]
  ]);
  let WEIGHT_OPTS = $derived<[string, string][]>([
    ['normal', $t('widgets.weight_normal')],
    ['bold', $t('widgets.weight_bold')],
    ['black', $t('widgets.weight_black')]
  ]);
  let COLOR_OPTS = $derived<[string, string][]>([
    ['default', $t('widgets.color_default')],
    ['muted', $t('widgets.color_muted')],
    ['success', $t('widgets.color_success')],
    ['warn', $t('widgets.color_warn')],
    ['error', $t('widgets.color_error')]
  ]);
</script>

<div class="mb-4 flex flex-wrap items-center justify-between gap-2">
  <div>
    <h1 class="text-2xl font-bold">{$t('widgets.title')}</h1>
    <p class="text-sm text-slate-500">
      {$t('widgets.intro')} <a href="/" class="underline">{$t('widgets.home_link')}</a> {$t('widgets.intro_suffix')}
    </p>
  </div>
  {#if isAdmin}
    <button class="btn-primary inline-flex items-center gap-1" onclick={startCreate}>
      <Icon name="plus" size={14} />{$t('widgets.new_widget')}
    </button>
  {/if}
</div>

{#if data.widgets.length === 0}
  <div class="card text-center text-slate-500">{$t('widgets.empty')}</div>
{/if}

<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
  {#each data.widgets as w (w.id)}
    <div class="card">
      <div class="mb-2 flex items-center justify-between gap-2">
        <div class="min-w-0">
          <div class="truncate text-sm font-semibold">{w.title || $t('widgets.untitled')}</div>
          <div class="text-xs text-slate-500">
            {w.kind}
            {#if w.on_home}<span class="ml-1 text-emerald-600">· {$t('widgets.on_home')}</span>{/if}
            {#if !w.enabled}<span class="ml-1 text-rose-500">· {$t('widgets.disabled')}</span>{/if}
          </div>
        </div>
        {#if isAdmin}
          <div class="flex gap-1">
            <button class="btn-ghost text-xs" onclick={() => toggleHome(w)}
                    title={w.on_home ? $t('widgets.remove_from_home') : $t('widgets.add_to_home')}>
              <Icon name={w.on_home ? 'eye-off' : 'eye'} size={12} />
            </button>
            <button class="btn-ghost text-xs" onclick={() => startEdit(w)} title={$t('common.edit')}>
              <Icon name="edit" size={12} />
            </button>
            <button class="btn-danger text-xs" onclick={() => del(w)} title={$t('common.delete')}>
              <Icon name="trash" size={12} />
            </button>
          </div>
        {/if}
      </div>
      <div class="flex h-40 items-stretch justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50/40 dark:border-slate-700 dark:bg-slate-900/40">
        <WidgetTile widget={w} devices={data.devices} httpValue={httpData[w.id]}
                    groupState={previewGroupState(w.config)} groupConfig={previewGroupConfig(w.config)} />
      </div>
    </div>
  {/each}
</div>

{#if editing}
  <div class="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-2 sm:p-4"
       role="dialog" aria-modal="true" tabindex="-1"
       onclick={(e) => { if (e.target === e.currentTarget) cancelEdit(); }}
       onkeydown={(e) => { if (e.key === 'Escape') cancelEdit(); }}>
    <div class="my-4 w-full max-w-3xl space-y-4 rounded-2xl bg-white p-4 sm:p-5 shadow-xl dark:bg-slate-900 max-h-[92vh] overflow-y-auto">
      <h2 class="text-lg font-bold">{draft.id ? $t('widgets.edit_widget') : $t('widgets.new_widget')}</h2>

      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <div class="label">{$t('widgets.type')}</div>
          <select class="input" value={draft.kind} disabled={!!draft.id}
                  onchange={(e) => changeKind((e.target as HTMLSelectElement).value)}>
            <option value="label">{$t('widgets.type_label')}</option>
            <option value="device">{$t('widgets.type_device')}</option>
            <option value="group">{$t('widgets.type_group')}</option>
            <option value="sensor">{$t('widgets.type_sensor')}</option>
            <option value="http">{$t('widgets.type_http')}</option>
            <option value="spacer">{$t('widgets.type_spacer')}</option>
            <option value="line">{$t('widgets.type_line')}</option>
          </select>
        </div>
        <div>
          <div class="label">{$t('widgets.title_optional')}</div>
          <input class="input" bind:value={draft.title}/>
        </div>
      </div>

      <!-- General rendering options (for everything except spacer). -->
      {#if draft.kind !== 'spacer'}
        <div class="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
          <div class="mb-2 text-xs font-semibold uppercase text-slate-500">{$t('widgets.appearance')}</div>
          <div class="grid gap-3 sm:grid-cols-3">
            <label class="flex items-center gap-2 text-sm">
              <input type="checkbox" bind:checked={draft.config.show_title}/>
              <span>{$t('widgets.show_title')}</span>
            </label>
            <div>
              <div class="label">{$t('widgets.title_size')}</div>
              <select class="input" bind:value={draft.config.title_size}>
                {#each SIZE_OPTS as [v, l]}<option value={v}>{l}</option>{/each}
              </select>
            </div>
            <div>
              <div class="label">{$t('widgets.title_align')}</div>
              <select class="input" bind:value={draft.config.title_align}>
                {#each ALIGN_OPTS as [v, l]}<option value={v}>{l}</option>{/each}
              </select>
            </div>
            <div>
              <div class="label">{$t('widgets.title_weight')}</div>
              <select class="input" bind:value={draft.config.title_weight}>
                {#each WEIGHT_OPTS as [v, l]}<option value={v}>{l}</option>{/each}
              </select>
            </div>
            <div>
              <div class="label">{$t('widgets.title_color')}</div>
              <select class="input" bind:value={draft.config.title_color}>
                {#each COLOR_OPTS as [v, l]}<option value={v}>{l}</option>{/each}
              </select>
            </div>
            <div>
              <div class="label">{$t('widgets.vertical_position')}</div>
              <select class="input" bind:value={draft.config.vertical_align}>
                <option value="top">{$t('widgets.v_top')}</option>
                <option value="middle">{$t('widgets.v_middle')}</option>
                <option value="bottom">{$t('widgets.v_bottom')}</option>
              </select>
            </div>
          </div>
          {#if draft.kind !== 'label'}
            <div class="mt-3 grid gap-3 sm:grid-cols-3">
              <div>
                <div class="label">{$t('widgets.value_size')}</div>
                <select class="input" bind:value={draft.config.value_size}>
                  {#each SIZE_OPTS as [v, l]}<option value={v}>{l}</option>{/each}
                </select>
              </div>
              <div>
                <div class="label">{$t('widgets.value_weight')}</div>
                <select class="input" bind:value={draft.config.value_weight}>
                  {#each WEIGHT_OPTS as [v, l]}<option value={v}>{l}</option>{/each}
                </select>
              </div>
              <div>
                <div class="label">{$t('widgets.value_color')}</div>
                <select class="input" bind:value={draft.config.value_color}>
                  {#each COLOR_OPTS as [v, l]}<option value={v}>{l}</option>{/each}
                </select>
              </div>
              <div class="sm:col-span-3">
                <div class="label">{$t('widgets.value_align')}</div>
                <select class="input" bind:value={draft.config.align}>
                  {#each ALIGN_OPTS as [v, l]}<option value={v}>{l}</option>{/each}
                </select>
              </div>
            </div>
          {/if}
        </div>
      {/if}

      <!-- Type-specific options. -->
      {#if draft.kind === 'group'}
        <div class="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
          <div class="mb-2 text-xs font-semibold uppercase text-slate-500">{$t('widgets.section_group')}</div>
          <div>
            <div class="label">{$t('widgets.select_group')}</div>
            <select class="input" bind:value={draft.config.group_id}>
              <option value="">{$t('common.select_placeholder')}</option>
              {#each data.groups as g}
                <option value={g.id}>{g.room ? `[${g.room}] ` : ''}{g.name}</option>
              {/each}
            </select>
          </div>
          {#if !data.groups.length}
            <p class="mt-2 text-xs text-slate-500">
              {$t('widgets.no_groups_hint')} <a href="/groups" class="underline">{$t('widgets.groups_link')}</a>.
            </p>
          {/if}
          <div class="mt-3">
            <div class="label">{$t('widgets.state_display')}</div>
            <select class="input" bind:value={draft.config.state_display}>
              <option value="icon">{$t('widgets.state_icon_only')}</option>
              <option value="text">{$t('widgets.state_text_only')}</option>
              <option value="both">{$t('widgets.state_both')}</option>
            </select>
          </div>
          <label class="mt-3 flex items-center gap-2 text-sm">
            <input type="checkbox" bind:checked={draft.config.show_meta}/>
            <span>{$t('widgets.show_meta_group')}</span>
          </label>
        </div>

      {:else if draft.kind === 'device' || draft.kind === 'sensor'}
        <div class="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
          <div class="mb-2 text-xs font-semibold uppercase text-slate-500">{$t('widgets.section_device')}</div>
          <div>
            <div class="label">{$t('widgets.select_device')}</div>
            <select class="input" bind:value={draft.config.device_id}>
              <option value="">{$t('common.select_placeholder')}</option>
              {#each data.devices as d}
                <option value={d.id}>{d.room ? `[${d.room}] ` : ''}{d.custom_name || d.tapo_alias || d.device_id} ({d.kind})</option>
              {/each}
            </select>
          </div>
          {#if draft.kind === 'device'}
            <div class="mt-3">
              <div class="label">{$t('widgets.state_display')}</div>
              <select class="input" bind:value={draft.config.state_display}>
                <option value="icon">{$t('widgets.state_icon_only')}</option>
                <option value="text">{$t('widgets.state_text_only')}</option>
                <option value="both">{$t('widgets.state_both')}</option>
              </select>
            </div>
          {:else}
            <div class="mt-3">
              <div class="label">{$t('widgets.primary_value')}</div>
              <select class="input" bind:value={draft.config.primary}>
                <option value="temperature">{$t('widgets.primary_temperature')}</option>
                <option value="humidity">{$t('widgets.primary_humidity')}</option>
                <option value="battery">{$t('widgets.primary_battery')}</option>
              </select>
            </div>
          {/if}
          <label class="mt-3 flex items-center gap-2 text-sm">
            <input type="checkbox" bind:checked={draft.config.show_meta}/>
            <span>{$t('widgets.show_meta_device')}</span>
          </label>
        </div>

      {:else if draft.kind === 'http'}
        <div class="rounded-xl border border-slate-200 p-3 dark:border-slate-700 space-y-3">
          <div class="text-xs font-semibold uppercase text-slate-500">{$t('widgets.section_api')}</div>
          <div class="grid gap-3 sm:grid-cols-3">
            <div class="sm:col-span-2">
              <div class="label">{$t('widgets.url')}</div>
              <input class="input" type="url" placeholder="https://api.example.com/x" bind:value={draft.config.url}/>
            </div>
            <div>
              <div class="label">{$t('widgets.method')}</div>
              <select class="input" bind:value={draft.config.method}>
                <option value="GET">GET</option>
                <option value="POST">POST</option>
              </select>
            </div>
          </div>
          {#if draft.config.method === 'POST'}
            <div class="grid gap-3 sm:grid-cols-3">
              <div>
                <div class="label">{$t('widgets.content_type')}</div>
                <input class="input" placeholder="application/json" bind:value={draft.config.post_content_type}/>
              </div>
              <div class="sm:col-span-2">
                <div class="label">{$t('widgets.request_body')}</div>
                <textarea class="input min-h-[60px]" placeholder={'{"key":"value"}'} bind:value={draft.config.post_body}></textarea>
              </div>
            </div>
          {/if}
          <div class="grid gap-3 sm:grid-cols-3">
            <div>
              <div class="label">{$t('widgets.json_path')}</div>
              <input class="input" placeholder="main.temp" bind:value={draft.config.json_path}/>
            </div>
            <div>
              <div class="label">{$t('widgets.refresh_seconds')}</div>
              <input class="input" type="number" min="5" bind:value={draft.config.refresh_seconds}/>
            </div>
            <div>
              <div class="label">{$t('widgets.decimals')}</div>
              <input class="input" type="number" min="0" max="6" bind:value={draft.config.decimals}/>
            </div>
          </div>

          <div class="text-xs font-semibold uppercase text-slate-500 pt-2">{$t('widgets.value_appearance')}</div>
          <div class="grid gap-3 sm:grid-cols-3">
            <div>
              <div class="label">{$t('widgets.layout')}</div>
              <select class="input" bind:value={draft.config.layout}>
                <option value="inline">{$t('widgets.layout_inline')}</option>
                <option value="sensor">{$t('widgets.layout_sensor')}</option>
              </select>
            </div>
            <label class="flex items-end gap-2 pb-2 text-sm">
              <input type="checkbox" bind:checked={draft.config.show_name}/>
              <span>{$t('widgets.show_name_sensor')}</span>
            </label>
            <label class="flex items-end gap-2 pb-2 text-sm">
              <input type="checkbox" bind:checked={draft.config.show_refresh_time}/>
              <span>{$t('widgets.show_refresh_time')}</span>
            </label>
          </div>

          <div class="text-xs font-semibold uppercase text-slate-500 pt-2">{$t('widgets.prefix')}</div>
          <div class="grid gap-3 sm:grid-cols-4">
            <input class="input" placeholder="" bind:value={draft.config.prefix}/>
            <select class="input" bind:value={draft.config.prefix_size}>
              {#each SIZE_OPTS as [v, l]}<option value={v}>{l}</option>{/each}
            </select>
            <select class="input" bind:value={draft.config.prefix_weight}>
              {#each WEIGHT_OPTS as [v, l]}<option value={v}>{l}</option>{/each}
            </select>
            <select class="input" bind:value={draft.config.prefix_color}>
              {#each COLOR_OPTS as [v, l]}<option value={v}>{l}</option>{/each}
            </select>
          </div>

          <div class="text-xs font-semibold uppercase text-slate-500 pt-2">{$t('widgets.suffix')}</div>
          <div class="grid gap-3 sm:grid-cols-4">
            <input class="input" placeholder=" °C" bind:value={draft.config.suffix}/>
            <select class="input" bind:value={draft.config.suffix_size}>
              {#each SIZE_OPTS as [v, l]}<option value={v}>{l}</option>{/each}
            </select>
            <select class="input" bind:value={draft.config.suffix_weight}>
              {#each WEIGHT_OPTS as [v, l]}<option value={v}>{l}</option>{/each}
            </select>
            <select class="input" bind:value={draft.config.suffix_color}>
              {#each COLOR_OPTS as [v, l]}<option value={v}>{l}</option>{/each}
            </select>
          </div>

          <p class="text-xs text-slate-500">
            {$t('widgets.http_hint')}
          </p>
        </div>

      {:else if draft.kind === 'label'}
        <div class="rounded-xl border border-slate-200 p-3 dark:border-slate-700 space-y-3">
          <div class="flex items-center justify-between">
            <div class="text-xs font-semibold uppercase text-slate-500">{$t('widgets.items')}</div>
            <div class="flex gap-1">
              <button type="button" class="btn-ghost text-xs" onclick={() => addItem('text')}>{$t('widgets.add_text')}</button>
              <button type="button" class="btn-ghost text-xs" onclick={() => addItem('divider')}>{$t('widgets.add_line')}</button>
              <button type="button" class="btn-ghost text-xs" onclick={() => addItem('spacer')}>{$t('widgets.add_spacer')}</button>
            </div>
          </div>
          {#if !draft.config.items?.length}
            <p class="text-sm text-slate-500">{$t('widgets.no_items')}</p>
          {/if}
          {#each (draft.config.items || []) as it, i}
            <div class="rounded-lg border border-slate-200 p-2 dark:border-slate-700">
              <div class="mb-2 flex items-center justify-between">
                <div class="text-xs font-semibold uppercase text-slate-500">{$t('widgets.item_' + it.type)}</div>
                <div class="flex gap-1">
                  <button type="button" class="btn-ghost text-xs" disabled={i===0} onclick={() => moveItem(i, -1)} aria-label="↑"><Icon name="chevron-up" size={12}/></button>
                  <button type="button" class="btn-ghost text-xs" disabled={i===(draft.config.items.length-1)} onclick={() => moveItem(i, 1)} aria-label="↓"><Icon name="chevron-down" size={12}/></button>
                  <button type="button" class="btn-danger text-xs" onclick={() => removeItem(i)} aria-label={$t('common.remove')}><Icon name="trash" size={12}/></button>
                </div>
              </div>
              {#if it.type === 'text'}
                <div class="grid gap-2 sm:grid-cols-2">
                  <div class="sm:col-span-2">
                    <div class="label">{$t('widgets.text')}</div>
                    <input class="input" bind:value={it.text}/>
                  </div>
                  <div>
                    <div class="label">{$t('widgets.size')}</div>
                    <select class="input" bind:value={it.size}>
                      {#each SIZE_OPTS as [v, l]}<option value={v}>{l}</option>{/each}
                    </select>
                  </div>
                  <div>
                    <div class="label">{$t('widgets.weight')}</div>
                    <select class="input" bind:value={it.weight}>
                      {#each WEIGHT_OPTS as [v, l]}<option value={v}>{l}</option>{/each}
                    </select>
                  </div>
                  <div>
                    <div class="label">{$t('widgets.align')}</div>
                    <select class="input" bind:value={it.align}>
                      {#each ALIGN_OPTS as [v, l]}<option value={v}>{l}</option>{/each}
                    </select>
                  </div>
                  <div>
                    <div class="label">{$t('widgets.color')}</div>
                    <select class="input" bind:value={it.color}>
                      {#each COLOR_OPTS as [v, l]}<option value={v}>{l}</option>{/each}
                    </select>
                  </div>
                  <label class="flex items-end gap-2 pb-2 text-sm">
                    <input type="checkbox" bind:checked={it.italic}/>
                    <span>{$t('widgets.italic')}</span>
                  </label>
                </div>
              {:else if it.type === 'spacer'}
                <div>
                  <div class="label">{$t('widgets.spacer_size')}</div>
                  <select class="input" bind:value={it.size}>
                    <option value="sm">{$t('widgets.spacer_sm')}</option>
                    <option value="md">{$t('widgets.spacer_md')}</option>
                    <option value="lg">{$t('widgets.spacer_lg')}</option>
                  </select>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}

      {#if draft.kind === 'line'}
        <div class="rounded-xl border border-slate-200 p-3 dark:border-slate-700 space-y-3">
          <div class="text-xs font-semibold uppercase text-slate-500">{$t('widgets.line_section')}</div>
          <div class="grid gap-3 sm:grid-cols-2">
            <div>
              <div class="label">{$t('widgets.line_thickness')}</div>
              <select class="input" bind:value={draft.config.line_thickness}>
                <option value="thin">{$t('widgets.line_thin')}</option>
                <option value="medium">{$t('widgets.line_medium')}</option>
                <option value="thick">{$t('widgets.line_thick')}</option>
              </select>
            </div>
            <div>
              <div class="label">{$t('widgets.line_color')}</div>
              <select class="input" bind:value={draft.config.line_color}>
                {#each COLOR_OPTS as [v, l]}<option value={v}>{l}</option>{/each}
              </select>
            </div>
          </div>
        </div>
      {/if}

      <label class="flex items-center gap-2 text-sm">
        <input type="checkbox" bind:checked={draft.enabled}/> {$t('widgets.enabled')}
      </label>

      <!-- Live preview -->
      {#if draft.kind !== 'spacer'}
        <div>
          <div class="mb-1 text-xs font-semibold uppercase text-slate-500">{$t('widgets.preview')}</div>
          <div class="flex h-40 items-stretch rounded-xl border border-dashed border-slate-300 bg-slate-50/40 dark:border-slate-700 dark:bg-slate-900/40">
            <WidgetTile widget={draft} devices={data.devices}
                        httpValue={draft.id ? httpData[draft.id] : undefined}
                        groupState={previewGroupState(draft.config)}
                        groupConfig={previewGroupConfig(draft.config)}/>
          </div>
        </div>
      {/if}

      <div class="flex justify-end gap-2 pt-2">
        <button class="btn-ghost" onclick={cancelEdit}>{$t('common.cancel')}</button>
        <button class="btn-primary" onclick={save}>{draft.id ? $t('widgets.save') : $t('widgets.create')}</button>
      </div>
    </div>
  </div>
{/if}
