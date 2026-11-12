import { captureOrder } from '@/lib/paypal-orders';

export const dynamic = 'force-dynamic';

/** Capture a sandbox order after the buyer approved it. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return Response.json(await captureOrder(id));
  } catch (e) {
    return Response.json({ error: (e as Error).message.slice(0, 300) }, { status: 502 });
  }
}
