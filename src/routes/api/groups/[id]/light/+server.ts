import { json, error } from '@sveltejs/kit';
import { q } from '$lib/server/db';
import { commandLight } from '$lib/server/poller';

// POST /api/groups/:id/light — fan out light parameters (brightness/hsv/color_temp)
// to every member that has the matching capability. Errors per-device are collected,
// but one device's failure does not abort the others.
export async function POST({ params, request }: any) {
  const id = Number(params.id);
  const b = await request.json().catch(() => ({}));
  const p: any = {};
  if (typeof b.brightness === 'number') p.brightness = b.brightness;
  if (Array.isArray(b.hsv) && b.hsv.length === 3) p.hsv = b.hsv;
  if (typeof b.color_temp === 'number') p.color_temp = b.color_temp;
  if (typeof b.effect === 'string') p.effect = b.effect;
  if (!Object.keys(p).length) throw error(400, 'no light parameters');

  const members = await q<{ device_id: number; kind: string; capabilities: any }>(
    `SELECT m.device_id, d.kind, d.capabilities
       FROM app_device_group_members m JOIN app_devices d ON d.id = m.device_id
      WHERE m.group_id = ?`,
    [id]
  );
  if (!members.length) throw error(400, 'group has no members');

  const errs: string[] = [];
  let ok = 0;
  await Promise.all(members.map(async (m: any) => {
    // Skip non-bulb / non-strip members; light commands are only meaningful there.
    const caps = (typeof m.capabilities === 'string' ? safeParse(m.capabilities) : m.capabilities) || {};
    if (!(caps.brightness || caps.color || caps.color_temp)) return;
    try { await commandLight(m.device_id, p); ok++; }
    catch (e: any) { errs.push(`${m.device_id}: ${e.message || e}`); }
  }));
  if (!ok && errs.length) throw error(500, errs.join('; '));
  return json({ ok: true, applied: ok, partial_errors: errs });
}

function safeParse(s: string): any { try { return JSON.parse(s); } catch { return null; } }
