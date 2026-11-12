'use client';

// The board. Two Bryntum views on ONE shared project:
//   - a Gantt with one row per dispute ("flight"): its chain is drawn as labelled ribbons in the row,
//     each row has its own PayPal deadline and a no-fly zone after it;
//   - a Scheduler Pro with one row per person, showing the same steps as labelled blocks.
// Dragging a step in either view is a human override; the server's engine re-plans the rest.
// Client-only: loaded through next/dynamic with ssr: false.
import '@bryntum/gantt/gantt.css';
import '@bryntum/gantt/svalbard-light.css';
import '@bryntum/gantt/fontawesome/css/fontawesome.css';
import '@bryntum/gantt/fontawesome/css/solid.css';
import { StringHelper, type DomConfig, type GridColumnConfig, type Model, type ProjectModel, type SchedulerEventModel, type TaskModel } from '@bryntum/gantt';
import { BryntumGantt, BryntumGanttProjectModel, BryntumSchedulerPro } from '@bryntum/gantt-react';
import { useEffect, useMemo, useRef } from 'react';
import { buildBoardData, type BoardTask } from '@/lib/board-data';
import { STATE_LABEL, dayAndClock, duration, planLine, toDate, toWall, usd } from '@/lib/format';
import { WORK_CALENDAR, type ProjectCalendar } from '@/lib/project';
import type { Dispute, Snapshot } from '@/lib/types';

export interface Override {
  taskId: string;
  start: string;
  durationMin: number;
  workerId?: string;
}

interface Props {
  snapshot: Snapshot;
  selectedId: string | null;
  /** The dispute the agent is working on right now, if any. */
  focusId: string | null;
  onSelect: (disputeId: string) => void;
  onOverride: (change: Override) => void;
}

const DAYS_SHOWN = 3;
const HOUR_WIDTH = 104;
const ROW_HEIGHT = 54;
const BAR_MARGIN = 9;
/** Vertical padding that stretches a highlight from a bar to its whole row. */
const ZONE_PAD = BAR_MARGIN - 1;
const e = StringHelper.encodeHtml;
/** DomConfig children without the gaps left by optional parts. */
const kids = (...items: (DomConfig | null | false)[]): DomConfig[] => items.filter((x): x is DomConfig => Boolean(x));

const VIEW_PRESET = {
  base: 'hourAndDay',
  tickWidth: HOUR_WIDTH,
  headers: [
    { unit: 'day' as const, dateFormat: 'ddd D MMM' },
    { unit: 'hour' as const, dateFormat: 'HH' },
  ],
};

// Bryntum's React wrappers re-apply any prop whose identity changes, so every static config lives
// here, created once.
const PROJECT_STATIC = {
  calendar: WORK_CALENDAR.id,
  hoursPerDay: 8,
  daysPerWeek: 7,
  taskStore: { syncDataOnLoad: true },
  dependencyStore: { syncDataOnLoad: true },
  assignmentStore: { syncDataOnLoad: true },
  resourceStore: { syncDataOnLoad: true },
  calendarManagerStore: { syncDataOnLoad: true },
};

const OFF = {
  cellEditFeature: false,
  cellMenuFeature: false,
  headerMenuFeature: false,
  scheduleMenuFeature: false,
  dependencyEditFeature: false,
  timeAxisHeaderMenuFeature: false,
  sortFeature: false,
  percentBarFeature: false,
} as const;

const GANTT_STATIC = {
  ...OFF,
  workingTime: { fromHour: 9, toHour: 17 },
  viewPreset: VIEW_PRESET,
  subGridConfigs: { locked: { width: 548 } },
  transition: { changeEvent: 500 },
  taskMenuFeature: false,
  taskEditFeature: false,
  taskDragCreateFeature: false,
  projectLinesFeature: false,
  rollupsFeature: false,
  indicatorsFeature: false,
  baselinesFeature: true,
  timeSpanHighlightFeature: true,
  dependenciesFeature: { allowCreate: false, radius: 6, showTooltip: false },
  timeRangesFeature: { showCurrentTimeLine: false, showHeaderElements: true },
} as const;

