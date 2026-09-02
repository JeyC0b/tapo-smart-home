import type { Handle, HandleServerError } from '@sveltejs/kit';
import { json, redirect } from '@sveltejs/kit';
import { startScheduler } from '$lib/server/scheduler';
import {
  AUTH_COOKIE_NAME, isAdminOnlyPage, isAdminOnlyRead, isAdminPasswordSet,
  isMutationAllowedPath, isValidSession
} from '$lib/server/auth';
import { q } from '$lib/server/db';
import { log } from '$lib/server/logger';

// Start the background scheduler once at server boot.
startScheduler();

// Safety net for UNEXPECTED errors (those not thrown via `error()`): log the
// real cause server-side and return a generic message so internals/stack traces
// never reach the client. Errors thrown via `error(status, msg)` are unaffected.
export const handleError: HandleServerError = ({ error: err, event, status, message }) => {
  if (status !== 404) {
    log('error', 'http', `Unhandled error on ${event.url.pathname}`, { err: String(err) })
      .catch(() => {});
  }
  return status === 404
    ? { message, code: 'not_found' }
    : { message: 'Internal server error.', code: 'internal' };
};

export const handle: Handle = async ({ event, resolve }) => {
  // Determine whether the request is authenticated as admin.
  const token = event.cookies.get(AUTH_COOKIE_NAME);
  const passwordIsSet = await isAdminPasswordSet().catch(() => false);
  const isAdmin = passwordIsSet ? await isValidSession(token).catch(() => false) : true;

  // Expose to `event.locals` for use in +page.server.ts/+server.ts.
  (event.locals as any).isAdmin = isAdmin;
  (event.locals as any).adminPasswordSet = passwordIsSet;

  const path = event.url.pathname;

  // Admin-only PAGES: hiding them from the nav is not access control — their
  // loaders return hub credentials, rules and logs to whoever asks.
  if (!isAdmin && isAdminOnlyPage(path)) {
    throw redirect(303, '/');
  }

  // Mutation middleware for API endpoints — guests must not change configuration.
  if (path.startsWith('/api/')) {
    // Configuration reads are admin-only too (hub IPs, the Tapo account
    // e-mail, rule/timer/widget definitions).
    if (!isAdmin && isAdminOnlyRead(path)) {
      return json(
        { message: 'Administrator password required.', code: 'admin_required' },
        { status: 401 }
      );
    }
    const role = isMutationAllowedPath(path, event.request.method);
    if (role === 'admin-only' && !isAdmin) {
      return json(
        { message: 'Administrator password required.', code: 'admin_required' },
        { status: 401 }
      );
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
            {
              message: 'This device is locked — only the administrator can control it.',
              code: 'device_locked'
            },
            { status: 403 }
          );
        }
      }
    }
  }

  return resolve(event);
};
