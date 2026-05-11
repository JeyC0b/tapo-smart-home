<script lang="ts">
  import type { Device, Hub } from '$lib/types';
  import { invalidateAll } from '$app/navigation';
  import Icon from '$lib/ui/Icon.svelte';
  import { t, tr } from '$lib/i18n';

  type DeviceWithHub = Device & { hub_name?: string };
  type HubRow = Hub & { child_count?: number };

  let { data }: { data: { devices: DeviceWithHub[]; hubs: HubRow[] } } = $props();

  let saving = $state<number | null>(null);
  let scanning = $state(false);
  let scanResult = $state<any>(null);
  let scanErr = $state<string | null>(null);
  let importing = $state<string | null>(null);
  let imported = $state<Set<string>>(new Set());

  // Manual add
  let manual = $state({ name: '', ip: '', username: '', password: '', kind: 'single' as 'single' | 'hub' });
  let manualErr = $state<string | null>(null);
  let manualBusy = $state(false);

  let testingHub = $state<number | null>(null);

  // Search across devices
  let search = $state('');
  const filtered = $derived(
    !search.trim()
      ? data.devices
      : data.devices.filter(d => {
          const q = search.toLowerCase();
          return (d.custom_name || '').toLowerCase().includes(q)
              || (d.tapo_alias  || '').toLowerCase().includes(q)
              || (d.room        || '').toLowerCase().includes(q)
              || (d.hub_name    || '').toLowerCase().includes(q)
              || d.device_id.toLowerCase().includes(q);
        })
  );

  async function save(d: Device, patch: Partial<Device>) {
    saving = d.id;
    try {
      const r = await fetch(`/api/devices/${d.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch)
      });
      if (!r.ok) alert(await r.text());
      await invalidateAll();
    } finally { saving = null; }
  }

  async function removeDevice(d: Device) {
    if (!confirm(tr('devices.delete_confirm', { name: d.custom_name || d.tapo_alias || d.device_id }))) return;
    await fetch(`/api/devices/${d.id}`, { method: 'DELETE' });
    await invalidateAll();
  }

  async function pollNow() {
    await fetch('/api/poll', { method: 'POST' });
    await invalidateAll();
  }

  async function scanNetwork() {
    scanning = true; scanErr = null; scanResult = null; imported = new Set();
    try {
      const r = await fetch('/api/discover', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ timeout: 8 })
      });
      if (!r.ok) { scanErr = await r.text(); return; }
      scanResult = await r.json();
    } finally { scanning = false; }
  }

  async function addFound(item: any) {
    if (!item.ip) { alert(tr('devices.add_failed_no_ip')); return; }
    importing = item.ip;
    try {
      const body: any = {
        ip: item.ip,
        alias: item.tapo_alias || item.model,
        kind_hint: item.kind === 'hub' ? 'hub' : 'single'
      };
      if (item.device_id) body.device_id = item.device_id;
      const r = await fetch('/api/devices/import', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!r.ok) { alert(await r.text()); return; }
      imported.add(item.ip); imported = new Set(imported);
      setTimeout(() => invalidateAll(), 1200);
    } finally { importing = null; }
  }

  async function repairIp(item: any) {
    if (!item.device_id || !item.ip) return;
    if (!confirm(tr('devices.ip_change_confirm', { name: item.tapo_alias || item.device_id, old: item.ip_change.old_ip, new: item.ip }))) return;
    importing = item.ip;
    try {
      const r = await fetch('/api/devices/import', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ip: item.ip, device_id: item.device_id, alias: item.tapo_alias || item.model })
      });
      if (!r.ok) { alert(await r.text()); return; }
      imported.add(item.ip); imported = new Set(imported);
      setTimeout(() => invalidateAll(), 1200);
    } finally { importing = null; }
  }

  async function manualAdd() {
    manualErr = null;
    if (!manual.ip) { manualErr = tr('devices.ip_required'); return; }
    manualBusy = true;
    try {
      const body: any = {
        ip: manual.ip,
        alias: manual.name || undefined,
        kind_hint: manual.kind
      };
      if (manual.username) body.username = manual.username;
      if (manual.password) body.password = manual.password;
      const r = await fetch('/api/devices/import', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!r.ok) { manualErr = await r.text(); return; }
      manual = { name: '', ip: '', username: '', password: '', kind: 'single' };
      await invalidateAll();
    } finally { manualBusy = false; }
  }

  async function toggleHub(h: HubRow) {
    await fetch(`/api/hubs/${h.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: h.enabled ? 0 : 1 })
    });
    await invalidateAll();
  }

  async function removeHub(h: HubRow) {
    const cnt = h.child_count ?? 0;
    const msg = cnt > 0
      ? tr('devices.hub_delete_with_children', { kind: h.kind === 'hub' ? tr('devices.hub_label') : tr('devices.device_label'), name: h.name, n: cnt })
      : tr('devices.hub_delete', { name: h.name });
    if (!confirm(msg)) return;
    const r = await fetch(`/api/hubs/${h.id}`, { method: 'DELETE' });
    if (!r.ok) { alert(await r.text()); return; }
    await invalidateAll();
  }

  async function testHub(h: HubRow) {
    testingHub = h.id;
    try {
      const r = await fetch('/api/discover', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ip: h.ip })
      });
      if (!r.ok) alert(await r.text());
      else alert(h.kind === 'hub' ? tr('devices.hub_test_ok_hub') : tr('devices.hub_test_ok_device'));
    } finally { testingHub = null; }
  }

  function kindLabel(k: string) {
    return tr(({
      sensor: 'kind.sensor', motion: 'kind.motion', contact: 'kind.contact',
      leak: 'kind.leak', switch: 'kind.switch', plug: 'kind.plug',
      bulb: 'kind.bulb', fan: 'kind.fan', strip: 'kind.strip',
      hub: 'kind.hub', button: 'kind.button', unknown: 'kind.unknown'
    } as any)[k] || k);
  }

  function kindIcon(k: string) {
    return ({
      sensor: 'thermometer', motion: 'motion', contact: 'door', leak: 'water',
      switch: 'switch', plug: 'plug', bulb: 'bulb', fan: 'fan', strip: 'strip',
      hub: 'hub', button: 'button'
    } as any)[k] || 'devices';
  }
