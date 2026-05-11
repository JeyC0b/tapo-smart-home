import { json } from '@sveltejs/kit';
import { q, exec } from '$lib/server/db';

export async function GET() {
  const rows = await q(
    `SELECT t.*, d.custom_name, d.tapo_alias
       FROM app_scheduled_tasks t
       LEFT JOIN app_devices d ON d.id = t.device_id
       ORDER BY (t.status = 'pending') DESC, t.run_at DESC LIMIT 100`
  );
  return json(rows);
}

export async function DELETE({ url }) {
  // ?id=123 → deletes one; otherwise deletes all done/failed entries
  const id = url.searchParams.get('id');
  if (id) await exec('DELETE FROM app_scheduled_tasks WHERE id = ?', [Number(id)]);
  else await exec(`DELETE FROM app_scheduled_tasks WHERE status IN ('done','failed','cancelled')`);
  return json({ ok: true });
}
