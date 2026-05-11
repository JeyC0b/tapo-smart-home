<script lang="ts">
  import type { Device } from '$lib/types';
  import { hsvToHex, hexToHsv } from '$lib/types';
  import { createEventDispatcher, untrack } from 'svelte';
  import { page } from '$app/stores';
  import Icon, { type IconName } from '$lib/ui/Icon.svelte';
  import { t } from '$lib/i18n';

  let { device }: { device: Device } = $props();
  const dispatch = createEventDispatcher();
  let busy = $state(false);
  let panel = $state<'none' | 'light' | 'countdown' | 'fan'>('none');

  const name = $derived(device.custom_name || device.tapo_alias || device.device_id);
  const caps = $derived(device.capabilities || {});
  const isMomentary = $derived(!!device.is_momentary || !!caps.is_momentary);
  // Per-device gate: when admin removed "Guests can control" in Settings,
  // buttons are disabled for guests (admin always sees everything).
  const isAdmin = $derived(!!$page.data.isAdmin);
  const canControl = $derived(isAdmin || device.guest_control !== 0);

  async function call(url: string, body: any) {
    busy = true;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!r.ok) alert(await r.text());
      dispatch('changed');
    } finally { busy = false; }
  }

  async function toggle() {
    await call(`/api/devices/${device.id}/state`, { on: !device.state });
  }
  // (S200B/S200D have no remote press — the UI button has been removed.)

  // light state
  let bri = $state(untrack(() => device.brightness ?? 80));
  let ctemp = $state(untrack(() => device.color_temp ?? 4000));
  // initialHsv — evaluated only on mount, hence untrack().
  let initialHsv: [number, number, number] = untrack(() => {
    if (device.hsv) {
      const p = device.hsv.split(',').map(Number);
      if (p.length === 3 && p.every(n => !isNaN(n))) return [p[0], p[1], p[2]] as [number, number, number];
    }
    return [0, 100, 100] as [number, number, number];
  });
  let pickerHex = $state(hsvToHex(...initialHsv));

  async function applyLight(p: any) { await call(`/api/devices/${device.id}/light`, p); }

  async function applyColorFromPicker() {
    const [h, s] = hexToHsv(pickerHex);
    // V is used as brightness — keep the current slider value
    await applyLight({ hsv: [h, s, bri] });
  }

  // countdown
  let cdMins = $state(15);
  let cdAction = $state<'on' | 'off' | 'toggle'>('off');
  let cdNative = $state(false);
  async function applyCountdown() {
    await call(`/api/devices/${device.id}/countdown`, {
      seconds: cdMins * 60, action: cdAction, native: cdNative
    });
    panel = 'none';
  }

  // fan
  let fanSpeed = $state(untrack(() => device.fan_speed ?? 1));
  async function applyFan() { await call(`/api/devices/${device.id}/fan`, { speed: fanSpeed }); }

  function kindIcon(k: string): IconName {
    return ({
      bulb: 'bulb', plug: 'plug', switch: 'switch', fan: 'fan',
      strip: 'strip', button: 'button', sensor: 'thermometer',
      motion: 'motion', contact: 'door', leak: 'water', hub: 'hub'
    } as Record<string, IconName>)[k] || 'devices';
  }

  // Predefined color palette for quick selection
  const PALETTE = [
    '#ff0000', '#ff7f00', '#ffff00', '#7fff00', '#00ff00', '#00ff7f',
    '#00ffff', '#007fff', '#0000ff', '#7f00ff', '#ff00ff', '#ff007f',
    '#ffffff', '#ffd6a5', '#ffadad'
  ];
</script>

