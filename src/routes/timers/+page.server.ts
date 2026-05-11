import { q } from '$lib/server/db';

export async function load({ url }: { url: URL }) {
  const view = url.searchParams.get('view') || 'pending';
  const page = Math.max(1, Number(url.searchParams.get('page') || '1') | 0);
  const pageSize = Math.min(200, Math.max(10, Number(url.searchParams.get('size') || '50') | 0));

  const where: string[] = [];
  if (view === 'pending') where.push("t.status = 'pending'");
  else if (view === 'history') where.push("t.status IN ('done','failed','cancelled')");
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalRows = await q<{ c: number }>(`SELECT COUNT(*) AS c FROM app_scheduled_tasks t ${whereSql}`);
  const total = totalRows[0]?.c ?? 0;

  const timers = await q<any>(
    `SELECT t.*,
            d.custom_name, d.tapo_alias, d.device_id AS device_uid
       FROM app_scheduled_tasks t
       LEFT JOIN app_devices d ON d.id = t.device_id
       ${whereSql}
       ORDER BY ${view === 'pending' ? 't.run_at ASC' : 't.id DESC'}
       LIMIT ? OFFSET ?`,
    [pageSize, (page - 1) * pageSize]
  );

  const devices = await q<any>(
    `SELECT id, kind, custom_name, tapo_alias, device_id, room
       FROM app_devices
      WHERE kind IN ('switch','plug','bulb','fan','strip')
      ORDER BY room, COALESCE(custom_name, tapo_alias, device_id)`
  );

  return {
    timers, devices, view, page, pageSize, total,
    totalPages: Math.max(1, Math.ceil(total / pageSize))
  };
}
