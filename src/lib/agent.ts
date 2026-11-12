// The agent that drives the schedule. Gemini decides what to do and why through function calls;
// every call runs through executeTool, where the deterministic planner and guardrails can reject it.
// Without GEMINI_API_KEY (or if Gemini fails) a rule-based agent uses the same tools.
import { FunctionCallingConfigMode, GoogleGenAI, ThinkingLevel, type Content, type FunctionDeclaration, type Part } from '@google/genai';
import { executeTool, heldBecause, type ToolContext } from './actions';
import { assembleParts } from './chain';
import { lateBy, priority } from './planner';
import { findDispute, logAction, nowMs, planNow, setRunning, store } from './store';
import { EVIDENCE_SOURCES, type Dispute, type EvidenceSource } from './types';

export type Trigger = 'plan' | 'event';

const MAX_TURNS = 4;
const TURN_TIMEOUT_MS = 20_000;
/** Pause between tool calls so each one is visible on the board. */
const stepDelayMs = () => Number(process.env.AGENT_STEP_MS ?? 650);
const sleep = (t: number) => new Promise((r) => setTimeout(r, t));

const str = { type: 'string' };
const reason = { type: 'string', description: 'Why you are doing this, 15 words at most, citing the deciding fact.' };
const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[]): FunctionDeclaration => ({
  name,
  description,
  parametersJsonSchema: { type: 'object', properties: { disputeId: str, ...properties, reason }, required: ['disputeId', ...required, 'reason'] },
});

const TOOLS: FunctionDeclaration[] = [
  tool(
    'setDecision',
    'Record the decision for a dispute. Call this first for every dispute that has no decision.',
    {
      decision: { type: 'string', enum: ['fight', 'refund', 'concede'] },
      winProbability: { type: 'number', description: '0 to 1' },
      rationale: { type: 'string', description: '25 words at most, citing the deciding fact.' },
      draft: { type: 'string', description: 'Evidence statement or refund note for PayPal, 90 words at most. Only facts listed on the dispute.' },
    },
    ['decision', 'winProbability', 'rationale'],
  ),
  tool(
    'swapEvidenceSource',
    'Use a different proof for a dispute. Only sources in evidenceAvailable are allowed. A faster source shortens the chain.',
    { from: str, to: str },
    ['to'],
  ),
  tool('splitBlock', 'Split the "assemble evidence" block into 2 or 3 equal parts that can run in parallel on different people.', { parts: { type: 'integer' } }, ['parts']),
  tool(
    'assignDispute',
    'Assign a dispute to a human worker. With "part", assign only that part of a split evidence block (1-based).',
    { workerId: { type: 'string', enum: ['owner', 'maya'] }, part: { type: 'integer' } },
    ['workerId'],
  ),
  tool('moveBlock', 'Pin the start of a dispute chain to a time (YYYY-MM-DDTHH:mm). The planner rejects times that miss the deadline.', { start: str }, ['start']),
  tool('flagForHuman', 'Ask the owner to decide. Use when evidence is missing and the amount is above the auto-resolve limit.', {}, []),
  tool('makeRefundOffer', 'Offer the buyer a full refund through PayPal. Above the auto-resolve limit it is held for approval.', { note: { type: 'string', description: 'Note to the buyer, 60 words at most.' } }, ['note']),
  tool('acceptClaim', 'Accept the claim (concede) through PayPal. Held for approval above the limits.', { note: str }, ['note']),
  tool('provideEvidence', 'Queue the evidence statement for PayPal. Always held until the human presses Approve & send.', { note: { type: 'string', description: 'Evidence statement, 90 words at most. Only facts listed on the dispute.' } }, ['note']),
];

const SYSTEM = `You are the dispute agent for one small PayPal seller. You drive a schedule board: three lanes
(owner "You", assistant "Maya", and your own Auto-resolver lane). Each dispute has a chain
proof -> assemble evidence -> submit that must END before the PayPal response deadline. Working hours are 09:00-17:00.

You act only through tool calls. A deterministic planner places the blocks and rejects any move that would
make a chain miss its deadline; when a call is rejected, read the error and try something else.

For each dispute in "focus":
1. If it has no decision, call setDecision. Fight when the listed facts support the seller. Refund when there is
   no usable evidence. Never concede above the never-concede limit.
2. refund or concede: call makeRefundOffer or acceptClaim. At or under the auto-resolve limit it is sent at once;
   above it, it waits for the human.
3. fight: if the chain is late or tight, fix it in this order and stop as soon as it lands in time:
   a. swapEvidenceSource to the fastest source in evidenceAvailable,
   b. splitBlock into 2 and assignDispute part 2 to the human with less work,
   c. only in a later turn, and only if the tool result still says PAST the deadline: assignDispute the whole
      dispute to the human with less work.
   Then call provideEvidence with the evidence statement.
   A dispute that is in focus only because another one pushed it late may recover by itself once that one is
   fixed: handle the most urgent dispute first and re-check the others in the state you get back.
4. If nothing can save it, call flagForHuman.

Rules:
- Never invent tracking numbers, dates, names or any fact. Use only "facts" on the dispute. If evidence is missing, say what is missing.
- rationale: 25 words at most, citing the deciding fact. Drafts and notes: 90 words at most.
- Put every call you are confident about into one turn, in the order they must run. Do not touch disputes outside "focus".
- When everything in focus is decided and on time (or flagged), reply with one short sentence and no tool call.`;

