/**
 * Server-side cache for HTTP widgets. Works the same way as http_cache_seconds
 * in app_rule_conditions:
 *   - If `cached_at + refresh_seconds > now`, the cached value is returned.
 *   - Otherwise the URL is re-fetched, the result is stored into
 *     app_widgets.cached_value/cached_at, and on error into cache_error.
 *
 * Called from two places:
 *   - `/api/widgets/[id]/value` (client requests the value — returns cache if valid)
 *   - scheduler `widgetTick()` (background pre-refresh so the client never waits)
 */
import { q, exec } from './db';
import { log } from './logger';
import { assertPublicUrl, safeFetch } from './net_guard';

export interface WidgetCacheRow {
  id: number;
  config: any;
  cached_value: any;
  cached_at: Date | null;
  cache_error: string | null;
}

function pickJson(data: any, path: string | undefined | null): any {
  if (!path) return data;
  let v: any = data;
  for (const seg of String(path).split(/[.[\]]/).filter(Boolean)) {
    if (v == null) return null;
    v = v[seg];
  }
  return v;
}

async function fetchWidget(cfg: any): Promise<{ ok: true; value: any } | { ok: false; error: string }> {
  const target = String(cfg?.url || '').trim();
  if (!target) return { ok: false, error: 'URL is not set.' };

  // Validate scheme + resolve/verify host against the SSRF guard.
  try { await assertPublicUrl(target); }
  catch (e: any) { return { ok: false, error: String(e?.message || e) }; }

  const method = (cfg?.method === 'POST' ? 'POST' : 'GET') as 'GET' | 'POST';
  const init: RequestInit = {
    method,
    headers: { 'user-agent': 'tapo-widget/1.0' },
    // 8s timeout
    signal: AbortSignal.timeout(8000)
  };
  if (method === 'POST') {
    const body = String(cfg?.post_body || '').trim();
    const ct = String(cfg?.post_content_type || '').trim();
    if (body) {
      (init.headers as any)['content-type'] = ct || (body.startsWith('{') ? 'application/json' : 'text/plain');
      init.body = body;
    }
  }

  let r: Response;
  try { r = await safeFetch(target, init); }
  catch (e: any) { return { ok: false, error: String(e?.message || e).slice(0, 400) }; }
  if (!r.ok) return { ok: false, error: `HTTP ${r.status} ${r.statusText}` };

  const ct = r.headers.get('content-type') || '';
  if (ct.includes('application/json') || cfg?.json_path) {
    let data: any;
    try { data = await r.json(); }
    catch { return { ok: false, error: 'Response is not valid JSON.' }; }
    return { ok: true, value: pickJson(data, cfg?.json_path) };
  }
  const text = (await r.text()).trim().slice(0, 500);
  return { ok: true, value: text };
}

export async function getWidgetValue(id: number, force = false): Promise<{
  value: any; cached_at: Date | null; error: string | null; refreshed: boolean;
}> {
  const rows = await q<WidgetCacheRow>(
    `SELECT id, config, cached_value, cached_at, cache_error
       FROM app_widgets WHERE id = ? AND kind='http'`, [id]
  );
  const w = rows[0];
  if (!w) return { value: null, cached_at: null, error: 'Widget nenalezen.', refreshed: false };
  let cfg: any = w.config;
  if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch { cfg = {}; } }
  const refreshSecs = Math.max(5, Number(cfg?.refresh_seconds ?? 60));
  const last = w.cached_at ? new Date(w.cached_at).getTime() : 0;
  const fresh = !force && last && (Date.now() - last) < refreshSecs * 1000;

  // If the cache is fresh, or the last attempt errored and the interval hasn't elapsed yet, return it.
  if (fresh) {
    return {
      value: typeof w.cached_value === 'string' ? safeParse(w.cached_value) : w.cached_value,
      cached_at: w.cached_at, error: w.cache_error, refreshed: false
    };
  }

  const res = await fetchWidget(cfg);
  if (res.ok) {
    await exec(
      `UPDATE app_widgets SET cached_value = ?, cached_at = NOW(), cache_error = NULL WHERE id = ?`,
      [JSON.stringify(res.value ?? null), id]
    );
    return { value: res.value, cached_at: new Date(), error: null, refreshed: true };
  } else {
    await exec(
      `UPDATE app_widgets SET cached_at = NOW(), cache_error = ? WHERE id = ?`,
      [res.error.slice(0, 500), id]
    );
    return {
      value: typeof w.cached_value === 'string' ? safeParse(w.cached_value) : w.cached_value,
      cached_at: new Date(), error: res.error, refreshed: true
    };
  }
}

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return s; }
}

/** Background refresh of all HTTP widgets whose cache interval has elapsed. */
export async function refreshDueWidgets(): Promise<void> {
  const rows = await q<{ id: number; config: any; cached_at: Date | null }>(
    `SELECT id, config, cached_at FROM app_widgets WHERE kind='http' AND enabled=1`
  );
  const now = Date.now();
  for (const r of rows) {
    let cfg: any = r.config;
    if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch { cfg = {}; } }
    const refreshSecs = Math.max(5, Number(cfg?.refresh_seconds ?? 60));
    const last = r.cached_at ? new Date(r.cached_at).getTime() : 0;
    if (!last || now - last >= refreshSecs * 1000) {
      await getWidgetValue(r.id, true).catch(e =>
        log('error', 'widget_cache', `refresh ${r.id}`, { err: String(e) })
      );
    }
  }
}
