// Deterministic slot planner. No LLM here: the agent proposes changes, this decides where blocks land.
import type { ChainTask, Counters, Dispute } from './types';
import { MIN, ms, nextWorkingMoment, wall, workEnd, workStart, workingMinutesBetween, DAY } from './time';

/** Below this much working slack before the deadline a plan counts as tight. */
export const TIGHT_SLACK_MIN = 45;
const MAX_BLOCK_MIN = 8 * 60;

type Interval = [number, number];

/** Priority = amount x win probability x deadline pressure. */
export function priority(d: Dispute, now: number): number {
  const hoursLeft = workingMinutesBetween(now, ms(d.deadline)) / 60;
  const pressure = 1 / Math.max(1, hoursLeft);
  return d.amount * (d.winProbability ?? 0.5) * pressure;
}

/** Earliest start >= earliest where a block of the given length fits in one working day without overlap. */
export function findSlot(busy: Interval[], earliest: number, durationMin: number): number {
  const length = Math.min(durationMin, MAX_BLOCK_MIN) * MIN;
  let t = nextWorkingMoment(earliest);
  for (;;) {
    if (t + length > workEnd(t)) {
      t = workStart(t + DAY);
      continue;
    }
    const clash = busy.find(([s, e]) => s < t + length && e > t);
    if (!clash) return t;
    t = nextWorkingMoment(clash[1]);
  }
}

function reserve(busy: Map<string, Interval[]>, task: ChainTask, start: number) {
  const end = start + Math.min(task.durationMin, MAX_BLOCK_MIN) * MIN;
  task.start = wall(start);
  task.end = wall(end);
  const lane = busy.get(task.workerId) ?? [];
  lane.push([start, end]);
  busy.set(task.workerId, lane);
}

export interface PlanResult {
  disputes: Dispute[];
  counters: Counters;
}

/**
 * Place every open dispute's chain. Disputes are handled in priority order; each task takes the
 * earliest free slot on its worker's lane after its predecessors end. A chain that cannot end
 * before its deadline is still placed (so the board can show how late it is) and reported as unplaced.
 */
export function planDisputes(input: Dispute[], nowWall: string): PlanResult {
  const now = ms(nowWall);
  const disputes = structuredClone(input);
  const busy = new Map<string, Interval[]>();

  // Finished work stays where it happened.
  for (const d of disputes) {
    if (d.status !== 'resolved') continue;
    d.state = 'resolved';
    for (const t of d.chain) {
      if (t.start && t.end) {
        const lane = busy.get(t.workerId) ?? [];
        lane.push([ms(t.start), ms(t.end)]);
        busy.set(t.workerId, lane);
      }
    }
  }

  const open = disputes
    .filter((d) => d.status === 'open')
    .sort((a, b) => priority(b, now) - priority(a, now) || a.id.localeCompare(b.id));

  // Pinned blocks (human drags, agent moves) claim their slots before anything else.
  const placed = new Set<string>();
  for (const d of open) {
    for (const t of d.chain) {
      if (!t.pinnedStart) continue;
      reserve(busy, t, findSlot(busy.get(t.workerId) ?? [], Math.max(now, ms(t.pinnedStart)), t.durationMin));
      placed.add(t.id);
    }
  }

  for (const d of open) {
    d.conflict = undefined;
    const byId = new Map(d.chain.map((t) => [t.id, t]));
    for (const t of d.chain) {
      const ready = Math.max(now, ...t.dependsOn.map((id) => ms(byId.get(id)!.end!)));
      if (placed.has(t.id)) {
        if (ms(t.start!) < ready) d.conflict = `"${t.name}" starts before the step it depends on is finished`;
        continue;
      }
      reserve(busy, t, findSlot(busy.get(t.workerId) ?? [], ready, t.durationMin));
    }
    const start = Math.min(...d.chain.map((t) => ms(t.start!)));
    const end = Math.max(...d.chain.map((t) => ms(t.end!)));
    const deadline = ms(d.deadline);
    d.slot = { start: wall(start), end: wall(end) };
    if (end > deadline || d.conflict) {
      d.state = 'late';
      d.slackMin = end > deadline ? -workingMinutesBetween(deadline, end) : workingMinutesBetween(end, deadline);
    } else {
      d.slackMin = workingMinutesBetween(end, deadline);
      d.state = d.slackMin < TIGHT_SLACK_MIN ? 'tight' : 'safe';
    }
  }

  return { disputes, counters: computeCounters(disputes) };
}

/** Dollar counters. A refund or concession gives the money back, so it is never counted as protected. */
export function computeCounters(disputes: Dispute[]): Counters {
  const counters: Counters = { atRiskUsd: 0, protectedUsd: 0, resolvedUsd: 0, unplaced: [] };
  for (const d of disputes) {
    if (d.status === 'resolved') {
      counters.resolvedUsd += d.amount;
      continue;
    }
    if (d.state === 'late') {
      counters.atRiskUsd += d.amount;
      counters.unplaced.push(d.id);
    } else if (d.decision !== 'refund' && d.decision !== 'concede') {
      counters.protectedUsd += d.amount;
    }
    if (!counters.earliestDeadline || ms(d.deadline) < ms(counters.earliestDeadline.deadline)) {
      counters.earliestDeadline = { disputeId: d.id, deadline: d.deadline };
    }
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  counters.atRiskUsd = round(counters.atRiskUsd);
  counters.protectedUsd = round(counters.protectedUsd);
  counters.resolvedUsd = round(counters.resolvedUsd);
  return counters;
}

export const lateBy = (d: Dispute): number => (d.state === 'late' && (d.slackMin ?? 0) < 0 ? -d.slackMin! : 0);
