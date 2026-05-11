import { json, error } from '@sveltejs/kit';

/**
 * Proxy pro HTTP widgety: GET ?url=...&json_path=a.b.c
 * Server-side fetch bypasses CORS and lets you pick a value from JSON.
 * Security: blocks localhost / private ranges (SSRF guard) — if an admin
 * deliberately wants an internal URL, add it to ALLOWED_HOSTS_PRIVATE below.
 */
const PRIVATE_RANGES = [
  /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, /^::1$/, /^fc/, /^fd/
];

export async function GET({ url, fetch }: any) {
  const target = url.searchParams.get('url');
  const jsonPath = url.searchParams.get('json_path') || '';
  if (!target) throw error(400, 'url required');

  let parsed: URL;
  try { parsed = new URL(target); } catch { throw error(400, 'Invalid URL.'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw error(400, 'Only http(s) is allowed.');
  }
  // SSRF: block IP literals in private ranges.
  const host = parsed.hostname;
  if (/^[\d.]+$/.test(host) || /^[\da-f:]+$/i.test(host)) {
    if (PRIVATE_RANGES.some(re => re.test(host))) {
      throw error(400, 'Private/loopback addresses are not allowed.');
    }
  } else if (host === 'localhost') {
    throw error(400, 'localhost is not allowed.');
  }

  let r: Response;
  try {
    r = await fetch(target, { headers: { 'user-agent': 'tapo-widget/1.0' } });
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
