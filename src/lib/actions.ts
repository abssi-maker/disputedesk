// Every change to the board goes through here: agent tool calls, human drags and approvals.
// The deterministic planner validates each move; a move that would push a chain past its
// deadline is rejected and returned to the caller as an error.
import { assembleParts, collapseToResolve, setEvidenceSource, splitAssemble } from './chain';
import * as paypal from './paypal-disputes';
import { lateBy, planDisputes } from './planner';
import { findDispute, logAction, planNow, replan, store } from './store';
import { MIN, formatDuration, ms, wall } from './time';
import {
  EVIDENCE_SOURCES,
  type Actor,
  type Decision,
  type Dispute,
  type EvidenceSource,
  type PayPalWriteKind,
  type PayPalWriteRecord,
} from './types';

export interface ToolContext {
  runId: string;
  by: Actor;
}

export interface ToolResult {
  ok: boolean;
  message: string;
}

type Args = Record<string, unknown>;

const RATIONALE_WORDS = 25;
const DRAFT_WORDS = 90;
const limitWords = (text: string, max: number) => {
  const words = text.trim().split(/\s+/);
  return words.length <= max ? text.trim() : `${words.slice(0, max).join(' ')}…`;
};
const money = (d: Dispute) => `$${d.amount.toFixed(2)}`;
const clock = (t: string) => t.slice(11);

function planStatus(d: Dispute): string {
  if (d.status === 'resolved') return 'resolved';
  const end = d.slot ? clock(d.slot.end) : '?';
  if (d.state === 'late') return `chain ends ${end}, ${formatDuration(lateBy(d))} PAST the deadline`;
  return `chain ends ${end}, ${formatDuration(d.slackMin ?? 0)} before the deadline`;
}

/**
 * Apply a change on a copy, re-plan, and commit only if no chain is made late by it.
 * Returns an error string when the planner rejects the change.
 */
async function tryChange(disputeId: string, mutate: (d: Dispute) => string | null | void): Promise<string | null> {
  const s = store();
  const trial = structuredClone(s.disputes);
  const target = trial.find((d) => d.id === disputeId)!;
  const error = mutate(target);
  if (error) return error;
  const planned = await planDisputes(trial, planNow());
  for (const after of planned.disputes) {
    if (after.status !== 'open' || after.state !== 'late') continue;
    const before = s.disputes.find((d) => d.id === after.id)!;
    if (before.state !== 'late') {
      return `rejected by the scheduling engine: ${after.id} would land ${formatDuration(lateBy(after))} past its deadline. Engine conflict: ${after.conflict}`;
    }
    if (after.id === disputeId && lateBy(after) > lateBy(before)) {
      return `rejected by the scheduling engine: ${after.id} would land even later (${formatDuration(lateBy(after))} past its deadline). Engine conflict: ${after.conflict}`;
    }
  }
  s.disputes = planned.disputes;
  s.counters = planned.counters;
  return null;
}

function record(ctx: ToolContext, tool: string, args: Args, d: Dispute | undefined, ok: boolean, message: string, paypalRecord?: PayPalWriteRecord): ToolResult {
  const { reason, ...rest } = args;
  logAction({
    runId: ctx.runId,
    by: ctx.by,
    tool,
    args: rest,
    disputeId: d?.id,
    ok,
    message,
    reason: typeof reason === 'string' ? reason : undefined,
    paypal: paypalRecord,
  });
  return { ok, message };
}

/** Send (or honestly not send) a PayPal write, then update the dispute. Guardrails are checked by the caller. */
async function performWrite(d: Dispute, kind: PayPalWriteKind, note: string): Promise<{ ok: boolean; message: string; paypal: PayPalWriteRecord }> {
  const path = `/v1/customer/disputes/${d.id}/${{ makeRefundOffer: 'make-offer', acceptClaim: 'accept-claim', provideEvidence: 'provide-evidence' }[kind]}`;
  let rec: PayPalWriteRecord;
  if (d.source === 'paypal') {
    rec =
      kind === 'makeRefundOffer'
        ? await paypal.makeOffer(d.id, d.amount, d.currency, note)
        : kind === 'acceptClaim'
          ? await paypal.acceptClaim(d.id, note)
          : await paypal.provideEvidence(d.id, note);
  } else {
    rec = { live: false, method: 'POST', path, ok: true, response: `Not sent: ${d.id} is ${d.source} data, not a PayPal dispute.` };
  }
  const label = { makeRefundOffer: 'Refund offer', acceptClaim: 'Claim accepted', provideEvidence: 'Evidence' }[kind];
  if (!rec.ok) return { ok: false, message: `PayPal rejected ${kind} for ${d.id}: ${rec.response}`, paypal: rec };

  d.pendingAction = undefined;
  d.status = 'resolved';
  d.state = 'resolved';
  if (kind !== 'provideEvidence') {
    d.decision = kind === 'makeRefundOffer' ? 'refund' : 'concede';
    d.autoResolved = true;
    collapseToResolve(d, 'auto', `${label} ${money(d)}`);
    // The agent lane is not a person: its blocks simply queue one after another from now.
    const laneEnd = store()
      .disputes.flatMap((x) => x.chain)
      .filter((t) => t.workerId === 'auto' && t.end)
      .map((t) => ms(t.end!));
    const start = Math.max(ms(planNow()), ...laneEnd);
    d.chain[0].start = wall(start);
    d.chain[0].end = wall(start + d.chain[0].durationMin * MIN);
    d.slot = { start: d.chain[0].start, end: d.chain[0].end };
  }
  await replan();
  const where = rec.live ? 'sent to PayPal sandbox' : 'simulated, no PayPal call';
  return { ok: true, message: `${label} for ${d.id} (${money(d)}): ${where}`, paypal: rec };
}

