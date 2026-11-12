// What a PayPal webhook delivery may do. Unverified deliveries never reach the agent.
import { runAgent } from './agent';
import { fetchDispute } from './paypal-disputes';
import { logAction, replan, upsertPayPalDispute } from './store';

const AGENT_EVENTS = new Set(['CUSTOMER.DISPUTE.CREATED', 'CUSTOMER.DISPUTE.UPDATED']);

export interface WebhookOutcome {
  agentTriggered: boolean;
  why: string;
}

export async function handleDisputeEvent(
  event: { event_type?: string; resource?: { dispute_id?: string } },
  verified: boolean,
): Promise<WebhookOutcome> {
  if (!verified) return { agentTriggered: false, why: 'signature not verified' };
  if (!AGENT_EVENTS.has(event.event_type ?? '')) return { agentTriggered: false, why: 'event type is not handled' };
  const id = event.resource?.dispute_id;
  if (!id) return { agentTriggered: false, why: 'no dispute id in event' };

  // The webhook body is only a trigger: the dispute itself is read back from PayPal.
  const { dispute, isNew } = upsertPayPalDispute(await fetchDispute(id));
  await replan();
  logAction({
    runId: `webhook-${id}`,
    by: 'system',
    tool: 'paypalWebhook',
    args: { eventType: event.event_type },
    disputeId: id,
    ok: true,
    message: `Verified PayPal webhook ${event.event_type}: ${id} ${isNew ? 'added to the board' : 'refreshed'}`,
  });

  // Our own writes come back as UPDATED events; a dispute that is decided or closed needs no new run.
  if (dispute.status !== 'open' || dispute.decision) return { agentTriggered: false, why: 'dispute already handled' };
  void runAgent('event', [id]).catch((e) => console.error('[agent] run failed', (e as Error).message));
  return { agentTriggered: true, why: 'verified dispute event' };
}
