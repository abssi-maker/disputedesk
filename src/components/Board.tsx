'use client';

// The Bryntum Scheduler board. Client-only: loaded through next/dynamic with ssr: false.
import '@bryntum/schedulerpro/schedulerpro.css';
import '@bryntum/schedulerpro/stockholm-dark.css';
import '@bryntum/schedulerpro/fontawesome/css/fontawesome.css';
import '@bryntum/schedulerpro/fontawesome/css/solid.css';
import type { DomConfig, Model, SchedulerEventModel as EventModel, SchedulerResourceModel as ResourceModel, Store } from '@bryntum/schedulerpro';
import { BryntumSchedulerPro } from '@bryntum/schedulerpro-react';
import { useEffect, useMemo, useRef } from 'react';
import { toDate, toWall } from '@/lib/format';
import type { Snapshot } from '@/lib/types';

export interface Override {
  taskId: string;
  start: string;
  workerId: string;
  durationMin: number;
}

interface Props {
  snapshot: Snapshot;
  selectedId: string | null;
  onSelect: (disputeId: string) => void;
  onOverride: (change: Override) => void;
}

const DAYS_SHOWN = 4;
const HOUR_WIDTH = 92;

const VIEW_PRESET = {
  base: 'hourAndDay',
  tickWidth: HOUR_WIDTH,
  headers: [
    { unit: 'day' as const, dateFormat: 'dddd D MMM' },
    { unit: 'hour' as const, dateFormat: 'HH:mm' },
  ],
};

const COLUMNS = [
  {
    text: 'Lane',
    field: 'name',
    width: 190,
    sortable: false,
    renderer: ({ record }: { record: Model }): DomConfig => ({
      className: 'dd-lane',
      children: [
        { tag: 'i', className: `fa ${record.get('kind') === 'agent' ? 'fa-robot' : 'fa-user'}` },
        {
          className: 'dd-lane-text',
          children: [
            { tag: 'strong', text: record.get('name') },
            { tag: 'span', text: record.get('role') },
          ],
        },
      ],
    }),
  },
];

const OFF = {
  cellEditFeature: false,
  cellMenuFeature: false,
  headerMenuFeature: false,
  sortFeature: false,
  eventEditFeature: false,
  eventMenuFeature: false,
  eventCopyPasteFeature: false,
  eventDragCreateFeature: false,
  eventTooltipFeature: false,
  scheduleMenuFeature: false,
  scheduleTooltipFeature: false,
  timeAxisHeaderMenuFeature: false,
  dependencyEditFeature: false,
} as const;

const eventRenderer = ({ eventRecord }: { eventRecord: EventModel }): DomConfig[] => [
  { tag: 'span', className: 'dd-ev-id', text: eventRecord.get('label') },
  { tag: 'span', className: 'dd-ev-name', text: eventRecord.name },
];

/** Update a Bryntum store in place so existing bars animate to their new position. */
function syncStore(store: Store, rows: { id: string }[]) {
  const ids = new Set(rows.map((r) => r.id));
  store.remove((store.records as Model[]).filter((r) => !ids.has(String(r.id))));
  for (const row of rows) {
    const existing = store.getById(row.id);
    if (existing) existing.set(row);
    else store.add(row);
  }
}

export default function Board({ snapshot, selectedId, onSelect, onOverride }: Props) {
  const ref = useRef<BryntumSchedulerPro>(null);
  const handlers = useRef({ onSelect, onOverride });
  handlers.current = { onSelect, onOverride };

  const day = snapshot.now.slice(0, 10);
  const range = useMemo(() => {
    const start = toDate(`${day}T09:00`);
    const end = new Date(start);
    end.setDate(end.getDate() + DAYS_SHOWN);
    return { start, end };
  }, [day]);

  const resources = useMemo(
    () => snapshot.workers.map((w) => ({ id: w.id, name: w.name, role: w.role, kind: w.kind })),
    [snapshot.workers],
  );

  useEffect(() => {
    const scheduler = ref.current?.instance;
    if (!scheduler) return;

    const events = snapshot.disputes.flatMap((d) =>
      d.chain
        .filter((t) => t.start && t.end)
        .map((t) => ({
          id: t.id,
          resourceId: t.workerId,
          startDate: toDate(t.start!),
          endDate: toDate(t.end!),
          name: t.kind === 'resolve' ? t.name : t.name.replace('Proof: ', ''),
          label: d.id,
          disputeId: d.id,
          cls: `dd-ev dd-${d.state} dd-kind-${t.kind}${d.id === selectedId ? ' dd-selected' : ''}${t.pinnedBy === 'human' ? ' dd-pinned' : ''}`,
          draggable: d.status === 'open',
          resizable: d.status === 'open',
        })),
    );
    const dependencies = snapshot.disputes.flatMap((d) =>
      d.chain.flatMap((t) =>
        t.dependsOn.map((from) => ({ id: `${from}>${t.id}`, from, to: t.id, cls: `dd-dep dd-${d.state}` })),
      ),
    );
    const timeRanges = [
      { id: 'now', startDate: toDate(snapshot.now), name: 'Now', cls: 'dd-now' },
      ...snapshot.disputes
        .filter((d) => d.status === 'open')
        .map((d) => ({
          id: `deadline-${d.id}`,
          startDate: toDate(d.deadline),
          name: d.id,
          cls: `dd-deadline dd-${d.state}${d.id === selectedId ? ' dd-selected' : ''}`,
        })),
    ];

    syncStore(scheduler.eventStore, events);
    syncStore(scheduler.dependencyStore, dependencies);
    syncStore(scheduler.project.timeRangeStore as Store, timeRanges);
  }, [snapshot.disputes, snapshot.now, selectedId]);

  return (
    <BryntumSchedulerPro
      ref={ref}
      {...OFF}
      startDate={range.start}
      endDate={range.end}
      workingTime={{ fromHour: 9, toHour: 17 }}
      viewPreset={VIEW_PRESET}
      columns={COLUMNS}
      resources={resources}
      rowHeight={96}
      barMargin={22}
      eventLayout="none"
      eventRenderer={eventRenderer}
      enableEventAnimations
      transitionDuration={550}
      useInitialAnimation={false}
      zoomOnMouseWheel={false}
      zoomOnTimeAxisDoubleClick={false}
      enableDeleteKey={false}
      timeResolution={{ unit: 'minute', increment: 15 }}
      dependenciesFeature={{ allowCreate: false, radius: 6, showTooltip: false }}
      timeRangesFeature={{ showHeaderElements: true, showCurrentTimeLine: false, enableResizing: false }}
      eventDragFeature={{ constrainDragToResource: false, validatorFn: ({ newResource }: { newResource: ResourceModel }) => newResource.get('kind') === 'human' }}
      onEventClick={({ eventRecord }: { eventRecord: EventModel }) => handlers.current.onSelect(eventRecord.get('disputeId'))}
      onEventDrop={({ eventRecords }: { eventRecords: EventModel[] }) => report(eventRecords[0], handlers.current.onOverride)}
      onEventResizeEnd={({ changed, eventRecord }: { changed: boolean; eventRecord: EventModel }) => {
        if (changed) report(eventRecord, handlers.current.onOverride);
      }}
    />
  );
}

function report(record: EventModel, onOverride: (change: Override) => void) {
  onOverride({
    taskId: String(record.id),
    start: toWall(record.startDate as Date),
    workerId: String(record.resourceId),
    durationMin: Math.round(((record.endDate as Date).getTime() - (record.startDate as Date).getTime()) / 60_000),
  });
}
