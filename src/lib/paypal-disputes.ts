// PayPal Disputes API (v1) through the REST helper; the server SDK does not cover disputes.
import { buildChain } from './chain';
import { paypalRequest } from './paypal-rest';
import { DAY, instantToWallMs, wall } from './time';
import type { Dispute, PayPalWriteRecord } from './types';

const REASONS: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'Item not received',
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'Item not as described',
  UNAUTHORISED: 'Unauthorized transaction',
  CREDIT_NOT_PROCESSED: 'Credit not processed',
  DUPLICATE_TRANSACTION: 'Duplicate transaction',
  INCORRECT_AMOUNT: 'Incorrect amount',
  PAYMENT_BY_OTHER_MEANS: 'Paid by other means',
  CANCELED_RECURRING_BILLING: 'Cancelled recurring billing',
  PROBLEM_WITH_REMITTANCE: 'Problem with remittance',
  OTHER: 'Other',
};

/** Used when PayPal gives no seller_response_due_date; shown as an estimate in the UI. */
const FALLBACK_RESPONSE_DAYS = 10;

/* eslint-disable @typescript-eslint/no-explicit-any */
export function mapPayPalDispute(raw: any, merchantId: string, timeZone: string): Dispute {
  const tx = raw.disputed_transactions?.[0];
  const due = raw.seller_response_due_date as string | undefined;
  const deadlineInstant = due
    ? new Date(due)
    : new Date(new Date(raw.create_time ?? Date.now()).getTime() + FALLBACK_RESPONSE_DAYS * DAY);
  const buyerMessage = (raw.messages as any[] | undefined)?.find((m) => m.posted_by === 'BUYER')?.content as
    | string
    | undefined;
  const facts = [
    `PayPal status ${raw.status}, stage ${raw.dispute_life_cycle_stage}`,
    ...(buyerMessage ? [`Buyer wrote: "${buyerMessage.slice(0, 160)}"`] : []),
    'No seller evidence is on file in DisputeDesk for this order',
  ];
  const base = { id: raw.dispute_id as string, merchantId, assignedTo: 'owner', evidenceSource: null };
  return {
    ...base,
    buyer: tx?.buyer?.name ?? 'PayPal buyer',
    item: tx?.items?.[0]?.item_name ?? tx?.items?.[0]?.item_description ?? `Order ${tx?.seller_transaction_id ?? ''}`.trim(),
    amount: Number(raw.dispute_amount?.value ?? 0),
    currency: raw.dispute_amount?.currency_code ?? 'USD',
    reason: REASONS[raw.reason] ?? raw.reason ?? 'Other',
    facts,
    deadline: wall(instantToWallMs(deadlineInstant, timeZone)),
    deadlineEstimated: !due,
    evidenceReadiness: 0,
    evidenceAvailable: [],
    source: 'paypal',
    status: raw.status === 'RESOLVED' ? 'resolved' : 'open',
    autoResolved: false,
    chain: buildChain(base),
    state: 'safe',
    paypal: {
      status: raw.status,
      stage: raw.dispute_life_cycle_stage,
      allowedActions: ((raw.links as any[] | undefined) ?? []).map((l) => l.rel).filter((rel) => rel !== 'self'),
      updatedAt: raw.update_time,
    },
  };
}

export async function fetchDispute(id: string): Promise<any> {
  return paypalRequest(`/v1/customer/disputes/${encodeURIComponent(id)}`);
}

export async function fetchAllDisputes(): Promise<any[]> {
  const list = await paypalRequest<{ items?: { dispute_id: string }[] }>('/v1/customer/disputes?page_size=50');
  return Promise.all((list.items ?? []).map((d) => fetchDispute(d.dispute_id)));
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function write(path: string, body: unknown, form?: FormData): Promise<PayPalWriteRecord> {
  const record: PayPalWriteRecord = { live: true, method: 'POST', path, body };
  try {
    const res = await paypalRequest(path, { method: 'POST', body: form ?? JSON.stringify(body) });
    record.ok = true;
    record.response = JSON.stringify(res).slice(0, 600);
  } catch (e) {
    record.ok = false;
    record.response = (e as Error).message.slice(0, 600);
  }
  return record;
}

/** POST make-offer: confirmed against the PayPal reference (JSON; note and offer_type required). */
export const makeOffer = (id: string, amount: number, currency: string, note: string) =>
  write(`/v1/customer/disputes/${encodeURIComponent(id)}/make-offer`, {
    note,
    offer_type: 'REFUND',
    offer_amount: { currency_code: currency, value: amount.toFixed(2) },
  });

/** POST accept-claim: the reference lists no required fields; the note is sent as JSON. */
export const acceptClaim = (id: string, note: string) =>
  write(`/v1/customer/disputes/${encodeURIComponent(id)}/accept-claim`, { note });

/**
 * POST provide-evidence. The reference confirms the endpoint and multipart encoding but not the
 * exact part layout, so this is only ever sent after a human approves, and the raw response is logged.
 */
export const provideEvidence = (id: string, note: string) => {
  const input = { evidences: [{ evidence_type: 'OTHER', notes: note }] };
  const form = new FormData();
  form.append('input', new Blob([JSON.stringify(input)], { type: 'application/json' }));
  return write(`/v1/customer/disputes/${encodeURIComponent(id)}/provide-evidence`, input, form);
};
