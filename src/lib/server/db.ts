import mysql from 'mysql2/promise';
import { env } from '$env/dynamic/private';

let pool: mysql.Pool | null = null;

export function db(): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: env.DB_HOST || 'localhost',
      port: Number(env.DB_PORT || 3306),
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 8,
      decimalNumbers: true,
      timezone: 'local',
      charset: 'utf8mb4'
    });
  }
  return pool;
}

export async function q<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const [rows] = await db().query(sql, params);
  return rows as T[];
}

export async function exec(sql: string, params: any[] = []): Promise<mysql.ResultSetHeader> {
  const [r] = await db().execute(sql, params);
  return r as mysql.ResultSetHeader;
}

/**
 * Run `fn` inside a single transaction on a dedicated connection. Commits on
 * success, rolls back on any throw. Use for multi-statement bulk writes
 * (reorder, positions, group-member replace) so a mid-loop failure cannot
 * leave the data half-applied.
 */
export async function tx<T>(fn: (c: mysql.PoolConnection) => Promise<T>): Promise<T> {
  const c = await db().getConnection();
  try {
    await c.beginTransaction();
    const r = await fn(c);
    await c.commit();
    return r;
  } catch (e) {
    try { await c.rollback(); } catch { /* ignore rollback error */ }
    throw e;
  } finally {
    c.release();
  }
}
