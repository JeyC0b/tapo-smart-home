import { json, error } from '@sveltejs/kit';
import {
  verifyAdminPassword, createAdminSession, isAdminPasswordSet,
  setAdminPassword, clearAdminPassword,
  AUTH_COOKIE_NAME, AUTH_COOKIE_OPTS
} from '$lib/server/auth';
import { log } from '$lib/server/logger';

/** GET — stav autentizace pro klienta. */
export async function GET({ locals }: any) {
  return json({
    is_admin: !!locals.isAdmin,
    password_set: !!locals.adminPasswordSet
  });
}

/** POST — password login (or initial password setup). */
export async function POST({ request, cookies, locals }: any) {
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
  const ok = await verifyAdminPassword(password);
  if (!ok) {
    await log('warn', 'auth', 'failed login attempt');
    throw error(401, 'Incorrect password.');
  }
  const sess = await createAdminSession(request.headers.get('user-agent') ?? '');
  cookies.set(AUTH_COOKIE_NAME, sess.token, AUTH_COOKIE_OPTS);
  return json({ ok: true, is_admin: true, password_set: true });
}
