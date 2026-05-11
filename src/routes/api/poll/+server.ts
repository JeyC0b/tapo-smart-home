import { json } from '@sveltejs/kit';
import { pollAll } from '$lib/server/poller';
import { evaluateRules } from '$lib/server/rules';

export async function POST() {
  await pollAll();
  await evaluateRules();
  return json({ ok: true });
}
