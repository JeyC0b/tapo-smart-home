<script lang="ts">
  import { apiError } from '$lib/api';
  import { toastError } from '$lib/ui/toast';
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/stores';
  import { untrack } from 'svelte';
  import Icon from '$lib/ui/Icon.svelte';
  import Spinner from '$lib/ui/Spinner.svelte';
  import { setLang, t, tr, type LangCode } from '$lib/i18n';

  let { data }: { data: { settings: any } } = $props();
  let passwordSet = $derived(!!$page.data.passwordSet);

  let adminPwd = $state('');
  let adminPwd2 = $state('');
  let adminBusy = $state(false);
  let adminMsg = $state('');

  async function changeAdminPassword() {
    adminMsg = '';
    if (adminPwd.length < 8) { adminMsg = tr('settings.password_min'); return; }
    if (adminPwd !== adminPwd2) { adminMsg = tr('settings.password_mismatch'); return; }
    adminBusy = true;
    try {
      const r = await fetch('/api/auth', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'change', password: adminPwd })
      });
      if (!r.ok) { adminMsg = await apiError(r); return; }
      adminPwd = ''; adminPwd2 = '';
      adminMsg = tr('settings.password_changed');
      await invalidateAll();
    } finally { adminBusy = false; }
  }

  async function disableAdminPassword() {
    if (!confirm(tr('settings.disable_password_confirm'))) return;
    adminBusy = true;
    try {
      const r = await fetch('/api/auth', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'disable' })
      });
      if (!r.ok) { adminMsg = await apiError(r); return; }
      adminMsg = tr('settings.password_disabled');
      await invalidateAll();
    } finally { adminBusy = false; }
  }

  // `untrack(...)` ensures we read the prop only for the initial value of state
  // and avoid the Svelte 5 state_referenced_locally warning.
  let s = $state(untrack(() => ({ ...data.settings })));
  let newPassword = $state('');
  let saving = $state(false);
  let saved = $state(false);

  async function save() {
    saving = true; saved = false;
    try {
      const body: any = {
        poll_interval_seconds: Math.max(60, Number(s.poll_interval_seconds)),
        rules_enabled: !!s.rules_enabled,
        offline_after_failures: Math.max(1, Number(s.offline_after_failures)),
        verify_actions: !!s.verify_actions,
        default_username: s.default_username || '',
        log_level: s.log_level || 'info',
        default_language: (s.default_language === 'cs' ? 'cs' : 'en') as LangCode,
        task_retry_minutes: Math.max(0, Number(s.task_retry_minutes) || 0),
        task_revert_retry_minutes: Math.max(0, Number(s.task_revert_retry_minutes) || 0)
      };
      if (newPassword) body.default_password = newPassword;
      const r = await fetch('/api/settings', {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!r.ok) { toastError(await apiError(r)); return; }
      newPassword = '';
      saved = true;
      // Apply the language immediately (writes the cookie + updates the store).
      // The next navigation/F5 will also pick it up via SSR.
      setLang(body.default_language as LangCode);
      await invalidateAll();
      setTimeout(() => saved = false, 2000);
    } finally { saving = false; }
  }
</script>

<h1 class="mb-4 text-2xl font-bold">{$t('settings.title')}</h1>

<!-- Language switcher — placed first so users can find it without scrolling. -->
<div class="card mb-6 space-y-3">
  <h2 class="font-semibold">{$t('settings.language')}</h2>
  <div>
    <select class="input" bind:value={s.default_language}>
      <option value="en">{$t('settings.language_en')}</option>
      <option value="cs">{$t('settings.language_cs')}</option>
    </select>
  </div>
</div>

<div class="card mb-6 space-y-3">
  <h2 class="flex items-center gap-2 font-semibold">
    <Icon name="lock" size={16} />{$t('settings.admin_password')}
  </h2>
  {#if passwordSet}
    <p class="rounded-md border border-emerald-300 bg-emerald-50 p-2 text-xs text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
      {$t('settings.admin_password_set')}
    </p>
  {:else}
    <p class="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
      {$t('settings.admin_password_unset')}
    </p>
  {/if}
  <div class="grid gap-3 sm:grid-cols-2">
    <div>
      <div class="label">{$t('settings.new_password')}</div>
      <input class="input" type="password" autocomplete="new-password" bind:value={adminPwd}/>
    </div>
    <div>
      <div class="label">{$t('settings.confirm_password')}</div>
      <input class="input" type="password" autocomplete="new-password" bind:value={adminPwd2}/>
    </div>
  </div>
  {#if adminMsg}
    <div class="rounded-md border border-slate-300 bg-slate-50 p-2 text-sm dark:border-slate-700 dark:bg-slate-900">{adminMsg}</div>
  {/if}
  <div class="flex flex-wrap gap-2">
    <button class="btn-primary inline-flex items-center gap-1" onclick={changeAdminPassword} disabled={adminBusy}>
      {#if adminBusy}<Spinner size={14} />{:else}<Icon name="check" size={14} />{/if}{passwordSet ? $t('settings.change_password') : $t('settings.set_password')}
    </button>
    {#if passwordSet}
      <button class="btn-danger inline-flex items-center gap-1" onclick={disableAdminPassword} disabled={adminBusy}>
        <Icon name="trash" size={14} />{$t('settings.disable_password')}
      </button>
    {/if}
  </div>
</div>

<div class="card mb-6 space-y-4">
  <div>
    <h2 class="font-semibold">{$t('settings.default_credentials')}</h2>
    <p class="text-xs text-slate-500">
      {$t('settings.default_credentials_hint')}
    </p>
  </div>
  <div class="grid gap-3 sm:grid-cols-2">
    <div>
      <div class="label">{$t('settings.default_username')}</div>
      <input class="input" type="email" autocomplete="username" bind:value={s.default_username}/>
    </div>
    <div>
      <div class="label">{$t('settings.default_password')} {data.settings.has_default_password ? $t('settings.default_password_change') : ''}</div>
      <input class="input" type="password" autocomplete="new-password"
             placeholder={data.settings.has_default_password ? '••••••••' : ''}
             bind:value={newPassword}/>
    </div>
  </div>
</div>

<div class="card mb-6 space-y-3">
  <h2 class="font-semibold">{$t('settings.polling')}</h2>
  <div class="grid gap-3 sm:grid-cols-2">
    <div>
      <div class="label">{$t('settings.poll_interval')}</div>
      <input class="input" type="number" min="60" step="10" bind:value={s.poll_interval_seconds}/>
    </div>
    <div>
      <div class="label">{$t('settings.offline_after')}</div>
      <input class="input" type="number" min="1" bind:value={s.offline_after_failures}/>
    </div>
  </div>
  <label class="flex items-center gap-2 text-sm">
    <input type="checkbox" bind:checked={s.rules_enabled}/> {$t('settings.rules_enabled')}
  </label>
  <label class="flex items-center gap-2 text-sm">
    <input type="checkbox" bind:checked={s.verify_actions}/> {$t('settings.verify_actions')}
  </label>
</div>

<div class="card mb-6 space-y-3">
  <h2 class="flex items-center gap-2 font-semibold">
    <Icon name="refresh" size={16} />{$t('settings.reliability')}
  </h2>
  <p class="text-xs text-slate-500">{$t('settings.reliability_hint')}</p>
  <div class="grid gap-3 sm:grid-cols-2">
    <div>
      <div class="label">{$t('settings.task_retry_minutes')}</div>
      <input class="input" type="number" min="0" max="10080" step="5" bind:value={s.task_retry_minutes}/>
    </div>
    <div>
      <div class="label">{$t('settings.task_revert_retry_minutes')}</div>
      <input class="input" type="number" min="0" max="10080" step="30" bind:value={s.task_revert_retry_minutes}/>
    </div>
  </div>
</div>

<div class="card mb-6 space-y-3">
  <h2 class="flex items-center gap-2 font-semibold">
    <Icon name="logs" size={16} />{$t('settings.logging')}
  </h2>
  <p class="text-xs text-slate-500">
    {$t('settings.logging_hint')}
  </p>
  <div>
    <div class="label">{$t('settings.log_level')}</div>
    <select class="input" bind:value={s.log_level}>
      <option value="debug">{$t('settings.log_level_debug')}</option>
      <option value="info">{$t('settings.log_level_info')}</option>
      <option value="warn">{$t('settings.log_level_warn')}</option>
      <option value="error">{$t('settings.log_level_error')}</option>
    </select>
  </div>
</div>

<div class="flex items-center gap-3">
  <button class="btn-primary inline-flex items-center gap-1" onclick={save} disabled={saving}>
    {#if saving}<Spinner size={14} />{:else}<Icon name="check" size={14} />{/if}{saving ? $t('common.saving') : $t('common.save')}
  </button>
  {#if saved}
    <span class="inline-flex items-center gap-1 text-sm text-emerald-600">
      <Icon name="check" size={14} /> {$t('common.saved')}
    </span>
  {/if}
</div>
