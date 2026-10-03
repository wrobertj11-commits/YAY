import type { Cadence, ISODate } from './types.ts';

const DAY_MS = 86_400_000;

export function toDate(iso: ISODate): Date {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`);
}

export function toISODate(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

export function addDays(iso: ISODate, days: number): ISODate {
  return toISODate(new Date(toDate(iso).getTime() + days * DAY_MS));
}

/** Adds months, clamping to the last day of the target month (Jan 31 + 1 month = Feb 28). */
export function addMonths(iso: ISODate, months: number, anchorDay?: number): ISODate {
  const d = toDate(iso);
  const day = anchorDay ?? d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return toISODate(target);
}

export function daysBetween(from: ISODate, to: ISODate): number {
  return Math.round((toDate(to).getTime() - toDate(from).getTime()) / DAY_MS);
}

export function advanceByCadence(iso: ISODate, cadence: Cadence, anchorDay?: number): ISODate {
  switch (cadence) {
    case 'weekly':
      return addDays(iso, 7);
    case 'monthly':
      return addMonths(iso, 1, anchorDay);
    case 'quarterly':
      return addMonths(iso, 3, anchorDay);
    case 'annual':
      return addMonths(iso, 12, anchorDay);
  }
}

/** Typical period length in days, used for tolerances and grace windows. */
export function cadenceDays(cadence: Cadence): number {
  return { weekly: 7, monthly: 30, quarterly: 91, annual: 365 }[cadence];
}

/** Rolls a schedule forward until it lands on or after `today`. */
export function nextOnOrAfter(start: ISODate, cadence: Cadence, today: ISODate, anchorDay?: number): ISODate {
  let next = start;
  for (let i = 0; i < 1000 && next < today; i++) next = advanceByCadence(next, cadence, anchorDay);
  return next;
}

/** Charges are assumed to post at noon UTC on their date. */
export function chargeInstant(date: ISODate): Date {
  return new Date(`${date}T12:00:00Z`);
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
