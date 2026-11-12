import { verifyWebhookSignature } from '@/lib/paypal-rest';

export const dynamic = 'force-dynamic';

interface LoggedEvent {
  id: string;
  type: string;
  resourceId?: string;
  verified: boolean;
  receivedAt: string;
}

// In-memory log of recent deliveries; resets when the instance restarts.
const g = globalThis as unknown as { __ppWebhookLog?: LoggedEvent[] };
const log = (g.__ppWebhookLog ??= []);

export async function POST(req: Request) {
  const raw = await req.text();
  let event: any;
  try {
    event = JSON.parse(raw);
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }

  let verified = false;
  try {
    verified = await verifyWebhookSignature(req.headers, event);
  } catch (e) {
    console.error('[paypal-webhook] verification error', (e as Error).message);
  }

  const entry: LoggedEvent = {
    id: event.id,
    type: event.event_type,
    resourceId: event.resource?.dispute_id ?? event.resource?.id,
    verified,
    receivedAt: new Date().toISOString(),
  };
  log.unshift(entry);
  log.length = Math.min(log.length, 50);
  console.log('[paypal-webhook]', JSON.stringify(entry));

  // Unverified events (e.g. from the dashboard simulator) are logged but must never trigger agent actions.
  // Always answer 200 quickly so PayPal does not retry; processing happens elsewhere.
  return Response.json({ received: true, verified });
}

/** Delivery check: event types and ids only, no payloads. */
export function GET() {
  return Response.json({ count: log.length, events: log });
}
