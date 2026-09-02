import { error } from '@sveltejs/kit';
import { log } from './logger';

/**
 * Throw an HTTP error carrying a stable `code` next to the English `message`.
 *
 * The client (`$lib/api.ts` → `apiError()`) looks the code up in the i18n
 * dictionary under `errors.<code>` and falls back to `message` when the key is
 * unknown, so API failures are readable in the user's language instead of
 * surfacing raw JSON or English-only text.
 *
 * `vars` are merged into the body and can be interpolated by the translation
 * (e.g. `errors.auth_throttled` = "Try again in {seconds} s.").
 */
export function fail(
  status: number, code: string, message: string, vars?: Record<string, unknown>
): never {
  throw error(status, { ...(vars ?? {}), code, message });
}

/**
 * Convert a thrown device/DB/bridge error into a clean HTTP error.
 *
 * App-level sentinel messages map to meaningful statuses; anything else is
 * logged server-side and surfaced generically, so raw python-kasa / DB /
 * network internals never reach the (possibly guest) client. Always throws.
 */
export async function deviceError(e: any, ctx: string): Promise<never> {
  const msg = String(e?.message ?? e);
  if (/not found/i.test(msg)) fail(404, 'device_not_found', 'Device not found.');
  if (/no hub/i.test(msg))    fail(409, 'device_no_hub', 'Device has no hub assigned.');
  if (/verif/i.test(msg))     fail(502, 'device_not_verified', 'Device did not confirm the new state.');
  await log('error', 'api', `${ctx} failed`, { err: msg });
  fail(502, 'device_command_failed', 'Device command failed.');
}
