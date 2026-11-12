// The deterministic layer under the AI. Dates are computed by the Bryntum Gantt engine (the same
// ProjectModel the board uses), running headless on the server:
//   - a 09:00-17:00 working calendar,
//   - finish-to-start dependencies along each dispute's evidence chain, with waiting time as lag,
//   - the PayPal response deadline as a "finish no later than" constraint.
// A chain that cannot meet its deadline comes back as an engine scheduling conflict; that message
// is what the agent is shown when one of its moves is rejected.
//
// The engine does not level resources, so one rule lives here: who goes first on each worker's
// lane. Disputes are taken in priority order (amount x win probability x deadline pressure) and
// each step takes the earliest free gap on its lane, which lets other work fill a wait on the
// carrier. That queue is handed to the engine as lane dependencies; the engine sets every date.
import { toDate, toWall } from './format';
import { WORK_CALENDAR, buildProjectData, taskName } from './project';
import { ms, wall, workingMinutesBetween } from './time';
import type { ChainTask, Counters, Dispute, Worker } from './types';

/** Below this much working slack before the deadline a plan counts as tight. */
export const TIGHT_SLACK_MIN = 45;

type Bryntum = typeof import('@bryntum/gantt');
let engine: Promise<Bryntum> | undefined;

/**
 * Load the Bryntum Gantt module. Its browser bundle touches DOM globals while loading, so a DOM
 * shim is registered for that moment only and removed again; the engine itself needs none.
 */
export function loadEngine(): Promise<Bryntum> {
  return (engine ??= (async () => {
    if (typeof window !== 'undefined') return import('@bryntum/gantt');
    const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
    GlobalRegistrator.register({ url: 'http://localhost/' });
    try {
      return await import('@bryntum/gantt');
    } finally {
      await GlobalRegistrator.unregister();
    }
  })());
}

/** Priority = amount x win probability x deadline pressure. */
export function priority(d: Dispute, now: number): number {
  const hoursLeft = workingMinutesBetween(now, ms(d.deadline)) / 60;
  const pressure = 1 / Math.max(1, hoursLeft);
  return d.amount * (d.winProbability ?? 0.5) * pressure;
}

/**
 * Decide each worker's queue. Works on a "working minutes from now" axis: every step is placed in
 * the earliest free gap on its lane after its predecessors (plus any wait) are done. Only the
 * resulting order is kept (laneSeq); the engine computes the real dates.
 */
function queueLanes(open: Dispute[], now: number) {
  const lanes = new Map<string, [number, number][]>();
  const startOf = new Map<string, number>();
  const doneAt = new Map<string, number>();
  const place = (t: ChainTask, ready: number) => {
    let at = ready;
    const lane = lanes.get(t.workerId) ?? [];
    for (let clash; (clash = lane.find(([s, e]) => s < at + t.durationMin && e > at)); ) at = clash[1];
    lane.push([at, at + t.durationMin]);
    lanes.set(t.workerId, lane);
    startOf.set(t.id, at);
  };
  const pinOf = (t: ChainTask) => (t.pinnedStart ? Math.max(0, workingMinutesBetween(now, ms(t.pinnedStart))) : 0);

  // A block a human pinned claims its slot before the agent's priorities are applied.
  for (const d of open) for (const t of d.chain) if (t.pinnedBy === 'human') place(t, pinOf(t));

  // Starting a wait early costs minutes and saves hours: requests that others must answer go first.
  for (const d of open) for (const t of d.chain) if (!startOf.has(t.id) && !t.dependsOn.length && t.waitAfterMin) place(t, pinOf(t));

  for (const d of open) {
    for (const t of d.chain) {
      if (!startOf.has(t.id)) place(t, Math.max(pinOf(t), ...t.dependsOn.map((id) => doneAt.get(id)!)));
      doneAt.set(t.id, startOf.get(t.id)! + t.durationMin + (t.waitAfterMin ?? 0));
    }
  }

  // Queue order = simulated start, never ahead of a step it depends on.
  const key = new Map<string, number>();
  const all = open.flatMap((d) => d.chain);
  for (const t of all) key.set(t.id, Math.max(startOf.get(t.id)!, ...t.dependsOn.map((id) => key.get(id)! + 0.001)));
  const rank = new Map(all.map((t, i) => [t.id, i]));
  [...all].sort((a, b) => key.get(a.id)! - key.get(b.id)! || rank.get(a.id)! - rank.get(b.id)!).forEach((t, i) => (t.laneSeq = i));
}

interface EngineRun {
  /** task id -> [start, end] as wall-clock strings */
  dates: Map<string, [string, string]>;
  /** dispute id -> the engine's own description of the deadline conflict */
  conflicts: Map<string, string>;
}

