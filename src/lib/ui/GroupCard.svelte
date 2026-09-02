<script lang="ts">
  import { apiError } from '$lib/api';
  import { toastError } from '$lib/ui/toast';
  import type { Device } from '$lib/types';
  import { hsvToHex, hexToHsv } from '$lib/types';
  import { createEventDispatcher, untrack } from 'svelte';
  import { page } from '$app/stores';
  import Icon, { type IconName } from '$lib/ui/Icon.svelte';
  import Spinner from '$lib/ui/Spinner.svelte';
  import { t, tr } from '$lib/i18n';

  /**
   * GroupCard — renders a device-group as if it were a single device.
   * Used on the home page when the group's appearance is set to bulb/plug.
   *
   * The component intentionally mirrors DeviceCard.svelte 1:1 in look & feel
   * (toggle pill on the right, "Light" / "Timer" buttons below). Actions
   * fan out to all matching members via /api/groups/:id/* endpoints.
   */
  let {
    group,
    devices,
    groupState,
    appearance
  }: {
    group: { id: number; name: string; room?: string | null; members: number[]; icon?: string | null };
    devices: Device[];
    groupState: { on: number; total: number; any_on: boolean; all_on: boolean } | undefined;
    appearance: 'bulb' | 'plug';
  } = $props();

  const dispatch = createEventDispatcher();
  // Which control the user clicked — the spinner is rendered right there.
  let busyKind = $state<null | 'toggle' | 'light' | 'countdown'>(null);
  let busy = $derived(busyKind !== null);
  let panel = $state<'none' | 'light' | 'countdown'>('none');

  const isAdmin = $derived(!!$page.data.isAdmin);

  // Collect this group's member devices from the page-wide list.
  const members = $derived(devices.filter(d => group.members.includes(d.id)));
  // Online if at least one member is reachable.
  const anyOnline = $derived(members.some(m => m.online));
  // Guests can control the group only if every member allows guest control.
  const canControl = $derived(isAdmin || members.every(m => m.guest_control !== 0));
  // Aggregate capabilities — show "Light" if ANY member is a light.
  const capsUnion = $derived.by(() => {
    let brightness: any = false, color: any = false, color_temp: any = false, light_effect: any = null;
    for (const m of members) {
      const c = m.capabilities || {};
      if (c.brightness) brightness = c.brightness;
      if (c.color) color = c.color;
      if (c.color_temp) color_temp = c.color_temp;
      if (c.light_effect) light_effect = c.light_effect;
    }
    return { brightness, color, color_temp, light_effect };
  });
  // Status: "any on" matches device-style power state.
  const isOn = $derived(!!groupState?.any_on);

  async function call(url: string, body: any, kind: NonNullable<typeof busyKind> = 'toggle') {
    busyKind = kind;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!r.ok) toastError(await apiError(r));
      dispatch('changed');
    } finally { busyKind = null; }
  }

  async function toggle() {
    // Group toggle: if anyone is on, turn all off; otherwise turn all on.
    await call(`/api/groups/${group.id}/toggle`, { on: !isOn }, 'toggle');
  }

  // ----- Light controls -----
  // Seed brightness/temp/colour ONCE from the members' average (untrack), the
  // same way DeviceCard does. A re-running $effect would re-seed on every data
  // refresh (the home page calls invalidateAll() every 60s and after each
  // action) and silently reset a slider/picker the user is mid-adjusting.
  let bri = $state(untrack(() => {
    const b = members.map(m => m.brightness).filter(x => typeof x === 'number') as number[];
    return b.length ? Math.round(b.reduce((a, c) => a + c, 0) / b.length) : 80;
  }));
  let ctemp = $state(untrack(() => {
    const t = members.map(m => m.color_temp).filter(x => typeof x === 'number') as number[];
    return t.length ? Math.round(t.reduce((a, c) => a + c, 0) / t.length) : 4000;
  }));
  let pickerHex = $state(untrack(() => {
    const m0 = members.find(m => m.hsv);
    if (m0?.hsv) {
      const p = m0.hsv.split(',').map(Number);
      if (p.length === 3 && p.every(n => !isNaN(n))) return hsvToHex(p[0], p[1], p[2]);
    }
    return '#ffffff';
  }));

  async function applyLight(p: any) { await call(`/api/groups/${group.id}/light`, p, 'light'); }
  async function applyColorFromPicker() {
    const [h, s] = hexToHsv(pickerHex);
    await applyLight({ hsv: [h, s, bri] });
  }

  // ----- Countdown -----
  let cdMins = $state(15);
  let cdAction = $state<'on' | 'off' | 'toggle'>('off');
  async function applyCountdown() {
    await call(`/api/groups/${group.id}/countdown`, {
      seconds: cdMins * 60, action: cdAction
    }, 'countdown');
    panel = 'none';
  }

  function kindIcon(): IconName {
    return appearance === 'plug' ? 'plug' : 'bulb';
  }

  // Predefined color palette for quick selection (matches DeviceCard).
  const PALETTE = [
    '#ff0000', '#ff7f00', '#ffff00', '#7fff00', '#00ff00', '#00ff7f',
    '#00ffff', '#007fff', '#0000ff', '#7f00ff', '#ff00ff', '#ff007f',
    '#ffffff', '#ffd6a5', '#ffadad'
  ];
</script>

