import { json, error } from '@sveltejs/kit';
import { exec } from '$lib/server/db';

export async function PATCH({ params, request }: any) {
  const id = Number(params.id);
  const b = await request.json().catch(() => ({}));
  const allowed = ['title','config','kind','pos_x','pos_y','width','height',
                   'on_home','home_x','home_y','home_width','home_height','enabled'];
  const sets: string[] = [];
  const args: any[] = [];
  for (const k of allowed) {
    if (k in b) {
      sets.push(`${k} = ?`);
      let v: any = b[k];
      if (k === 'config' && v && typeof v === 'object') v = JSON.stringify(v);
      args.push(v);
    }
  }
  if (sets.length === 0) throw error(400, 'No changes provided.');
  args.push(id);
  await exec(`UPDATE app_widgets SET ${sets.join(', ')} WHERE id = ?`, args);
  return json({ ok: true });
}

export async function DELETE({ params }: any) {
  await exec('DELETE FROM app_widgets WHERE id = ?', [Number(params.id)]);
  return json({ ok: true });
}
