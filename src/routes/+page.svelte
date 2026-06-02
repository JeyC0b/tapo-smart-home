<script lang="ts">
  import type { Device } from '$lib/types';
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/stores';
  import { onMount, onDestroy, untrack } from 'svelte';
  import DeviceCard from '$lib/ui/DeviceCard.svelte';
  import GroupCard from '$lib/ui/GroupCard.svelte';
  import WidgetTile from '$lib/ui/WidgetTile.svelte';
  import Icon from '$lib/ui/Icon.svelte';
  import { t } from '$lib/i18n';

  type Widget = {
    id: number;
    kind: 'device' | 'sensor' | 'http' | 'label' | 'spacer' | 'group' | 'line';
    title: string | null;
    config: any;
    on_home: 0 | 1;
    home_x: number; home_y: number;
    home_width: number; home_height: number;
  };

  type GroupState = { on: number; total: number; any_on: boolean; all_on: boolean };

  let { data }: { data: { devices: Device[]; widgets: Widget[]; groups: any[]; groupStates: Record<number, GroupState> } } = $props();
  let isAdmin = $derived(!!$page.data.isAdmin);

  async function toggleGroup(id: number) {
    try {
      await fetch(`/api/groups/${id}/toggle`, { method: 'POST', body: '{}' });
      await invalidateAll();
    } catch { /* ignore */ }
  }

  // ---------- HTTP widgety: hodnoty z DB-cache (nikoli per-mount fetch) ----------
  let httpData = $state<Record<number, any>>({});
  let pullTimer: ReturnType<typeof setInterval> | null = null;

  async function pullValue(id: number) {
    try {
      const r = await fetch(`/api/widgets/${id}/value`);
      if (!r.ok) return;
      httpData[id] = await r.json();
    } catch { /* ignore */ }
  }
  function pullAll() {
    for (const w of data.widgets) {
      if (w.on_home && w.kind === 'http') pullValue(w.id);
    }
  }

  onMount(() => {
    pullAll();
    // The client refreshes cache every 30 s. The server controls the actual refresh in scheduler.widgetTick().
    pullTimer = setInterval(pullAll, 30_000);
    // Sensors and devices are refreshed by the server poller; we just reload data periodically.
    const reloadInt = setInterval(() => invalidateAll(), 60_000);
    return () => clearInterval(reloadInt);
  });
  onDestroy(() => { if (pullTimer) clearInterval(pullTimer); });

  // ---------- Grid constants ----------
  const COLS = 12;
  const ROW_PX = 40;       // ← reduced from 80
  const GAP_PX = 8;
  // Mobile layout (< sm) = single column, tiles use their natural height
  let isMobile = $state(false);
  function checkViewport() {
    if (typeof window !== 'undefined') isMobile = window.innerWidth < 640;
  }
  onMount(() => {
    checkViewport();
    window.addEventListener('resize', checkViewport);
    return () => window.removeEventListener('resize', checkViewport);
  });

  // ---------- Edit mode + DnD ----------
  let editMode = $state(false);
  let gridEl: HTMLDivElement | undefined = $state();

  type Tile = {
    type: 'device' | 'widget';
    id: number;
    x: number; y: number; w: number; h: number;
    device?: Device;
    widget?: Widget;
  };

  let tiles = $state<Tile[]>([]);
  // Tiles with an in-flight position PATCH. A background invalidateAll() can
  // re-load page data before that PATCH commits; without this guard rebuildTiles
  // would revert the just-dragged tile to its old coordinates ("snap back").
  let savingKeys = new Set<string>();

  // Spacer and line widgets are slim by design — let them go down to a single 40 px row.
  function minHForKind(kind?: string) {
    return kind === 'spacer' || kind === 'line' ? 1 : 2;
  }

  function rebuildTiles() {
    const prev = new Map(tiles.map(t => [`${t.type}:${t.id}`, t]));
    const ts: Tile[] = [];
    for (const d of data.devices) {
      if ((d.on_home ?? 1) !== 1) continue;
      const keep = savingKeys.has(`device:${d.id}`) ? prev.get(`device:${d.id}`) : undefined;
      ts.push({
        type: 'device', id: d.id,
        x: keep ? keep.x : (d.home_x ?? 0), y: keep ? keep.y : (d.home_y ?? 0),
        w: keep ? keep.w : Math.max(2, Math.min(COLS, d.home_width ?? 4)),
        h: keep ? keep.h : Math.max(2, d.home_height ?? 4),
        device: d
      });
    }
    for (const w of data.widgets) {
      if (!w.on_home) continue;
      const minH = minHForKind(w.kind);
      const keep = savingKeys.has(`widget:${w.id}`) ? prev.get(`widget:${w.id}`) : undefined;
      ts.push({
        type: 'widget', id: w.id,
        x: keep ? keep.x : (w.home_x ?? 0), y: keep ? keep.y : (w.home_y ?? 0),
        w: keep ? keep.w : Math.max(2, Math.min(COLS, w.home_width ?? 4)),
        h: keep ? keep.h : Math.max(minH, w.home_height ?? Math.max(minH, 2)),
        widget: w
      });
    }
    tiles = ts;
  }
  $effect(() => { void data; untrack(rebuildTiles); });

  // Mobile order: top-to-bottom (Y), then left-to-right (X). User wants to see
  // each "row" of the desktop layout in sequence on mobile.
  let mobileTiles = $derived([...tiles].sort((a, b) => (a.y - b.y) || (a.x - b.x)));

  function tilesOverlap(a: { x:number;y:number;w:number;h:number }, b: { x:number;y:number;w:number;h:number }) {
    return !(a.x + a.w <= b.x || b.x + b.w <= a.x ||
             a.y + a.h <= b.y || b.y + b.h <= a.y);
  }
  function isPositionFree(x: number, y: number, w: number, h: number, ignoreKey?: string): boolean {
    const cand = { x, y, w, h };
    return !tiles.some(t => `${t.type}:${t.id}` !== ignoreKey && tilesOverlap(cand, t));
  }
  function findFreeSlot(w: number, h: number, ignoreKey?: string): { x: number; y: number } {
    for (let y = 0; y < 200; y++) {
      for (let x = 0; x <= COLS - w; x++) {
        if (isPositionFree(x, y, w, h, ignoreKey)) return { x, y };
      }
    }
    return { x: 0, y: 999 };
  }

  // ---------- Drag & Drop ----------
  let dragKey: string | null = $state(null);
  let dragOffset = { dx: 0, dy: 0 };
  let ghost = $state<{ x: number; y: number; w: number; h: number; visible: boolean; valid: boolean }>({
    x: 0, y: 0, w: 1, h: 1, visible: false, valid: true
  });

  function onPointerDown(e: PointerEvent, t: Tile) {
    if (!editMode || isMobile) return;
    if (e.button !== 0) return;
    const tile = (e.currentTarget as HTMLElement);
    tile.setPointerCapture(e.pointerId);
    const rect = tile.getBoundingClientRect();
    dragOffset = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    dragKey = `${t.type}:${t.id}`;
    ghost = { x: t.x, y: t.y, w: t.w, h: t.h, visible: true, valid: true };
    e.preventDefault();
  }
  function onPointerMove(e: PointerEvent) {
    if (!dragKey || !gridEl) return;
    const grid = gridEl.getBoundingClientRect();
    const colW = grid.width / COLS;
    const px = e.clientX - grid.left - dragOffset.dx;
    const py = e.clientY - grid.top - dragOffset.dy;
    let nx = Math.round(px / colW);
    let ny = Math.round(py / (ROW_PX + GAP_PX));
    nx = Math.max(0, Math.min(COLS - ghost.w, nx));
    ny = Math.max(0, ny);
    ghost.x = nx; ghost.y = ny;
    ghost.valid = isPositionFree(nx, ny, ghost.w, ghost.h, dragKey);
  }
  async function onPointerUp(e: PointerEvent) {
    if (!dragKey) return;
    const tile = tiles.find(t => `${t.type}:${t.id}` === dragKey);
    const wasValid = ghost.valid;
    const targetX = ghost.x, targetY = ghost.y;
    dragKey = null;
    ghost.visible = false;
    if (!tile) return;
    if (!wasValid) return; // overlap → do not move
    if (tile.x === targetX && tile.y === targetY) return;
    tile.x = targetX; tile.y = targetY;
    tiles = [...tiles];
    await persistPosition(tile);
  }

  async function persistPosition(t: Tile) {
    const key = `${t.type}:${t.id}`;
    savingKeys.add(key);
    const url = t.type === 'device' ? `/api/devices/${t.id}` : `/api/widgets/${t.id}`;
    try {
      await fetch(url, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          home_x: t.x, home_y: t.y, home_width: t.w, home_height: t.h
        })
      });
    } finally {
      savingKeys.delete(key);
    }
  }

  async function resize(t: Tile, dw: number, dh: number) {
    const minH = minHForKind(t.widget?.kind);
    const newW = Math.max(2, Math.min(COLS - t.x, t.w + dw));
    const newH = Math.max(minH, t.h + dh);
    // verify the new size doesn't cause overlap
    if (!isPositionFree(t.x, t.y, newW, newH, `${t.type}:${t.id}`)) {
      // move the tile down to the first free slot with the new size
      const slot = findFreeSlot(newW, newH, `${t.type}:${t.id}`);
      t.x = slot.x; t.y = slot.y;
    }
    t.w = newW; t.h = newH;
    tiles = [...tiles];
    await persistPosition(t);
  }

  // ---------- Pointer-driven resize (bottom-right corner handle) ----------
  let resizeKey = $state<string | null>(null);
  let resizeStart = $state({ sx: 0, sy: 0, w: 2, h: 2, x: 0, y: 0, minH: 2 });
  let resizeGhost = $state<{ x: number; y: number; w: number; h: number; visible: boolean; valid: boolean }>({
    x: 0, y: 0, w: 1, h: 1, visible: false, valid: true
  });

  function onResizePointerDown(e: PointerEvent, t: Tile) {
    if (!editMode || isMobile) return;
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    resizeKey = `${t.type}:${t.id}`;
    resizeStart = {
      sx: e.clientX, sy: e.clientY,
      w: t.w, h: t.h, x: t.x, y: t.y,
      minH: minHForKind(t.widget?.kind)
    };
    resizeGhost = { x: t.x, y: t.y, w: t.w, h: t.h, visible: true, valid: true };
  }
  function onResizePointerMove(e: PointerEvent) {
    if (!resizeKey || !gridEl) return;
    const grid = gridEl.getBoundingClientRect();
    const colW = grid.width / COLS;
    const dxCells = Math.round((e.clientX - resizeStart.sx) / colW);
    const dyCells = Math.round((e.clientY - resizeStart.sy) / (ROW_PX + GAP_PX));
    const newW = Math.max(2, Math.min(COLS - resizeStart.x, resizeStart.w + dxCells));
    const newH = Math.max(resizeStart.minH, resizeStart.h + dyCells);
    resizeGhost.w = newW;
    resizeGhost.h = newH;
    resizeGhost.valid = isPositionFree(resizeStart.x, resizeStart.y, newW, newH, resizeKey);
  }
  async function onResizePointerUp() {
    if (!resizeKey) return;
    const key = resizeKey;
    const t = tiles.find(x => `${x.type}:${x.id}` === key);
    const wasValid = resizeGhost.valid;
    const newW = resizeGhost.w, newH = resizeGhost.h;
    resizeKey = null;
    resizeGhost.visible = false;
    if (!t || !wasValid) return;
    if (t.w === newW && t.h === newH) return;
    t.w = newW; t.h = newH;
    tiles = [...tiles];
    await persistPosition(t);
  }

  async function removeFromHome(t: Tile) {
    const url = t.type === 'device' ? `/api/devices/${t.id}` : `/api/widgets/${t.id}`;
    await fetch(url, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ on_home: 0 })
    });
    await invalidateAll();
  }

  // ---------- Pickery ----------
  let pickerOpen = $state<null | 'device' | 'widget' | 'group'>(null);

  let availableDevices = $derived(data.devices.filter(d => (d.on_home ?? 1) === 0));
  let availableWidgets = $derived(data.widgets.filter(w => !w.on_home));
  // Groups that do not yet have their own widget on the home screen.
  let groupIdsOnHome = $derived(new Set(
    data.widgets
      .filter(w => w.on_home && w.kind === 'group' && w.config?.group_id)
      .map(w => Number(w.config.group_id))
  ));
  let availableGroups = $derived(data.groups.filter((g: any) => !groupIdsOnHome.has(g.id)));

  async function addDeviceToHome(d: Device) {
    const slot = findFreeSlot(4, 4);
    await fetch(`/api/devices/${d.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ on_home: 1, home_x: slot.x, home_y: slot.y, home_width: 4, home_height: 4 })
    });
    pickerOpen = null;
    await invalidateAll();
  }
  async function addWidgetToHome(w: Widget) {
    const slot = findFreeSlot(4, 4);
    await fetch(`/api/widgets/${w.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ on_home: 1, home_x: slot.x, home_y: slot.y, home_width: 4, home_height: 4 })
    });
    pickerOpen = null;
    pullValue(w.id);
    await invalidateAll();
  }
  // Adds a group to the home screen by creating a pre-filled "group" widget linked to the group
  // and placing it in the first free grid slot. If a widget for this group already exists
  // (but is not on the home screen), it is reused — no duplicates are created.
  async function addGroupToHome(g: any) {
    const slot = findFreeSlot(4, 4);
    const existing = data.widgets.find(w =>
      w.kind === 'group' && Number(w.config?.group_id) === g.id
    );
    if (existing) {
      await fetch(`/api/widgets/${existing.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          on_home: 1, enabled: 1,
          home_x: slot.x, home_y: slot.y, home_width: 4, home_height: 4
        })
      });
    } else {
      const r = await fetch('/api/widgets', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'group',
          title: g.name,
          config: {
            group_id: g.id,
            show_title: true,
            state_display: 'icon',
            show_meta: true,
            title_size: 'sm', title_align: 'left', title_weight: 'bold', title_color: 'default',
            align: 'center', vertical_align: 'top',
            value_size: '3xl', value_weight: 'bold', value_color: 'default'
          },
          enabled: 1, on_home: 1
        })
      });
      if (!r.ok) { alert(await r.text()); return; }
      const { id } = await r.json();
      await fetch(`/api/widgets/${id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ home_x: slot.x, home_y: slot.y, home_width: 4, home_height: 4 })
      });
    }
    pickerOpen = null;
    await invalidateAll();
  }

  const SENSOR_KINDS = new Set(['sensor','motion','contact','leak']);
  function isSensor(d: Device) { return SENSOR_KINDS.has(d.kind); }

  function gridRows() {
    let maxY = 6;
    for (const t of tiles) maxY = Math.max(maxY, t.y + t.h);
    return Math.max(maxY + (editMode ? 4 : 0), 6);
  }
