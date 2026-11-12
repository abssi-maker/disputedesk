// In-memory state, kept on globalThis so every route handler shares it. Nothing is persisted:
// on boot the store is rebuilt from seeds plus a re-fetch of the PayPal sandbox disputes.
import { fetchAllDisputes, mapPayPalDispute } from './paypal-disputes';
import { paypalConfigured } from './paypal-rest';
import { planDisputes } from './planner';
import { MERCHANT_ID, WORKERS, seedDisputes } from './seeds';
import { MIN, instantToWallMs, wall, workStart } from './time';
import type { AgentAction, Counters, Dispute, Policy, Snapshot, Worker } from './types';

const PLAN_GRID_MIN = 15;
const MAX_ACTIONS = 200;

interface Store {
  merchantId: string;
  workers: Worker[];
  disputes: Dispute[];
  counters: Counters;
  actions: AgentAction[];
  policy: Policy;
  demo: boolean;
  /** Demo mode freezes the clock at 09:00 so the scripted path lays out identically every run. */
  frozenNow?: number;
  version: number;
  running: boolean;
  simulatedCount: number;
  actionCount: number;
  listeners: Set<(snapshot: Snapshot) => void>;
  boot?: Promise<void>;
}

const g = globalThis as unknown as { __disputeDeskStore?: Store };

const timeZone = () => process.env.MERCHANT_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

function defaultPolicy(): Policy {
  const limit = Number(process.env.AUTO_RESOLVE_LIMIT_USD);
  const autoResolveLimitUsd = Number.isFinite(limit) && limit >= 0 ? limit : 50;
  return { autoResolveLimitUsd, neverConcedeAboveUsd: autoResolveLimitUsd };
}

function create(demo: boolean): Store {
  const realNow = Math.floor(instantToWallMs(new Date(), timeZone()) / MIN) * MIN;
  const s: Store = {
    merchantId: MERCHANT_ID,
    workers: WORKERS,
    disputes: [],
    counters: { atRiskUsd: 0, protectedUsd: 0, resolvedUsd: 0, unplaced: [] },
    actions: [],
    policy: defaultPolicy(),
    demo,
    frozenNow: demo ? workStart(realNow) : undefined,
    version: 0,
    running: false,
    simulatedCount: 0,
    actionCount: 0,
    listeners: g.__disputeDeskStore?.listeners ?? new Set(),
  };
  s.disputes = seedDisputes(planFrom(s));
  replanStore(s);
  return s;
}

const nowOf = (s: Store) => s.frozenNow ?? Math.floor(instantToWallMs(new Date(), timeZone()) / MIN) * MIN;
/** Blocks are planned from the next quarter hour so bars sit on a readable grid. */
const planFrom = (s: Store) => Math.ceil(nowOf(s) / (PLAN_GRID_MIN * MIN)) * PLAN_GRID_MIN * MIN;

function replanStore(s: Store) {
  const result = planDisputes(s.disputes, wall(planFrom(s)));
  s.disputes = result.disputes;
  s.counters = result.counters;
}

export const store = (): Store => (g.__disputeDeskStore ??= create(false));
export const nowMs = () => nowOf(store());
export const planNow = () => wall(planFrom(store()));
export const replan = () => replanStore(store());
export const findDispute = (id: string) => store().disputes.find((d) => d.id === id);

export function snapshot(): Snapshot {
  const s = store();
  return {
    version: s.version,
    now: wall(nowOf(s)),
    demo: s.demo,
    agentMode: process.env.GEMINI_API_KEY ? 'gemini' : 'offline',
    agentModel: process.env.GEMINI_API_KEY ? process.env.GEMINI_MODEL || 'gemini-3.8-flash' : undefined,
    paypal: paypalConfigured() ? 'configured' : 'missing',
    running: s.running,
    workers: s.workers,
    disputes: s.disputes,
    counters: s.counters,
    policy: s.policy,
    actions: s.actions,
  };
}

/** Tell every open SSE stream that state changed. */
export function publish() {
  const s = store();
  s.version += 1;
  const snap = snapshot();
  for (const listener of s.listeners) listener(snap);
}

export function subscribe(listener: (snapshot: Snapshot) => void): () => void {
  const s = store();
  s.listeners.add(listener);
  return () => s.listeners.delete(listener);
}

export function logAction(action: Omit<AgentAction, 'id' | 'at' | 'merchantId'>): AgentAction {
  const s = store();
  const full: AgentAction = {
    ...action,
    id: `a${++s.actionCount}`,
    at: new Date().toISOString(),
    merchantId: s.merchantId,
  };
  s.actions.push(full);
  if (s.actions.length > MAX_ACTIONS) s.actions.splice(0, s.actions.length - MAX_ACTIONS);
  publish();
  return full;
}

export function setRunning(running: boolean) {
  store().running = running;
  publish();
}

export function setPolicy(policy: Partial<Policy>) {
  const s = store();
  s.policy = { ...s.policy, ...policy };
  publish();
}

export function nextSimulatedSequence(): number {
  return ++store().simulatedCount;
}

/** Insert or refresh a dispute fetched from PayPal, keeping local decisions and the planned chain. */
export function upsertPayPalDispute(raw: unknown): { dispute: Dispute; isNew: boolean } {
  const s = store();
  const mapped = mapPayPalDispute(raw, s.merchantId, timeZone());
  const existing = s.disputes.find((d) => d.id === mapped.id);
  if (!existing) {
    s.disputes.push(mapped);
    return { dispute: mapped, isNew: true };
  }
  Object.assign(existing, {
    amount: mapped.amount,
    deadline: mapped.deadline,
    deadlineEstimated: mapped.deadlineEstimated,
    facts: mapped.facts,
    paypal: mapped.paypal,
    status: mapped.status,
  });
  return { dispute: existing, isNew: false };
}

/** Load sandbox disputes once per process. Safe to call from every request. */
export function ensureBooted(): Promise<void> {
  const s = store();
  return (s.boot ??= (async () => {
    if (!paypalConfigured()) return;
    try {
      const raws = await fetchAllDisputes();
      for (const raw of raws) upsertPayPalDispute(raw);
      replanStore(s);
      logAction({
        runId: 'boot',
        by: 'system',
        tool: 'loadPayPalDisputes',
        args: {},
        ok: true,
        message: `Loaded ${raws.length} dispute(s) from the PayPal sandbox`,
      });
    } catch (e) {
      logAction({
        runId: 'boot',
        by: 'system',
        tool: 'loadPayPalDisputes',
        args: {},
        ok: false,
        message: `Could not load PayPal disputes: ${(e as Error).message.slice(0, 200)}`,
      });
    }
  })());
}

/** Rebuild from seeds (and PayPal). Demo mode freezes the clock at 09:00. */
export async function resetStore(demo: boolean): Promise<void> {
  g.__disputeDeskStore = create(demo);
  await ensureBooted();
  publish();
}
