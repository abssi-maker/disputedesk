// Snapshot -> Bryntum Gantt records for the browser. Dates come from the server's engine run; in the
// browser every step is manually scheduled so the board shows exactly what the server decided.
//
// Shape: a dispute is a parent row ("flight"); its steps are children with rollup bars, so a
// collapsed row still shows the whole chain. Waiting on the carrier becomes its own hatched step
// with no one assigned, so it is visibly not anyone's work.
import { people, type ProjectCalendar } from './project';
import { addWorkingMinutes, ms, wall } from './time';
import type { Dispute, Snapshot } from './types';

export interface BoardTask {
  id: string;
  name: string;
  startDate?: string;
  endDate?: string;
  manuallyScheduled?: boolean;
  rollup?: boolean;
  expanded?: boolean;
  deadlineDate?: string | null;
  cls: string;
  /** 'flight' (dispute), 'step' (work), 'wait' (waiting on someone else) */
  role: 'flight' | 'step' | 'wait';
  disputeId: string;
  kind?: string;
  workerId?: string;
  baselines?: { startDate: string; endDate: string }[];
  children?: BoardTask[];
}

export interface BoardData {
  tasks: BoardTask[];
  dependencies: { id: string; fromTask: string; toTask: string; cls: string }[];
  assignments: { id: string; event: string; resource: string }[];
  resources: { id: string; name: string; role: string; kind: string; calendar: string }[];
  calendars: ProjectCalendar[];
}

const waitId = (taskId: string) => `${taskId}:wait`;

function flight(d: Dispute, baseline: Snapshot['baseline'], expanded: boolean): BoardTask {
  const steps: BoardTask[] = [];
  for (const t of d.chain) {
    if (!t.start || !t.end) continue;
    const before = baseline[t.id];
    const moved = before && (before[0] !== t.start || before[1] !== t.end);
    steps.push({
      id: t.id,
      name: t.name.replace('Proof: ', ''),
      startDate: t.start,
      endDate: t.end,
      manuallyScheduled: true,
      rollup: true,
      cls: `dd-step dd-kind-${t.kind} dd-${d.state}${t.pinnedBy === 'human' ? ' dd-pinned' : ''}`,
      role: 'step',
      disputeId: d.id,
      kind: t.kind,
      workerId: t.workerId,
      ...(moved ? { baselines: [{ startDate: before[0], endDate: before[1] }] } : {}),
    });
    if (t.waitAfterMin && d.status === 'open') {
      steps.push({
        id: waitId(t.id),
        name: 'Waiting on carrier',
        startDate: t.end,
        endDate: wall(addWorkingMinutes(ms(t.end), t.waitAfterMin)),
        manuallyScheduled: true,
        rollup: true,
        cls: 'dd-wait',
        role: 'wait',
        disputeId: d.id,
      });
    }
  }
  return {
    id: d.id,
    name: d.id,
    expanded,
    cls: `dd-flight dd-${d.state}`,
    role: 'flight',
    disputeId: d.id,
    // null (not absent) so an in-place sync clears the flag once a dispute closes
    deadlineDate: d.status === 'open' ? d.deadline : null,
    children: steps,
  };
}

export function buildBoardData(snapshot: Snapshot, expandedIds: Set<string>): BoardData {
  const order = [...snapshot.disputes].sort(
    (a, b) => Number(a.status === 'resolved') - Number(b.status === 'resolved') || a.deadline.localeCompare(b.deadline),
  );
  const tasks = order.map((d) => flight(d, snapshot.baseline, expandedIds.has(d.id)));
  const dependencies: BoardData['dependencies'] = [];
  const assignments: BoardData['assignments'] = [];

  for (const d of order) {
    const byId = new Map(d.chain.map((t) => [t.id, t]));
    for (const t of d.chain) {
      if (!t.start) continue;
      assignments.push({ id: `as:${t.id}`, event: t.id, resource: t.workerId });
      for (const from of t.dependsOn) {
        const source = byId.get(from);
        const cls = `dd-dep dd-${d.state}`;
        if (source?.waitAfterMin && d.status === 'open') {
          if (!dependencies.some((x) => x.id === `${from}>wait`)) {
            dependencies.push({ id: `${from}>wait`, fromTask: from, toTask: waitId(from), cls: `${cls} dd-dep-wait` });
          }
          dependencies.push({ id: `wait:${from}>${t.id}`, fromTask: waitId(from), toTask: t.id, cls });
        } else {
          dependencies.push({ id: `${from}>${t.id}`, fromTask: from, toTask: t.id, cls });
        }
      }
    }
  }

  return { tasks, dependencies, assignments, ...people(snapshot.workers) };
}
