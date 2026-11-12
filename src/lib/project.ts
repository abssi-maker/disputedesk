// Turns disputes into a Bryntum Gantt project. This one function feeds both the engine on the
// server and the Gantt in the browser, so they schedule from identical input.
//
// A dispute is a parent task; its evidence chain is the child tasks. Waiting on a carrier is
// dependency lag, not work. Each worker's queue (laneSeq, decided by the planner) becomes
// finish-to-start "lane" dependencies, so nobody is booked twice.
import type { ChainTask, Dispute, WallTime, Worker } from './types';

export const WORK_CALENDAR = {
  id: 'working-hours',
  name: 'Working hours',
  unspecifiedTimeIsWorking: false,
  intervals: [{ recurrentStartDate: 'at 9:00', recurrentEndDate: 'at 17:00', isWorking: true }],
};

export interface ProjectTask {
  id: string;
  name: string;
  expanded?: boolean;
  deadlineDate?: WallTime;
  duration?: number;
  durationUnit?: 'minute';
  startDate?: WallTime;
  endDate?: WallTime;
  manuallyScheduled?: boolean;
  constraintType?: 'startnoearlierthan' | 'finishnolaterthan';
  constraintDate?: WallTime;
  children?: ProjectTask[];
}

export interface ProjectDependency {
  id: string;
  fromTask: string;
  toTask: string;
  lag?: number;
  lagUnit?: 'minute';
  /** 'chain' is the evidence chain; 'lane' is a worker's queue. */
  kind: 'chain' | 'lane';
}

export interface ProjectData {
  startDate: WallTime;
  tasks: ProjectTask[];
  dependencies: ProjectDependency[];
  resources: { id: string; name: string; role: string; kind: Worker['kind'] }[];
  assignments: { id: string; event: string; resource: string }[];
}

export const taskName = (d: Dispute, t: ChainTask) => `${d.id} ${t.name}`;

/**
 * @param enforceDeadlines add the PayPal deadline as a "finish no later than" constraint on the last
 *   step, so the engine reports a scheduling conflict when a chain cannot make it (server only; the
 *   browser shows the deadline as an indicator instead).
 */
export function buildProjectData(disputes: Dispute[], workers: Worker[], planFrom: WallTime, enforceDeadlines: boolean): ProjectData {
  const tasks: ProjectTask[] = [];
  const dependencies: ProjectDependency[] = [];
  const assignments: ProjectData['assignments'] = [];
  const lanes = new Map<string, ChainTask[]>();

  for (const d of disputes) {
    const open = d.status === 'open';
    const isLast = (t: ChainTask) => !d.chain.some((other) => other.dependsOn.includes(t.id));
    tasks.push({
      id: d.id,
      name: d.id,
      expanded: true,
      ...(open ? { deadlineDate: d.deadline } : {}),
      children: d.chain.map((t) => ({
        id: t.id,
        name: taskName(d, t),
        duration: t.durationMin,
        durationUnit: 'minute' as const,
        ...(open
          ? t.pinnedStart
            ? { constraintType: 'startnoearlierthan' as const, constraintDate: t.pinnedStart }
            : enforceDeadlines && isLast(t)
              ? { constraintType: 'finishnolaterthan' as const, constraintDate: d.deadline }
              : {}
          : // Finished work stays where it happened.
            { manuallyScheduled: true, startDate: t.start, endDate: t.end }),
      })),
    });
    for (const t of d.chain) {
      assignments.push({ id: `as:${t.id}`, event: t.id, resource: t.workerId });
      if (!open) continue;
      lanes.set(t.workerId, [...(lanes.get(t.workerId) ?? []), t]);
      for (const from of t.dependsOn) {
        const wait = d.chain.find((x) => x.id === from)?.waitAfterMin ?? 0;
        dependencies.push({ id: `${from}>${t.id}`, fromTask: from, toTask: t.id, kind: 'chain', ...(wait ? { lag: wait, lagUnit: 'minute' as const } : {}) });
      }
    }
  }

  for (const lane of lanes.values()) {
    lane.sort((a, b) => (a.laneSeq ?? 0) - (b.laneSeq ?? 0));
    for (let i = 1; i < lane.length; i++) {
      const [before, after] = [lane[i - 1], lane[i]];
      if (!after.dependsOn.includes(before.id)) {
        dependencies.push({ id: `lane:${before.id}>${after.id}`, fromTask: before.id, toTask: after.id, kind: 'lane' });
      }
    }
  }

  return {
    startDate: planFrom,
    tasks,
    dependencies,
    resources: workers.map((w) => ({ id: w.id, name: w.name, role: w.role, kind: w.kind })),
    assignments,
  };
}
