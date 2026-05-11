<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import Icon from '$lib/ui/Icon.svelte';
  import { t, tr } from '$lib/i18n';

  let { data } = $props();

  let editing = $state<any | null>(null);   // group being edited (or 'new')
  let busy    = $state(false);
  let err     = $state('');
  let toast   = $state('');
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  function flashToast(msg: string) {
    toast = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast = ''; }, 2200);
  }

  function newGroup() {
    editing = {
      id: null, name: '', icon: 'bulb', room: '',
      enabled: 1, device_ids: [],
      render_as: 'default', overlay_icon: 'layers'
    };
  }

  function edit(g: any) {
    editing = {
      id: g.id, name: g.name, icon: g.icon || 'bulb', room: g.room || '',
      enabled: g.enabled, device_ids: g.members.map((m: any) => m.device_id),
      render_as: g.config?.render_as || 'default',
      overlay_icon: g.config?.overlay_icon || 'layers'
    };
  }

  async function save() {
    if (!editing) return;
    busy = true; err = '';
    try {
      const config = {
        render_as: editing.render_as || 'default',
        overlay_icon: editing.overlay_icon || 'layers'
      };
      const body: any = {
        name: editing.name, icon: editing.icon, room: editing.room || null,
        enabled: editing.enabled, device_ids: editing.device_ids,
        config
      };
      let id = editing.id;
      if (!id) {
        const r = await fetch('/api/groups', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (!r.ok) { err = await r.text(); return; }
        id = (await r.json()).id;
      }
      const r2 = await fetch(`/api/groups/${id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!r2.ok) { err = await r2.text(); return; }
      const wasNew = !editing.id;
      editing = null;
      await invalidateAll();
      flashToast(wasNew ? tr('groups.created_toast') : tr('groups.saved_toast'));
    } finally { busy = false; }
  }

  async function del(g: any) {
    if (!confirm(tr('groups.delete_confirm', { name: g.name }))) return;
    await fetch(`/api/groups/${g.id}`, { method: 'DELETE' });
    await invalidateAll();
  }

  async function toggle(g: any) {
    await fetch(`/api/groups/${g.id}/toggle`, { method: 'POST', body: '{}' });
    await invalidateAll();
  }

  function memberLabel(m: any) {
    return m.custom_name || m.tapo_alias || `#${m.device_id}`;
  }

  function toggleDevice(id: number) {
    if (!editing) return;
    const i = editing.device_ids.indexOf(id);
    if (i >= 0) editing.device_ids.splice(i, 1);
    else editing.device_ids.push(id);
    editing = { ...editing };
  }
</script>

<div class="space-y-4">
  {#if toast}
    <div class="fixed left-1/2 top-4 z-50 -translate-x-1/2 rounded-full bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-lg">
      {toast}
    </div>
  {/if}
  <div class="flex items-center justify-between">
    <h1 class="text-xl font-bold">{$t('groups.title')}</h1>
    <button class="btn-primary" onclick={newGroup}>
      <Icon name="plus" size={16}/> {$t('groups.new_group')}
    </button>
  </div>

  <p class="text-sm text-slate-500">
    {$t('groups.intro')}
  </p>

  <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
    {#each data.groups as g}
      {@const anyOn = g.members.some((m: any) => m.state === 1)}
      <div class="card">
        <div class="mb-2 flex items-center justify-between">
          <div class="flex items-center gap-2 min-w-0">
            <Icon name={g.icon || 'bulb'} size={18} class={anyOn ? 'text-emerald-500' : 'text-slate-400'}/>
            <span class="truncate font-semibold">{g.name}</span>
            <Icon name="layers" size={12} class="text-slate-400"/>
          </div>
          <div class="flex items-center gap-1">
            <button class="btn-ghost !p-1" onclick={() => edit(g)} title={$t('common.edit')}><Icon name="edit" size={14}/></button>
            <button class="btn-danger !p-1" onclick={() => del(g)} title={$t('common.delete')}><Icon name="trash" size={14}/></button>
          </div>
        </div>
        <button class="w-full rounded-xl border-2 p-3 text-lg font-bold transition
                       {anyOn ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                              : 'border-slate-300 bg-slate-50 text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400'}"
                onclick={() => toggle(g)}>
          {anyOn ? $t('groups.on') : $t('groups.off')}
          <span class="block text-xs font-normal">{tr('groups.on_count', { on: g.members.filter((m: any) => m.state === 1).length, total: g.members.length })}</span>
        </button>
        {#if g.room}<div class="mt-1 text-xs text-slate-500">{g.room}</div>{/if}
        {#if g.members.length}
          <ul class="mt-2 space-y-0.5 text-xs text-slate-600 dark:text-slate-300">
            {#each g.members as m}
              <li class="flex items-center gap-1 truncate">
                <span class={m.state === 1 ? 'text-emerald-500' : 'text-slate-400'}>●</span>
                {memberLabel(m)}
              </li>
            {/each}
          </ul>
        {:else}
          <div class="mt-2 text-xs text-rose-500">{$t('groups.empty_members')}</div>
        {/if}
      </div>
    {:else}
      <div class="card text-sm text-slate-500">{$t('groups.empty_list')}</div>
    {/each}
  </div>
</div>

{#if editing}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
       role="dialog" aria-modal="true" tabindex="-1"
       onclick={(e) => { if (e.target === e.currentTarget) editing = null; }}
       onkeydown={(e) => { if (e.key === 'Escape') editing = null; }}>
    <div class="w-full max-w-2xl space-y-3 rounded-2xl bg-white p-5 shadow-xl dark:bg-slate-900 max-h-[90vh] overflow-y-auto">
      <h2 class="text-lg font-bold">{editing.id ? $t('groups.edit_group') : $t('groups.new_group')}</h2>
      {#if err}<div class="rounded bg-rose-50 p-2 text-sm text-rose-700">{err}</div>{/if}

      <div class="grid gap-2 sm:grid-cols-3">
        <div class="sm:col-span-2">
          <div class="label">{$t('groups.name')}</div>
          <input class="input" bind:value={editing.name} placeholder={$t('groups.name_placeholder')}/>
        </div>
        <div>
          <div class="label">{$t('groups.icon')}</div>
          <select class="input" bind:value={editing.icon}>
            <option value="bulb">{$t('groups.icon_bulb')}</option>
            <option value="plug">{$t('groups.icon_plug')}</option>
            <option value="strip">{$t('groups.icon_strip')}</option>
            <option value="fan">{$t('groups.icon_fan')}</option>
            <option value="switch">{$t('groups.icon_switch')}</option>
            <option value="layers">{$t('groups.icon_layers')}</option>
          </select>
        </div>
      </div>

      <div>
        <div class="label">{$t('groups.room')}</div>
        <input class="input" bind:value={editing.room} placeholder={$t('groups.room_placeholder')}/>
      </div>

      <div class="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
        <div class="mb-2 text-xs font-semibold uppercase text-slate-500">{$t('groups.appearance_section')}</div>
        <p class="mb-2 text-xs text-slate-500">
          {$t('groups.appearance_hint')}
        </p>
        <div class="grid gap-2 sm:grid-cols-2">
          <div>
            <div class="label">{$t('groups.tile_style')}</div>
            <select class="input" bind:value={editing.render_as}>
              <option value="default">{$t('groups.render_default')}</option>
              <option value="bulb">{$t('groups.render_bulb')}</option>
              <option value="plug">{$t('groups.render_plug')}</option>
            </select>
          </div>
          <div>
            <div class="label">{$t('groups.overlay_icon')}</div>
            <select class="input" bind:value={editing.overlay_icon}>
              <option value="layers">{$t('groups.overlay_layers')}</option>
              <option value="copy">{$t('groups.overlay_copy')}</option>
              <option value="hub">{$t('groups.overlay_hub')}</option>
              <option value="devices">{$t('groups.overlay_devices')}</option>
            </select>
          </div>
        </div>
      </div>

      <div>
        <div class="label">{tr('groups.members_count', { n: editing.device_ids.length })}</div>
        <div class="max-h-72 overflow-y-auto rounded-xl border border-slate-200 dark:border-slate-700">
          {#each data.devices as d}
            {@const checked = editing.device_ids.includes(d.id)}
            <label class="flex cursor-pointer items-center gap-2 border-b border-slate-100 p-2 last:border-b-0 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800">
              <input type="checkbox" {checked} onchange={() => toggleDevice(d.id)}/>
              <span class="flex-1 truncate">{d.custom_name || d.tapo_alias}</span>
              <span class="text-xs text-slate-500">{d.room || '—'} · {d.kind}</span>
            </label>
          {/each}
        </div>
      </div>

      <div class="flex justify-end gap-2 pt-2">
        <button class="btn-ghost" onclick={() => editing = null}>{$t('common.cancel')}</button>
        <button class="btn-primary" onclick={save} disabled={busy || !editing.name.trim()}>{$t('common.save')}</button>
      </div>
    </div>
  </div>
{/if}
