#!/usr/bin/env node
/**
 * Applies db/schema.sql (safe to re-run — everything is CREATE TABLE IF NOT
 * EXISTS / INSERT IGNORE) and then every db/migrations/*.sql in version order.
 *
 * The migration files are written to be idempotent (ADD COLUMN IF NOT EXISTS,
 * ON DUPLICATE KEY UPDATE, …), so running this after an upgrade is always safe
 * and no separate "applied migrations" bookkeeping table is needed.
 *
 *   npm run db:migrate            # schema + all migrations
 *   npm run db:migrate -- --only v12
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal .env reader — the app itself uses SvelteKit's $env at runtime. */
function loadEnv() {
  const out = { ...process.env };
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (out[key] === undefined || out[key] === '') out[key] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Split a script into statements. Comments are stripped first: `--` comments
 * are common INSIDE our multi-line ALTER statements, so a naive split on ';'
 * would swallow the rest of the statement into a comment.
 */
function statements(sql) {
  return sql
    .replace(/^\uFEFF/, '')      // some editors save the .sql files with a BOM
    .replace(/\r\n?/g, '\n')     // CRLF → LF, otherwise `.*$` stops before the \r
    .split('\n')
    .map(l => l.replace(/(^|\s)--\s.*$/, ''))
    .join('\n')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);
}

/** v6_… < v9_… < v10_… — compare the leading version number numerically. */
function versionOf(name) {
  const m = /^v(\d+)/.exec(name);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

const env = loadEnv();
const onlyIdx = process.argv.indexOf('--only');
const only = onlyIdx > -1 ? process.argv[onlyIdx + 1] : null;

const conn = await mysql.createConnection({
  host: env.DB_HOST || 'localhost',
  port: Number(env.DB_PORT || 3306),
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  multipleStatements: false
});

const files = [];
if (!only) files.push(path.join(root, 'db', 'schema.sql'));
const migDir = path.join(root, 'db', 'migrations');
if (fs.existsSync(migDir)) {
  files.push(
    ...fs.readdirSync(migDir)
      .filter(f => f.endsWith('.sql'))
      .filter(f => !only || f.startsWith(only))
      .sort((a, b) => versionOf(a) - versionOf(b) || a.localeCompare(b))
      .map(f => path.join(migDir, f))
  );
}

let failed = 0;
for (const file of files) {
  const rel = path.relative(root, file);
  const stmts = statements(fs.readFileSync(file, 'utf8'));
  let ok = 0;
  for (const stmt of stmts) {
    try {
      await conn.query(stmt);
      ok++;
    } catch (e) {
      // Duplicates are expected when re-running against an up-to-date DB.
      if (['ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME', 'ER_TABLE_EXISTS_ERROR'].includes(e.code)) {
        ok++;
        continue;
      }
      failed++;
      console.error(`✗ ${rel}: ${e.code || ''} ${e.message}\n  ${stmt.slice(0, 160)}`);
    }
  }
  console.log(`${failed ? '•' : '✓'} ${rel} — ${ok}/${stmts.length} statements`);
}

await conn.end();
if (failed) {
  console.error(`\n${failed} statement(s) failed.`);
  process.exit(1);
}
console.log('\nDatabase is up to date.');