/** Guardrail: may the agent send this write on its own? Returns the reason it must wait, or null. */
export function heldBecause(d: Dispute, kind: PayPalWriteKind): string | null {
  const { autoResolveLimitUsd, neverConcedeAboveUsd } = store().policy;
  if (kind === 'provideEvidence') return 'evidence is always reviewed by a human before it is sent';
  if (d.amount > autoResolveLimitUsd) return `${money(d)} is above the $${autoResolveLimitUsd} auto-resolve limit`;
  if (kind === 'acceptClaim' && d.amount > neverConcedeAboveUsd) return `${money(d)} is above the $${neverConcedeAboveUsd} never-concede limit`;
  return null;
}

const HUMAN_WORKERS = () => store().workers.filter((w) => w.kind === 'human').map((w) => w.id);

export async function executeTool(name: string, args: Args, ctx: ToolContext): Promise<ToolResult> {
  const id = String(args.disputeId ?? '');
  const d = findDispute(id);
  const fail = (message: string) => record(ctx, name, args, d, false, message);
  if (!d) return fail(`unknown dispute "${id}"`);
  if (d.status === 'resolved') return fail(`${id} is already resolved`);
  const done = (message: string) => record(ctx, name, args, findDispute(id), true, `${message}. ${id}: ${planStatus(findDispute(id)!)}`);

  switch (name) {
    case 'setDecision': {
      const decision = args.decision as Decision;
      const p = Number(args.winProbability);
      if (!['fight', 'refund', 'concede'].includes(decision)) return fail('decision must be fight, refund or concede');
      if (!(p >= 0 && p <= 1)) return fail('winProbability must be between 0 and 1');
      d.decision = decision;
      d.winProbability = p;
      d.rationale = limitWords(String(args.rationale ?? ''), RATIONALE_WORDS);
      if (args.draft) d.draft = limitWords(String(args.draft), DRAFT_WORDS);
      await replan();
      return record(ctx, name, { ...args, reason: d.rationale }, d, true, `Decision for ${id}: ${decision}, ${Math.round(p * 100)}% win chance`);
    }

    case 'assignDispute': {
      const workerId = String(args.workerId);
      if (!HUMAN_WORKERS().includes(workerId)) return fail(`workerId must be one of ${HUMAN_WORKERS().join(', ')}`);
      const part = args.part == null ? null : Number(args.part);
      const error = await tryChange(id, (t) => {
        if (part == null) {
          t.assignedTo = workerId;
          for (const task of t.chain) task.workerId = workerId;
          return null;
        }
        const parts = assembleParts(t);
        if (parts.length < 2) return 'split the block first, then assign a part';
        if (!parts[part - 1]) return `part must be 1..${parts.length}`;
        parts[part - 1].workerId = workerId;
        return null;
      });
      if (error) return fail(error);
      const name_ = store().workers.find((w) => w.id === workerId)!.name;
      return done(part == null ? `Assigned ${id} to ${name_}` : `Assigned part ${part} of ${id} to ${name_}`);
    }

    case 'moveBlock': {
      const start = String(args.start ?? '').slice(0, 16);
      if (Number.isNaN(ms(start))) return fail('start must look like 2026-01-31T09:30');
      if (ms(start) < ms(planNow())) return fail(`start is in the past; now is ${planNow()}`);
      const error = await tryChange(id, (t) => {
        t.chain[0].pinnedStart = start;
        t.chain[0].pinnedBy = 'agent';
      });
      if (error) return fail(error);
      return done(`Moved ${id} to start at ${clock(start)}`);
    }

    case 'splitBlock': {
      const parts = Number(args.parts);
      if (!Number.isInteger(parts) || parts < 2 || parts > 3) return fail('parts must be 2 or 3');
      const error = await tryChange(id, (t) => splitAssemble(t, parts));
      if (error) return fail(error);
      return done(`Split the evidence block of ${id} into ${parts} parts`);
    }

    case 'swapEvidenceSource': {
      const to = String(args.to) as EvidenceSource;
      if (args.from != null && d.evidenceSource && args.from !== d.evidenceSource) return fail(`current source is ${d.evidenceSource}, not ${String(args.from)}`);
      if (!d.evidenceAvailable.includes(to)) {
        return fail(`"${to}" is not available for ${id}; available: ${d.evidenceAvailable.join(', ') || 'none'}`);
      }
      const from = d.evidenceSource;
      const error = await tryChange(id, (t) => setEvidenceSource(t, to));
      if (error) return fail(error);
      const saved = from ? EVIDENCE_SOURCES[from].minutes - EVIDENCE_SOURCES[to].minutes : 0;
      return done(
        `Switched proof for ${id} from ${from ? EVIDENCE_SOURCES[from].label : 'none'} to ${EVIDENCE_SOURCES[to].label}` +
          (saved > 0 ? ` (${formatDuration(saved)} shorter)` : ''),
      );
    }

    case 'flagForHuman': {
      d.flaggedForHuman = limitWords(String(args.reason ?? 'needs a human decision'), RATIONALE_WORDS);
      return record(ctx, name, args, d, true, `Flagged ${id} for you: ${d.flaggedForHuman}`);
    }

    case 'makeRefundOffer':
    case 'acceptClaim':
    case 'provideEvidence': {
      const note = limitWords(String(args.note ?? ''), DRAFT_WORDS);
      if (!note) return fail('note is required');
      if (name === 'provideEvidence') d.draft = note;
      const held = heldBecause(d, name);
      if (held) {
        d.pendingAction = { kind: name, note, heldBecause: held };
        return record(ctx, name, args, d, true, `Held for Approve & send: ${held}. Nothing was sent`);
      }
      const result = await performWrite(d, name, note);
      return record(ctx, name, args, d, result.ok, result.message, result.paypal);
    }

    default:
      return fail(`unknown tool "${name}"`);
  }
}

