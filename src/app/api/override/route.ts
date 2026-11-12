import { humanOverride } from '@/lib/actions';

export const dynamic = 'force-dynamic';

/** A human dragged or resized a block on the board. */
export async function POST(req: Request) {
  const { taskId, start, workerId, durationMin } = await req.json();
  if (typeof taskId !== 'string') return Response.json({ ok: false, message: 'taskId is required' }, { status: 400 });
  const result = await humanOverride(taskId, { start, workerId, durationMin });
  return Response.json(result, { status: result.ok ? 200 : 400 });
}
