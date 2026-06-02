import { json, error } from '@sveltejs/kit';
import {
  verifyAdminPassword, createAdminSession, isAdminPasswordSet,
  setAdminPassword, clearAdminPassword,
  AUTH_COOKIE_NAME, AUTH_COOKIE_OPTS
} from '$lib/server/auth';
import { log } from '$lib/server/logger';

// In-memory per-IP brute-force throttle for the standard login path.
const WINDOW_MS = 15 * 60_000;   // failures expire after 15 min
const MAX_ATTEMPTS = 10;         // ...then a temporary lockout kicks in
const LOCK_MS = 15 * 60_000;
const attempts = new Map<string, { count: number; first: number; lockedUntil: number }>();

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

/** GET — stav autentizace pro klienta. */
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
      throw error(400, 'Password is already set. Change it on the Settings page.');
    }
    await setAdminPassword(password);
    const sess = await createAdminSession(request.headers.get('user-agent') ?? '');
    cookies.set(AUTH_COOKIE_NAME, sess.token, AUTH_COOKIE_OPTS);
    await log('info', 'auth', 'admin password set (initial)');
    return json({ ok: true, is_admin: true, password_set: true });
  }

  // Change password (requires the user to already be admin).
  if (action === 'change') {
    if (!locals.isAdmin) throw error(401, 'Login required.');
    await setAdminPassword(password);
    const sess = await createAdminSession(request.headers.get('user-agent') ?? '');
    cookies.set(AUTH_COOKIE_NAME, sess.token, AUTH_COOKIE_OPTS);
    await log('info', 'auth', 'admin password changed');
    return json({ ok: true, is_admin: true, password_set: true });
  }

  // Disable password (admin only)
  if (action === 'disable') {
    if (!locals.isAdmin) throw error(401, 'Login required.');
    await clearAdminPassword();
    cookies.delete(AUTH_COOKIE_NAME, { path: '/' });
    await log('warn', 'auth', 'admin password DISABLED');
    return json({ ok: true, is_admin: true, password_set: false });
  }

  // Standard login
  if (!(await isAdminPasswordSet())) {
    throw error(400, 'Password has not been set yet — create one on the Settings page.');
  }
  let ip = 'unknown';
  try { ip = getClientAddress?.() || 'unknown'; } catch { /* adapter without address */ }
  const lock = loginLockRemaining(ip);
  if (lock > 0) {
    await log('warn', 'auth', `login throttled (${ip})`);
    throw error(429, `Too many attempts. Try again in ${lock}s.`);
  }
  const ok = await verifyAdminPassword(password);
  if (!ok) {
    recordLoginFailure(ip);
    await log('warn', 'auth', 'failed login attempt', { ip });
    throw error(401, 'Incorrect password.');
  }
  attempts.delete(ip);
  const sess = await createAdminSession(request.headers.get('user-agent') ?? '');
  cookies.set(AUTH_COOKIE_NAME, sess.token, AUTH_COOKIE_OPTS);
  return json({ ok: true, is_admin: true, password_set: true });
}
