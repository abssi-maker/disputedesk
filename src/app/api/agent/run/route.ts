import { runAgent } from '@/lib/agent';
import { ensureBooted, store } from '@/lib/store';

export const dynamic = 'force-dynamic';

/** "Plan with agent": starts a run over every open dispute. Progress arrives on /api/agent/stream. */
export async function POST() {
  await ensureBooted();
  if (store().running) return Response.json({ started: false, why: 'a run is already in progress' }, { status: 409 });
  void runAgent('plan').catch((e) => console.error('[agent] run failed', (e as Error).message));
  return Response.json({ started: true });
}
