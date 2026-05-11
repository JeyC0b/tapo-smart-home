import { json } from '@sveltejs/kit';
import { getWidgetValue } from '$lib/server/widget_cache';

/**
 * Returns the current value of an HTTP widget from the DB cache. If the cache
 * is stale, re-fetches it (server-side). The client has no reason to call this
 * often — the scheduler refreshes in the background based on widget.config.refresh_seconds.
 */
export async function GET({ params, url }: any) {
  const id = Number(params.id);
  if (!id) return json({ ok: false, error: 'invalid id' }, { status: 400 });
  const force = url.searchParams.get('force') === '1';
  const r = await getWidgetValue(id, force);
  return json({
    ok: !r.error,
    value: r.value,
    cached_at: r.cached_at,
    error: r.error,
    refreshed: r.refreshed
  });
}
