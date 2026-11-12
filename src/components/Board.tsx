'use client';

// The board: a Bryntum Gantt (one row per dispute) above a Bryntum ResourceHistogram (one row per
// person), both on one shared project so a change in either is a change in both.
// Client-only: loaded through next/dynamic with ssr: false.
import '@bryntum/gantt/gantt.css';
import '@bryntum/gantt/svalbard-light.css';
import '@bryntum/gantt/fontawesome/css/fontawesome.css';
import '@bryntum/gantt/fontawesome/css/solid.css';
import { StringHelper, type DomConfig, type GridColumnConfig, type Model, type ProjectModel, type TaskModel } from '@bryntum/gantt';
import { BryntumGantt, BryntumGanttProjectModel, BryntumResourceHistogram } from '@bryntum/gantt-react';
import { useEffect, useMemo, useRef } from 'react';
import { buildBoardData, type BoardTask } from '@/lib/board-data';
import { STATE_LABEL, dayAndClock, duration, planLine, toDate, toWall, usd } from '@/lib/format';
import { WORK_CALENDAR, type ProjectCalendar } from '@/lib/project';
import type { Dispute, Snapshot } from '@/lib/types';

export interface Override {
  taskId: string;
  start: string;
  durationMin: number;
}

interface Props {
  snapshot: Snapshot;
  selectedId: string | null;
  /** The dispute the agent is working on right now, if any. */
  focusId: string | null;
  onSelect: (disputeId: string) => void;
  onOverride: (change: Override) => void;
}

const DAYS_SHOWN = 4;
const HOUR_WIDTH = 64;
const e = StringHelper.encodeHtml;
const ROW_HEIGHT = 52;
const BAR_MARGIN = 12;
/** Vertical padding that stretches a highlight from a bar to its whole row. */
const ZONE_PAD_STEP = BAR_MARGIN - 1;
const ZONE_PAD_FLIGHT = 17;

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

const HISTOGRAM_STATIC = {
  hideHeaders: true,
  rowHeight: 80,
  showBarTip: true,
};

/** Calendar intervals carry wall-clock strings; Bryntum wants Dates. */
const datedCalendars = (calendars: ProjectCalendar[]) =>
  calendars.map((c) => ({
    ...c,
    intervals: c.intervals.map((i) => ({ ...i, ...(i.startDate ? { startDate: toDate(i.startDate) } : {}), ...(i.endDate ? { endDate: toDate(i.endDate) } : {}) })),
  }));

const GANTT_STATIC = {
  workingTime: { fromHour: 9, toHour: 17 },
  viewPreset: VIEW_PRESET,
  subGridConfigs: { locked: { width: 540 } },
  transition: { changeEvent: 500 },
  cellEditFeature: false,
  cellMenuFeature: false,
  headerMenuFeature: false,
  taskMenuFeature: false,
  scheduleMenuFeature: false,
  taskEditFeature: false,
  taskDragCreateFeature: false,
  dependencyEditFeature: false,
  timeAxisHeaderMenuFeature: false,
  sortFeature: false,
  percentBarFeature: false,
  projectLinesFeature: false,
  rollupsFeature: true,
  baselinesFeature: true,
  timeSpanHighlightFeature: true,
  dependenciesFeature: { allowCreate: false, radius: 5, showTooltip: false },
  indicatorsFeature: { items: { earlyDates: false, lateDates: false, constraintDate: false, deadlineDate: true } },
  timeRangesFeature: { showCurrentTimeLine: false, showHeaderElements: true },
} as const;

const HISTOGRAM_COLUMNS = [
  {
    text: 'Who',
    field: 'name',
    width: 540,
    renderer: ({ record }: { record: Model }): DomConfig => ({
      className: 'dd-person',
      children: [
        { tag: 'strong', text: record.get('name') },
        { tag: 'span', text: record.get('role') },
      ],
    }),
  },
];

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

const SOURCE_TAG: Record<Dispute['source'], string> = { paypal: 'PAYPAL', seed: 'SEED', simulated: 'SIM' };
const WORKER_TAG: Record<string, string> = { owner: 'YOU', maya: 'MAYA', auto: 'AGENT' };

