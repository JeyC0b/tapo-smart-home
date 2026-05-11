<script lang="ts">
  import { invalidateAll, goto } from '$app/navigation';
  import { page } from '$app/stores';
  import Icon from '$lib/ui/Icon.svelte';
  import { untrack } from 'svelte';
  import { t, tr, lang } from '$lib/i18n';

  type Filters = { level: string; source: string; q: string };

  let { data }: {
    data: {
      logs: any[];
      page: number;
      pageSize: number;
      total: number;
      totalPages: number;
      filters: Filters;
      sources: string[];
    }
  } = $props();

  let autoRefresh = $state(true);
  let expanded = $state<Set<number>>(new Set());

  // Filter form state — initialized from current URL via data.filters,
  // submitting navigates and triggers SSR reload. `untrack` prevents the
  // state_referenced_locally warning by reading the initial value only.
  let level = $state(untrack(() => data.filters.level || ''));
  let source = $state(untrack(() => data.filters.source || ''));
  let qStr = $state(untrack(() => data.filters.q || ''));
  let pageSize = $state(untrack(() => data.pageSize));

  function levelClass(l: string) {
    return l === 'error' ? 'badge-err'
         : l === 'warn'  ? 'badge-warn'
         : l === 'info'  ? 'badge-on'
         : l === 'debug' ? 'badge-off'
         : 'badge-off';
  }

  function buildUrl(params: Partial<{ page: number; size: number; level: string; source: string; q: string }>) {
    const u = new URL($page.url);
    const setOrDel = (k: string, v: string | number | undefined | null) => {
      if (v === undefined || v === null || v === '') u.searchParams.delete(k);
      else u.searchParams.set(k, String(v));
    };
    if ('page' in params)   setOrDel('page',   params.page === 1 ? '' : params.page!);
    if ('size' in params)   setOrDel('size',   params.size === 100 ? '' : params.size!);
    if ('level' in params)  setOrDel('level',  params.level!);
    if ('source' in params) setOrDel('source', params.source!);
    if ('q' in params)      setOrDel('q',      params.q!);
    return u.pathname + (u.search || '');
  }

  async function applyFilters(e?: Event) {
    e?.preventDefault();
    await goto(buildUrl({ page: 1, size: pageSize, level, source, q: qStr }), { invalidateAll: true });
  }
  async function resetFilters() {
    level = ''; source = ''; qStr = '';
    await goto('/logs', { invalidateAll: true });
  }
  async function gotoPage(p: number) {
    await goto(buildUrl({ page: p, size: pageSize, level, source, q: qStr }), { invalidateAll: true });
  }

  function toggleMeta(id: number) {
    const s = new Set(expanded);
    if (s.has(id)) s.delete(id); else s.add(id);
    expanded = s;
  }

  $effect(() => {
    if (!autoRefresh) return;
    const i = setInterval(() => invalidateAll(), 5_000);
    return () => clearInterval(i);
  });

  function fmtMeta(m: unknown): string {
    if (m == null) return '';
    if (typeof m === 'string') {
      try { return JSON.stringify(JSON.parse(m), null, 2); } catch { return m; }
    }
    try { return JSON.stringify(m, null, 2); } catch { return String(m); }
  }
</script>

<div class="mb-4 flex items-center justify-between">
  <h1 class="text-2xl font-bold">{$t('logs.title')}</h1>
  <div class="flex items-center gap-2">
    <label class="flex items-center gap-1 text-xs text-slate-500">
      <input type="checkbox" bind:checked={autoRefresh}/>{$t('logs.auto_refresh')}
    </label>
    <button class="btn-ghost inline-flex items-center gap-1" onclick={() => invalidateAll()} aria-label={$t('common.refresh')}>
      <Icon name="refresh" size={14} />
    </button>
  </div>
</div>