/** The human pressed "Approve & send": the held write goes out with their authority. */
export async function approvePending(disputeId: string): Promise<ToolResult> {
  const ctx: ToolContext = { runId: `approve-${Date.now()}`, by: 'human' };
  const d = findDispute(disputeId);
  if (!d?.pendingAction) return { ok: false, message: 'nothing is waiting for approval' };
  const { kind, note } = d.pendingAction;
  const result = await performWrite(d, kind, note);
  return record(ctx, kind, { disputeId, note, reason: 'Approved by you' }, d, result.ok, result.message, result.paypal);
}

/** A human dragged or resized a block. The human always wins; the planner re-plans the rest and explains conflicts. */
export async function humanOverride(taskId: string, change: { start?: string; workerId?: string; durationMin?: number }): Promise<ToolResult> {
  const s = store();
  const d = s.disputes.find((x) => x.chain.some((t) => t.id === taskId));
  const task = d?.chain.find((t) => t.id === taskId);
  if (!d || !task || d.status === 'resolved') return { ok: false, message: 'that block cannot be moved' };
  const ctx: ToolContext = { runId: `override-${Date.now()}`, by: 'human' };
  const lateBefore = new Set(s.counters.unplaced);

  if (change.workerId && s.workers.some((w) => w.id === change.workerId && w.kind === 'human')) task.workerId = change.workerId;
  if (change.durationMin && change.durationMin >= 15) task.durationMin = Math.round(change.durationMin / 5) * 5;
  if (change.start && !Number.isNaN(ms(change.start))) {
    task.pinnedStart = change.start.slice(0, 16);
    task.pinnedBy = 'human';
  }
  await replan();

  const placed = findDispute(d.id)!.chain.find((t) => t.id === taskId)!;
  const worker = s.workers.find((w) => w.id === placed.workerId)!.name;
  record(ctx, 'humanOverride', { taskId, ...change }, d, true, `You moved "${placed.name}" of ${d.id} to ${worker} at ${clock(placed.start!)}; the rest was re-planned around it`);

  const newlyLate = store().disputes.filter((x) => x.status === 'open' && x.state === 'late' && !lateBefore.has(x.id));
  for (const late of newlyLate) {
    record(
      { runId: ctx.runId, by: 'planner' },
      'explainConflict',
      {},
      late,
      true,
      `Your move leaves ${late.id} ${formatDuration(lateBy(late))} past its deadline (${money(late)} at risk). Engine conflict: ${late.conflict}. Press Plan with agent to rebalance`,
    );
  }
  return { ok: true, message: 'moved' };
}
