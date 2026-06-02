import { json, error } from '@sveltejs/kit';
import { assertPublicUrl, safeFetch } from '$lib/server/net_guard';

/**
 * Proxy pro HTTP widgety: GET ?url=...&json_path=a.b.c
 * Server-side fetch bypasses CORS and lets you pick a value from JSON.
 * Security: the SSRF guard (net_guard) resolves DNS and blocks loopback /
 * private / link-local / ULA / CGNAT addresses, dotless-decimal and
 * IPv4-mapped forms, and re-validates redirect hops.
 */
export async function GET({ url }: any) {
  const target = url.searchParams.get('url');
  const jsonPath = url.searchParams.get('json_path') || '';
  if (!target) throw error(400, 'url required');

  // Validate scheme + resolve/verify host (throws on private/loopback).
  try { await assertPublicUrl(target); }
  catch (e: any) { throw error(400, String(e?.message || e)); }

  let r: Response;
  try {
    r = await safeFetch(target, { headers: { 'user-agent': 'tapo-widget/1.0' } });
  } catch (e: any) {
    return json({ ok: false, error: String(e.message || e) }, { status: 200 });
  }
  if (!r.ok) return json({ ok: false, status: r.status, error: r.statusText }, { status: 200 });

  const ct = r.headers.get('content-type') || '';
  if (ct.includes('application/json') || jsonPath) {
    let data: any;
    try { data = await r.json(); } catch (e: any) {
      return json({ ok: false, error: 'Response is not valid JSON.' }, { status: 200 });
    }
    let value: any = data;
    if (jsonPath) {
      for (const seg of jsonPath.split(/[.[\]]/).filter(Boolean)) {
        if (value == null) break;
        value = value[seg];
      }
    }
    return json({ ok: true, value, raw: data });
  }
  const text = await r.text();
  return json({ ok: true, value: text.trim().slice(0, 500), raw: null });
}