const PEOPLE_STATIC = {
  ...OFF,
  workingTime: { fromHour: 9, toHour: 17 },
  viewPreset: VIEW_PRESET,
  rowHeight: 52,
  barMargin: 9,
  eventLayout: 'none' as const,
  transition: { changeEvent: 500 },
  eventMenuFeature: false,
  eventEditFeature: false,
  taskEditFeature: false,
  eventDragCreateFeature: false,
  dependenciesFeature: false,
  eventTooltipFeature: false,
  resourceTimeRangesFeature: true,
  timeRangesFeature: false,
} as const;

/** Illustrated avatars (generated for this app, fictional people). */
const AVATAR: Record<string, string> = { owner: '/avatars/owner.png', maya: '/avatars/maya.png', auto: '/avatars/agent.png' };

const PEOPLE_COLUMNS = [
  {
    text: 'People / capacity',
    field: 'name',
    width: 548,
    renderer: ({ record }: { record: Model }): DomConfig => ({
      className: 'dd-person',
      children: [
        { tag: 'img', className: 'dd-avatar', src: AVATAR[String(record.id)], alt: '' },
        {
          className: 'dd-person-text',
          children: [
            { tag: 'strong', text: record.get('name') },
            { tag: 'span', text: record.get('role') },
          ],
        },
      ],
    }),
  },
];

const clock = (d: Date) => {
  const w = toWall(d).slice(11);
  return w.endsWith(':00') ? w.slice(0, 2) : w;
};
const span = (start: Date, end: Date) => `${clock(start)}–${clock(end)}`;
const hhmm = (d: Date) => toWall(d).slice(11);
const minutes = (start: Date, end: Date) => (end.getTime() - start.getTime()) / 60_000;

/** Wall-clock strings to Date objects, recursively, for Bryntum. */
function dated(task: BoardTask): Record<string, unknown> {
  return {
    ...task,
    ...(task.startDate ? { startDate: toDate(task.startDate) } : {}),
    ...(task.endDate ? { endDate: toDate(task.endDate) } : {}),
    ...(task.deadlineDate !== undefined ? { deadlineDate: task.deadlineDate && toDate(task.deadlineDate) } : {}),
    ...(task.baselines ? { baselines: task.baselines.map((b) => ({ startDate: toDate(b.startDate), endDate: toDate(b.endDate) })) } : {}),
    ...(task.children ? { children: task.children.map(dated) } : {}),
  };
}

/** Calendar intervals carry wall-clock strings; Bryntum wants Dates. */
const datedCalendars = (calendars: ProjectCalendar[]) =>
  calendars.map((c) => ({
    ...c,
    intervals: c.intervals.map((i) => ({ ...i, ...(i.startDate ? { startDate: toDate(i.startDate) } : {}), ...(i.endDate ? { endDate: toDate(i.endDate) } : {}) })),
  }));

const SOURCE_TAG: Record<Dispute['source'], string> = { paypal: 'PAYPAL', seed: 'SEED', simulated: 'SIM' };
const WORKER_TAG: Record<string, string> = { owner: 'YOU', maya: 'MAYA', auto: 'AGENT' };
const SHORT: Record<string, string> = { proof: 'Proof', assemble: 'Evidence', submit: 'Submit', resolve: 'Resolve' };

