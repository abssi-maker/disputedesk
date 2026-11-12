import { runAgent } from '@/lib/agent';
import { ensureBooted, store } from '@/lib/store';

export const dynamic = 'force-dynamic';

const MAX_LENGTH = 280;

/** "Tell the agent": a plain-language instruction from the owner, e.g. "Maya leaves at 2pm". */
export async function POST(req: Request) {
  await ensureBooted();
  const { text } = await req.json().catch(() => ({ text: '' }));
  const instruction = typeof text === 'string' ? text.trim().slice(0, MAX_LENGTH) : '';
  if (!instruction) return Response.json({ started: false, why: 'say something' }, { status: 400 });
  if (store().running) return Response.json({ started: false, why: 'a run is already in progress' }, { status: 409 });
  void runAgent('command', undefined, instruction).catch((e) => console.error('[agent] run failed', (e as Error).message));
  return Response.json({ started: true });
}
