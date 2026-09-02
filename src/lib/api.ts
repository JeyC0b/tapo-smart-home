/**
 * Client-side helpers for talking to the JSON API.
 *
 * SvelteKit's `error(status, …)` answers a `fetch()` with a JSON body
 * (`{"message":"…","code":"…"}`), so the old `await r.text()` pattern printed
 * raw JSON at the user ("{\"message\":\"Incorrect password.\"}"). Everything
 * that shows an API failure now goes through `apiError()`, which unwraps that
 * body and — when the server tagged the failure with a stable `code` —
 * translates it through the i18n dictionary so the text follows the UI
 * language instead of being English-only.
 */
import { tr } from '$lib/i18n';

/** Parsed shape of an API error body (both SvelteKit's and our own). */
interface ApiErrorBody {
  message?: string;
  error?: string;
  code?: string;
  [k: string]: unknown;
}

function parseBody(raw: string): ApiErrorBody | null {
  const s = raw.trim();
  if (!s.startsWith('{')) return null;
  try {
    const j = JSON.parse(s);
    return j && typeof j === 'object' ? (j as ApiErrorBody) : null;
  } catch { return null; }
}

/**
 * Turn a failed `Response` into a human-readable, localised message.
 * Never throws and never returns an empty string.
 */
export async function apiError(res: Response): Promise<string> {
  let raw = '';
  try { raw = await res.text(); } catch { /* body unreadable — fall through */ }

  const body = parseBody(raw);
  if (body) {
    // Prefer a stable machine code so the text can be localised.
    if (typeof body.code === 'string' && body.code) {
      const key = `errors.${body.code}`;
      const translated = tr(key, body as Record<string, unknown>);
      if (translated !== key) return translated;
    }
    const msg = typeof body.message === 'string' ? body.message
              : typeof body.error === 'string'   ? body.error : '';
    if (msg) return msg;
  } else if (raw.trim()) {
    // Plain-text body (proxy error pages etc.) — show at most one line.
    return raw.trim().slice(0, 300);
  }

  // Empty/unparseable body — fall back to the HTTP status.
  if (res.status === 401) return tr('errors.unauthorized');
  if (res.status === 403) return tr('errors.forbidden');
  if (res.status === 404) return tr('errors.not_found');
  return tr('errors.request_failed', { status: res.status });
}

/**
 * `fetch` + JSON, returning `{ ok, data, error }` instead of throwing.
 * Network failures are reported the same way as HTTP failures.
 */
export async function apiFetch<T = any>(
  url: string, init?: RequestInit
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    return { ok: false, error: tr('errors.network') };
  }
  if (!res.ok) return { ok: false, error: await apiError(res) };
  try {
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: true, data: undefined as T };
  }
}

/** Shorthand for the very common `POST <json>` call. */
export function postJson(url: string, body: unknown, method = 'POST'): Promise<Response> {
  return fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}