function columns(disputes: React.RefObject<Map<string, Dispute>>): GridColumnConfig[] {
  const of = (record: Model) => disputes.current.get(record.get('disputeId'));
  const dash = (record: Model) => (record.get('role') === 'flight' ? null : { className: 'dd-dash', text: '–' });
  return [
    {
      type: 'name' as const,
      text: 'Dispute',
      field: 'name',
      width: 268,
      sortable: false,
      renderer: ({ record }: { record: Model }): DomConfig => {
        const d = of(record);
        if (!d) return { text: '' };
        if (record.get('role') !== 'flight') {
          const worker = record.get('workerId');
          return {
            className: 'dd-cell-step',
            children: [
              { tag: 'span', text: record.get('role') === 'wait' ? 'Waiting on carrier' : record.get('name') },
              worker
                ? { className: 'dd-who', children: [{ tag: 'img', className: 'dd-avatar-sm', src: AVATAR[worker], alt: '' }, { tag: 'span', text: WORKER_TAG[worker] }] }
                : { tag: 'span', className: 'dd-who dd-who-none', text: 'NOBODY' },
            ],
          };
        }
        return {
          className: 'dd-cell-flight',
          dataset: { flight: d.id, state: d.state },
          children: [
            {
              className: 'dd-cell-flight-top',
              children: kids(
                { tag: 'strong', text: d.id },
                { tag: 'span', className: `dd-tag dd-tag-${d.source}`, text: SOURCE_TAG[d.source] },
                d.state === 'late' && { tag: 'span', className: 'dd-tag dd-tag-late', text: 'LATE' },
              ),
            },
            { tag: 'span', className: 'dd-cell-sub', text: `${d.reason} · ${d.item}` },
          ],
        };
      },
    },
    {
      text: 'Amount',
      field: 'disputeId',
      width: 96,
      align: 'right' as const,
      sortable: false,
      renderer: ({ record }: { record: Model }) => dash(record) ?? { className: 'dd-num', text: usd(of(record)?.amount ?? 0) },
    },
    {
      text: 'Call',
      field: 'disputeId',
      width: 84,
      sortable: false,
      renderer: ({ record }: { record: Model }): DomConfig | string => {
        const d = of(record);
        if (record.get('role') !== 'flight' || !d) return dash(record) ?? '';
        if (!d.decision) return { className: 'dd-call dd-call-none', text: '—' };
        return {
          className: `dd-call dd-call-${d.decision}`,
          children: kids(
            { tag: 'span', text: d.decision.toUpperCase() },
            d.decision === 'fight' && { tag: 'span', text: `${Math.round((d.winProbability ?? 0) * 100)}%` },
          ),
        };
      },
    },
    {
      text: 'Lands',
      field: 'disputeId',
      width: 92,
      align: 'right' as const,
      sortable: false,
      renderer: ({ record }: { record: Model }): DomConfig | string => {
        const d = of(record);
        if (record.get('role') !== 'flight' || !d) return dash(record) ?? '';
        if (d.status === 'resolved') return { className: 'dd-lands dd-closed', text: 'closed' };
        const slack = d.slackMin ?? 0;
        return { className: `dd-lands dd-${d.state}`, text: `${slack < 0 ? '−' : '+'}${duration(Math.abs(slack))}` };
      },
    },
  ] as GridColumnConfig[];
}

/** One labelled ribbon: step name on top, its time underneath (dropped when there is no room). */
function ribbon(cls: string, label: string, start: Date, end: Date, style?: string): DomConfig {
  const wide = minutes(start, end) >= 55;
  const tiny = minutes(start, end) < 20;
  return {
    className: `dd-ribbon ${cls}`,
    style,
    children: tiny ? [] : kids({ tag: 'b', text: label }, wide && { tag: 'small', text: span(start, end) }),
  };
}

/**
 * The whole chain of a dispute, drawn inside its own row: ribbons positioned inside the parent bar,
 * arrows between them, and a dashed capsule where the chain was before the agent moved it.
 */
function flightRenderer(record: TaskModel, d: Dispute | undefined, baseline: Snapshot['baseline'], expanded: boolean, moved: boolean): DomConfig[] | string {
  if (!d) return '';
  const start = (record.startDate as Date).getTime();
  const total = (record.endDate as Date).getTime() - start || 1;
  const pct = (t: number) => `${((t - start) / total) * 100}%`;
  const kids = (Array.isArray(record.children) ? (record.children as TaskModel[]) : []).filter((k) => k.startDate && k.endDate);
  const nodes: DomConfig[] = [];

  if (!expanded) {
    kids.forEach((k, i) => {
      const s = k.startDate as Date;
      const en = k.endDate as Date;
      const role = k.get('role');
      const label = role === 'wait' ? 'Waiting on carrier' : SHORT[k.get('kind')] ?? k.name;
      const cls = role === 'wait' ? 'dd-ribbon-wait' : `dd-ribbon-${d.state}${k.get('kind') === 'submit' && d.status === 'resolved' ? ' dd-done' : ''}`;
      nodes.push(ribbon(cls, label, s, en, `left:${pct(s.getTime())};width:calc(${pct(en.getTime())} - ${pct(s.getTime())} - 3px)`));
      if (i > 0) nodes.push({ className: 'dd-arrow', style: `left:calc(${pct(s.getTime())} - 7px)` });
    });
  }

  // Previous plan: where this dispute's steps sat before the current or last agent run.
  const before = d.chain.map((t) => baseline[t.id]).filter(Boolean);
  const now = d.chain.filter((t) => t.start && t.end);
  if (moved && before.length && now.length) {
    const b0 = Math.min(...before.map((b) => toDate(b[0]).getTime()));
    const b1 = Math.max(...before.map((b) => toDate(b[1]).getTime()));
    if (Math.abs(b1 - Math.max(...now.map((t) => toDate(t.end!).getTime()))) > 60_000) {
      nodes.unshift({
        className: 'dd-prev',
        style: `left:${pct(b0)};width:calc(${pct(b1)} - ${pct(b0)})`,
        children: [{ tag: 'b', text: 'Previous plan' }, { tag: 'small', text: span(new Date(b0), new Date(b1)) }],
      });
    }
  }
  if (d.state === 'late' && d.slackMin) nodes.push({ className: 'dd-late-tag', text: `${duration(-d.slackMin)} LATE` });
  return nodes;
}

