import { exec, q } from './db';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// Cache log_level setting for 5s, refreshed on demand.
let _cachedLevel: LogLevel = 'info';
let _cachedAt = 0;
const LEVEL_TTL_MS = 5000;

async function currentLevel(): Promise<LogLevel> {
  const now = Date.now();
  if (now - _cachedAt < LEVEL_TTL_MS) return _cachedLevel;
  try {
    const r = await q<{ v: string }>(`SELECT v FROM app_settings WHERE k = 'log_level'`);
    const v = (r[0]?.v ?? 'info') as LogLevel;
    _cachedLevel = (['debug','info','warn','error'].includes(v) ? v : 'info') as LogLevel;
  } catch {
    _cachedLevel = 'info';
  }
  _cachedAt = now;
  return _cachedLevel;
}

/** Force refresh of cached level after settings change. */
export function invalidateLogLevelCache() { _cachedAt = 0; }

export async function log(level: LogLevel, source: string, message: string, meta?: unknown) {
  const min = await currentLevel();
  if (LEVEL_RANK[level] < LEVEL_RANK[min]) return;

  // eslint-disable-next-line no-console
  console.log(`[${level}] ${source}: ${message}`, meta ?? '');
  try {
    await exec(
      'INSERT INTO app_logs (level, source, message, meta) VALUES (?,?,?,?)',
      [level, source, message, meta ? JSON.stringify(meta) : null]
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('log() failed', e);
  }
}

/** Convenience helpers (still respect level filter via log()). */
export const logDebug = (source: string, message: string, meta?: unknown) => log('debug', source, message, meta);
export const logInfo  = (source: string, message: string, meta?: unknown) => log('info',  source, message, meta);
export const logWarn  = (source: string, message: string, meta?: unknown) => log('warn',  source, message, meta);
export const logError = (source: string, message: string, meta?: unknown) => log('error', source, message, meta);
