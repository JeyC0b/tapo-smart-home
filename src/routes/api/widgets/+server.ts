import { json } from '@sveltejs/kit';
import { q, exec } from '$lib/server/db';
import { fail } from '$lib/server/api_error';

const KINDS = new Set(['device','sensor','http','label','spacer','group','line']);

export async function GET() {
  const rows = await q<any>(
    `SELECT id, kind, title, config, on_home, home_x, home_y, home_width, home_height,
            pos_x, pos_y, width, height, enabled, created_at
       FROM app_widgets
      ORDER BY id DESC`
  );
  return json({ widgets: rows.map(r => ({ ...r, config: safeJson(r.config) })) });
}

export async function POST({ request }: any) {
  const b = await request.json().catch(() => ({}));
  const kind = String(b.kind || '');
  if (!KINDS.has(kind)) fail(400, 'invalid_input', 'Invalid widget type.');
  const title = (b.title || '').toString().slice(0, 128) || null;
  const config = b.config && typeof b.config === 'object' ? JSON.stringify(b.config) : null;
  const r = await exec(
    `INSERT INTO app_widgets (kind, title, config, on_home, enabled)
     VALUES (?,?,?,?,?)`,
    [kind, title, config, b.on_home ? 1 : 0, b.enabled === 0 ? 0 : 1]
  );
  return json({ ok: true, id: (r as any).insertId });
}

function safeJson(v: any) { if (!v) return null; try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } }
