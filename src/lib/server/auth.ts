import { createHash, randomBytes, timingSafeEqual, scryptSync } from 'node:crypto';
import { q, exec } from './db';
import { getSetting, setSetting } from './settings';
import { log } from './logger';

const COOKIE_NAME = 'tapo_admin';
const SESSION_TTL_DAYS = 30;

// Password storage uses scrypt (a slow, memory-hard KDF from the Node stdlib —
// no extra dependency). Stored hashes are tagged `scrypt$<hex>` so legacy
// fast-SHA-256 hashes (bare hex) can be detected and transparently upgraded on
// the next successful login.
const SCRYPT_PREFIX = 'scrypt$';
const SCRYPT_KEYLEN = 64;
export const MIN_PASSWORD_LEN = 8;

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
function scryptHash(plain: string, salt: string): string {
  return SCRYPT_PREFIX + scryptSync(plain, salt, SCRYPT_KEYLEN).toString('hex');
}

/** True when no admin password has ever been set — initial state, everything visible. */
export async function isAdminPasswordSet(): Promise<boolean> {
  const h = await getSetting('admin_password_hash', '');
  return !!h;
}

export async function setAdminPassword(plain: string): Promise<void> {
  if (!plain || plain.length < MIN_PASSWORD_LEN) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LEN} characters long.`);
  }
  const salt = randomBytes(16).toString('hex');
  await setSetting('admin_password_salt', salt);
  await setSetting('admin_password_hash', scryptHash(plain, salt));
  // Drop all existing sessions — password has changed.
  await exec('DELETE FROM app_admin_sessions');
}

export async function clearAdminPassword(): Promise<void> {
  await setSetting('admin_password_salt', '');
  await setSetting('admin_password_hash', '');
  await exec('DELETE FROM app_admin_sessions');
}

export async function verifyAdminPassword(plain: string): Promise<boolean> {
  const salt = await getSetting('admin_password_salt', '');
  const stored = await getSetting('admin_password_hash', '');
  if (!salt || !stored) return false;
  try {
    if (stored.startsWith(SCRYPT_PREFIX)) {
      const calc = scryptSync(plain, salt, SCRYPT_KEYLEN);
      const expected = Buffer.from(stored.slice(SCRYPT_PREFIX.length), 'hex');
      if (calc.length !== expected.length) return false;
      return timingSafeEqual(calc, expected);
    }
    // Legacy fast-SHA-256 hash: verify in constant time, then upgrade to scrypt.
    const legacy = Buffer.from(sha256(salt + ':' + plain), 'hex');
    const b = Buffer.from(stored, 'hex');
    if (legacy.length !== b.length || !timingSafeEqual(legacy, b)) return false;
    setSetting('admin_password_hash', scryptHash(plain, salt)).catch(() => {});
    return true;
  } catch { return false; }
}

export async function createAdminSession(userAgent?: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 3600 * 1000);
  await exec(
    'INSERT INTO app_admin_sessions (token, expires_at, user_agent) VALUES (?,?,?)',
    [token, expires, (userAgent ?? '').slice(0, 250)]
  );
  await log('info', 'auth', 'admin session created');
  return { token, expiresAt: expires };
}

export async function destroyAdminSession(token: string): Promise<void> {
  if (!token) return;
  await exec('DELETE FROM app_admin_sessions WHERE token = ?', [token]);
}

export async function isValidSession(token: string | undefined | null): Promise<boolean> {
  if (!token) return false;
  const r = await q<{ token: string }>(
    'SELECT token FROM app_admin_sessions WHERE token = ? AND expires_at > NOW() LIMIT 1',
    [token]
  );
  if (r.length === 0) return false;
  // best-effort touch — do not block the hot path on failure
  exec('UPDATE app_admin_sessions SET last_seen_at = NOW() WHERE token = ?', [token]).catch(() => {});
  return true;
}

export const AUTH_COOKIE_NAME = COOKIE_NAME;
export const AUTH_COOKIE_OPTS = {
  path: '/',
  httpOnly: true,
  sameSite: 'lax' as const,
  // secure: true — leave the decision to the deployment (proxy / HTTPS)
  maxAge: SESSION_TTL_DAYS * 24 * 3600
};

/**
 * Reads that expose the installation's configuration. GET is otherwise open
 * (the dashboard has to work for guests), but these endpoints hand out hub IPs,
 * the Tapo account e-mail, rules, timers and widget definitions — none of which
 * a guest has any use for.
 */
const ADMIN_ONLY_READS: RegExp[] = [
  /^\/api\/hubs(\/|$)/,            // hub IP + Tapo account e-mail
  /^\/api\/rules(\/|$)/,
  /^\/api\/dependencies(\/|$)/,
  /^\/api\/timers(\/|$)/,
  /^\/api\/scheduled-tasks(\/|$)/,
  /^\/api\/discover(\/|$)/,
  /^\/api\/groups$/,                // the group LIST; /api/groups/:id/* stays guest-usable
  /^\/api\/widgets$/,               // the widget LIST; /api/widgets/:id/value stays public
  /^\/api\/widgets\/proxy$/         // server-side fetch of an arbitrary URL
];

export function isAdminOnlyRead(pathname: string): boolean {
  return ADMIN_ONLY_READS.some(re => re.test(pathname));
}

/**
 * Pages that only make sense for the administrator. The nav already hides them,
 * but the routes were still served on a direct URL — and their loaders return
 * hub credentials, rule definitions and logs. Guests are redirected home.
 */
const ADMIN_ONLY_PAGES = /^\/(settings|devices|rules|widgets|logs|timers|groups)(\/|$)/;

export function isAdminOnlyPage(pathname: string): boolean {
  return ADMIN_ONLY_PAGES.test(pathname);
}

/**
 * Decides whether the given request may perform a mutation (POST/PATCH/DELETE).
 * - GET is always allowed (read / dashboard / overview).
 * - When no password is set yet (initial setup), everything is allowed (admin = guest).
 * - When set, mutations require a valid session, except for the whitelist
 *   for device control (toggle/light/fan/countdown), which guests may use too.
 */
export function isMutationAllowedPath(pathname: string, method: string): 'always' | 'admin-only' | 'guest-ok' {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return 'always';

  // Auth endpoints (login/logout) are always accessible.
  if (pathname === '/api/auth' || pathname === '/api/auth/logout') return 'always';

  // Public-safe actions: toggle / lights / fan / countdown.
  // Everything else under /api/devices (e.g. PATCH excluded, sort_order, DELETE)
  // i /api/widgets, /api/timers, /api/rules, /api/settings, /api/hubs → admin only.
  const guestPlayPatterns: RegExp[] = [
    /^\/api\/devices\/\d+\/state$/,
    /^\/api\/devices\/\d+\/light$/,
    /^\/api\/devices\/\d+\/fan$/,
    /^\/api\/devices\/\d+\/countdown$/,
    /^\/api\/groups\/\d+\/toggle$/,    // toggle group state (guest-friendly)
    /^\/api\/groups\/\d+\/light$/,     // light fan-out (guest-friendly)
    /^\/api\/groups\/\d+\/countdown$/  // countdown fan-out (guest-friendly)
  ];
  if (guestPlayPatterns.some(re => re.test(pathname))) return 'guest-ok';

  return 'admin-only';
}