<div class="card card-hover">
  <div class="flex items-start justify-between gap-3">
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-2">
        <!-- Subtle "this is a group" hint, then the chosen device-style icon. -->
        <Icon name="layers" size={14} class="text-slate-400" />
        <Icon name={kindIcon()} size={20} class={isOn ? (appearance === 'bulb' ? 'text-amber-400' : 'text-emerald-500') : 'text-slate-500'} />
        <span class="truncate font-semibold">{group.name}</span>
      </div>
      <div class="mt-0.5 flex flex-wrap gap-1 text-xs text-slate-500">
        <span class="badge-off">{appearance}</span>
        <span class={anyOnline ? 'badge-on' : 'badge-err'}>{anyOnline ? $t('common.online') : $t('common.offline')}</span>
        {#if groupState}<span class="badge-off">{tr('group_card.on_count', { on: groupState.on, total: groupState.total })}</span>{/if}
      </div>
    </div>

    <button onclick={toggle} disabled={busy || !anyOnline || !canControl}
            aria-label={$t('group_card.toggle_aria')}
            aria-pressed={isOn}
            aria-busy={busyKind === 'toggle'}
            title={canControl ? '' : $t('group_card.locked_hint')}
            class="toggle-pill
                   {canControl && anyOnline && !busy ? 'toggle-pill-active' : ''}
                   {!canControl ? 'opacity-50 cursor-not-allowed ' : ''}
                   {isOn ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-700'}">
      <span class="toggle-knob {isOn ? 'left-8' : 'left-1'}">
        {#if busyKind === 'toggle'}<Spinner size={14} class="text-slate-500" />{/if}
      </span>
    </button>
  </div>

  <div class="mt-3 flex flex-wrap gap-1.5">
    {#if canControl && (capsUnion.brightness || capsUnion.color || capsUnion.color_temp)}
      <button class="btn-ghost inline-flex items-center gap-1 text-xs" onclick={() => panel = panel === 'light' ? 'none' : 'light'}>
        {#if busyKind === 'light'}<Spinner size={12} />{:else}<Icon name="bulb" size={12} />{/if}{$t('device_card.light')}
      </button>
    {/if}
    {#if canControl}
      <button class="btn-ghost inline-flex items-center gap-1 text-xs" onclick={() => panel = panel === 'countdown' ? 'none' : 'countdown'}>
        {#if busyKind === 'countdown'}<Spinner size={12} />{:else}<Icon name="refresh" size={12} />{/if}{$t('device_card.timer')}
      </button>
    {/if}
  </div>

  {#if panel === 'light'}
    <div class="mt-3 space-y-3 border-t border-slate-200 pt-3 dark:border-slate-800">
      {#if capsUnion.brightness}
        <div>
          <div class="label flex justify-between">{$t('device_card.brightness')} <span>{bri}%</span></div>
          <input type="range" min="1" max="100" bind:value={bri} class="w-full"
                 onchange={() => applyLight({ brightness: bri })}/>
        </div>
      {/if}

      {#if capsUnion.color}
        <div>
          <div class="label">{$t('device_card.color')}</div>
          <div class="flex items-center gap-2">
            <input type="color" bind:value={pickerHex}
                   onchange={applyColorFromPicker}
                   class="h-10 w-14 cursor-pointer rounded-lg border border-slate-300 dark:border-slate-700"/>
            <div class="flex flex-1 flex-wrap gap-1">
              {#each PALETTE as col}
                <button title={col} disabled={busy}
                        onclick={() => { pickerHex = col; applyColorFromPicker(); }}
                        class="h-7 w-7 rounded-md border border-slate-200 transition hover:scale-110 hover:border-slate-400
                               active:scale-95 disabled:opacity-50 dark:border-slate-700"
                        style="background:{col}"></button>
              {/each}
            </div>
          </div>
        </div>
      {/if}

      {#if capsUnion.color_temp}
        {@const range = capsUnion.color_temp?.range || [2500, 6500]}
        <div>
          <div class="label flex justify-between">{$t('device_card.white_temp')} <span>{ctemp} K</span></div>
          <input type="range" min={range[0]} max={range[1]} step="100" bind:value={ctemp} class="w-full"
                 onchange={() => applyLight({ color_temp: ctemp })}/>
        </div>
      {/if}

      {#if capsUnion.light_effect && capsUnion.light_effect.list?.length}
        <div>
          <div class="label">{$t('device_card.effect')}</div>
          <select class="input" onchange={(e) => applyLight({ effect: (e.currentTarget as HTMLSelectElement).value })}>
            <option value="">{$t('device_card.effect_none')}</option>
            {#each capsUnion.light_effect.list as effect}<option>{effect}</option>{/each}
          </select>
        </div>
      {/if}
    </div>
  {/if}

  {#if panel === 'countdown'}
    <div class="mt-3 space-y-2 border-t border-slate-200 pt-3 dark:border-slate-800">
      <div class="grid grid-cols-2 gap-2">
        <div>
          <div class="label">{$t('device_card.action')}</div>
          <select class="input" bind:value={cdAction}>
            <option value="on">{$t('device_card.act_on')}</option>
            <option value="off">{$t('device_card.act_off')}</option>
            <option value="toggle">{$t('device_card.act_toggle')}</option>
          </select>
        </div>
        <div>
          <div class="label">{$t('device_card.after_min')}</div>
          <input class="input" type="number" min="1" bind:value={cdMins}/>
        </div>
      </div>
      <button class="btn-primary w-full" onclick={applyCountdown} disabled={busy}>
        {#if busyKind === 'countdown'}<Spinner size={14} />{/if}{$t('device_card.schedule')}
      </button>
    </div>
  {/if}
</div>
