declare global {
  namespace App {
    interface Locals {
      /** True when the request carries a valid admin session (or no password is set). */
      isAdmin: boolean;
      /** True when an admin password has been configured at all. */
      adminPasswordSet: boolean;
    }
    interface PageData {}
    /**
     * Error payload returned to the client. `code` is a stable, machine-readable
     * identifier the UI maps to a localised string (see `src/lib/api.ts` and the
     * `errors.*` section of the i18n dictionaries); `message` is the English
     * fallback. Extra scalar fields are available as interpolation variables.
     */
    interface Error {
      message: string;
      code?: string;
      [key: string]: unknown;
    }
    interface Platform {}
  }
}

export {};
