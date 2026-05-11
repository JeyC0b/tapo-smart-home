import { json } from '@sveltejs/kit';
import { destroyAdminSession, AUTH_COOKIE_NAME } from '$lib/server/auth';

export async function POST({ cookies }: any) {
  const t = cookies.get(AUTH_COOKIE_NAME);
  if (t) await destroyAdminSession(t);
  cookies.delete(AUTH_COOKIE_NAME, { path: '/' });
  return json({ ok: true });
}
