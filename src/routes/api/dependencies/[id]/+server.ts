import { exec } from '$lib/server/db';
import { json } from '@sveltejs/kit';

export async function DELETE({ params }) {
  await exec('DELETE FROM app_dependencies WHERE id = ?', [Number(params.id)]);
  return json({ ok: true });
}