</script>

<div class="mb-4 flex flex-wrap items-center justify-between gap-2">
  <h1 class="text-2xl font-bold">{$t('devices.title')}</h1>
  <div class="flex flex-wrap gap-2">
    <button class="btn-ghost flex items-center gap-1.5" onclick={scanNetwork} disabled={scanning}>
      <Icon name="search" size={16} />{scanning ? $t('devices.scanning') : $t('devices.scan')}
    </button>
    <button class="btn-primary flex items-center gap-1.5" onclick={pollNow}>
      <Icon name="refresh" size={16} />{$t('devices.poll_now')}
    </button>
  </div>
</div>

<!-- Sken -->
{#if scanErr}
  <div class="card mb-4 flex items-start gap-2 bg-rose-50 text-rose-700 dark:bg-rose-900/20">
    <Icon name="alert" size={18} /> <div>{scanErr}</div>
  </div>
{/if}
{#if scanResult}
  <div class="card mb-4 space-y-2">
    <div class="flex items-center justify-between">
      <div class="font-semibold">{$t('devices.found_on_network')}
        <span class="text-xs text-slate-500">
          ({scanResult.found?.length ?? 0}{scanResult.recovered?.length ? tr('devices.found_count_recovered', { n: scanResult.recovered.length }) : ''})
        </span>
      </div>
      <button class="btn-ghost text-xs" onclick={() => scanResult = null}>
        <Icon name="x" size={14} class="inline" /> {$t('common.close')}
      </button>
    </div>

    {#if scanResult.found?.length === 0}
      <div class="text-sm text-slate-500">{$t('devices.nothing_found')}</div>
    {/if}

    <div class="space-y-1 text-sm">
      {#each scanResult.found as f}
        {@const dup = imported.has(f.ip)}
        <div class="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 py-2 dark:border-slate-800">
          <div class="min-w-0 flex-1 flex items-start gap-2">
            <Icon name={kindIcon(f.kind || 'unknown')} size={20} class="mt-0.5 text-slate-500" />
            <div class="min-w-0">
              <div>
                <span class="font-medium">{f.tapo_alias || f.model || '?'}</span>
                {#if f.recovered_via}<span class="badge-warn ml-1 text-[10px]">{$t('devices.tpap_fallback')}</span>{/if}
              </div>
              <div class="text-xs text-slate-500">
                {f.ip ?? '?'} · {kindLabel(f.kind || 'unknown')} · {f.device_type || ''}
                {#if f.error} · <span class="text-rose-600">{f.error}</span>{/if}
              </div>
              {#if f.capabilities?.modules?.length}
                <div class="mt-1 flex flex-wrap gap-0.5">
                  {#each f.capabilities.modules as m}<span class="badge-off text-[10px]">{m}</span>{/each}
                </div>
              {/if}
            </div>
          </div>
          <div class="flex flex-col items-end gap-1">
            {#if dup}
              <span class="badge-on inline-flex items-center gap-1"><Icon name="check" size={12} />{$t('devices.added')}</span>
            {:else if f.ip_change}
              <span class="badge-warn text-[10px]">{tr('devices.ip_changed_from', { ip: f.ip_change.old_ip })}</span>
              <button class="btn-primary inline-flex items-center gap-1 text-xs"
                      onclick={() => repairIp(f)} disabled={importing === f.ip}>
                <Icon name="refresh" size={12} />{importing === f.ip ? '…' : $t('devices.update_ip')}
              </button>
            {:else if f.parent_device_id}
              <span class="text-xs text-slate-500">{$t('devices.will_be_added_with_hub')}</span>
            {:else if f.ip}
              <button class="btn-primary inline-flex items-center gap-1 text-xs"
                      onclick={() => addFound(f)} disabled={importing === f.ip}>
                <Icon name="plus" size={12} />{importing === f.ip ? '…' : $t('devices.add_dots')}
              </button>
            {/if}
          </div>
        </div>
      {/each}
    </div>

    {#if scanResult.unsupported?.length}
      <details class="text-xs text-slate-500">
        <summary>{tr('devices.unsupported', { n: scanResult.unsupported.length })}</summary>
        <ul class="mt-1 space-y-0.5">
          {#each scanResult.unsupported as u}<li>{u.info}{u.fallback_error ? ` — ${u.fallback_error}` : ''}</li>{/each}
        </ul>
      </details>
    {/if}
  </div>
{/if}

<!-- Manual add -->
<details class="card mb-6">
  <summary class="flex cursor-pointer items-center gap-2 font-semibold">
    <Icon name="plus" size={16} />{$t('devices.add_manual')}
  </summary>
  <div class="mt-3 grid gap-3 sm:grid-cols-2">
    <div>
      <div class="label">{$t('devices.add_name')}</div>
      <input class="input" placeholder={$t('devices.add_name_placeholder')} bind:value={manual.name}/>
    </div>
    <div>
      <div class="label">{$t('devices.ip_address')}</div>
      <input class="input" placeholder={$t('devices.ip_placeholder')} bind:value={manual.ip}/>
    </div>
    <div>
      <div class="label">{$t('devices.tapo_email')}</div>
      <input class="input" type="email" autocomplete="username" bind:value={manual.username}/>
    </div>
    <div>
      <div class="label">{$t('devices.tapo_password')}</div>
      <input class="input" type="password" autocomplete="current-password" bind:value={manual.password}/>
    </div>
    <div class="sm:col-span-2">
      <div class="label">{$t('devices.type_label')}</div>
      <div class="flex gap-2">
        <label class="flex flex-1 cursor-pointer items-center gap-2 rounded-xl border border-slate-200 bg-white p-3 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100
                       {manual.kind === 'single' ? '!border-brand-500 dark:!bg-brand-900/20 dark:!border-brand-400' : ''}">
          <input type="radio" bind:group={manual.kind} value="single" />
          <Icon name="plug" size={18} />
          <div>
            <div class="font-medium">{$t('devices.type_single')}</div>
            <div class="text-xs text-slate-500">{$t('devices.type_single_hint')}</div>
          </div>
        </label>
        <label class="flex flex-1 cursor-pointer items-center gap-2 rounded-xl border border-slate-200 bg-white p-3 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100
                       {manual.kind === 'hub' ? '!border-brand-500 dark:!bg-brand-900/20 dark:!border-brand-400' : ''}">
          <input type="radio" bind:group={manual.kind} value="hub" />
          <Icon name="hub" size={18} />
          <div>
            <div class="font-medium">{$t('devices.type_hub')}</div>
            <div class="text-xs text-slate-500">{$t('devices.type_hub_hint')}</div>
          </div>
        </label>
      </div>
    </div>
  </div>
  {#if manualErr}
    <div class="mt-3 flex items-center gap-2 rounded-lg bg-rose-100 p-2 text-sm text-rose-700">
      <Icon name="alert" size={14} />{manualErr}
    </div>
  {/if}
  <div class="mt-3">
    <button class="btn-primary inline-flex items-center gap-1" onclick={manualAdd} disabled={manualBusy}>
      <Icon name="plus" size={14} />{manualBusy ? $t('devices.adding') : $t('devices.add')}
    </button>
  </div>
</details>

<!-- HUBy / standalone -->
{#if data.hubs.length}
  <h2 class="mb-2 mt-2 text-lg font-semibold">{$t('devices.hubs_title')}</h2>
  <div class="mb-6 space-y-2">
    {#each data.hubs as h (h.id)}
      <div class="card flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <Icon name={h.kind === 'hub' ? 'hub' : 'plug'} size={18} class="text-slate-500" />
            <span class="badge {h.enabled ? 'badge-on' : 'badge-off'}">{h.enabled ? $t('devices.hub_active') : $t('devices.hub_disabled')}</span>
            <span class="badge-off">{h.kind === 'hub' ? $t('devices.hub_label') : $t('devices.hub_standalone')}</span>
            {#if (h.child_count ?? 0) > 0}
              <span class="badge-off">{tr('devices.devices_count', { n: h.child_count })}</span>
            {/if}
            <span class="font-semibold">{h.name}</span>
            <span class="text-xs text-slate-500">· {h.ip} · {h.username}</span>
          </div>
        </div>
        <div class="flex flex-wrap gap-2">
          <button class="btn-ghost inline-flex items-center gap-1 text-xs"
                  onclick={() => testHub(h)} disabled={testingHub === h.id}>
            <Icon name="wifi" size={12} />{testingHub === h.id ? $t('devices.testing') : $t('devices.test')}
          </button>
          <button class="btn-ghost inline-flex items-center gap-1 text-xs" onclick={() => toggleHub(h)}>
            {#if h.enabled}<Icon name="pause" size={12} />{$t('devices.hub_disable')}{:else}<Icon name="play" size={12} />{$t('devices.hub_enable')}{/if}
          </button>
          <button class="btn-danger inline-flex items-center gap-1 text-xs" onclick={() => removeHub(h)}>
            <Icon name="trash" size={12} />{$t('devices.delete')}
          </button>
        </div>
      </div>
    {/each}
  </div>
{/if}

<!-- Devices -->
<div class="mb-2 flex flex-wrap items-center justify-between gap-2">
  <h2 class="text-lg font-semibold">{tr('devices.connected_count', { n: filtered.length })}</h2>
  <div class="relative">
    <Icon name="search" size={14} class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
    <input class="input pl-7" placeholder={$t('common.search_placeholder')} bind:value={search}/>
  </div>
</div>

<div class="space-y-3">
  {#each filtered as d (d.id)}
    <div class="card {d.excluded ? 'opacity-60' : ''}">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <div class="mb-1 flex flex-wrap items-center gap-2">
            <Icon name={kindIcon(d.kind)} size={18} class="text-slate-500" />
            <span class="badge {d.online ? 'badge-on' : 'badge-err'} inline-flex items-center gap-1">
              <Icon name={d.online ? 'wifi' : 'wifi-off'} size={11} />{d.online ? $t('common.online') : $t('common.offline')}
            </span>
            <span class="badge-off">{kindLabel(d.kind)}</span>
            {#if d.hub_name}
              <span class="badge-off inline-flex items-center gap-1"><Icon name="hub" size={11} />{d.hub_name}</span>
            {/if}
            {#if d.is_momentary}<span class="badge-warn">{$t('devices.momentary_readonly')}</span>{/if}
            {#if d.guest_control === 0}<span class="badge-warn inline-flex items-center gap-1"><Icon name="lock" size={11} />{$t('devices.admin_only')}</span>{/if}
            {#if d.excluded}
              <span class="badge-warn inline-flex items-center gap-1"><Icon name="eye-off" size={11} />{$t('devices.hidden')}</span>
            {/if}
          </div>
          <div class="grid gap-2 sm:grid-cols-2">
            <div>
              <div class="label">{$t('devices.custom_name')}</div>
              <input class="input" value={d.custom_name ?? ''}
                     placeholder={d.tapo_alias ?? ''}
                     onchange={(e) => save(d, { custom_name: (e.currentTarget as HTMLInputElement).value || null })}/>
            </div>
            <div>
              <div class="label">{$t('devices.room')}</div>
              <input class="input" value={d.room ?? ''} placeholder={$t('devices.room_placeholder')}
                     onchange={(e) => save(d, { room: (e.currentTarget as HTMLInputElement).value || null })}/>
            </div>
          </div>
          <div class="mt-2 grid gap-1 text-xs text-slate-500 sm:grid-cols-2">
            <div>{$t('devices.tapo_alias')}: <code>{d.tapo_alias ?? '—'}</code></div>
            <div>{$t('devices.model')}: {d.model ?? '—'}</div>
            <div class="truncate">{$t('devices.device_id')}: <code>{d.device_id}</code></div>
            <div>
              {#if d.kind === 'sensor'}
                {$t('devices.temperature')}: <b>{d.temperature ?? '—'}</b> °C · {$t('devices.humidity')} {d.humidity ?? '—'}%
                {#if d.battery != null} · {$t('devices.battery')} {d.battery}%{/if}
              {:else if d.kind === 'motion'}
                {$t('devices.motion')}: <b>{d.motion === 1 ? $t('devices.motion_detected') : $t('devices.motion_calm')}</b>
                {#if d.battery != null} · {$t('devices.battery')} {d.battery}%{/if}
              {:else if d.kind === 'contact'}
                {$t('devices.contact_state')}: <b>{d.state ? $t('devices.contact_open') : $t('devices.contact_closed')}</b>
                {#if d.battery != null} · {$t('devices.battery')} {d.battery}%{/if}
              {:else if d.kind === 'leak'}
                {$t('devices.contact_state')}: <b>{d.state ? $t('devices.leak_label') : $t('devices.leak_dry')}</b>
                {#if d.battery != null} · {$t('devices.battery')} {d.battery}%{/if}
              {:else if d.state != null}
                {$t('devices.state')}: <b>{d.state ? 'ON' : 'OFF'}</b>
                {#if d.energy_w != null} · {d.energy_w} W{/if}
              {/if}
            </div>
          </div>
          {#if d.capabilities?.modules?.length}
            <div class="mt-2 flex flex-wrap gap-1">
              {#each d.capabilities.modules as m}<span class="badge-off text-[10px]">{m}</span>{/each}
            </div>
          {/if}
          <label class="mt-2 flex items-center gap-2 text-xs">
            <input type="checkbox" checked={d.guest_control !== 0}
                   onchange={(e) => save(d, { guest_control: (e.currentTarget as HTMLInputElement).checked ? 1 : 0 } as any)}/>
            <span class="text-slate-600 dark:text-slate-300">
              <b>{$t('devices.guest_can_control')}</b>
              <span class="text-slate-500">{$t('devices.guest_can_control_hint')}</span>
            </span>
          </label>
          <div class="mt-2 flex items-center gap-2 text-xs">
            <span class="text-slate-600 dark:text-slate-300"><b>{$t('devices.poll_interval')}</b></span>
            <input type="number" min="30" step="10" placeholder={$t('devices.poll_interval_placeholder')}
                   class="input !w-24 !py-1 !text-xs"
                   value={d.poll_interval_seconds ?? ''}
                   onchange={(e) => {
                     const v = (e.currentTarget as HTMLInputElement).value;
                     save(d, { poll_interval_seconds: v === '' ? null : Math.max(30, Number(v)) } as any);
                   }}/>
            <span class="text-slate-500">{$t('devices.poll_interval_unit')}</span>
          </div>
        </div>
        <div class="flex flex-col gap-1">
          <button class="btn-danger inline-flex items-center gap-1 text-xs" onclick={() => removeDevice(d)}>
            <Icon name="trash" size={12} />{$t('devices.delete')}
          </button>
        </div>
      </div>
    </div>
  {/each}
  {#if filtered.length === 0}
    <div class="card text-center text-slate-500">{$t('devices.empty')}</div>
  {/if}
</div>
