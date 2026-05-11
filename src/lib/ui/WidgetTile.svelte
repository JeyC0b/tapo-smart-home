<script lang="ts">
  import Icon from '$lib/ui/Icon.svelte';
  import { t, tr, lang } from '$lib/i18n';

  /**
   * Reusable widget body (no chrome, no DnD).
   * Rendered inside a card on /widgets (preview) and on the home grid.
   *
   * Configuration (everything optional with sensible defaults):
   *   show_title        bool    - default true
   *   title_size        'xs'..'2xl'
   *   title_align       'left'|'center'|'right'
   *   title_weight      'normal'|'bold'|'black'
   *   title_color       'default'|'muted'|'success'|'warn'|'error'
   *   align             horizontal alignment of main value
   *   vertical_align    'top'|'middle'|'bottom'  (default 'top')
   *   value_size        'sm'..'5xl'
   *   value_weight      'normal'|'bold'|'black'
   *   value_color       'default'|'muted'|'success'|'warn'|'error'
   *   state_display     'icon'|'text'|'both'  - device widget
   *
   *   device_id         number  - device/sensor
   *   show_meta         bool
   *
   *   url, method, post_body, post_content_type, json_path, refresh_seconds
   *   show_refresh_time bool
   *   prefix, suffix, decimals
   *   prefix_size/weight/color, suffix_size/weight/color  - per-piece formatting
   *   layout            'inline' | 'sensor'  - HTTP widget: 'sensor' renders like a sensor (big number, suffix as small unit)
   *   show_name         bool   - HTTP sensor-style: shows widget.title as bold device-like name on top
   *
   *   primary           'temperature'|'humidity'|'battery'  - sensor widget
   *
   *   items[]           label widget rich content
   *
   *   group_id          number  - group widget
   */

  type Widget = {
    id: number;
    kind: 'device' | 'sensor' | 'http' | 'label' | 'spacer' | 'group' | 'line';
    title: string | null;
    config: any;
  };

  type GroupState = { on: number; total: number; any_on: boolean; all_on: boolean };

  let { widget, devices, httpValue, groupState, groupConfig }: {
    widget: Widget;
    devices: any[];
    httpValue?: { value: any; cached_at?: string | Date | null; error?: string | null; loading?: boolean };
    groupState?: GroupState;
    /** Per-group appearance from app_device_groups.config (render_as, overlay_icon, …). */
    groupConfig?: { render_as?: string; overlay_icon?: string } | null;
  } = $props();

  const cfg = $derived(widget.config || {});

  // ---- size / alignment helper maps ----
  const SIZE: Record<string, string> = {
    'xs':  'text-xs',
    'sm':  'text-sm',
    'md':  'text-base',
    'lg':  'text-lg',
    'xl':  'text-xl',
    '2xl': 'text-2xl',
    '3xl': 'text-3xl',
    '4xl': 'text-4xl',
    '5xl': 'text-5xl'
  };
  const ALIGN_TXT: Record<string, string> = {
    'left':   'text-left',
    'center': 'text-center',
    'right':  'text-right'
  };
  const ALIGN_ITEMS: Record<string, string> = {
    'left':   'items-start',
    'center': 'items-center',
    'right':  'items-end'
  };
  const VALIGN: Record<string, string> = {
    'top':    'justify-start',
    'middle': 'justify-center',
    'bottom': 'justify-end'
  };
  const WEIGHT: Record<string, string> = {
    'normal': 'font-normal',
    'bold':   'font-bold',
    'black':  'font-black'
  };
  const COLOR: Record<string, string> = {
    'default': '',
    'muted':   'text-slate-500 dark:text-slate-400',
    'success': 'text-emerald-600 dark:text-emerald-400',
    'warn':    'text-amber-600 dark:text-amber-400',
    'error':   'text-rose-600 dark:text-rose-400'
  };

  function sz(k: string | undefined, fb: string) { return SIZE[String(k || fb)] || SIZE[fb]; }
  function alignTxt(k: string | undefined, fb = 'center') { return ALIGN_TXT[String(k || fb)] || ALIGN_TXT[fb]; }
  function alignItems(k: string | undefined, fb = 'center') { return ALIGN_ITEMS[String(k || fb)] || ALIGN_ITEMS[fb]; }
  function valign(k: string | undefined, fb = 'top') { return VALIGN[String(k || fb)] || VALIGN[fb]; }
  function wt(k: string | undefined, fb = 'normal') { return WEIGHT[String(k || fb)] || WEIGHT[fb]; }
  function cl(k: string | undefined, fb = 'default') { return COLOR[String(k || fb)] || ''; }

  function findDevice(id: number) { return devices.find(d => d.id === id); }
  function deviceStateText(d: any): string { return d.state ? tr('widget_tile.on') : tr('widget_tile.off'); }
  function deviceMetaParts(d: any): string[] {
    const parts: string[] = [];
    if (d.temperature != null) parts.push(`${Number(d.temperature).toFixed(1)} °C`);
    if (d.humidity != null) parts.push(`${Number(d.humidity).toFixed(0)} %`);
    if (d.energy_w != null) parts.push(`${Number(d.energy_w).toFixed(1)} W`);
    if (d.battery != null) parts.push(`${tr('widget_tile.battery')} ${d.battery}%`);
    return parts;
  }

  // Formatted main HTTP value (just the number, prefix/suffix are rendered as separate spans).
  function httpMain(): string {
    const v = httpValue?.value;
    if (v == null) return '—';
    const num = typeof v === 'number' ? v : parseFloat(v);
    if (!isNaN(num) && isFinite(num)) {
      return num.toFixed(Number(cfg.decimals ?? 1));
    }
    if (typeof v === 'object') return JSON.stringify(v).slice(0, 30);
    return String(v);
  }

  const showTitle  = $derived(cfg.show_title !== false && !!widget.title);
  const titleAlign = $derived(alignTxt(cfg.title_align, 'left'));
  const titleSize  = $derived(sz(cfg.title_size, 'sm'));
  const titleWeight = $derived(wt(cfg.title_weight, 'bold'));
  const titleColor = $derived(cl(cfg.title_color, 'default'));

  const hAlignTxt   = $derived(alignTxt(cfg.align, 'center'));
  const hAlignItems = $derived(alignItems(cfg.align, 'center'));
  const vAlignCls   = $derived(valign(cfg.vertical_align, 'top'));

  const mainSize   = $derived(sz(cfg.value_size, '3xl'));
  const mainWeight = $derived(wt(cfg.value_weight, 'bold'));
  const mainColor  = $derived(cl(cfg.value_color, 'default'));

  const stateDisplay = $derived(String(cfg.state_display || 'icon'));

  // Per-piece prefix/suffix formatting for HTTP widget.
  const preCls = $derived(`${sz(cfg.prefix_size, 'md')} ${wt(cfg.prefix_weight, 'normal')} ${cl(cfg.prefix_color, 'muted')}`);
  const sufCls = $derived(`${sz(cfg.suffix_size, 'md')} ${wt(cfg.suffix_weight, 'normal')} ${cl(cfg.suffix_color, 'muted')}`);
