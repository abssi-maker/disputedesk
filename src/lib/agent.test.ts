import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./paypal-disputes', async (original) => ({
  ...(await original<typeof import('./paypal-disputes')>()),
  fetchDispute: vi.fn(),
  makeOffer: vi.fn(),
}));

import { approvePending, executeTool } from './actions';
import { runAgent } from './agent';
import * as paypal from './paypal-disputes';
import { simulatedDispute } from './seeds';
import { findDispute, planNow, replan, resetStore, setPolicy, store } from './store';
import { ms } from './time';
import { handleDisputeEvent } from './webhook';

const ctx = { runId: 'test', by: 'gemini' as const };
const tools = () => store().actions.map((a) => a.tool);

beforeEach(async () => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.PAYPAL_CLIENT_ID;
  delete process.env.PAYPAL_CLIENT_SECRET;
  process.env.AGENT_STEP_MS = '0';
  process.env.AUTO_RESOLVE_LIMIT_USD = '50';
  vi.clearAllMocks();
  await resetStore(true);
});

async function addSimulated() {
  const d = simulatedDispute(ms(planNow()), 1);
  store().disputes.push(d);
  await replan();
  return d.id;
}

describe('the wow path with the offline agent', () => {
  it('turns a late simulated dispute green by swapping proof, splitting and assigning half to Maya', async () => {
    const id = await addSimulated();
    expect(findDispute(id)!.state).toBe('late');
    expect(store().counters.atRiskUsd).toBeGreaterThanOrEqual(640);

    await runAgent('event', [id]);

    const d = findDispute(id)!;
    expect(d.state).toBe('safe');
    expect(d.evidenceSource).toBe('delivery_photo');
    expect(d.chain.filter((t) => t.kind === 'assemble').map((t) => t.workerId)).toEqual(['owner', 'maya']);
    expect(tools()).toEqual(expect.arrayContaining(['swapEvidenceSource', 'splitBlock', 'assignDispute']));
    expect(store().counters.unplaced).not.toContain(id);
    expect(store().running).toBe(false);
  });

  it('leaves no dispute late after planning the whole seeded board', async () => {
    await runAgent('plan');
    const late = store().disputes.filter((d) => d.status === 'open' && d.state === 'late' && !d.flaggedForHuman);
    expect(late).toEqual([]);
    expect(store().counters.protectedUsd).toBeGreaterThan(0);
  });
});

describe('planner validation of agent moves', () => {
  it('rejects a move that would put a chain past its deadline', async () => {
    const d = store().disputes.find((x) => x.state !== 'late')!;
    const result = await executeTool('moveBlock', { disputeId: d.id, start: d.deadline }, ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('rejected by the scheduling engine');
    expect(result.message).toContain('Finish-No-Later-Than');
    expect(findDispute(d.id)!.chain[0].pinnedStart).toBeUndefined();
  });

  it('rejects an evidence source that is not available for the dispute', async () => {
    const result = await executeTool('swapEvidenceSource', { disputeId: 'D-4858', to: 'signature' }, ctx);
    expect(result.ok).toBe(false);
  });
});

describe('guardrails', () => {
  it('holds a write above the auto-resolve limit until Approve & send', async () => {
    const result = await executeTool('makeRefundOffer', { disputeId: 'D-4830', note: 'Full refund.' }, ctx); // $64.50 > $50
    expect(result.message).toContain('Held for Approve & send');
    const held = findDispute('D-4830')!;
    expect(held.status).toBe('open');
    expect(held.pendingAction?.kind).toBe('makeRefundOffer');
    expect(store().actions.at(-1)!.paypal).toBeUndefined();

    const approved = await approvePending('D-4830');
    expect(approved.ok).toBe(true);
    expect(findDispute('D-4830')!.status).toBe('resolved');
    expect(store().actions.at(-1)!.by).toBe('human');
  });

  it('sends a write at or under the limit at once, on the agent lane', async () => {
    await executeTool('makeRefundOffer', { disputeId: 'D-4833', note: 'Full refund.' }, ctx); // $18.99
    const d = findDispute('D-4833')!;
    expect(d.status).toBe('resolved');
    expect(d.autoResolved).toBe(true);
    expect(d.chain.map((t) => t.workerId)).toEqual(['auto']);
  });

  it('never marks a seed dispute write as a live PayPal call', async () => {
    await executeTool('makeRefundOffer', { disputeId: 'D-4833', note: 'Full refund.' }, ctx);
    const rec = store().actions.at(-1)!.paypal!;
    expect(rec.live).toBe(false);
    expect(paypal.makeOffer).not.toHaveBeenCalled();
  });

  it('follows the policy panel when the limit changes', async () => {
    setPolicy({ autoResolveLimitUsd: 10 });
    await executeTool('makeRefundOffer', { disputeId: 'D-4833', note: 'Full refund.' }, ctx);
    expect(findDispute('D-4833')!.pendingAction).toBeDefined();
  });

  it('always holds evidence for human review', async () => {
    await executeTool('provideEvidence', { disputeId: 'D-4833', note: 'Statement.' }, ctx);
    expect(findDispute('D-4833')!.pendingAction?.kind).toBe('provideEvidence');
  });
});

describe('webhook path', () => {
  const event = { event_type: 'CUSTOMER.DISPUTE.CREATED', resource: { dispute_id: 'PP-D-1' } };
  const raw = {
    dispute_id: 'PP-D-1',
    status: 'WAITING_FOR_SELLER_RESPONSE',
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    dispute_life_cycle_stage: 'INQUIRY',
    dispute_amount: { currency_code: 'USD', value: '25.00' },
    create_time: new Date().toISOString(),
    links: [{ rel: 'self' }, { rel: 'make_offer' }],
  };

  it('does nothing for an unverified delivery', async () => {
    const outcome = await handleDisputeEvent(event, false);
    expect(outcome.agentTriggered).toBe(false);
    expect(paypal.fetchDispute).not.toHaveBeenCalled();
    expect(findDispute('PP-D-1')).toBeUndefined();
    expect(tools()).not.toContain('runStart');
  });

  it('adds the dispute and starts the agent for a verified delivery', async () => {
    vi.mocked(paypal.fetchDispute).mockResolvedValue(raw);
    vi.mocked(paypal.makeOffer).mockResolvedValue({ live: true, method: 'POST', path: '/x', ok: true, response: '{}' });
    const outcome = await handleDisputeEvent(event, true);
    expect(outcome.agentTriggered).toBe(true);
    await vi.waitFor(() => expect(tools()).toContain('runEnd'));

    const d = findDispute('PP-D-1')!;
    expect(d.source).toBe('paypal');
    expect(d.decision).toBe('refund');
    expect(paypal.makeOffer).toHaveBeenCalledWith('PP-D-1', 25, 'USD', expect.any(String));
    expect(store().actions.find((a) => a.tool === 'makeRefundOffer')!.paypal!.live).toBe(true);
  });

  it('does not start a second run when our own write comes back as an UPDATED event', async () => {
    vi.mocked(paypal.fetchDispute).mockResolvedValue(raw);
    vi.mocked(paypal.makeOffer).mockResolvedValue({ live: true, method: 'POST', path: '/x', ok: true, response: '{}' });
    await handleDisputeEvent(event, true);
    await vi.waitFor(() => expect(tools()).toContain('runEnd'));
    const again = await handleDisputeEvent({ ...event, event_type: 'CUSTOMER.DISPUTE.UPDATED' }, true);
    expect(again.agentTriggered).toBe(false);
  });
});
