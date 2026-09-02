import { q, exec } from './db';

export type LogLevelSetting = 'debug' | 'info' | 'warn' | 'error';
export type LanguageCode = 'en' | 'cs';

export interface AppSettings {
  poll_interval_seconds: number;
  rules_enabled: boolean;
  offline_after_failures: number;
  verify_actions: boolean;
  default_username: string;
  default_password: string;
  log_level: LogLevelSetting;
  default_language: LanguageCode;
  /**
   * Roughly how long a task keeps retrying a device that does not answer.
   * The window is converted into an attempt budget, so a task that starts late
   * still gets its full share of retries. 0 disables retrying. Automatic
   * reverts of "on/off for N minutes" timers use their own, much longer window
   * so a device is never left in a state the user did not ask for.
   */
  task_retry_minutes: number;
  task_revert_retry_minutes: number;
}

const DEFAULTS: AppSettings = {
  poll_interval_seconds: 180,
  rules_enabled: true,
  offline_after_failures: 3,
  verify_actions: true,
  default_username: '',
  default_password: '',
  log_level: 'info',
  default_language: 'en',
  task_retry_minutes: 60,
  task_revert_retry_minutes: 1440
};

/** Parse a stored setting as a non-negative number, falling back on garbage. */
function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export async function getAllSettings(): Promise<AppSettings> {
  const rows = await q<{ k: string; v: string }>('SELECT k, v FROM app_settings');
  const m = new Map(rows.map(r => [r.k, r.v]));
  const lvl = (m.get('log_level') ?? DEFAULTS.log_level) as LogLevelSetting;
  const langRaw = (m.get('default_language') ?? DEFAULTS.default_language) as string;
  const lang: LanguageCode = (langRaw === 'cs' || langRaw === 'en') ? langRaw : 'en';
  return {
    poll_interval_seconds: Number(m.get('poll_interval_seconds') ?? DEFAULTS.poll_interval_seconds),
    rules_enabled: (m.get('rules_enabled') ?? '1') === '1',
    offline_after_failures: Number(m.get('offline_after_failures') ?? DEFAULTS.offline_after_failures),
    verify_actions: (m.get('verify_actions') ?? '1') === '1',
    default_username: m.get('default_username') ?? '',
    default_password: m.get('default_password') ?? '',
    log_level: (['debug','info','warn','error'].includes(lvl) ? lvl : 'info') as LogLevelSetting,
    default_language: lang,
    task_retry_minutes: num(m.get('task_retry_minutes'), DEFAULTS.task_retry_minutes),
    task_revert_retry_minutes: num(m.get('task_revert_retry_minutes'), DEFAULTS.task_revert_retry_minutes)
  };
}

export async function getSetting(key: string, fallback = ''): Promise<string> {
  const r = await q<{ v: string }>(`SELECT v FROM app_settings WHERE k = ?`, [key]);
  return r[0]?.v ?? fallback;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await exec(
    `INSERT INTO app_settings (k, v) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE v = VALUES(v)`,
    [key, value]
  );
}

export async function getDefaultCredentials(): Promise<{ username: string; password: string } | null> {
  const u = await getSetting('default_username');
  const p = await getSetting('default_password');
  if (u && p) return { username: u, password: p };
  return null;
}