<form class="card mb-3 grid gap-2 sm:grid-cols-5" onsubmit={applyFilters}>
  <div>
    <div class="label">{$t('logs.level')}</div>
    <select class="input" bind:value={level}>
      <option value="">{$t('logs.all')}</option>
      <option value="debug">debug</option>
      <option value="info">info</option>
      <option value="warn">warn</option>
      <option value="error">error</option>
    </select>
  </div>
  <div>
    <div class="label">{$t('logs.source')}</div>
    <select class="input" bind:value={source}>
      <option value="">{$t('logs.all')}</option>
      {#each data.sources as src}<option value={src}>{src}</option>{/each}
    </select>
  </div>
  <div class="sm:col-span-2">
    <div class="label">{$t('logs.search_message')}</div>
    <input class="input" type="search" placeholder={$t('logs.search_placeholder')} bind:value={qStr}/>
  </div>
  <div>
    <div class="label">{$t('logs.page_size')}</div>
    <select class="input" bind:value={pageSize}>
      <option value={20}>20</option>
      <option value={50}>50</option>
      <option value={100}>100</option>
      <option value={200}>200</option>
      <option value={500}>500</option>
    </select>
  </div>
  <div class="flex items-end gap-2 sm:col-span-5">
    <button type="submit" class="btn-primary inline-flex items-center gap-1">
      <Icon name="search" size={14} />{$t('logs.apply_filter')}
    </button>
    <button type="button" class="btn-ghost" onclick={resetFilters}>{$t('logs.clear')}</button>
    <div class="ml-auto self-center text-xs text-slate-500">
      {tr('logs.total_records', { total: data.total, page: data.page, pages: data.totalPages })}
    </div>
  </div>
</form>

<div class="card overflow-x-auto">
  <table class="w-full text-sm">
    <thead class="text-left text-xs uppercase text-slate-500">
      <tr>
        <th class="py-1 pr-2">{$t('logs.col_time')}</th>
        <th class="pr-2">{$t('logs.col_level')}</th>
        <th class="pr-2">{$t('logs.col_source')}</th>
        <th>{$t('logs.col_message')}</th>
      </tr>
    </thead>
    <tbody>
      {#each data.logs as l (l.id)}
        <tr class="border-t border-slate-100 align-top dark:border-slate-800">
          <td class="whitespace-nowrap py-1 pr-3 font-mono text-xs text-slate-500">
            {new Date(l.created_at).toLocaleString($lang === 'cs' ? 'cs-CZ' : 'en-US')}
          </td>
          <td class="pr-3"><span class={levelClass(l.level)}>{l.level}</span></td>
          <td class="pr-3 text-xs text-slate-500">{l.source}</td>
          <td>
            <div class="flex items-start justify-between gap-2">
              <div class="break-words">{l.message}</div>
              {#if l.meta}
                <button type="button"
                        class="shrink-0 text-xs text-brand-500 hover:underline"
                        aria-label={$t('logs.detail_aria')}
                        onclick={() => toggleMeta(l.id)}>
                  {expanded.has(l.id) ? $t('logs.hide_detail') : $t('logs.show_detail')}
                </button>
              {/if}
            </div>
            {#if l.meta && expanded.has(l.id)}
              <pre class="mt-1 whitespace-pre-wrap rounded bg-slate-100 p-2 text-[11px] text-slate-700 dark:bg-slate-800 dark:text-slate-200">{fmtMeta(l.meta)}</pre>
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
  {#if data.logs.length === 0}
    <div class="py-4 text-center text-slate-500">{$t('logs.empty_filter')}</div>
  {/if}
</div>

{#if data.totalPages > 1}
  {@const pages = Array.from({ length: data.totalPages }, (_, i) => i + 1)
                       .filter(p => p === 1 || p === data.totalPages || Math.abs(p - data.page) <= 2)}
  <div class="mt-3 flex flex-wrap items-center justify-center gap-1">
    <button class="btn-ghost text-xs" disabled={data.page <= 1} onclick={() => gotoPage(1)}>«</button>
    <button class="btn-ghost text-xs" disabled={data.page <= 1} onclick={() => gotoPage(data.page - 1)}>‹</button>
    {#each pages as p, idx}
      {#if idx > 0 && p - pages[idx - 1] > 1}
        <span class="px-1 text-slate-400">…</span>
      {/if}
      <button class="btn-ghost text-xs {p === data.page ? '!bg-brand-600 !text-white' : ''}"
              onclick={() => gotoPage(p)}>{p}</button>
    {/each}
    <button class="btn-ghost text-xs" disabled={data.page >= data.totalPages} onclick={() => gotoPage(data.page + 1)}>›</button>
    <button class="btn-ghost text-xs" disabled={data.page >= data.totalPages} onclick={() => gotoPage(data.totalPages)}>»</button>
  </div>
{/if}
