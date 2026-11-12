// Display helpers shared by the client components.
import type { Dispute, WallTime } from './types';

export const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/** Wall-clock string to a Date in the browser's zone showing the same clock reading. */
export function toDate(t: WallTime): Date {
  const [y, m, d, h, min] = t.split(/[-T:]/).map(Number);
  return new Date(y, m - 1, d, h, min);
}

export function toWall(date: Date): WallTime {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
}

export const dayAndClock = (t: WallTime) =>
  toDate(t).toLocaleString('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function duration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d) return `${d}d ${h}h`;
  return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

export const SOURCE_LABEL: Record<Dispute['source'], string> = {
  paypal: 'PayPal sandbox',
  seed: 'Seed data',
  simulated: 'Simulated',
};

export const STATE_LABEL: Record<Dispute['state'], string> = {
  late: 'Misses deadline',
  tight: 'Tight',
  safe: 'On time',
  resolved: 'Resolved',
};

export function planLine(d: Dispute): string {
  if (d.status === 'resolved') return d.autoResolved ? 'Resolved by the agent' : 'Evidence sent';
  if (d.state === 'late') return `Lands ${duration(-(d.slackMin ?? 0))} after the deadline`;
  return `Lands ${duration(d.slackMin ?? 0)} before the deadline`;
}