type SchedulingIssue = { getDescription(): string; getResolutions(): { getDescription(): string; resolve(): void }[] };
type Dated = { startDate?: string; endDate?: string; constraintDate?: string; deadlineDate?: string | null };

/** Wall-clock strings to Date objects for the engine. */
const withDates = <T extends Dated>(t: T) => ({
  ...t,
  ...(t.startDate ? { startDate: toDate(t.startDate) } : {}),
  ...(t.endDate ? { endDate: toDate(t.endDate) } : {}),
  ...(t.constraintDate ? { constraintDate: toDate(t.constraintDate) } : {}),
  ...(t.deadlineDate ? { deadlineDate: toDate(t.deadlineDate) } : {}),
});

/** One engine calculation: build the project, let Bryntum schedule it, read the dates back. */
async function runEngine(disputes: Dispute[], workers: Worker[], planFrom: string): Promise<EngineRun> {
  // EffectResolutionResult is exported by the module but missing from its type definitions.
  const { ProjectModel, EffectResolutionResult } = (await loadEngine()) as Bryntum & { EffectResolutionResult: { Resume: unknown } };
  const data = buildProjectData(disputes, workers, planFrom, true);
  const byName = new Map(disputes.flatMap((d) => d.chain.map((t) => [taskName(d, t), d.id] as const)));

  const project = new ProjectModel({
    startDate: toDate(data.startDate),
    calendar: WORK_CALENDAR.id,
    calendars: data.calendars.map((c) => ({ ...c, intervals: c.intervals.map(withDates) })),
    resources: data.resources,
    tasks: data.tasks.map((parent) => ({ ...withDates(parent), children: parent.children!.map(withDates) })),
    assignments: data.assignments,
    dependencies: data.dependencies,
  });

  const conflicts = new Map<string, string>();
  project.on('schedulingConflict', ({ schedulingIssue, continueWithResolutionResult }: { schedulingIssue: SchedulingIssue; continueWithResolutionResult(result: unknown): void }) => {
    const description = schedulingIssue.getDescription();
    const name = /Task "([^"]+)" Finish-No-Later-Than/.exec(description)?.[1];
    const disputeId = name && byName.get(name);
    if (disputeId) conflicts.set(disputeId, description.replace('A scheduling conflict has been found: ', ''));
    // Keep scheduling without the deadline so the board can show how late the chain lands.
    const dropConstraint = schedulingIssue.getResolutions().find((r) => /constraint/i.test(r.getDescription()));
    (dropConstraint ?? schedulingIssue.getResolutions()[0]).resolve();
    continueWithResolutionResult(EffectResolutionResult.Resume);
  });

  try {
    await project.commitAsync();
    const dates = new Map<string, [string, string]>();
    for (const d of disputes) {
      for (const t of d.chain) {
        const record = project.taskStore.getById(t.id) as unknown as { startDate: Date; endDate: Date };
        dates.set(t.id, [toWall(record.startDate), toWall(record.endDate)]);
      }
    }
    return { dates, conflicts };
  } finally {
    project.destroy();
  }
}

export interface PlanResult {
  disputes: Dispute[];
  counters: Counters;
}

/**
 * Schedule every open dispute's chain with the Bryntum engine. A chain that cannot end before its
 * deadline is still placed (so the board can show how late it is), reported as unplaced, and
 * carries the engine's conflict message.
 */
export async function planDisputes(input: Dispute[], workers: Worker[], planFrom: string): Promise<PlanResult> {
  const now = ms(planFrom);
  const disputes = structuredClone(input);
  for (const d of disputes) if (d.status === 'resolved') d.state = 'resolved';

  const open = disputes
    .filter((d) => d.status === 'open')
    .sort((a, b) => priority(b, now) - priority(a, now) || a.id.localeCompare(b.id));
  if (!open.length) return { disputes, counters: computeCounters(disputes) };

  queueLanes(open, now);
  const run = await runEngine(disputes, workers, planFrom);

  for (const d of open) {
    for (const t of d.chain) [t.start, t.end] = run.dates.get(t.id)!;
    const start = Math.min(...d.chain.map((t: ChainTask) => ms(t.start!)));
    const end = Math.max(...d.chain.map((t: ChainTask) => ms(t.end!)));
    const deadline = ms(d.deadline);
    d.slot = { start: wall(start), end: wall(end) };
    if (end > deadline) {
      d.state = 'late';
      d.slackMin = -workingMinutesBetween(deadline, end);
      d.conflict = run.conflicts.get(d.id) ?? `${d.id} finishes after its response deadline`;
    } else {
      d.slackMin = workingMinutesBetween(end, deadline);
      d.state = d.slackMin < TIGHT_SLACK_MIN ? 'tight' : 'safe';
      d.conflict = undefined;
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
