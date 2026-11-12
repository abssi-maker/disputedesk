import { createTestOrder } from '@/lib/paypal-orders';

export const dynamic = 'force-dynamic';

/** Create a sandbox order for the test item. */
export async function POST() {
  try {
    return Response.json(await createTestOrder());
  } catch (e) {
    return Response.json({ error: (e as Error).message.slice(0, 300) }, { status: 502 });
  }
}
