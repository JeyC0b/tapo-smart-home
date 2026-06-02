<script lang="ts">
  import '../app.css';
  import { page } from '$app/stores';
  import { invalidateAll, goto } from '$app/navigation';
  import Icon, { type IconName } from '$lib/ui/Icon.svelte';
  import { onMount, untrack } from 'svelte';
  import { setLang, t, type LangCode } from '$lib/i18n';

  let { data, children } = $props();

  // `untrack` prevents the state_referenced_locally warning — read initial value only.
  let theme = $state<'light' | 'dark'>(untrack(() => (data?.theme ?? 'dark')));

  // Apply the server-resolved language (cookie → installation default)
  // SYNCHRONOUSLY so the SSR markup is rendered in the correct language. An
  // $effect alone runs only after hydration, which caused a flash of English on
  // every full load for Czech users. (SvelteKit renders SSR synchronously, so
  // setting the module store here is safe for this single-user app.)
  setLang((data?.lang ?? 'en') as LangCode);
  // Keep following later changes (e.g. the /settings switcher + invalidateAll).
  $effect(() => { setLang((data?.lang ?? 'en') as LangCode); });

  // Auth state is read-only from layout.server (refreshed after every F5/invalidate).
  let isAdmin = $derived(!!data?.isAdmin);
  let passwordSet = $derived(!!data?.passwordSet);

  let loginOpen = $state(false);
  let loginPwd = $state('');
  let loginErr = $state('');
  let loginBusy = $state(false);
  let loginInput = $state<HTMLInputElement | null>(null);
  let setupMode = $derived(!passwordSet);   // first run — admin password must be set

  $effect(() => {
    if (loginOpen && loginInput) {
      requestAnimationFrame(() => loginInput?.focus());
    }
  });

  function applyTheme(t: 'light' | 'dark') {
    if (typeof document === 'undefined') return;
    document.documentElement.classList.toggle('dark', t === 'dark');
    document.documentElement.style.colorScheme = t;
  }
  onMount(() => applyTheme(theme));

  async function toggleTheme() {
    theme = theme === 'dark' ? 'light' : 'dark';
    applyTheme(theme);
    // Persist per-user via cookie (1 year). No DB write so each browser is independent.
    if (typeof document !== 'undefined') {
      const oneYear = 60 * 60 * 24 * 365;
      document.cookie = `theme=${theme}; path=/; max-age=${oneYear}; SameSite=Lax`;
    }
  }

  async function doLogin(e?: Event) {
    e?.preventDefault();
    loginErr = ''; loginBusy = true;
    try {
      const r = await fetch('/api/auth', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          password: loginPwd,
          action: setupMode ? 'set_initial' : 'login'
        })
      });
      if (!r.ok) { loginErr = await r.text(); return; }
      loginPwd = ''; loginOpen = false;
      await invalidateAll();
    } finally { loginBusy = false; }
  }

  async function doLogout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    await invalidateAll();
    if ($page.url.pathname !== '/') await goto('/');
  }

  // Navigation — admin only. Guests see a clean page (no nav, no "host" badge).
  type NavItem = { href: string; labelKey: string; icon: IconName };
  const NAV_ALL: NavItem[] = [
    { href: '/',         labelKey: 'nav.home',     icon: 'home' },
    { href: '/timers',   labelKey: 'nav.timers',   icon: 'refresh' },
    { href: '/devices',  labelKey: 'nav.devices',  icon: 'devices' },
    { href: '/groups',   labelKey: 'nav.groups',   icon: 'layers' },
    { href: '/rules',    labelKey: 'nav.rules',    icon: 'rules' },
    { href: '/widgets',  labelKey: 'nav.widgets',  icon: 'sparkles' },
    { href: '/logs',     labelKey: 'nav.logs',     icon: 'logs' },
    { href: '/settings', labelKey: 'nav.settings', icon: 'settings' }
  ];
  const nav = $derived(isAdmin ? NAV_ALL : []);
</script>

<svelte:head>
  <meta name="color-scheme" content="dark light" />
</svelte:head>