</script>

<svelte:window
  onpointermove={(e) => { onPointerMove(e); onResizePointerMove(e); }}
  onpointerup={(e) => { onPointerUp(e); onResizePointerUp(); }} />

<div class="space-y-3">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h1 class="text-2xl font-bold">{$t('home.title')}</h1>
    <div class="flex flex-wrap gap-2">
      {#if isAdmin}
        <button class="btn-ghost inline-flex items-center gap-1 text-sm" onclick={() => pickerOpen = 'device'}>
          <Icon name="plus" size={14} /><span class="hidden sm:inline">{$t('home.add_prefix')}</span>{$t('home.add_device')}
        </button>
        <button class="btn-ghost inline-flex items-center gap-1 text-sm" onclick={() => pickerOpen = 'group'}>
          <Icon name="plus" size={14} /><span class="hidden sm:inline">{$t('home.add_prefix')}</span>{$t('home.add_group')}
        </button>
        <button class="btn-ghost inline-flex items-center gap-1 text-sm" onclick={() => pickerOpen = 'widget'}>
          <Icon name="plus" size={14} /><span class="hidden sm:inline">{$t('home.add_prefix')}</span>{$t('home.add_widget')}
        </button>
        <button class="btn-ghost inline-flex items-center gap-1 text-sm" onclick={() => editMode = !editMode}>
          {#if editMode}<Icon name="check" size={14} />{$t('home.done')}{:else}<Icon name="edit" size={14} />{$t('home.rearrange')}{/if}
        </button>
      {/if}
      <button class="btn-ghost inline-flex items-center gap-1 text-sm" onclick={() => invalidateAll()}>
        <Icon name="refresh" size={14} /><span class="hidden sm:inline">{$t('home.refresh')}</span>
      </button>
    </div>
  </div>

  {#if tiles.length === 0}
    <div class="card text-center text-slate-500">
      {$t('home.empty')}
      {#if isAdmin}{$t('home.empty_hint_admin')}{/if}
    </div>
  {/if}

  {#if editMode && !isMobile}
    <p class="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
      <Icon name="info" size={12} class="inline" /> {$t('home.edit_hint_desktop')}
    </p>
  {:else if editMode && isMobile}
    <p class="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
      {$t('home.edit_hint_mobile')}
    </p>
  {/if}

  <!-- DESKTOP grid -->
  {#if !isMobile}
    <div bind:this={gridEl}
         class="relative grid select-none"
         style="grid-template-columns: repeat({COLS}, minmax(0, 1fr));
                grid-auto-rows: {ROW_PX}px;
                gap: {GAP_PX}px;
                {editMode ? `min-height: ${gridRows() * (ROW_PX + GAP_PX)}px; background-image: linear-gradient(to right, rgb(148 163 184 / .15) 1px, transparent 1px), linear-gradient(to bottom, rgb(148 163 184 / .15) 1px, transparent 1px); background-size: calc((100% + ${GAP_PX}px) / ${COLS}) ${ROW_PX + GAP_PX}px;` : ''}">

      {#each tiles as tile (tile.type + ':' + tile.id)}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div class="relative {editMode ? 'cursor-move ring-2 ring-brand-400/50 rounded-2xl' : ''}"
             style="grid-column: {tile.x + 1} / span {tile.w}; grid-row: {tile.y + 1} / span {tile.h};"
             role={editMode ? 'button' : 'presentation'}
             tabindex={editMode ? 0 : undefined}
             aria-label={editMode ? $t('home.tile.move') : undefined}
             onpointerdown={editMode ? (e) => onPointerDown(e, tile) : null}
             onkeydown={editMode ? (e) => { if (e.key === 'Delete' || e.key === 'Backspace') removeFromHome(tile); } : null}>

          {#if tile.type === 'device' && tile.device}
            {@const d = tile.device}
            {#if isSensor(d)}
              <div class="card h-full overflow-hidden" class:opacity-60={d.excluded === 1}>
                <div class="flex items-center justify-between gap-1 min-w-0">
                  <span class="truncate text-sm font-semibold">{d.custom_name || d.tapo_alias}</span>
                  <span class={d.online ? 'badge-on' : 'badge-err'}>{d.online ? '●' : '○'}</span>
                </div>
                {#if d.kind === 'sensor'}
                  <div class="mt-1 text-3xl font-bold tabular-nums leading-tight">
                    {d.temperature ?? '—'}<span class="ml-0.5 text-base font-normal text-slate-500">°C</span>
                  </div>
                  {#if d.humidity != null}<div class="text-xs text-slate-500">{$t('home.sensor.humidity')} {d.humidity}%</div>{/if}
                  {#if d.battery != null}<div class="text-xs text-slate-500">{$t('home.sensor.battery')} {d.battery}%</div>{/if}
                {:else if d.kind === 'motion'}
                  <div class="mt-1 flex items-center gap-2">
                    <Icon name={d.motion === 1 ? 'alert' : 'eye'} size={28} class={d.motion === 1 ? 'text-rose-500' : 'text-slate-400'} />
                    <div class="text-lg font-bold">{d.motion === 1 ? $t('home.sensor.motion') : $t('home.sensor.calm')}</div>
                  </div>
                  {#if d.battery != null}<div class="mt-1 text-xs text-slate-500">{$t('home.sensor.battery')} {d.battery}%</div>{/if}
                {:else if d.kind === 'contact'}
                  <div class="mt-1 flex items-center gap-2">
                    <Icon name={d.state ? 'door' : 'lock'} size={28} class={d.state ? 'text-amber-500' : 'text-emerald-500'} />
                    <div class="text-lg font-bold">{d.state ? $t('home.sensor.open') : $t('home.sensor.closed')}</div>
                  </div>
                  {#if d.battery != null}<div class="mt-1 text-xs text-slate-500">{$t('home.sensor.battery')} {d.battery}%</div>{/if}
                {:else if d.kind === 'leak'}
                  <div class="mt-1 flex items-center gap-2">
                    <Icon name={d.state ? 'water' : 'check'} size={28} class={d.state ? 'text-rose-500' : 'text-emerald-500'} />
                    <div class="text-lg font-bold">{d.state ? $t('home.sensor.leak') : $t('home.sensor.dry')}</div>
                  </div>
                  {#if d.battery != null}<div class="mt-1 text-xs text-slate-500">{$t('home.sensor.battery')} {d.battery}%</div>{/if}
                {/if}
              </div>
            {:else}
              <DeviceCard device={d} on:changed={() => invalidateAll()}/>
            {/if}
          {:else if tile.type === 'widget' && tile.widget}
            {#if tile.widget.kind === 'group'}
              {@const gid = Number(tile.widget.config?.group_id)}
              {@const grp = data.groups.find(g => g.id === gid)}
              {@const gcfg = grp?.config ?? null}
              {@const renderAs = String(tile.widget.config?.render_as || gcfg?.render_as || 'default')}
              {#if grp && (renderAs === 'bulb' || renderAs === 'plug')}
                <!-- Group rendered as a single device card (DeviceCard look-alike). -->
                <GroupCard group={grp} devices={data.devices}
                           groupState={data.groupStates[gid]}
                           appearance={renderAs as 'bulb' | 'plug'}
                           on:changed={() => invalidateAll()} />
              {:else}
                <button type="button" class="card h-full w-full overflow-hidden p-0 text-left"
                        onclick={() => { if (!editMode) toggleGroup(gid); }}>
                  <WidgetTile widget={tile.widget} devices={data.devices}
                              groupState={data.groupStates[gid]} groupConfig={gcfg} />
                </button>
              {/if}
            {:else}
              <div class="card h-full overflow-hidden p-0">
                <WidgetTile widget={tile.widget} devices={data.devices} httpValue={httpData[tile.widget.id]} />
              </div>
            {/if}
          {/if}

          {#if editMode}
            <div class="absolute right-1 top-1 z-10 flex gap-0.5"
                 role="toolbar" aria-label={$t('home.tile.controls')} tabindex="-1"
                 onpointerdown={(e) => e.stopPropagation()}>
              <button class="btn-ghost !p-1" title={$t('home.tile.narrower')} aria-label={$t('home.tile.narrower')}
                      onclick={() => resize(tile, -1, 0)}><Icon name="chevron-left" size={12} /></button>
              <button class="btn-ghost !p-1" title={$t('home.tile.wider')} aria-label={$t('home.tile.wider')}
                      onclick={() => resize(tile, 1, 0)}><Icon name="chevron-right" size={12} /></button>
              <button class="btn-ghost !p-1" title={$t('home.tile.shorter')} aria-label={$t('home.tile.shorter')}
                      onclick={() => resize(tile, 0, -1)}><Icon name="chevron-up" size={12} /></button>
              <button class="btn-ghost !p-1" title={$t('home.tile.taller')} aria-label={$t('home.tile.taller')}
                      onclick={() => resize(tile, 0, 1)}><Icon name="chevron-down" size={12} /></button>
              <button class="btn-danger !p-1" title={$t('home.tile.remove')} aria-label={$t('home.tile.remove')}
                      onclick={() => removeFromHome(tile)}><Icon name="trash" size={12} /></button>
            </div>
            <!-- Drag-resize corner handle (bottom-right) -->
            <div class="absolute bottom-1 right-1 z-10 flex h-5 w-5 cursor-nwse-resize items-center justify-center rounded
                        bg-brand-500/20 text-brand-700 hover:bg-brand-500/40 dark:text-brand-300"
                 role="button" tabindex="-1" aria-label={$t('home.tile.resize')}
                 title={$t('home.tile.resize_title')}
                 onpointerdown={(e) => onResizePointerDown(e, tile)}>
              <Icon name="grip-resize" size={12} />
            </div>
          {/if}
        </div>
      {/each}

      {#if ghost.visible}
        <div class="pointer-events-none rounded-2xl border-2 border-dashed {ghost.valid ? 'border-brand-400 bg-brand-400/10' : 'border-rose-500 bg-rose-500/10'}"
             style="grid-column: {ghost.x + 1} / span {ghost.w}; grid-row: {ghost.y + 1} / span {ghost.h};"></div>
      {/if}
      {#if resizeGhost.visible}
        <div class="pointer-events-none rounded-2xl border-2 border-dashed {resizeGhost.valid ? 'border-emerald-400 bg-emerald-400/10' : 'border-rose-500 bg-rose-500/10'}"
             style="grid-column: {resizeStart.x + 1} / span {resizeGhost.w}; grid-row: {resizeStart.y + 1} / span {resizeGhost.h};"></div>
      {/if}
    </div>

  <!-- MOBILE: single-column stack ordered by home_y then home_x -->
  {:else}
    <div class="flex flex-col gap-2">
      {#each mobileTiles as tile (tile.type + ':' + tile.id)}
        <div class="relative">
          {#if tile.type === 'device' && tile.device}
            {@const d = tile.device}
            {#if isSensor(d)}
              <div class="card">
                <div class="flex items-center justify-between gap-1">
                  <span class="truncate text-sm font-semibold">{d.custom_name || d.tapo_alias}</span>
                  <span class={d.online ? 'badge-on' : 'badge-err'}>{d.online ? '●' : '○'}</span>
                </div>
                {#if d.kind === 'sensor' && d.temperature != null}
                  <div class="mt-1 text-3xl font-bold tabular-nums leading-tight">
                    {d.temperature}<span class="ml-0.5 text-base font-normal text-slate-500">°C</span>
                  </div>
                {/if}
                {#if d.humidity != null}<div class="text-xs text-slate-500">{$t('home.sensor.humidity')} {d.humidity}%</div>{/if}
                {#if d.battery != null}<div class="text-xs text-slate-500">{$t('home.sensor.battery')} {d.battery}%</div>{/if}
              </div>
            {:else}
              <DeviceCard device={d} on:changed={() => invalidateAll()}/>
            {/if}
          {:else if tile.type === 'widget' && tile.widget}
            {#if tile.widget.kind === 'group'}
              {@const gid = Number(tile.widget.config?.group_id)}
              {@const grp = data.groups.find(g => g.id === gid)}
              {@const gcfg = grp?.config ?? null}
              {@const renderAs = String(tile.widget.config?.render_as || gcfg?.render_as || 'default')}
              {#if grp && (renderAs === 'bulb' || renderAs === 'plug')}
                <GroupCard group={grp} devices={data.devices}
                           groupState={data.groupStates[gid]}
                           appearance={renderAs as 'bulb' | 'plug'}
                           on:changed={() => invalidateAll()} />
              {:else}
                <button type="button" class="card w-full p-0 min-h-[120px] text-left"
                        onclick={() => toggleGroup(gid)}>
                  <WidgetTile widget={tile.widget} devices={data.devices}
                              groupState={data.groupStates[gid]} groupConfig={gcfg} />
                </button>
              {/if}
            {:else}
              <div class="card p-0 min-h-[120px]">
                <WidgetTile widget={tile.widget} devices={data.devices} httpValue={httpData[tile.widget.id]} />
              </div>
            {/if}
          {/if}
          {#if editMode}
            <div class="absolute right-1 top-1 z-10 flex gap-0.5">
              <button class="btn-danger !p-1" title={$t('home.tile.remove')} aria-label={$t('home.tile.remove')}
                      onclick={() => removeFromHome(tile)}><Icon name="trash" size={12} /></button>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<!-- Picker -->
{#if pickerOpen}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
       role="dialog" aria-modal="true" tabindex="-1"
       onclick={(e) => { if (e.target === e.currentTarget) pickerOpen = null; }}
       onkeydown={(e) => { if (e.key === 'Escape') pickerOpen = null; }}>
    <div class="w-full max-w-2xl space-y-3 rounded-2xl bg-white p-5 shadow-xl dark:bg-slate-900 max-h-[85vh] overflow-y-auto">
      <h2 class="text-lg font-bold">
        {#if pickerOpen === 'device'}{$t('home.picker.add_device_to_home')}
        {:else if pickerOpen === 'group'}{$t('home.picker.add_group_to_home')}
        {:else}{$t('home.picker.add_widget_to_home')}{/if}
      </h2>

      {#if pickerOpen === 'device'}
        {#if availableDevices.length === 0}
          <p class="text-sm text-slate-500">{$t('home.picker.all_devices_on_home')}</p>
        {:else}
          <div class="grid gap-2 sm:grid-cols-2">
            {#each availableDevices as d}
              <button class="flex items-center justify-between gap-2 rounded-xl border border-slate-200 p-2 text-left hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
                      onclick={() => addDeviceToHome(d)}>
                <div class="min-w-0">
                  <div class="truncate text-sm font-medium">{d.custom_name || d.tapo_alias || d.device_id}</div>
                  <div class="text-[11px] text-slate-500">{d.room || $t('common.unassigned')} · {d.kind}</div>
                </div>
                <Icon name="plus" size={14} class="shrink-0 text-brand-600" />
              </button>
            {/each}
          </div>
        {/if}
      {:else if pickerOpen === 'group'}
        {#if availableGroups.length === 0}
          <p class="text-sm text-slate-500">
            {$t('home.picker.no_groups')}
            {$t('home.picker.manage_groups')} <a href="/groups" class="underline">{$t('home.picker.groups_link_label')}</a>.
          </p>
        {:else}
          <p class="text-xs text-slate-500">
            {$t('home.picker.group_hint')} <a href="/groups" class="underline">{$t('home.picker.groups_link_label')}</a>.
          </p>
          <div class="grid gap-2 sm:grid-cols-2">
            {#each availableGroups as g}
              <button class="flex items-center justify-between gap-2 rounded-xl border border-slate-200 p-2 text-left hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
                      onclick={() => addGroupToHome(g)}>
                <div class="flex items-center gap-2 min-w-0">
                  <Icon name={g.icon || 'layers'} size={18} class="shrink-0 text-slate-500" />
                  <div class="min-w-0">
                    <div class="truncate text-sm font-medium">{g.name}</div>
                    <div class="text-[11px] text-slate-500">
                      {g.room || $t('common.unassigned')}
                      {#if g.config?.render_as && g.config.render_as !== 'default'} · {$t('home.picker.appearance')}: {g.config.render_as}{/if}
                    </div>
                  </div>
                </div>
                <Icon name="plus" size={14} class="shrink-0 text-brand-600" />
              </button>
            {/each}
          </div>
        {/if}
      {:else}
        {#if availableWidgets.length === 0}
          <p class="text-sm text-slate-500">
            {$t('home.picker.no_widgets')} <a href="/widgets" class="underline">{$t('home.picker.create_widget')}</a>.
          </p>
        {:else}
          <div class="grid gap-2 sm:grid-cols-2">
            {#each availableWidgets as w}
              <button class="flex items-center justify-between gap-2 rounded-xl border border-slate-200 p-2 text-left hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
                      onclick={() => addWidgetToHome(w)}>
                <div class="min-w-0">
                  <div class="truncate text-sm font-medium">{w.title || $t('widgets.untitled')}</div>
                  <div class="text-[11px] text-slate-500">{w.kind}</div>
                </div>
                <Icon name="plus" size={14} class="shrink-0 text-brand-600" />
              </button>
            {/each}
          </div>
        {/if}
      {/if}

      <div class="flex justify-end pt-2">
        <button class="btn-ghost" onclick={() => pickerOpen = null}>{$t('common.close')}</button>
      </div>
    </div>
  </div>
{/if}