function describe(d: Dispute) {
  return {
    id: d.id,
    source: d.source,
    amountUsd: d.amount,
    reason: d.reason,
    buyer: d.buyer,
    item: d.item,
    facts: d.facts,
    deadline: d.deadline,
    plan: d.state === 'late' ? `LATE by ${lateBy(d)} min` : `${d.state}, ${d.slackMin} min slack`,
    conflict: d.conflict,
    evidenceSource: d.evidenceSource && { name: d.evidenceSource, minutes: EVIDENCE_SOURCES[d.evidenceSource].minutes },
    evidenceAvailable: d.evidenceAvailable.map((s) => ({ name: s, minutes: EVIDENCE_SOURCES[s].minutes })),
    decision: d.decision,
    pendingApproval: d.pendingAction?.kind,
    paypal: d.paypal && { stage: d.paypal.stage, status: d.paypal.status, allowedActions: d.paypal.allowedActions },
    chain: d.chain.map((t) => ({ step: t.name, worker: t.workerId, minutes: t.durationMin, start: t.start, end: t.end })),
  };
}

function workload(): Record<string, number> {
  const load: Record<string, number> = {};
  for (const w of store().workers) load[w.id] = 0;
  for (const d of store().disputes) {
    if (d.status !== 'open') continue;
    for (const t of d.chain) load[t.workerId] += t.durationMin;
  }
  return load;
}

const openFocus = (ids: string[]) => ids.map((id) => findDispute(id)).filter((d): d is Dispute => d?.status === 'open');
/** Work is left when a focus dispute has no decision, or is late and not yet handed to the human. */
const needsWork = (d: Dispute) => !d.decision || (d.state === 'late' && !d.flaggedForHuman);

function stateMessage(focus: string[]): string {
  const s = store();
  return JSON.stringify({
    now: planNow(),
    policy: s.policy,
    workersBusyMinutes: workload(),
    focus: openFocus(focus).map(describe),
    otherOpenDisputes: s.disputes
      .filter((d) => d.status === 'open' && !focus.includes(d.id))
      .map((d) => ({ id: d.id, amountUsd: d.amount, deadline: d.deadline, plan: d.state, worker: d.assignedTo })),
  });
}

async function geminiRun(focus: string[], ctx: ToolContext): Promise<void> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  const contents: Content[] = [{ role: 'user', parts: [{ text: stateMessage(focus) }] }];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await ai.models.generateContent({
      model,
      contents,
      config: {
        systemInstruction: SYSTEM,
        temperature: 0,
        tools: [{ functionDeclarations: TOOLS }],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        abortSignal: AbortSignal.timeout(TURN_TIMEOUT_MS),
      },
    });
    const calls = res.functionCalls ?? [];
    if (!calls.length) return;

    const responses: Part[] = [];
    for (const call of calls) {
      const result = await executeTool(call.name ?? '', call.args ?? {}, ctx);
      responses.push({
        functionResponse: { id: call.id, name: call.name, response: result.ok ? { output: result.message } : { error: result.message } },
      });
      await sleep(stepDelayMs());
    }
    if (!openFocus(focus).some(needsWork) && !openFocus(focus).some((d) => d.decision === 'fight' && !d.pendingAction)) return;

    // The model's own content goes back unchanged: its parts carry thought signatures.
    contents.push(res.candidates![0].content!, { role: 'user', parts: [...responses, { text: stateMessage(focus) }] });
  }
}

// ---- Rule-based agent: same tools, same guardrails, no LLM. ----

function heuristicDecision(d: Dispute) {
  const usable = d.evidenceAvailable.length > 0 && d.evidenceReadiness >= 0.25;
  if (usable) {
    const p = Math.min(0.9, 0.4 + 0.1 * d.evidenceAvailable.length + 0.3 * d.evidenceReadiness);
    return {
      decision: 'fight' as const,
      winProbability: Math.round(p * 100) / 100,
      rationale: `Evidence on file: ${d.facts[0] ?? d.evidenceAvailable.join(', ')}.`,
      draft: `We are contesting this claim for "${d.item}". ${d.facts.join('. ')}. We ask PayPal to decide in the seller's favour.`,
    };
  }
  return {
    decision: 'refund' as const,
    winProbability: 0.15,
    rationale: `No usable proof: ${d.facts[0] ?? 'no evidence on file'}.`,
    draft: `We are sorry about the problem with your "${d.item}". We are offering a full refund.`,
  };
}

