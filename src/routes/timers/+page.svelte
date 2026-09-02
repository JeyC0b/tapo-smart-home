<script lang="ts">
  import { apiError } from '$lib/api';
  import { toastError } from '$lib/ui/toast';
  import { invalidateAll, goto } from '$app/navigation';
  import { page } from '$app/stores';
  import Icon from '$lib/ui/Icon.svelte';
  import Spinner from '$lib/ui/Spinner.svelte';
  import { t, tr, lang } from '$lib/i18n';

  type Timer = any;
  let { data }: {
    data: {
      timers: Timer[];
      devices: any[];
      view: 'pending' | 'history' | 'all';
      page: number; pageSize: number; total: number; totalPages: number;
    }
  } = $props();

  const ACTION_LABEL = $derived<Record<string, string>>({
    on: $t('timers.act_on'), off: $t('timers.act_off'), toggle: $t('timers.act_toggle'),
    on_for: $t('timers.act_on_for'), off_for: $t('timers.act_off_for')
  });
  const REPEAT_LABEL = $derived<Record<string, string>>({
    once: $t('timers.repeat_once'), minutely: $t('timers.repeat_minutely'), hourly: $t('timers.repeat_hourly'),
    daily: $t('timers.repeat_daily'), weekly: $t('timers.repeat_weekly'), monthly: $t('timers.repeat_monthly')
  });
  const DAYS_LABELS = $derived([
    $t('days.mon'), $t('days.tue'), $t('days.wed'), $t('days.thu'),
    $t('days.fri'), $t('days.sat'), $t('days.sun')
  ]);
  const localeStr = $derived($lang === 'cs' ? 'cs-CZ' : 'en-US');

  function nowLocalISO(plusMin = 5): string {
    const d = new Date(Date.now() + plusMin * 60_000);
    d.setSeconds(0, 0);
    const tzOff = d.getTimezoneOffset() * 60_000;
    return new Date(d.getTime() - tzOff).toISOString().slice(0, 16);
  }
  function toLocalInput(v: string | Date | null): string {
    if (!v) return '';
    const d = new Date(v);
    if (isNaN(d.getTime())) return '';
    const tzOff = d.getTimezoneOffset() * 60_000;
    return new Date(d.getTime() - tzOff).toISOString().slice(0, 16);
  }

  type FormMode = 'create' | 'edit' | 'duplicate';
  type FormState = ReturnType<typeof blank>;

  function blank() {
    return {
      id: 0,
      title: '',
      device_ids: [] as number[],
      action: 'on' as 'on'|'off'|'toggle'|'on_for'|'off_for',
      duration_minutes: 30,
      run_at: nowLocalISO(),
      repeat_kind: 'once' as 'once'|'minutely'|'hourly'|'daily'|'weekly'|'monthly',
      repeat_interval: 1,
      repeat_until: '' as string,
      days: [true,true,true,true,true,true,true],
      is_random: false,
      random_window_start: '18:00',
      random_window_end:   '23:00',
      random_min_minutes: 5,
      random_max_minutes: 30,
      // Vacation / presence simulation
      vacation_min_per_day: 2,
      vacation_max_per_day: 5,
      vacation_min_duration_min: 8,
      vacation_max_duration_min: 35,
      vacation_pick_one: true,
      vacation_dim_chance: 30,
      note: ''
    };
  }
  let formMode = $state<FormMode>('create');
  let f = $state<FormState>(blank());
  let formOpen = $state(false);
  let busy = $state(false);

  function openCreate() {
    formMode = 'create'; f = blank(); formOpen = true;
  }
  function openEdit(t: Timer) {
    formMode = 'edit';
    f = fromTimer(t, /*keepId*/ true);
    formOpen = true;
  }
  function openDuplicate(t: Timer) {
    formMode = 'duplicate';
    f = fromTimer(t, /*keepId*/ false);
    f.run_at = nowLocalISO(5);
    formOpen = true;
  }
  function fromTimer(t: Timer, keepId: boolean): FormState {
    let ids: number[] = [];
    if (t.device_ids) {
      try {
        const a = JSON.parse(t.device_ids);
        if (Array.isArray(a)) ids = a.map(Number).filter(Boolean);
      } catch {}
    }
    if (ids.length === 0 && t.device_id) ids = [Number(t.device_id)];
    const days = [];
    for (let i = 0; i < 7; i++) days.push(((t.days_mask ?? 127) & (1 << i)) !== 0);
    return {
      id: keepId ? t.id : 0,
      title: t.title || '',
      device_ids: ids,
      action: t.action,
      duration_minutes: t.duration_minutes ?? 30,
      run_at: toLocalInput(t.run_at) || nowLocalISO(),
      repeat_kind: t.repeat_kind || 'once',
      repeat_interval: t.repeat_interval || 1,
      repeat_until: toLocalInput(t.repeat_until),
      days,
      is_random: !!t.is_random,
      random_window_start: (t.random_window_start || '18:00').slice(0, 5),
      random_window_end:   (t.random_window_end   || '23:00').slice(0, 5),
      random_min_minutes: t.random_min_minutes ?? 5,
      random_max_minutes: t.random_max_minutes ?? 30,
      vacation_min_per_day: t.vacation_min_per_day ?? 2,
      vacation_max_per_day: t.vacation_max_per_day ?? 5,
      vacation_min_duration_min: t.vacation_min_duration_min ?? 8,
      vacation_max_duration_min: t.vacation_max_duration_min ?? 35,
      vacation_pick_one: !!t.vacation_pick_one,
      vacation_dim_chance: t.vacation_dim_chance ?? 30,
      note: t.note || ''
    };
  }

  function dname(t: Timer): string {
    if (t.device_ids) {
      try {
        const ids = JSON.parse(t.device_ids);
        if (Array.isArray(ids) && ids.length > 1) {
          const names = ids.map((id: number) => {
            const d = data.devices.find((x: any) => x.id === id);
            return d ? (d.custom_name || d.tapo_alias || d.device_id) : `#${id}`;
          });
          return `${names[0]} +${names.length - 1}`;
        }
      } catch {}
    }
    return t.custom_name || t.tapo_alias || t.device_uid || `#${t.device_id}`;
  }

  function repeatText(t: Timer): string {
    if (t.repeat_kind === 'once') return '—';
    const lbl = REPEAT_LABEL[t.repeat_kind] || t.repeat_kind;
    let extra = '';
    if (t.repeat_interval > 1) extra = ` × ${t.repeat_interval}`;
    if ((t.repeat_kind === 'daily' || t.repeat_kind === 'weekly') && t.days_mask !== 127) {
      const days: string[] = [];
      for (let i = 0; i < 7; i++) if (t.days_mask & (1 << i)) days.push(DAYS_LABELS[i]);
      extra += ` (${days.join(', ')})`;
    }
    return lbl + extra;
  }

  function statusBadge(s: string, retrying = false): string {
    if (s === 'pending' && retrying) return 'badge-warn';
    return s === 'pending' ? 'badge-on'
         : s === 'done'    ? 'badge-off'
         : s === 'failed'  ? 'badge-err'
                           : 'badge-warn';
  }

  function toggleDevice(id: number) {
    f.device_ids = f.device_ids.includes(id)
      ? f.device_ids.filter(x => x !== id)
      : [...f.device_ids, id];
  }
  function daysToMask(): number {
    let m = 0;
    for (let i = 0; i < 7; i++) if (f.days[i]) m |= (1 << i);
    return m || 127;
  }

  async function submit(e?: Event) {
    e?.preventDefault();
    if (f.device_ids.length === 0) { toastError(tr('timers.pick_one_device')); return; }
    busy = true;
    try {
      const isEdit = formMode === 'edit' && f.id;
      const body: any = {
        title: f.title.trim() || null,
        device_ids: f.device_ids,
        action: f.action,
        repeat_kind: f.repeat_kind,
        repeat_interval: Number(f.repeat_interval) || 1,
        repeat_until: f.repeat_until || null,
        days_mask: daysToMask(),
        is_random: f.is_random ? 1 : 0,
        note: f.note.trim() || null
      };
      if (f.action === 'on_for' || f.action === 'off_for') {
        body.duration_minutes = Number(f.duration_minutes);
      }
      if (f.is_random) {
        body.random_window_start = f.random_window_start;
        body.random_window_end = f.random_window_end;
        body.random_min_minutes = Number(f.random_min_minutes);
        body.random_max_minutes = Number(f.random_max_minutes);
        body.vacation_min_per_day = Number(f.vacation_min_per_day) || 1;
        body.vacation_max_per_day = Math.max(
          Number(f.vacation_max_per_day) || 1,
          Number(f.vacation_min_per_day) || 1
        );
        body.vacation_min_duration_min = Number(f.vacation_min_duration_min) || 1;
        body.vacation_max_duration_min = Math.max(
          Number(f.vacation_max_duration_min) || 1,
          Number(f.vacation_min_duration_min) || 1
        );
        body.vacation_pick_one = f.vacation_pick_one ? 1 : 0;
        body.vacation_dim_chance = Math.min(100, Math.max(0, Number(f.vacation_dim_chance) || 0));
        if (body.repeat_kind === 'once') body.repeat_kind = 'daily';
      } else {
        // Guard against an empty/cleared datetime-local: new Date('').toISOString()
        // throws RangeError, which (with no catch) silently aborted the submit.
        const at = new Date(f.run_at);
        if (isNaN(at.getTime())) { toastError(tr('timers.invalid_time')); return; }
        body.run_at = at.toISOString();
      }
      const url = isEdit ? `/api/timers/${f.id}` : '/api/timers';
      const r = await fetch(url, {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!r.ok) { toastError(await apiError(r)); return; }
      formOpen = false; f = blank();
      await invalidateAll();
    } finally { busy = false; }
  }

  async function cancelTimer(t: Timer) {
    if (!confirm(tr('timers.cancel_confirm'))) return;
    const r = await fetch(`/api/timers/${t.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'cancelled' })
    });
    if (!r.ok) { toastError(await apiError(r)); return; }
    await invalidateAll();
  }
  async function delTimer(t: Timer) {
    if (!confirm(tr('timers.delete_confirm'))) return;
    const r = await fetch(`/api/timers/${t.id}`, { method: 'DELETE' });
    if (!r.ok) { toastError(await apiError(r)); return; }
    await invalidateAll();
  }

  // ---- runs viewer ----
  let runsTimer = $state<Timer | null>(null);
  let runs = $state<any[]>([]);
  let runsLoading = $state(false);
  async function showRuns(t: Timer) {
    runsTimer = t; runs = []; runsLoading = true;
    try {
      const r = await fetch(`/api/timers/${t.id}/runs`);
      const j = await r.json();
      runs = j.runs || [];
    } finally { runsLoading = false; }
  }

  async function changeView(v: 'pending'|'history'|'all') {
    const u = new URL($page.url);
    u.searchParams.set('view', v);
    u.searchParams.delete('page');
    await goto(u.pathname + u.search, { invalidateAll: true });
  }
  async function gotoPage(p: number) {
    const u = new URL($page.url);
    u.searchParams.set('page', String(p));
    await goto(u.pathname + u.search, { invalidateAll: true });
  }

  let groupedDevices = $derived.by(() => {
    const m = new Map<string, any[]>();
    for (const d of data.devices) {
      const r = d.room || tr('common.unassigned');
      const a = m.get(r) || [];
      a.push(d); m.set(r, a);
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  });

  let formTitle = $derived(
    formMode === 'edit'      ? $t('timers.edit_timer')
    : formMode === 'duplicate' ? $t('timers.duplicate_timer')
    : $t('timers.new_timer')
  );
</script>

<div class="mb-4 flex flex-wrap items-center justify-between gap-2">
  <h1 class="text-2xl font-bold">{$t('timers.title')}</h1>
  <div class="flex flex-wrap gap-1">
    <button class="btn-ghost text-xs {data.view==='pending' ? '!bg-brand-600 !text-white' : ''}" onclick={() => changeView('pending')}>{$t('timers.view_pending')}</button>
    <button class="btn-ghost text-xs {data.view==='history' ? '!bg-brand-600 !text-white' : ''}" onclick={() => changeView('history')}>{$t('timers.view_history')}</button>
    <button class="btn-ghost text-xs {data.view==='all'     ? '!bg-brand-600 !text-white' : ''}" onclick={() => changeView('all')}>{$t('timers.view_all')}</button>
    <button class="btn-primary inline-flex items-center gap-1 text-sm" onclick={openCreate}>
      <Icon name="plus" size={14} />{$t('timers.new_timer')}
    </button>
  </div>
</div>

<div class="card overflow-x-auto">
  {#if data.timers.length === 0}
    <div class="py-6 text-center text-slate-500">{$t('timers.empty')}</div>
  {:else}
    <table class="w-full text-sm">
      <thead class="text-left text-xs uppercase text-slate-500">
        <tr>
          <th class="py-1 pr-2">{$t('timers.col_status')}</th>
          <th class="pr-2">{$t('timers.col_time')}</th>
          <th class="pr-2">{$t('timers.col_action')}</th>
          <th class="pr-2">{$t('timers.col_device')}</th>
          <th class="pr-2">{$t('timers.col_repeat')}</th>
          <th class="pr-2">{$t('timers.col_note')}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each data.timers as timer (timer.id)}
          <tr class="border-t border-slate-100 transition-colors hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/40">
            <td class="py-1 pr-2"><span class={statusBadge(timer.status, !!timer.retry_at)}>{$t('timers.status_' + timer.status) ?? timer.status}</span></td>
            <td class="whitespace-nowrap pr-2">
              <div class="font-mono text-xs">{new Date(timer.run_at).toLocaleString(localeStr)}</div>
              {#if timer.executed_at}
                <div class="text-[10px] text-slate-500">{$t('timers.executed_short')} {new Date(timer.executed_at).toLocaleString(localeStr)}</div>
              {/if}
              <!-- A pending timer whose device did not answer keeps retrying;
                   show when the next attempt is due so the state is not a mystery. -->
              {#if timer.status === 'pending' && timer.retry_at}
                <div class="text-[10px] text-amber-600 dark:text-amber-400">
                  {tr('timers.retry_at', { ts: new Date(timer.retry_at).toLocaleString(localeStr) })}
                  · {tr('timers.attempt_badge', { n: timer.attempt_count })}
                </div>
              {/if}
              {#if timer.error_message}
                <div class="text-[10px] text-rose-500" title={timer.error_message}>{$t('timers.error_prefix')} {timer.error_message.slice(0, 60)}</div>
              {/if}
            </td>
            <td class="pr-2">
              <span class="font-medium">{ACTION_LABEL[timer.action] || timer.action}</span>
              {#if timer.duration_minutes && (timer.action==='on_for' || timer.action==='off_for')}
                <span class="text-xs text-slate-500"> {timer.duration_minutes}m</span>
              {/if}
            </td>
            <td class="pr-2">
              <div class="font-medium">{dname(timer)}</div>
              {#if timer.title}<div class="text-[10px] text-slate-500">{timer.title}</div>{/if}
            </td>
            <td class="pr-2 text-xs">
              {repeatText(timer)}
              {#if timer.is_random}<span class="badge-warn ml-1">{$t('timers.vacation_badge')}</span>{/if}
              {#if timer.is_revert}<span class="badge-off ml-1">{$t('timers.revert_badge')}</span>{/if}
            </td>
            <td class="pr-2 text-xs text-slate-500">{timer.note || ''}</td>
            <td class="text-right">
              <div class="flex justify-end gap-1">
                <button class="btn-ghost text-xs" onclick={() => showRuns(timer)} title={$t('timers.show_runs')}>
                  <Icon name="logs" size={12} />
                </button>
                {#if timer.status === 'pending'}
                  <button class="btn-ghost text-xs" onclick={() => openEdit(timer)} title={$t('timers.edit')}>
                    <Icon name="edit" size={12} />
                  </button>
                  <button class="btn-ghost text-xs" onclick={() => cancelTimer(timer)} title={$t('timers.cancel_pending')}>
                    <Icon name="pause" size={12} />
                  </button>
                {:else}
                  <button class="btn-ghost text-xs" onclick={() => openDuplicate(timer)} title={$t('timers.duplicate')}>
                    <Icon name="copy" size={12} />
                  </button>
                {/if}
                <button class="btn-danger text-xs" onclick={() => delTimer(timer)} title={$t('timers.delete')}>
                  <Icon name="trash" size={12} />
                </button>
              </div>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

{#if data.totalPages > 1}
  {@const pages = Array.from({ length: data.totalPages }, (_, i) => i + 1)
                       .filter(p => p === 1 || p === data.totalPages || Math.abs(p - data.page) <= 2)}
  <div class="mt-3 flex flex-wrap items-center justify-center gap-1">
    <button class="btn-ghost text-xs" disabled={data.page <= 1} onclick={() => gotoPage(data.page - 1)}>‹</button>
    {#each pages as p, idx}
      {#if idx > 0 && p - pages[idx - 1] > 1}<span class="px-1 text-slate-400">…</span>{/if}
      <button class="btn-ghost text-xs {p === data.page ? '!bg-brand-600 !text-white' : ''}"
              onclick={() => gotoPage(p)}>{p}</button>
    {/each}
    <button class="btn-ghost text-xs" disabled={data.page >= data.totalPages} onclick={() => gotoPage(data.page + 1)}>›</button>
  </div>
{/if}

<!-- Form modal: create / edit / duplicate -->
{#if formOpen}
  <div class="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 overflow-y-auto"
       role="dialog" aria-modal="true" tabindex="-1"
       onclick={(e) => { if (e.target === e.currentTarget) formOpen = false; }}
       onkeydown={(e) => { if (e.key === 'Escape') formOpen = false; }}>
    <form class="my-8 w-full max-w-2xl space-y-4 rounded-2xl bg-white p-5 shadow-xl dark:bg-slate-900"
          onsubmit={submit}>
      <h2 class="text-lg font-bold">{formTitle}</h2>

      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <div class="label">{$t('timers.name_optional')}</div>
          <input class="input" bind:value={f.title} placeholder={$t('timers.name_placeholder')}/>
        </div>
        <div>
          <div class="label">{$t('timers.action')}</div>
          <select class="input" bind:value={f.action}>
            {#each Object.entries(ACTION_LABEL) as [v, l]}<option value={v}>{l}</option>{/each}
          </select>
        </div>
      </div>

      {#if f.action === 'on_for' || f.action === 'off_for'}
        <div>
          <div class="label">{$t('timers.duration_minutes')}</div>
          <input class="input" type="number" min="1" bind:value={f.duration_minutes}/>
        </div>
      {/if}

      <div>
        <div class="label">{$t('timers.devices_multi')}</div>
        <div class="space-y-2 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
          {#each groupedDevices as [room, list]}
            <div>
              <div class="mb-1 text-xs font-semibold uppercase text-slate-500">{room}</div>
              <div class="flex flex-wrap gap-1">
                {#each list as d}
                  <button type="button"
                          class="rounded-lg border px-2 py-1 text-xs transition
                                 {f.device_ids.includes(d.id)
                                   ? 'border-brand-500 bg-brand-50 text-brand-700 dark:border-brand-400 dark:bg-brand-900/30 dark:text-brand-200'
                                   : 'border-slate-200 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'}"
                          onclick={() => toggleDevice(d.id)}>
                    {d.custom_name || d.tapo_alias || d.device_id}
                  </button>
                {/each}
              </div>
            </div>
          {/each}
        </div>
        <div class="mt-1 text-xs text-slate-500">{tr('timers.devices_selected', { n: f.device_ids.length })}</div>
      </div>

      <label class="flex items-center gap-2 text-sm">
        <input type="checkbox" bind:checked={f.is_random}/>
        <span>{$t('timers.vacation_mode')}</span>
      </label>

      {#if !f.is_random}
        <div>
          <div class="label">{$t('timers.run_at')}</div>
          <input class="input" type="datetime-local" bind:value={f.run_at}/>
        </div>
      {:else}
        <div class="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-700/40 dark:bg-amber-900/20 dark:text-amber-200">
          {$t('timers.vacation_hint')}
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <div>
            <div class="label">{$t('timers.window_from')}</div>
            <input class="input" type="time" bind:value={f.random_window_start}/>
          </div>
          <div>
            <div class="label">{$t('timers.window_to')}</div>
            <input class="input" type="time" bind:value={f.random_window_end}/>
          </div>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <div>
            <div class="label">{$t('timers.per_day_min')}</div>
            <input class="input" type="number" min="1" max="50" bind:value={f.vacation_min_per_day}/>
          </div>
          <div>
            <div class="label">{$t('timers.per_day_max')}</div>
            <input class="input" type="number" min="1" max="50" bind:value={f.vacation_max_per_day}/>
          </div>
          <div>
            <div class="label">{$t('timers.duration_min_from')}</div>
            <input class="input" type="number" min="1" bind:value={f.vacation_min_duration_min}/>
          </div>
          <div>
            <div class="label">{$t('timers.duration_min_to')}</div>
            <input class="input" type="number" min="1" bind:value={f.vacation_max_duration_min}/>
          </div>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" bind:checked={f.vacation_pick_one}/>
            <span>{$t('timers.pick_one_each')}</span>
          </label>
          <div>
            <div class="label">{$t('timers.dim_chance')}</div>
            <input class="input" type="number" min="0" max="100" bind:value={f.vacation_dim_chance}/>
          </div>
        </div>
        <details class="text-xs text-slate-500">
          <summary class="cursor-pointer">{$t('timers.advanced')}</summary>
          <div class="mt-2 text-[11px] text-slate-400">{$t('timers.gap_hint')}</div>
          <div class="mt-2 grid gap-3 sm:grid-cols-2">
            <div>
              <div class="label">{$t('timers.gap_min')}</div>
              <input class="input" type="number" min="1" bind:value={f.random_min_minutes}/>
            </div>
            <div>
              <div class="label">{$t('timers.gap_max')}</div>
              <input class="input" type="number" min="1" bind:value={f.random_max_minutes}/>
            </div>
          </div>
        </details>
      {/if}

      <div class="grid gap-3 sm:grid-cols-3">
        <div>
          <div class="label">{$t('timers.repeat')}</div>
          <select class="input" bind:value={f.repeat_kind}>
            {#each Object.entries(REPEAT_LABEL) as [v, l]}<option value={v}>{l}</option>{/each}
          </select>
        </div>
        {#if f.repeat_kind !== 'once'}
          <div>
            <div class="label">{$t('timers.every_n')}</div>
            <input class="input" type="number" min="1" bind:value={f.repeat_interval}/>
          </div>
          <div>
            <div class="label">{$t('timers.repeat_until')}</div>
            <input class="input" type="datetime-local" bind:value={f.repeat_until}/>
          </div>
        {/if}
      </div>

      {#if f.repeat_kind === 'daily' || f.repeat_kind === 'weekly'}
        <div>
          <div class="label">{$t('timers.days_of_week')}</div>
          <div class="flex flex-wrap gap-1">
            {#each DAYS_LABELS as d, i}
              <button type="button"
                      class="rounded-lg border px-2 py-1 text-xs transition
                             {f.days[i]
                               ? 'border-brand-500 bg-brand-50 text-brand-700 dark:border-brand-400 dark:bg-brand-900/30 dark:text-brand-200'
                               : 'border-slate-200 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'}"
                      onclick={() => f.days[i] = !f.days[i]}>{d}</button>
            {/each}
          </div>
        </div>
      {/if}

      <div>
        <div class="label">{$t('timers.note')}</div>
        <input class="input" bind:value={f.note}/>
      </div>

      <div class="flex justify-end gap-2">
        <button type="button" class="btn-ghost" onclick={() => { formOpen = false; }}>{$t('timers.cancel')}</button>
        <button type="submit" class="btn-primary inline-flex items-center gap-1" disabled={busy}>
          {#if busy}<Spinner size={14} />{:else}<Icon name="check" size={14} />{/if}{busy ? $t('timers.saving_dots')
            : (formMode === 'edit' ? $t('timers.saving_changes')
            : formMode === 'duplicate' ? $t('timers.creating_copy')
            : $t('timers.creating_save'))}
        </button>
      </div>
    </form>
  </div>
{/if}

<!-- Run log drawer -->
{#if runsTimer}
  <div class="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 overflow-y-auto"
       role="dialog" aria-modal="true" tabindex="-1"
       onclick={(e) => { if (e.target === e.currentTarget) runsTimer = null; }}
       onkeydown={(e) => { if (e.key === 'Escape') runsTimer = null; }}>
    <div class="my-8 w-full max-w-2xl space-y-3 rounded-2xl bg-white p-5 shadow-xl dark:bg-slate-900">
      <h2 class="flex items-center gap-2 text-lg font-bold">
        <Icon name="logs" size={16} />{tr('timers.runs_title', { name: runsTimer.title || dname(runsTimer) })}
      </h2>
      {#if runsLoading}
        <div class="py-4 text-center text-slate-500">{$t('timers.loading')}</div>
      {:else if runs.length === 0}
        <div class="py-4 text-center text-slate-500">{$t('timers.no_runs')}</div>
      {:else}
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="text-left text-xs uppercase text-slate-500">
              <tr><th class="py-1 pr-2">{$t('timers.col_time')}</th><th class="pr-2">{$t('timers.col_device')}</th><th class="pr-2">{$t('timers.col_action')}</th><th class="pr-2">{$t('timers.col_result')}</th></tr>
            </thead>
            <tbody>
              {#each runs as r}
                <tr class="border-t border-slate-100 dark:border-slate-800">
                  <td class="py-1 pr-2 font-mono text-xs whitespace-nowrap">{new Date(r.ran_at).toLocaleString(localeStr)}</td>
                  <td class="pr-2">{r.custom_name || r.tapo_alias || r.device_uid || `#${r.device_id}`}</td>
                  <td class="pr-2">{ACTION_LABEL[r.action] || r.action}</td>
                  <td class="pr-2">
                    {#if r.result === 'ok'}
                      <span class="badge-on">{$t('timers.run_ok')}</span>
                    {:else}
                      <span class="badge-err" title={r.error_message}>{$t('timers.run_error')}</span>
                      {#if r.error_message}<div class="text-[10px] text-rose-500">{r.error_message.slice(0,80)}</div>{/if}
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
      <div class="flex justify-end pt-2">
        <button class="btn-ghost" onclick={() => runsTimer = null}>{$t('timers.close')}</button>
      </div>
    </div>
  </div>
{/if}
