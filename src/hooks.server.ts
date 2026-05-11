import type { Handle } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { startScheduler } from '$lib/server/scheduler';
import {
  AUTH_COOKIE_NAME, isAdminPasswordSet, isMutationAllowedPath, isValidSession
} from '$lib/server/auth';
import { q } from '$lib/server/db';

// Start the background scheduler once at server boot.
startScheduler();

export const handle: Handle = async ({ event, resolve }) => {
  // Determine whether the request is authenticated as admin.
  const token = event.cookies.get(AUTH_COOKIE_NAME);
  const passwordIsSet = await isAdminPasswordSet().catch(() => false);
  const isAdmin = passwordIsSet ? await isValidSession(token).catch(() => false) : true;

  // Expose to `event.locals` for use in +page.server.ts/+server.ts.
  (event.locals as any).isAdmin = isAdmin;
  (event.locals as any).adminPasswordSet = passwordIsSet;

  // Mutation middleware for API endpoints — guests must not change configuration.
  const path = event.url.pathname;
  if (path.startsWith('/api/')) {
    const role = isMutationAllowedPath(path, event.request.method);
    if (role === 'admin-only' && !isAdmin) {
      return json({ error: 'Administrator password required.' }, { status: 401 });
    }
    // Per-device guest_control: even on guest-allowed endpoints, reject devices
    // for which the admin disabled guest control in Settings.
    if (role === 'guest-ok' && !isAdmin) {
      const m = path.match(/^\/api\/devices\/(\d+)\//);
      if (m) {
        const rows = await q<{ guest_control: 0 | 1 }>(
          'SELECT guest_control FROM app_devices WHERE id = ?', [Number(m[1])]
        ).catch(() => []);
        if (rows[0] && rows[0].guest_control === 0) {
          return json(
            { error: 'This device is locked — only the administrator can control it.' },
            { status: 403 }
          );
        }
      }
    }
  }

  return resolve(event);
};
