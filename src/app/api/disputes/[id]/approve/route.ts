import { approvePending } from '@/lib/actions';

export const dynamic = 'force-dynamic';

/** "Approve & send": releases the write the agent was not allowed to send on its own. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await approvePending(id);
  return Response.json(result, { status: result.ok ? 200 : 400 });
}
