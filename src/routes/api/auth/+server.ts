import { json } from '@sveltejs/kit';
import {
  verifyAdminPassword, createAdminSession, isAdminPasswordSet,
  setAdminPassword, clearAdminPassword, MIN_PASSWORD_LEN,
  AUTH_COOKIE_NAME, AUTH_COOKIE_OPTS
} from '$lib/server/auth';
import { fail } from '$lib/server/api_error';
import { log } from '$lib/server/logger';

// In-memory per-IP brute-force throttle for the standard login path.
const WINDOW_MS = 15 * 60_000;   // failures expire after 15 min
const MAX_ATTEMPTS = 10;         // ...then a temporary lockout kicks in
const LOCK_MS = 15 * 60_000;
const attempts = new Map<string, { count: number; first: number; lockedUntil: number }>();

/**
 * The password length rule lives in auth.setAdminPassword(), which throws a
 * plain Error — that would surface to the user as "Internal server error".
 * Check it up front so a too-short password returns a proper 400 the UI can
 * translate.
 */
function assertPasswordLength(password: string): void {
  if (!password || password.length < MIN_PASSWORD_LEN) {
    fail(400, 'auth_password_too_short',
      `Password must be at least ${MIN_PASSWORD_LEN} characters long.`,
      { min: MIN_PASSWORD_LEN });
  }
}

function loginLockRemaining(ip: string): number {
  const e = attempts.get(ip);
  if (!e) return 0;
  const now = Date.now();
  return e.lockedUntil > now ? Math.ceil((e.lockedUntil - now) / 1000) : 0;
}
function recordLoginFailure(ip: string): void {
  const now = Date.now();
  // Opportunistically evict fully-expired (and unlocked) entries so the map
  // can't grow without bound from many distinct never-succeeding IPs.
  for (const [k, v] of attempts) {
    if (now - v.first > WINDOW_MS && v.lockedUntil <= now) attempts.delete(k);
  }
  let e = attempts.get(ip);
  if (!e || now - e.first > WINDOW_MS) e = { count: 0, first: now, lockedUntil: 0 };
  e.count++;
  if (e.count >= MAX_ATTEMPTS) e.lockedUntil = now + LOCK_MS;
  attempts.set(ip, e);
}

/** GET — authentication state for the client. */
export async function GET({ locals }: any) {
  return json({
    is_admin: !!locals.isAdmin,
    password_set: !!locals.adminPasswordSet
  });
}

/** POST — password login (or initial password setup). */
export async function POST({ request, cookies, locals, getClientAddress }: any) {
  const body = await request.json().catch(() => ({}));
  const password: string = String(body.password ?? '');
  const action: string = String(body.action ?? 'login');

  // First password setup — allowed only when no password exists yet.
  if (action === 'set_initial') {
    if (await isAdminPasswordSet()) {
      fail(400, 'auth_password_already_set',
        'Password is already set. Change it on the Settings page.');
    }
    assertPasswordLength(password);
    await setAdminPassword(password);
    const sess = await createAdminSession(request.headers.get('user-agent') ?? '');
    cookies.set(AUTH_COOKIE_NAME, sess.token, AUTH_COOKIE_OPTS);
    await log('info', 'auth', 'admin password set (initial)');
    return json({ ok: true, is_admin: true, password_set: true });
  }

  // Change password (requires the user to already be admin).
  if (action === 'change') {
    if (!locals.isAdmin) fail(401, 'auth_login_required', 'Login required.');
    assertPasswordLength(password);
    await setAdminPassword(password);
    const sess = await createAdminSession(request.headers.get('user-agent') ?? '');
    cookies.set(AUTH_COOKIE_NAME, sess.token, AUTH_COOKIE_OPTS);
    await log('info', 'auth', 'admin password changed');
    return json({ ok: true, is_admin: true, password_set: true });
  }

  // Disable password (admin only)
  if (action === 'disable') {
    if (!locals.isAdmin) fail(401, 'auth_login_required', 'Login required.');
    await clearAdminPassword();
    cookies.delete(AUTH_COOKIE_NAME, { path: '/' });
    await log('warn', 'auth', 'admin password DISABLED');
    return json({ ok: true, is_admin: true, password_set: false });
  }

  // Standard login
  if (!(await isAdminPasswordSet())) {
    fail(400, 'auth_password_not_set',
      'Password has not been set yet — create one on the Settings page.');
  }
  let ip = 'unknown';
  try { ip = getClientAddress?.() || 'unknown'; } catch { /* adapter without address */ }
  const lock = loginLockRemaining(ip);
  if (lock > 0) {
    await log('warn', 'auth', `login throttled (${ip})`);
    fail(429, 'auth_throttled', `Too many attempts. Try again in ${lock} s.`, { seconds: lock });
  }
  const ok = await verifyAdminPassword(password);
  if (!ok) {
    recordLoginFailure(ip);
    await log('warn', 'auth', 'failed login attempt', { ip });
    fail(401, 'auth_bad_password', 'Incorrect password.');
  }
  attempts.delete(ip);
  const sess = await createAdminSession(request.headers.get('user-agent') ?? '');
  cookies.set(AUTH_COOKIE_NAME, sess.token, AUTH_COOKIE_OPTS);
  return json({ ok: true, is_admin: true, password_set: true });
}
