import { q } from '$lib/server/db';

const VALID_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

export async function load({ url }: { url: URL }) {
  const page = Math.max(1, Number(url.searchParams.get('page') || '1') | 0);
  const pageSize = Math.min(500, Math.max(20, Number(url.searchParams.get('size') || '100') | 0));
  const level = url.searchParams.get('level') || '';
  const source = (url.searchParams.get('source') || '').trim();
  const qStr = (url.searchParams.get('q') || '').trim();

  const where: string[] = [];
  const args: any[] = [];

  if (level && VALID_LEVELS.has(level)) {
    where.push('level = ?');
    args.push(level);
  }
  if (source) {
    where.push('source = ?');
    args.push(source);
  }
  if (qStr) {
    where.push('(message LIKE ? OR meta LIKE ?)');
    const like = '%' + qStr.replace(/[%_\\]/g, (c: string) => '\\' + c) + '%';
    args.push(like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalRows = await q<{ c: number }>(
    `SELECT COUNT(*) AS c FROM app_logs ${whereSql}`, args
  );
  const total = totalRows[0]?.c ?? 0;
  const offset = (page - 1) * pageSize;

  const logs = await q<any>(
    `SELECT id, level, source, message, meta, created_at
       FROM app_logs ${whereSql}
       ORDER BY id DESC
       LIMIT ? OFFSET ?`,
    [...args, pageSize, offset]
  );

  // Distinct sources for filter dropdown
  const sources = await q<{ source: string }>(
    `SELECT source FROM app_logs GROUP BY source ORDER BY source`
  );

  return {
    logs,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    filters: { level, source, q: qStr },
    sources: sources.map((s: { source: string }) => s.source).filter(Boolean)
  };
}
