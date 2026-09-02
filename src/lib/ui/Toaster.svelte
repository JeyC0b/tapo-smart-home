<script lang="ts">
  /**
   * Renders the toast stack. Mounted once in the root layout — components push
   * messages through `$lib/ui/toast`, never by rendering this themselves.
   */
  import { toasts, dismissToast } from './toast';
  import Icon from './Icon.svelte';
  import { t } from '$lib/i18n';

  const STYLE: Record<string, string> = {
    error:   'border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-100',
    success: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100',
    info:    'border-slate-300 bg-white text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100'
  };
  const ICON: Record<string, 'alert' | 'check' | 'info'> = {
    error: 'alert', success: 'check', info: 'info'
  };
</script>

{#if $toasts.length}
  <div class="pointer-events-none fixed inset-x-0 bottom-24 z-[60] flex flex-col items-center gap-2 px-4 md:bottom-6"
       role="status" aria-live="polite">
    {#each $toasts as toast (toast.id)}
      <div class="pointer-events-auto flex w-full max-w-md items-start gap-2 rounded-xl border p-3 text-sm shadow-lg {STYLE[toast.kind]}">
        <Icon name={ICON[toast.kind]} size={16} class="mt-0.5 shrink-0" />
        <span class="min-w-0 flex-1 break-words">{toast.text}</span>
        <button type="button" class="shrink-0 opacity-60 transition hover:opacity-100"
                aria-label={$t('common.close')}
                onclick={() => dismissToast(toast.id)}>
          <Icon name="x" size={14} />
        </button>
      </div>
    {/each}
  </div>
{/if}
