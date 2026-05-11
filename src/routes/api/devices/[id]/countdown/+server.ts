import { json, error } from '@sveltejs/kit';
import { commandNativeCountdown } from '$lib/server/poller';
import { scheduleIn } from '$lib/server/tasks';

/**
 * Body: { seconds: number, action: 'on'|'off'|'toggle', native?: boolean }
 *   native=true → use device-side countdown (only when supported by the capability)
 *     NOTE: native countdown only supports on/off (toggle falls back to the app scheduler).
 *   native=false (default) → app scheduler (universal, works for hub-children and bulbs)
 */
export async function POST({ params, request }) {
  const id = Number(params.id);
  const b = await request.json();
  if (typeof b.seconds !== 'number' || b.seconds <= 0) throw error(400, 'seconds:>0');
  if (!['on','off','toggle'].includes(b.action)) throw error(400, 'action: on|off|toggle');

  try {
    if (b.native && b.action !== 'toggle') {
      await commandNativeCountdown(id, b.seconds, b.action);
      return json({ ok: true, mode: 'native' });
    }
    const taskId = await scheduleIn(id, b.seconds, b.action, `countdown ${b.action} ${b.seconds}s`);
    return json({ ok: true, mode: 'app', task_id: taskId });
  } catch (e: any) {
    throw error(500, e.message);
  }
}
