// The deterministic layer under the AI. Dates are computed by the Bryntum Scheduler Pro engine
// (the same ProjectModel the board uses), running headless on the server:
//   - a 09:00-17:00 working calendar,
//   - finish-to-start dependencies along each dispute's evidence chain,
//   - the PayPal response deadline as a "finish no later than" constraint.
// A chain that cannot meet its deadline comes back as an engine scheduling conflict; that message
// is what the agent is shown when one of its moves is rejected.
//
// The engine does not level resources, so one rule lives here: on each lane, work is queued in
// priority order (amount x win probability x deadline pressure), expressed to the engine as
// lane dependencies. The engine does the rest.
import { toDate, toWall } from './format';
import { ms, wall, workingMinutesBetween } from './time';
import type { ChainTask, Counters, Dispute } from './types';

/** Below this much working slack before the deadline a plan counts as tight. */
export const TIGHT_SLACK_MIN = 45;

type Bryntum = typeof import('@bryntum/schedulerpro');
let engine: Promise<Bryntum> | undefined;

/**
 * Load the Scheduler Pro module. Its browser bundle touches DOM globals while loading, so a DOM
 * shim is registered for that moment only and removed again; the engine itself needs none.
 */
export function loadEngine(): Promise<Bryntum> {
  return (engine ??= (async () => {
    if (typeof window !== 'undefined') return import('@bryntum/schedulerpro');
    const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
    GlobalRegistrator.register({ url: 'http://localhost/' });
    try {
      return await import('@bryntum/schedulerpro');
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

const CALENDAR = {
  id: 'working-hours',
  name: 'Working hours',
  unspecifiedTimeIsWorking: false,
  intervals: [{ recurrentStartDate: 'at 9:00', recurrentEndDate: 'at 17:00', isWorking: true }],
};

interface Queued {
  task: ChainTask;
  dispute: Dispute;
  /** Position in the lane queue; lower runs first. */
  key: number;
}

interface EngineRun {
  /** task id -> [start, end] as wall-clock strings */
  dates: Map<string, [string, string]>;
  /** dispute id -> the engine's own description of the deadline conflict */
  conflicts: Map<string, string>;
}

const engineName = (d: Dispute, t: ChainTask) => `${d.id} ${t.name}`;

/** One engine calculation: build a project from the queue, let Scheduler Pro schedule it, read it back. */
async function runEngine(queue: Queued[], nowWall: string): Promise<EngineRun> {
  // EffectResolutionResult is exported by the module but missing from its type definitions.
  const { ProjectModel, EffectResolutionResult } = (await loadEngine()) as Bryntum & { EffectResolutionResult: { Resume: unknown } };
  const now = toDate(nowWall);
  const lastOfChain = (q: Queued) => !q.dispute.chain.some((other) => other.dependsOn.includes(q.task.id));
  const byName = new Map(queue.map((q) => [engineName(q.dispute, q.task), q.dispute.id]));

  const lanes = new Map<string, Queued[]>();
  for (const q of [...queue].sort((a, b) => a.key - b.key)) {
    lanes.set(q.task.workerId, [...(lanes.get(q.task.workerId) ?? []), q]);
  }

  const project = new ProjectModel({
    calendar: CALENDAR.id,
    calendars: [CALENDAR],
    resources: [...lanes.keys()].map((id) => ({ id })),
    events: queue.map((q) => ({
      id: q.task.id,
      name: engineName(q.dispute, q.task),
      startDate: now,
      duration: q.task.durationMin,
      durationUnit: 'minute',
      // A pinned block may not start before its pin; the last step may not finish after the deadline.
      ...(q.task.pinnedStart
        ? { constraintType: 'startnoearlierthan' as const, constraintDate: toDate(q.task.pinnedStart) }
        : lastOfChain(q)
          ? { constraintType: 'finishnolaterthan' as const, constraintDate: toDate(q.dispute.deadline) }
          : {}),
    })),
    assignments: queue.map((q) => ({ id: `as:${q.task.id}`, event: q.task.id, resource: q.task.workerId })),
    dependencies: [
      ...queue.flatMap((q) => q.task.dependsOn.map((from) => ({ id: `${from}>${q.task.id}`, from, to: q.task.id }))),
      ...[...lanes.values()].flatMap((lane) =>
        lane.slice(1).flatMap((q, i) =>
          q.task.dependsOn.includes(lane[i].task.id) ? [] : [{ id: `lane:${lane[i].task.id}>${q.task.id}`, from: lane[i].task.id, to: q.task.id }],
        ),
      ),
    ],
  });

  const conflicts = new Map<string, string>();
  project.on('schedulingConflict', ({ schedulingIssue, continueWithResolutionResult }: { schedulingIssue: { getDescription(): string; getResolutions(): { getDescription(): string; resolve(): void }[] }; continueWithResolutionResult(result: unknown): void }) => {
    const description = schedulingIssue.getDescription();
    const taskName = /Task "([^"]+)" Finish-No-Later-Than/.exec(description)?.[1];
    const disputeId = taskName && byName.get(taskName);
    if (disputeId) conflicts.set(disputeId, description.replace('A scheduling conflict has been found: ', ''));
    // Keep scheduling without the deadline so the board can show how late the chain lands.
    const dropConstraint = schedulingIssue.getResolutions().find((r) => /constraint/i.test(r.getDescription()));
    (dropConstraint ?? schedulingIssue.getResolutions()[0]).resolve();
    continueWithResolutionResult(EffectResolutionResult.Resume);
  });

  try {
    await project.commitAsync();
    const dates = new Map<string, [string, string]>();
    for (const q of queue) {
      const record = project.eventStore.getById(q.task.id) as unknown as { startDate: Date; endDate: Date };
      dates.set(q.task.id, [toWall(record.startDate), toWall(record.endDate)]);
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
 * Schedule every open dispute's chain with the Scheduler Pro engine. A chain that cannot end
 * before its deadline is still placed (so the board can show how late it is), reported as
 * unplaced, and carries the engine's conflict message.
 */
export async function planDisputes(input: Dispute[], nowWall: string): Promise<PlanResult> {
  const now = ms(nowWall);
  const disputes = structuredClone(input);
  for (const d of disputes) if (d.status === 'resolved') d.state = 'resolved';

  const open = disputes
    .filter((d) => d.status === 'open')
    .sort((a, b) => priority(b, now) - priority(a, now) || a.id.localeCompare(b.id));
  const queue: Queued[] = open.flatMap((dispute, i) => dispute.chain.map((task, j) => ({ task, dispute, key: i * 1000 + j })));
  if (!queue.length) return { disputes, counters: computeCounters(disputes) };

  let run = await runEngine(queue, nowWall);

  // Pinned blocks (human drags, agent moves) take their place in the lane queue by time, not priority.
  if (queue.some((q) => q.task.pinnedStart)) {
    const keys = new Map<string, number>();
    for (const q of queue) {
      const own = q.task.pinnedStart ? Math.max(now, ms(q.task.pinnedStart)) - 0.5 : ms(run.dates.get(q.task.id)![0]);
      keys.set(q.task.id, Math.max(own, ...q.task.dependsOn.map((id) => keys.get(id)! + 1)));
    }
    const ordered = [...queue].sort((a, b) => keys.get(a.task.id)! - keys.get(b.task.id)! || a.key - b.key);
    ordered.forEach((q, i) => (q.key = i));
    run = await runEngine(queue, nowWall);
  }

  for (const d of open) {
    for (const t of d.chain) [t.start, t.end] = run.dates.get(t.id)!;
    const start = Math.min(...d.chain.map((t) => ms(t.start!)));
    const end = Math.max(...d.chain.map((t) => ms(t.end!)));
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