async function heuristicFix(id: string, ctx: ToolContext) {
  const step = async (name: string, args: Record<string, unknown>) => {
    const result = await executeTool(name, { disputeId: id, ...args }, ctx);
    await sleep(stepDelayMs());
    return result;
  };
  const current = () => findDispute(id)!;
  const stillLate = () => current().status === 'open' && current().state === 'late';

  if (!current().decision) {
    const { decision, winProbability, rationale, draft } = heuristicDecision(current());
    await step('setDecision', { decision, winProbability, rationale, draft });
  }
  const d = current();
  if (d.decision === 'refund' || d.decision === 'concede') {
    if (d.pendingAction) return;
    if (d.decision === 'refund' || !heldBecause(d, 'acceptClaim')) {
      await step(d.decision === 'refund' ? 'makeRefundOffer' : 'acceptClaim', {
        note: d.draft ?? `Full refund for "${d.item}".`,
        reason: heldBecause(d, 'makeRefundOffer') ? 'Above the auto limit, so it needs your approval' : 'Small amount with no proof: cheaper to refund than to lose',
      });
    }
    return;
  }

  if (stillLate() && d.evidenceSource) {
    const fastest = [...d.evidenceAvailable].sort((a, b) => EVIDENCE_SOURCES[a].minutes - EVIDENCE_SOURCES[b].minutes)[0] as EvidenceSource | undefined;
    if (fastest && EVIDENCE_SOURCES[fastest].minutes < EVIDENCE_SOURCES[d.evidenceSource].minutes) {
      await step('swapEvidenceSource', { from: d.evidenceSource, to: fastest, reason: `${EVIDENCE_SOURCES[fastest].label} is already available and faster to obtain` });
    }
  }
  const load = workload();
  const other = (current().assignedTo === 'owner' ? 'maya' : 'owner') as string;
  if (stillLate() && assembleParts(current()).length === 1) {
    const split = await step('splitBlock', { parts: 2, reason: 'Two people can assemble the evidence in parallel' });
    if (split.ok) await step('assignDispute', { workerId: other, part: 2, reason: `${other === 'maya' ? 'Maya' : 'You'} can take half so the chain lands before the deadline` });
  }
  if (stillLate()) {
    const lighter = load.maya <= load.owner ? 'maya' : 'owner';
    if (lighter !== current().assignedTo) await step('assignDispute', { workerId: lighter, reason: 'That lane has less work queued' });
  }
  if (stillLate() && !current().flaggedForHuman) {
    await step('flagForHuman', { reason: `Cannot land before the deadline: ${lateBy(current())} minutes short with every option used` });
  }
  if (current().status === 'open' && !current().pendingAction && current().draft) {
    await step('provideEvidence', { note: current().draft, reason: 'Evidence statement is drafted and waits for your review' });
  }
}

async function heuristicRun(focus: string[], ctx: ToolContext) {
  const now = nowMs();
  const ordered = openFocus(focus).sort((a, b) => priority(b, now) - priority(a, now));
  for (const d of ordered) await heuristicFix(d.id, ctx);
}

let runCount = 0;

/**
 * Run the agent over the given disputes (default: every open one). One run at a time;
 * a second call while one is in flight is ignored and returns false.
 */
export async function runAgent(trigger: Trigger, focusIds?: string[]): Promise<boolean> {
  const s = store();
  if (s.running) return false;
  const runId = `run-${++runCount}`;
  const focus = focusIds ?? s.disputes.filter((d) => d.status === 'open').map((d) => d.id);
  setRunning(true);
  try {
    const useGemini = Boolean(process.env.GEMINI_API_KEY);
    logAction({
      runId,
      by: 'system',
      tool: 'runStart',
      args: { trigger },
      ok: true,
      message: `Agent run started (${trigger === 'event' ? `new event: ${focus.join(', ')}` : `planning ${focus.length} disputes`}) with ${useGemini ? 'Gemini' : 'the offline rule-based agent'}`,
    });
    if (useGemini) {
      try {
        await geminiRun(focus, { runId, by: 'gemini' });
      } catch (e) {
        logAction({ runId, by: 'system', tool: 'geminiError', args: {}, ok: false, message: `Gemini failed, the rule-based agent takes over: ${(e as Error).message.slice(0, 160)}` });
      }
    }
    // Anything Gemini left undone (or everything, when offline) is finished by rule.
    const leftover = openFocus(focus).filter((d) => needsWork(d) || (d.decision === 'fight' && !d.pendingAction));
    if (leftover.length) await heuristicRun(leftover.map((d) => d.id), { runId, by: 'heuristic' });

    const c = store().counters;
    logAction({
      runId,
      by: 'system',
      tool: 'runEnd',
      args: {},
      ok: true,
      message: `Run finished: $${c.protectedUsd.toFixed(2)} protected, $${c.atRiskUsd.toFixed(2)} at risk`,
    });
    return true;
  } finally {
    setRunning(false);
  }
}

/** Open the connection to Gemini ahead of a demo run so the first real call is not a cold start. */
export async function warmUp(): Promise<void> {
  if (!process.env.GEMINI_API_KEY) return;
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    await ai.models.get({ model: process.env.GEMINI_MODEL || 'gemini-3.8-flash' });
  } catch {
    // A failed warm-up is not an error: the run itself reports Gemini problems.
  }
}
