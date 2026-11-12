import { warmUp } from '@/lib/agent';
import { resetStore, store } from '@/lib/store';

export const dynamic = 'force-dynamic';

/** Rebuild the board from seeds. { demo: true } freezes the clock at 09:00 and warms up the agent. */
export async function POST(req: Request) {
  if (store().running) return Response.json({ ok: false, why: 'a run is in progress' }, { status: 409 });
  const { demo } = await req.json().catch(() => ({ demo: false }));
  await Promise.all([resetStore(Boolean(demo)), demo ? warmUp() : undefined]);
  return Response.json({ ok: true, demo: Boolean(demo) });
}
