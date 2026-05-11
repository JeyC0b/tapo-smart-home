import { json } from '@sveltejs/kit';
import { q } from '$lib/server/db';

export async function GET({ params }: any) {
  const id = Number(params.id);
  const runs = await q<any>(
    `SELECT r.*, d.custom_name, d.tapo_alias, d.device_id AS device_uid
       FROM app_task_runs r
       LEFT JOIN app_devices d ON d.id = r.device_id
      WHERE r.task_id = ?
      ORDER BY r.ran_at DESC, r.id DESC
      LIMIT 200`,
    [id]
  );
  return json({ runs });
}