<div class="card">
  <div class="flex items-start justify-between gap-3">
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-2">
        <Icon name={kindIcon(device.kind)} size={20} class="text-slate-500" />
        <span class="truncate font-semibold">{name}</span>
      </div>
      <div class="mt-0.5 flex flex-wrap gap-1 text-xs text-slate-500">
        <span class="badge-off">{device.kind}</span>
        <span class={device.online ? 'badge-on' : 'badge-err'}>{device.online ? $t('common.online') : $t('common.offline')}</span>
        {#if isMomentary}<span class="badge-warn">{$t('device_card.button_label')}</span>{/if}
        {#if device.energy_w != null}<span class="badge-off">{device.energy_w} W</span>{/if}
        {#if device.battery != null}<span class="badge-off inline-flex items-center gap-1"><Icon name="battery" size={11} />{device.battery}%</span>{/if}
      </div>
    </div>

    {#if device.kind === 'button' || isMomentary}
      <span class="badge-warn shrink-0 inline-flex items-center gap-1"
            title={$t('device_card.physical_button_hint')}>
        <Icon name="button" size={12} />{$t('device_card.physical_button')}
      </span>
    {:else if caps.can_toggle}
      <button onclick={toggle} disabled={busy || !device.online || !canControl}
              aria-label={$t('device_card.toggle_aria')}
              aria-pressed={!!device.state}
              title={canControl ? '' : $t('device_card.locked_hint')}
              class="relative h-9 w-16 shrink-0 rounded-full transition
                     {!canControl ? 'opacity-50 cursor-not-allowed ' : ''}
                     {device.state ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-700'}">
        <span class="absolute top-1 h-7 w-7 rounded-full bg-white shadow transition-all
                     {device.state ? 'left-8' : 'left-1'}"></span>
      </button>
    {/if}
  </div>

  <div class="mt-3 flex flex-wrap gap-1.5">
    {#if canControl && (caps.brightness || caps.color || caps.color_temp)}
      <button class="btn-ghost inline-flex items-center gap-1 text-xs" onclick={() => panel = panel === 'light' ? 'none' : 'light'}>
        <Icon name="bulb" size={12} />{$t('device_card.light')}
      </button>
    {/if}
    {#if canControl && caps.fan}
      <button class="btn-ghost inline-flex items-center gap-1 text-xs" onclick={() => panel = panel === 'fan' ? 'none' : 'fan'}>
        <Icon name="fan" size={12} />{$t('device_card.speed')}
      </button>
    {/if}
    {#if canControl && caps.can_toggle && !isMomentary}
      <button class="btn-ghost inline-flex items-center gap-1 text-xs" onclick={() => panel = panel === 'countdown' ? 'none' : 'countdown'}>
        <Icon name="refresh" size={12} />{$t('device_card.timer')}
      </button>
    {/if}
  </div>

  {#if panel === 'light'}
    <div class="mt-3 space-y-3 border-t border-slate-200 pt-3 dark:border-slate-800">
      {#if caps.brightness}
        <div>
          <div class="label flex justify-between">{$t('device_card.brightness')} <span>{bri}%</span></div>
          <input type="range" min="1" max="100" bind:value={bri} class="w-full"
                 onchange={() => applyLight({ brightness: bri })}/>
        </div>
      {/if}

      {#if caps.color}
        <div>
          <div class="label">{$t('device_card.color')}</div>
          <div class="flex items-center gap-2">
            <input type="color" bind:value={pickerHex}
                   onchange={applyColorFromPicker}
                   class="h-10 w-14 cursor-pointer rounded-lg border border-slate-300 dark:border-slate-700"/>
            <div class="flex flex-1 flex-wrap gap-1">
              {#each PALETTE as col}
                <button title={col}
                        onclick={() => { pickerHex = col; applyColorFromPicker(); }}
                        class="h-7 w-7 rounded-md border border-slate-200 transition hover:scale-110 dark:border-slate-700"
                        style="background:{col}"></button>
              {/each}
            </div>
          </div>
        </div>
      {/if}

      {#if caps.color_temp}
        {@const range = caps.color_temp?.range || [2500, 6500]}
        <div>
          <div class="label flex justify-between">{$t('device_card.white_temp')} <span>{ctemp} K</span></div>
          <input type="range" min={range[0]} max={range[1]} step="100" bind:value={ctemp} class="w-full"
                 onchange={() => applyLight({ color_temp: ctemp })}/>
        </div>
      {/if}

      {#if caps.light_effect && caps.light_effect.list?.length}
        <div>
          <div class="label">{$t('device_card.effect')}</div>
          <select class="input" onchange={(e) => applyLight({ effect: (e.currentTarget as HTMLSelectElement).value })}>
            <option value="">{$t('device_card.effect_none')}</option>
            {#each caps.light_effect.list as effect}<option>{effect}</option>{/each}
          </select>
        </div>
      {/if}
    </div>
  {/if}

  {#if panel === 'fan'}
    <div class="mt-3 border-t border-slate-200 pt-3 dark:border-slate-800">
      <div class="label flex justify-between">{$t('device_card.speed_label')} <span>{fanSpeed}/4</span></div>
      <input type="range" min="0" max="4" step="1" bind:value={fanSpeed} class="w-full"
             onchange={applyFan}/>
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
      {#if caps.countdown_native}
        <label class="flex items-center gap-2 text-xs text-slate-500">
          <input type="checkbox" bind:checked={cdNative}/>
          {$t('device_card.native_countdown')}
        </label>
      {/if}
      <button class="btn-primary w-full" onclick={applyCountdown} disabled={busy}>{$t('device_card.schedule')}</button>
    </div>
  {/if}
</div>
