// Merchant wall-clock time. A WallTime string has no zone; internally it is handled as the epoch
// milliseconds of that same clock reading in UTC, so arithmetic never depends on the server's zone.
import type { WallTime } from './types';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const WORK_START_HOUR = 9;
export const WORK_END_HOUR = 17;

export const ms = (t: WallTime): number => Date.parse(`${t.slice(0, 16)}:00Z`);
export const wall = (t: number): WallTime => new Date(t).toISOString().slice(0, 16);

const dayStart = (t: number) => Math.floor(t / DAY) * DAY;
export const workStart = (t: number) => dayStart(t) + WORK_START_HOUR * HOUR;
export const workEnd = (t: number) => dayStart(t) + WORK_END_HOUR * HOUR;

/** The first working moment at or after t. */
export function nextWorkingMoment(t: number): number {
  if (t < workStart(t)) return workStart(t);
  if (t >= workEnd(t)) return workStart(t + DAY);
  return t;
}

/** Working minutes between a and b (0 when b <= a). */
export function workingMinutesBetween(a: number, b: number): number {
  if (b <= a) return 0;
  let total = 0;
  for (let day = dayStart(a); day <= b; day += DAY) {
    const from = Math.max(a, day + WORK_START_HOUR * HOUR);
    const to = Math.min(b, day + WORK_END_HOUR * HOUR);
    if (to > from) total += (to - from) / MIN;
  }
  return total;
}

/** t advanced by the given number of working minutes. */
export function addWorkingMinutes(t: number, minutes: number): number {
  let cursor = nextWorkingMoment(t);
  let left = minutes * MIN;
  for (;;) {
    const room = workEnd(cursor) - cursor;
    if (left <= room) return cursor + left;
    left -= room;
    cursor = workStart(cursor + DAY);
  }
}

/** Convert a real instant to the wall clock of an IANA zone. */
export function instantToWallMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const n = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
}

export function formatDuration(minutes: number): string {
  const m = Math.round(Math.abs(minutes));
  const h = Math.floor(m / 60);
  return h ? `${h}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`;
}
