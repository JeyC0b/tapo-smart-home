import { error } from '@sveltejs/kit';
import { log } from './logger';

/**
 * Convert a thrown device/DB/bridge error into a clean HTTP error.
 *
 * App-level sentinel messages map to meaningful statuses; anything else is
 * logged server-side and surfaced generically, so raw python-kasa / DB /
 * network internals never reach the (possibly guest) client. Always throws.
 */
export async function deviceError(e: any, ctx: string): Promise<never> {
  const msg = String(e?.message ?? e);
  if (/not found/i.test(msg)) throw error(404, 'Device not found.');
  if (/no hub/i.test(msg)) throw error(409, 'Device has no hub assigned.');
  if (/verif/i.test(msg)) throw error(502, 'Device did not confirm the new state.');
  await log('error', 'api', `${ctx} failed`, { err: msg });
  throw error(502, 'Device command failed.');
}
