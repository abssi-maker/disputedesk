// Shared data shapes. Every record carries a merchantId so multi-merchant mode can be added later.
// All times are merchant wall-clock strings, "YYYY-MM-DDTHH:mm" (no zone); see time.ts.

export type WallTime = string;

export interface Worker {
  id: string;
  merchantId: string;
  name: string;
  role: string;
  kind: 'human' | 'agent';
}

export type EvidenceSource = 'signature' | 'delivery_photo' | 'tracking' | 'chat_log' | 'listing_photos';

/** How long it takes to obtain each kind of proof, in working minutes. */
export const EVIDENCE_SOURCES: Record<EvidenceSource, { label: string; minutes: number }> = {
  signature: { label: 'Carrier signature', minutes: 240 },
  delivery_photo: { label: 'Delivery photo', minutes: 30 },
  tracking: { label: 'Tracking record', minutes: 45 },
  chat_log: { label: 'Buyer chat log', minutes: 30 },
  listing_photos: { label: 'Listing photos', minutes: 60 },
};

export type TaskKind = 'proof' | 'assemble' | 'submit' | 'resolve';

/** One step of a dispute's evidence chain. start/end are written by the planner. */
export interface ChainTask {
  id: string;
  disputeId: string;
  merchantId: string;
  kind: TaskKind;
  name: string;
  durationMin: number;
  workerId: string;
  dependsOn: string[];
  /** Earliest start requested by a human drag or an agent moveBlock. */
  pinnedStart?: WallTime;
  pinnedBy?: 'human' | 'agent';
  start?: WallTime;
  end?: WallTime;
}

export type DisputeSource = 'paypal' | 'seed' | 'simulated';
export type Decision = 'fight' | 'refund' | 'concede';
export type PlanState = 'late' | 'tight' | 'safe' | 'resolved';
export type PayPalWriteKind = 'makeRefundOffer' | 'acceptClaim' | 'provideEvidence';

export interface PendingAction {
  kind: PayPalWriteKind;
  note: string;
  amount?: number;
  /** Why the write is waiting for the human instead of going out. */
  heldBecause: string;
}

export interface Dispute {
  id: string;
  merchantId: string;
  buyer: string;
  item: string;
  amount: number;
  currency: string;
  reason: string;
  /** Extra facts the agent may cite. It must not cite anything that is not here. */
  facts: string[];
  deadline: WallTime;
  deadlineEstimated?: boolean;
  /** 0..1: how complete the evidence on file is. */
  evidenceReadiness: number;
  evidenceSource: EvidenceSource | null;
  evidenceAvailable: EvidenceSource[];
  source: DisputeSource;
  status: 'open' | 'resolved';
  decision?: Decision;
  winProbability?: number;
  rationale?: string;
  draft?: string;
  autoResolved: boolean;
  assignedTo: string;
  flaggedForHuman?: string;
  pendingAction?: PendingAction;
  chain: ChainTask[];
  /** Planner output. */
  slot?: { start: WallTime; end: WallTime };
  state: PlanState;
  slackMin?: number;
  /** The scheduling engine's own description of the deadline conflict, when the chain is late. */
  conflict?: string;
  /** Present only for source 'paypal'. */
  paypal?: { status: string; stage: string; allowedActions: string[]; updatedAt?: string };
}

export interface PayPalWriteRecord {
  /** true only when an HTTP request was actually sent to PayPal. */
  live: boolean;
  method: string;
  path: string;
  body?: unknown;
  ok?: boolean;
  response?: string;
}

export type Actor = 'gemini' | 'heuristic' | 'planner' | 'human' | 'system';

export interface AgentAction {
  id: string;
  at: string;
  runId: string;
  merchantId: string;
  by: Actor;
  tool: string;
  args: Record<string, unknown>;
  disputeId?: string;
  ok: boolean;
  /** What happened. */
  message: string;
  /** Why the actor did it. */
  reason?: string;
  paypal?: PayPalWriteRecord;
}

export interface Policy {
  /** Agent may send PayPal writes on its own at or under this amount. */
  autoResolveLimitUsd: number;
  /** Agent may never concede (accept the claim) above this amount without approval. */
  neverConcedeAboveUsd: number;
}

export interface Counters {
  atRiskUsd: number;
  protectedUsd: number;
  resolvedUsd: number;
  unplaced: string[];
  earliestDeadline?: { disputeId: string; deadline: WallTime };
}

export interface Snapshot {
  version: number;
  now: WallTime;
  demo: boolean;
  agentMode: 'gemini' | 'offline';
  agentModel?: string;
  paypal: 'configured' | 'missing';
  running: boolean;
  workers: Worker[];
  disputes: Dispute[];
  counters: Counters;
  policy: Policy;
  actions: AgentAction[];
}