function tooltip(d: Dispute | undefined, task: TaskModel): string {
  if (!d) return '';
  const role = task.get('role');
  const head = `<h4>${e(d.id)} · ${e(usd(d.amount))}</h4>`;
  if (role === 'wait') return `<div class="dd-tip">${head}<p>Waiting on the carrier. Nobody is booked; the next step can only start after this.</p></div>`;
  const step =
    role === 'step'
      ? `<p><b>${e(task.name)}</b> · ${e(WORKER_TAG[task.get('workerId')] ?? '')} · ${e(dayAndClock(toWall(task.startDate as Date)))}–${e(toWall(task.endDate as Date).slice(11))}</p>`
      : '';
  const decision = d.decision ? `<p><b>${e(d.decision)}</b> ${Math.round((d.winProbability ?? 0) * 100)}% · ${e(d.rationale ?? '')}</p>` : '';
  const conflict = d.conflict ? `<p class="dd-tip-conflict">Scheduling engine: ${e(d.conflict)}</p>` : '';
  return `<div class="dd-tip">${head}${step}<p class="dd-tip-${d.state}">${e(STATE_LABEL[d.state])}: ${e(planLine(d))}</p><p>PayPal deadline ${e(dayAndClock(d.deadline))}</p>${decision}${conflict}</div>`;
}