function columns(disputes: React.RefObject<Map<string, Dispute>>): GridColumnConfig[] {
  const of = (record: Model) => disputes.current.get(record.get('disputeId'));
  return [
    {
      type: 'name' as const,
      text: 'Dispute',
      field: 'name',
      width: 250,
      sortable: false,
      renderer: ({ record }: { record: Model }): DomConfig => {
        const d = of(record);
        if (!d) return { text: '' };
        if (record.get('role') !== 'flight') {
          const worker = record.get('workerId');
          return {
            className: 'dd-cell-step',
            children: [
              { tag: 'span', text: record.get('name') },
              worker ? { tag: 'span', className: `dd-who dd-who-${worker}`, text: WORKER_TAG[worker] } : { tag: 'span', className: 'dd-who dd-who-none', text: 'NOBODY' },
            ],
          };
        }
        return {
          className: 'dd-cell-flight',
          dataset: { flight: d.id, state: d.state },
          children: [
            {
              className: 'dd-cell-flight-top',
              children: [
                { tag: 'strong', text: d.id },
                { tag: 'span', className: `dd-src dd-src-${d.source}`, text: SOURCE_TAG[d.source] },
              ],
            },
            { tag: 'span', className: 'dd-cell-sub', text: `${d.reason} · ${d.item}` },
          ],
        };
      },
    },
    {
      text: 'Amount',
      field: 'disputeId',
      width: 92,
      align: 'right' as const,
      sortable: false,
      renderer: ({ record }: { record: Model }) => (record.get('role') === 'flight' ? { className: 'dd-num', text: usd(of(record)?.amount ?? 0) } : ''),
    },
    {
      text: 'Call',
      field: 'disputeId',
      width: 96,
      sortable: false,
      renderer: ({ record }: { record: Model }): DomConfig | string => {
        const d = of(record);
        if (record.get('role') !== 'flight' || !d) return '';
        if (!d.decision) return { className: 'dd-call dd-call-none', text: '—' };
        return {
          className: `dd-call dd-call-${d.decision}`,
          children: [
            { tag: 'span', text: d.decision.toUpperCase() },
            { tag: 'span', className: 'dd-num', text: `${Math.round((d.winProbability ?? 0) * 100)}%` },
          ],
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
        if (record.get('role') !== 'flight' || !d) return '';
        if (d.status === 'resolved') return { className: 'dd-lands dd-resolved', text: 'closed' };
        const slack = d.slackMin ?? 0;
        return { className: `dd-lands dd-num dd-${d.state}`, text: `${slack < 0 ? '−' : '+'}${duration(Math.abs(slack))}` };
      },
    },
  ] as GridColumnConfig[];
}

function tooltip(d: Dispute | undefined, task: TaskModel): string {
  if (!d) return '';
  const role = task.get('role');
  const head = `<h4>${e(d.id)} · ${e(usd(d.amount))}</h4>`;
  if (role === 'wait') return `<div class="dd-tip">${head}<p>Waiting on the carrier. Nobody is booked; the next step can only start after this.</p></div>`;
  const step = role === 'step' ? `<p><b>${e(task.name)}</b> · ${e(WORKER_TAG[task.get('workerId')] ?? '')} · ${e(dayAndClock(toWall(task.startDate as Date)))}–${e(toWall(task.endDate as Date).slice(11))}</p>` : '';
  const decision = d.decision ? `<p><b>${e(d.decision)}</b> ${Math.round((d.winProbability ?? 0) * 100)}% · ${e(d.rationale ?? '')}</p>` : '';
  const conflict = d.conflict ? `<p class="dd-tip-conflict">Engine: ${e(d.conflict)}</p>` : '';
  return `<div class="dd-tip">${head}${step}<p class="dd-tip-${d.state}">${e(STATE_LABEL[d.state])}: ${e(planLine(d))}</p><p>PayPal deadline ${e(dayAndClock(d.deadline))}</p>${decision}${conflict}</div>`;
}

export default function Board({ snapshot, selectedId, focusId, onSelect, onOverride }: Props) {
  const ganttRef = useRef<BryntumGantt>(null);
  const histogramRef = useRef<BryntumResourceHistogram>(null);
  const projectRef = useRef<BryntumGanttProjectModel>(null);
  const handlers = useRef({ onSelect, onOverride });
  handlers.current = { onSelect, onOverride };
  const disputes = useRef(new Map<string, Dispute>());
  disputes.current = new Map(snapshot.disputes.map((d) => [d.id, d]));

  // Open rows: what the user picked, what the agent is working on, and (when idle) whatever is late.
  const lateIds = snapshot.running ? '' : snapshot.disputes.filter((d) => d.status === 'open' && d.state === 'late').map((d) => d.id).join(',');
  const expanded = useMemo(
    () => new Set([selectedId, focusId, ...lateIds.split(',')].filter((x): x is string => Boolean(x))),
    [selectedId, focusId, lateIds],
  );
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
  const initial = useMemo(() => ({ ...first.current, tasks: first.current.tasks.map(dated), calendars: datedCalendars(first.current.calendars) }), []);
  // "Now", plus every stretch of time someone said they are away.
  const awayKey = JSON.stringify(snapshot.workers.map((w) => w.away ?? []));
  const timeRanges = useMemo(
    () => [
      { id: 'now', startDate: toDate(snapshot.now), name: snapshot.demo ? 'Now (demo)' : 'Now', cls: 'dd-now' },
      ...snapshot.workers.flatMap((w) =>
        (w.away ?? []).map((a, i) => ({ id: `away:${w.id}:${i}`, startDate: toDate(a.from), endDate: toDate(a.to), name: `${w.name === 'You' ? 'You' : w.name} away`, cls: 'dd-away' })),
      ),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot.now, snapshot.demo, awayKey],
  );
  const tooltipFeature = useMemo(
    () => ({ template: ({ taskRecord }: { taskRecord: TaskModel }) => tooltip(disputes.current.get(taskRecord.get('disputeId')), taskRecord) }),
    [],
  );

  // Share the time axis and scrolling between the Gantt and the histogram.
  useEffect(() => {
    const gantt = ganttRef.current?.instance;
    const histogram = histogramRef.current?.instance;
    if (gantt && histogram) (histogram as unknown as { partner: unknown }).partner = gantt;
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

  // Past each PayPal deadline, the dispute's own row turns into a hatched no-fly zone.
  useEffect(() => {
    const gantt = ganttRef.current?.instance;
    if (!gantt) return;
    const zones = snapshot.disputes
      .filter((d) => d.status === 'open')
      .flatMap((d) => {
        const record = gantt.taskStore.getById(d.id) as TaskModel | undefined;
        if (!record) return [];
        const kids = Array.isArray(record.children) ? (record.children as TaskModel[]) : [];
        // padding inflates the highlight from the bar's height to the full row
        const zone = [record, ...kids].map((taskRecord) => ({
          startDate: toDate(d.deadline),
          endDate: range.end,
          taskRecord,
          name: '',
          padding: taskRecord === record ? ZONE_PAD_FLIGHT : ZONE_PAD_STEP,
          animationId: `zone:${taskRecord.id}`,
          cls: `dd-zone dd-zone-${d.state}`,
        }));
        // The window the agent is working inside: from now to the deadline, on the dispute it is touching.
        const focus =
          d.id === focusId
            ? [{ startDate: toDate(snapshot.planFrom), endDate: toDate(d.deadline), taskRecord: record, name: 'agent working', padding: ZONE_PAD_FLIGHT, animationId: 'focus', cls: 'dd-focus' }]
            : [];
        return [...zone, ...focus];
      });
    void gantt.highlightTimeSpans(zones, { clearExisting: true });
  }, [snapshot.disputes, snapshot.planFrom, data, range.end, focusId]);

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
          onTaskClick={({ taskRecord }: { taskRecord: TaskModel }) => handlers.current.onSelect(taskRecord.get('disputeId'))}
          onCellClick={({ record }: { record: Model }) => handlers.current.onSelect(record.get('disputeId'))}
          onAfterTaskDrop={({ taskRecords, valid }: { taskRecords: TaskModel[]; valid: boolean }) => valid && report(taskRecords[0], handlers.current.onOverride)}
          onTaskResizeEnd={({ taskRecord, changed }: { taskRecord: TaskModel; changed: boolean }) => changed && report(taskRecord, handlers.current.onOverride)}
        />
      </div>
      <div className="board-people">
        <BryntumResourceHistogram ref={histogramRef} project={projectRef} {...HISTOGRAM_STATIC} columns={HISTOGRAM_COLUMNS} />
      </div>
    </div>
  );
}

const isStep = ({ taskRecord }: { taskRecord: TaskModel }) => taskRecord.get('role') === 'step';

/** Long enough steps carry their name; short ones stay clean. */
const taskRenderer = ({ taskRecord }: { taskRecord: TaskModel }) =>
  taskRecord.get('role') === 'step' && ((taskRecord.endDate as Date).getTime() - (taskRecord.startDate as Date).getTime()) / 60_000 > 40
    ? e(taskRecord.name)
    : '';

function report(task: TaskModel, onOverride: (change: Override) => void) {
  const start = task.startDate as Date;
  const end = task.endDate as Date;
  onOverride({ taskId: String(task.id), start: toWall(start), durationMin: Math.round((end.getTime() - start.getTime()) / 60_000) });
}