</script>

<div class="flex h-full w-full flex-col gap-1 p-2 text-slate-900 dark:text-slate-100 overflow-hidden {hAlignItems}">
  {#if showTitle}
    <div class="w-full truncate {titleSize} {titleWeight} {titleAlign} {titleColor || 'text-slate-700 dark:text-slate-200'}">
      {widget.title}
    </div>
  {/if}

  {#if widget.kind === 'device'}
    {@const d = findDevice(Number(cfg.device_id))}
    {#if !d}
      <div class="text-slate-400">{$t('widget_tile.device_disconnected')}</div>
    {:else}
      <div class="flex flex-1 flex-col {vAlignCls} {hAlignItems} w-full">
        <div class="flex items-center gap-2 {mainSize} {mainWeight} {mainColor} tabular-nums">
          {#if stateDisplay !== 'text'}
            <Icon name={d.state ? 'bolt' : 'power'}
                  size={Math.max(20, parseInt(SIZE[String(cfg.value_size||'3xl')]?.match(/\d+/)?.[0] || '36'))}
                  class={d.state ? 'text-emerald-500' : 'text-slate-400'} />
          {/if}
          {#if stateDisplay !== 'icon'}
            <span class={d.state ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500'}>
              {deviceStateText(d)}
            </span>
          {/if}
        </div>
        <div class="mt-1 truncate text-sm text-slate-700 dark:text-slate-200 w-full {hAlignTxt}">
          {d.custom_name || d.tapo_alias || d.device_id}
        </div>
        {#if cfg.show_meta !== false}
          {@const meta = deviceMetaParts(d)}
          {#if meta.length}
            <div class="text-xs text-slate-500 truncate w-full {hAlignTxt}">{meta.join(' · ')}</div>
          {/if}
        {/if}
      </div>
    {/if}

  {:else if widget.kind === 'group'}
    {#if !groupState}
      <div class="text-slate-400">— {$t('widget_tile.group_label')} —</div>
    {:else}
      {@const on = groupState.any_on}
      <!-- Appearance: widget cfg.render_as (per-tile) overrides groupConfig.render_as (per-group). -->
      {@const renderAs = String(cfg.render_as || groupConfig?.render_as || 'default')}
      {@const overlayIcon = String(cfg.overlay_icon || groupConfig?.overlay_icon || 'layers')}
      {#if renderAs === 'bulb' || renderAs === 'plug'}
        <!-- "Looks-like-a-device" group rendering — same layout as a single device tile,
             with a tiny overlay icon to hint at group membership. -->
        <div class="relative flex flex-1 flex-col {vAlignCls} {hAlignItems} w-full">
          <div class="flex items-center gap-2 {mainSize} {mainWeight} {mainColor} tabular-nums">
            {#if stateDisplay !== 'text'}
              <Icon name={renderAs === 'bulb' ? 'bulb' : 'plug'}
                    size={Math.max(20, parseInt(SIZE[String(cfg.value_size||'3xl')]?.match(/\d+/)?.[0] || '36'))}
                    class={on ? (renderAs === 'bulb' ? 'text-amber-400' : 'text-emerald-500') : 'text-slate-400'} />
            {/if}
            {#if stateDisplay !== 'icon'}
              <span class={on ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500'}>
                {on ? $t('widget_tile.on') : $t('widget_tile.off')}
              </span>
            {/if}
          </div>
          <div class="mt-1 truncate text-sm text-slate-700 dark:text-slate-200 w-full {hAlignTxt}">
            {widget.title || $t('widget_tile.group_label')}
          </div>
          {#if cfg.show_meta !== false}
            <div class="text-xs text-slate-500 truncate w-full {hAlignTxt}">
              {tr('widget_tile.on_count', { on: groupState.on, total: groupState.total })}
            </div>
          {/if}
          <!-- Discreet overlay icon in the top-left corner, hinting "this is a group". -->
          <Icon name={overlayIcon as any} size={12}
                class="absolute left-1 top-1 text-slate-400/80 dark:text-slate-500/80" />
        </div>
      {:else}
        <div class="flex flex-1 flex-col {vAlignCls} {hAlignItems} w-full">
          <div class="flex items-center gap-2 {mainSize} {mainWeight} {mainColor} tabular-nums">
            {#if stateDisplay !== 'text'}
              <Icon name={on ? 'bolt' : 'power'}
                    size={Math.max(20, parseInt(SIZE[String(cfg.value_size||'3xl')]?.match(/\d+/)?.[0] || '36'))}
                    class={on ? 'text-emerald-500' : 'text-slate-400'} />
            {/if}
            <Icon name="layers" size={14} class="text-slate-400" />
            {#if stateDisplay !== 'icon'}
              <span class={on ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500'}>
                {on ? $t('widget_tile.on') : $t('widget_tile.off')}
              </span>
            {/if}
          </div>
          <div class="mt-1 truncate text-sm text-slate-700 dark:text-slate-200 w-full {hAlignTxt}">
            {widget.title || $t('widget_tile.group_label')}
          </div>
          {#if cfg.show_meta !== false}
            <div class="text-xs text-slate-500 truncate w-full {hAlignTxt}">
              {tr('widget_tile.on_count', { on: groupState.on, total: groupState.total })}
            </div>
          {/if}
        </div>
      {/if}
    {/if}

  {:else if widget.kind === 'sensor'}
    {@const d = findDevice(Number(cfg.device_id))}
    {#if !d}
      <div class="text-slate-400">{$t('widget_tile.device_disconnected')}</div>
    {:else}
      {@const primary = String(cfg.primary || 'temperature')}
      <div class="flex flex-1 flex-col {vAlignCls} {hAlignItems} w-full min-w-0">
        <div class="truncate text-base font-semibold text-slate-800 dark:text-slate-100 w-full {hAlignTxt}">
          {d.custom_name || d.tapo_alias || d.device_id}
        </div>
        {#if primary === 'humidity' && d.humidity != null}
          <div class="{mainSize} {mainWeight} {mainColor} tabular-nums leading-tight">
            {Number(d.humidity).toFixed(0)}<span class="ml-0.5 text-base font-normal text-slate-500">%</span>
          </div>
        {:else if primary === 'battery' && d.battery != null}
          <div class="{mainSize} {mainWeight} {mainColor} tabular-nums leading-tight">
            {d.battery}<span class="ml-0.5 text-base font-normal text-slate-500">%</span>
          </div>
        {:else if d.temperature != null}
          <div class="{mainSize} {mainWeight} {mainColor} tabular-nums leading-tight">
            {Number(d.temperature).toFixed(1)}<span class="ml-0.5 text-base font-normal text-slate-500">°C</span>
          </div>
        {:else}
          <div class="text-slate-400 {mainSize}">—</div>
        {/if}
        {#if cfg.show_meta !== false}
          <div class="text-xs text-slate-500 w-full truncate {hAlignTxt}">
            {#if primary !== 'humidity' && d.humidity != null}{$t('widget_tile.humidity')} {Number(d.humidity).toFixed(0)} %{/if}
            {#if primary !== 'battery' && d.battery != null}{primary !== 'humidity' && d.humidity != null ? ' · ' : ''}{$t('widget_tile.battery')} {d.battery}%{/if}
          </div>
        {/if}
      </div>
    {/if}

  {:else if widget.kind === 'http'}
    {@const layout = String(cfg.layout || 'inline')}
    <div class="flex flex-1 flex-col {vAlignCls} {hAlignItems} w-full">
      {#if layout === 'sensor' && cfg.show_name && widget.title}
        <div class="truncate text-base font-semibold text-slate-800 dark:text-slate-100 w-full {hAlignTxt}">
          {widget.title}
        </div>
      {/if}

      <div class="{mainSize} {mainWeight} {mainColor} tabular-nums leading-tight truncate w-full {hAlignTxt}">
        {#if cfg.prefix}<span class={preCls}>{cfg.prefix}</span>{/if}
        {httpMain()}
        {#if cfg.suffix}<span class="{sufCls} ml-0.5">{cfg.suffix}</span>{/if}
      </div>

      {#if httpValue?.error}
        <div class="text-[11px] text-rose-500 truncate w-full {hAlignTxt}" title={httpValue.error}>
          {tr('widget_tile.error', { msg: String(httpValue.error).slice(0, 60) })}
        </div>
      {:else if cfg.show_refresh_time && httpValue?.cached_at}
        <div class="text-[11px] text-slate-500 truncate w-full {hAlignTxt}">
          {tr('widget_tile.refreshed', { ts: new Date(httpValue.cached_at).toLocaleTimeString($lang === 'cs' ? 'cs-CZ' : 'en-US') })}
        </div>
      {/if}
    </div>

  {:else if widget.kind === 'label'}
    {#if Array.isArray(cfg.items) && cfg.items.length}
      <div class="flex flex-1 flex-col {vAlignCls} w-full gap-1">
        {#each cfg.items as it}
          {#if it.type === 'spacer'}
            <div class={it.size === 'lg' ? 'h-4' : it.size === 'md' ? 'h-2' : 'h-1'}></div>
          {:else if it.type === 'divider'}
            <hr class="border-slate-300 dark:border-slate-700"/>
          {:else}
            <div class="{sz(it.size, 'lg')} {wt(it.weight, 'normal')} {alignTxt(it.align, 'left')} {it.italic ? 'italic' : ''} {cl(it.color)} truncate w-full">
              {it.text || ''}
            </div>
          {/if}
        {/each}
      </div>
    {:else}
      <div class="flex flex-1 {vAlignCls} {hAlignItems} w-full">
        <div class="{mainSize} {mainWeight} {hAlignTxt} truncate" style={cfg.fontSize ? `font-size:${Number(cfg.fontSize)}px;line-height:1.2` : ''}>
          {cfg.text || widget.title || ''}
        </div>
      </div>
    {/if}

  {:else if widget.kind === 'spacer'}
    <div class="h-full w-full"></div>

  {:else if widget.kind === 'line'}
    {@const lc = String(cfg.line_color || 'default')}
    {@const lt = String(cfg.line_thickness || 'thin')}
    <div class="flex h-full w-full items-center px-1">
      <hr class="w-full {lt === 'thick' ? 'border-t-4' : lt === 'medium' ? 'border-t-2' : 'border-t'} {lc === 'success' ? 'border-emerald-500' : lc === 'warn' ? 'border-amber-500' : lc === 'error' ? 'border-rose-500' : lc === 'muted' ? 'border-slate-300 dark:border-slate-700' : 'border-slate-400 dark:border-slate-500'}"/>
    </div>
  {/if}
</div>