export default function Board({ snapshot, selectedId, focusId, onSelect, onOverride }: Props) {
  const ganttRef = useRef<BryntumGantt>(null);
  const peopleRef = useRef<BryntumSchedulerPro>(null);
  const projectRef = useRef<BryntumGanttProjectModel>(null);
  const handlers = useRef({ onSelect, onOverride });
  handlers.current = { onSelect, onOverride };
  const disputes = useRef(new Map<string, Dispute>());
  disputes.current = new Map(snapshot.disputes.map((d) => [d.id, d]));
  const baseline = useRef(snapshot.baseline);
  baseline.current = snapshot.baseline;
  // Disputes whose schedule the agent changed in its latest run: only these show their previous plan.
  const moved = useRef(new Set<string>());
  moved.current = movedInLastRun(snapshot);

  // Open rows: what the user picked, what the agent is working on, and (when idle) whatever is late.
  const lateIds = snapshot.running ? '' : snapshot.disputes.filter((d) => d.status === 'open' && d.state === 'late').map((d) => d.id).join(',');
  const expanded = useMemo(
    () => new Set([selectedId, focusId, ...lateIds.split(',')].filter((x): x is string => Boolean(x))),
    [selectedId, focusId, lateIds],
  );
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const data = useMemo(() => buildBoardData(snapshot, expanded), [snapshot, expanded]);
  const first = useRef(data);

  const day = snapshot.planFrom.slice(0, 10);
  const range = useMemo(() => {
    const start = toDate(`${day}T09:00`);
    const end = new Date(start);
    end.setDate(end.getDate() + DAYS_SHOWN);
    return { start, end };
  }, [day]);

  const cols = useMemo(() => columns(disputes), []);
  const initial = useMemo(
    () => ({ ...first.current, tasks: first.current.tasks.map(dated), calendars: datedCalendars(first.current.calendars) }),
    [],
  );
  const timeRanges = useMemo(
    () => [{ id: 'now', startDate: toDate(snapshot.now), name: `NOW ${snapshot.now.slice(11)}`, cls: 'dd-now' }],
    [snapshot.now],
  );
  // Time someone said they are away, drawn on their row of the people view.
  const awayKey = JSON.stringify(snapshot.workers.map((w) => w.away ?? []));
  const resourceTimeRanges = useMemo(
    () =>
      snapshot.workers.flatMap((w) =>
        (w.away ?? []).map((a, i) => ({
          id: `away:${w.id}:${i}`,
          resourceId: w.id,
          startDate: toDate(a.from),
          endDate: toDate(a.to),
          name: `${w.name} away ${span(toDate(a.from), toDate(a.to))}`,
          cls: 'dd-away',
        })),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [awayKey],
  );

  const tooltipFeature = useMemo(
    () => ({ template: ({ taskRecord }: { taskRecord: TaskModel }) => tooltip(disputes.current.get(taskRecord.get('disputeId')), taskRecord) }),
    [],
  );
  const taskRenderer = useMemo(
    () =>
      ({ taskRecord }: { taskRecord: TaskModel }) => {
        const role = taskRecord.get('role');
        const d = disputes.current.get(taskRecord.get('disputeId'));
        if (role === 'flight') return flightRenderer(taskRecord, d, baseline.current, expandedRef.current.has(taskRecord.id as string), moved.current.has(taskRecord.id as string));
        const s = taskRecord.startDate as Date;
        const en = taskRecord.endDate as Date;
        if (minutes(s, en) < 20) return '';
        return kids(
          { tag: 'b', text: role === 'wait' ? 'Waiting on carrier' : SHORT[taskRecord.get('kind')] ?? taskRecord.name },
          minutes(s, en) >= 55 && { tag: 'small', text: span(s, en) },
        );
      },
    [],
  );
  const peopleRenderer = useMemo(
    () =>
      ({ eventRecord }: { eventRecord: SchedulerEventModel }) => {
        const d = disputes.current.get(eventRecord.get('disputeId'));
        const s = eventRecord.startDate as Date;
        const en = eventRecord.endDate as Date;
        return kids({ tag: 'b', text: d?.id ?? '' }, minutes(s, en) >= 55 && { tag: 'small', text: span(s, en) });
      },
    [],
  );

  // One time axis for both views.
  useEffect(() => {
    const gantt = ganttRef.current?.instance;
    const people = peopleRef.current?.instance;
    if (gantt && people) (people as unknown as { partner: unknown }).partner = gantt;
  }, []);

  // Sync the shared project in place, so bars glide to their new place instead of re-rendering.
  useEffect(() => {
    const project = projectRef.current?.instance as ProjectModel | undefined;
    if (!project) return;
    project.calendarManagerStore.data = datedCalendars(data.calendars) as never;
    project.resourceStore.data = data.resources as never;
    project.taskStore.data = data.tasks.map(dated) as never;
    project.dependencyStore.data = data.dependencies as never;
    project.assignmentStore.data = data.assignments as never;
  }, [data]);

  // Expansion follows the agent and the selection.
  useEffect(() => {
    const gantt = ganttRef.current?.instance;
    if (!gantt) return;
    for (const d of snapshot.disputes) {
      const record = gantt.taskStore.getById(d.id) as TaskModel | undefined;
      if (!record) continue;
      const want = expanded.has(d.id);
      if (want && !record.isExpanded(gantt.taskStore)) void gantt.expand(record);
      if (!want && record.isExpanded(gantt.taskStore)) void gantt.collapse(record);
    }
    const target = focusId && (gantt.taskStore.getById(focusId) as TaskModel | undefined);
    if (target) void gantt.scrollTaskIntoView(target, { animate: 300, block: 'nearest', edgeOffset: 40 });
  }, [expanded, focusId, snapshot.disputes]);

  // Per row: a no-fly zone after the PayPal deadline (tagged "DL 14:45"), and on the dispute the agent
  // is touching, the window it is working inside.
  useEffect(() => {
    const gantt = ganttRef.current?.instance;
    if (!gantt) return;
    const zones = snapshot.disputes
      .filter((d) => d.status === 'open')
      .flatMap((d) => {
        const record = gantt.taskStore.getById(d.id) as TaskModel | undefined;
        if (!record) return [];
        const rows = [record, ...(Array.isArray(record.children) ? (record.children as TaskModel[]) : [])];
        const deadline = toDate(d.deadline);
        const zone = rows.map((taskRecord, i) => ({
          startDate: deadline,
          endDate: range.end,
          taskRecord,
          name: i === 0 ? `DL ${hhmm(deadline)}` : '',
          padding: ZONE_PAD,
          animationId: `zone:${taskRecord.id}`,
          cls: `dd-zone dd-zone-${d.state}${i === 0 ? ' dd-zone-head' : ''}`,
        }));
        const focus =
          d.id === focusId
            ? rows.map((taskRecord, i) => ({
                startDate: toDate(snapshot.planFrom),
                endDate: deadline,
                taskRecord,
                name: i === 0 ? 'AGENT WORKING' : '',
                padding: ZONE_PAD,
                animationId: `focus:${i}`,
                cls: 'dd-focus',
              }))
            : [];
        return [...zone, ...focus];
      });
    void gantt.highlightTimeSpans(zones, { clearExisting: true });
  }, [snapshot.disputes, snapshot.planFrom, data, range.end, focusId]);

  const select = (record: Model) => handlers.current.onSelect(record.get('disputeId'));

  return (
    <div className="board-stack">
      <BryntumGanttProjectModel
        ref={projectRef}
        {...PROJECT_STATIC}
        calendars={initial.calendars as never}
        resources={initial.resources}
        tasks={initial.tasks as never}
        dependencies={initial.dependencies}
        assignments={initial.assignments}
      />
      <div className="board-gantt">
        <BryntumGantt
          ref={ganttRef}
          project={projectRef}
          {...GANTT_STATIC}
          startDate={range.start}
          endDate={range.end}
          columns={cols}
          rowHeight={ROW_HEIGHT}
          barMargin={BAR_MARGIN}
          timeRanges={timeRanges}
          taskTooltipFeature={tooltipFeature}
          taskRenderer={taskRenderer}
          onBeforeTaskDrag={isStep}
          onBeforeTaskResize={isStep}
          onTaskClick={({ taskRecord }: { taskRecord: TaskModel }) => select(taskRecord)}
          onCellClick={({ record }: { record: Model }) => select(record)}
          onAfterTaskDrop={({ taskRecords, valid }: { taskRecords: TaskModel[]; valid: boolean }) => valid && report(taskRecords[0], handlers.current.onOverride)}
          onTaskResizeEnd={({ taskRecord, changed }: { taskRecord: TaskModel; changed: boolean }) => changed && report(taskRecord, handlers.current.onOverride)}
        />
      </div>
      <div className="board-people">
        <BryntumSchedulerPro
          ref={peopleRef}
          project={projectRef}
          {...PEOPLE_STATIC}
          columns={PEOPLE_COLUMNS}
          resourceTimeRanges={resourceTimeRanges}
          eventRenderer={peopleRenderer}
          onEventClick={({ eventRecord }: { eventRecord: Model }) => select(eventRecord)}
          onAfterEventDrop={({ eventRecords, assignmentRecords }: { eventRecords: SchedulerEventModel[]; assignmentRecords: Model[] }) =>
            report(eventRecords[0], handlers.current.onOverride, String(assignmentRecords[0]?.get('resourceId') ?? ''))
          }
        />
      </div>
    </div>
  );
}

const SCHEDULE_TOOLS = new Set(['swapEvidenceSource', 'splitBlock', 'assignDispute', 'moveBlock']);

function movedInLastRun(snapshot: Snapshot): Set<string> {
  const start = snapshot.actions.findLast((a) => a.tool === 'runStart');
  if (!start) return new Set();
  return new Set(snapshot.actions.filter((a) => a.runId === start.runId && a.ok && SCHEDULE_TOOLS.has(a.tool) && a.disputeId).map((a) => a.disputeId!));
}

const isStep = ({ taskRecord }: { taskRecord: TaskModel }) => taskRecord.get('role') === 'step';

function report(task: TaskModel | SchedulerEventModel, onOverride: (change: Override) => void, workerId?: string) {
  const start = task.startDate as Date;
  const end = task.endDate as Date;
  onOverride({ taskId: String(task.id), start: toWall(start), durationMin: Math.round(minutes(start, end)), ...(workerId ? { workerId } : {}) });
}