<div class="mx-auto flex min-h-screen max-w-6xl flex-col">
  <header class="sticky top-0 z-30 border-b border-slate-200 bg-white/80 backdrop-blur dark:border-slate-800 dark:bg-slate-950/80">
    <div class="flex items-center justify-between px-4 py-3">
      <a href="/" class="flex items-center gap-2 text-lg font-bold tracking-tight text-slate-900 dark:text-slate-50">
        <Icon name="smarthome" size={22} class="text-brand-600 dark:text-brand-500" /> Tapo
      </a>
      <div class="flex items-center gap-1">
        <nav class="hidden gap-1 md:flex">
          {#each nav as n}
            <a href={n.href}
               class="flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium transition
                      {$page.url.pathname === n.href
                        ? 'bg-brand-600 text-white'
                        : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}">
              <Icon name={n.icon} size={16} />{$t(n.labelKey)}
            </a>
          {/each}
        </nav>

        <!-- Auth button: lock icon for guests / logout for the admin -->
        {#if isAdmin && passwordSet}
          <button type="button" onclick={doLogout}
                  aria-label={$t('auth.logout_admin')}
                  title={$t('auth.logout_admin')}
                  class="ml-1 inline-flex h-9 w-9 items-center justify-center rounded-xl
                         text-emerald-600 hover:bg-slate-100 dark:hover:bg-slate-800">
            <Icon name="lock" size={18} />
          </button>
        {:else}
          <button type="button" onclick={() => { loginOpen = true; loginErr=''; }}
                  aria-label={passwordSet ? $t('auth.login_admin') : $t('auth.set_password')}
                  title={passwordSet ? $t('auth.login_admin') : $t('auth.set_password')}
                  class="ml-1 inline-flex h-9 w-9 items-center justify-center rounded-xl
                         text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800">
            <Icon name="lock" size={18} />
          </button>
        {/if}

        <button type="button" onclick={toggleTheme}
                aria-label={$t('layout.theme_toggle')}
                title={$t('layout.theme_toggle')}
                class="inline-flex h-9 w-9 items-center justify-center rounded-xl
                       text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800">
          {#if theme === 'dark'}
            <Icon name="sun" size={18} />
          {:else}
            <Icon name="moon" size={18} />
          {/if}
        </button>
      </div>
    </div>
  </header>

  <main class="flex-1 px-4 py-4 pb-24 md:pb-6 text-slate-900 dark:text-slate-100">
    {@render children()}
  </main>

  <!-- Mobile bottom nav (admin only — guests have no admin pages to navigate).
       Horizontal scroll lets us show all 8 items without truncating. -->
  {#if nav.length > 0}
  <nav class="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 backdrop-blur dark:border-slate-800 dark:bg-slate-950/95 md:hidden">
    <div class="flex overflow-x-auto">
      {#each nav as n}
        <a href={n.href}
           class="flex shrink-0 flex-col items-center gap-0.5 px-3 py-2 min-w-[68px] text-[11px] font-medium
                  {$page.url.pathname === n.href ? 'text-brand-600' : 'text-slate-500'}">
          <Icon name={n.icon} size={20} />{$t(n.labelKey)}
        </a>
      {/each}
    </div>
  </nav>
  {/if}
</div>

<!-- Login / setup modal -->
{#if loginOpen}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
       role="dialog" aria-modal="true" aria-labelledby="login-title" tabindex="-1"
       onclick={(e) => { if (e.target === e.currentTarget) loginOpen = false; }}
       onkeydown={(e) => { if (e.key === 'Escape') loginOpen = false; }}>
    <form class="w-full max-w-sm space-y-3 rounded-2xl bg-white p-5 shadow-xl dark:bg-slate-900"
          onsubmit={doLogin}>
      <h2 id="login-title" class="flex items-center gap-2 text-lg font-bold">
        <Icon name="lock" size={18} />
        {setupMode ? $t('auth.set_password') : $t('auth.login_admin')}
      </h2>
      {#if setupMode}
        <p class="text-xs text-slate-500">
          {$t('layout.setup_hint')}
        </p>
      {/if}
      <div>
        <div class="label">{$t('auth.password')}{setupMode ? ' (min. 8)' : ''}</div>
        <input type="password" class="input" autocomplete={setupMode ? 'new-password' : 'current-password'}
               bind:value={loginPwd} bind:this={loginInput} required minlength={setupMode ? 8 : 1}/>
      </div>
      {#if loginErr}
        <div class="rounded-md border border-rose-300 bg-rose-50 p-2 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200">
          {loginErr}
        </div>
      {/if}
      <div class="flex justify-end gap-2 pt-1">
        <button type="button" class="btn-ghost" onclick={() => loginOpen = false}>{$t('common.cancel')}</button>
        <button type="submit" class="btn-primary inline-flex items-center gap-1" disabled={loginBusy}>
          <Icon name="check" size={14} />{setupMode ? $t('auth.set_password') : $t('auth.login')}
        </button>
      </div>
    </form>
  </div>
{/if}
