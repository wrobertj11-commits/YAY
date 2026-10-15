import type { EmailInput, LabeledTransactionInput } from '../types.ts';

/**
 * Small, deterministic generators for synthetic fixtures. Nothing here reads the clock or uses
 * Math.random: the dataset fingerprint in the baseline must not change between runs.
 *
 * The date math is written out here instead of imported from packages/core: fixtures must not move
 * when the code under test changes, or a bug in core's date helpers would quietly shift the labels too.
 */

type ISODate = string;

const DAY_MS = 86_400_000;
const utc = (iso: ISODate) => new Date(`${iso}T00:00:00Z`);
const iso = (d: Date): ISODate => d.toISOString().slice(0, 10);

export function addDays(date: ISODate, days: number): ISODate {
  return iso(new Date(utc(date).getTime() + days * DAY_MS));
}

/** Calendar months on `anchorDay`, clamped to the month's last day (Jan 31 + 1 month = Feb 28). */
export function addMonths(date: ISODate, months: number, anchorDay = utc(date).getUTCDate()): ISODate {
  const d = utc(date);
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return iso(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(anchorDay, lastDay))));
}

/** Monthly billing dates on a fixed day of the month, clamped at short months like real billers do. */
export function monthly(first: ISODate, count: number, anchorDay = Number(first.slice(8, 10))): ISODate[] {
  return Array.from({ length: count }, (_, i) => addMonths(first, i, anchorDay));
}

export function everyDays(first: ISODate, days: number, count: number): ISODate[] {
  return Array.from({ length: count }, (_, i) => addDays(first, i * days));
}

export function yearly(first: ISODate, count: number): ISODate[] {
  return Array.from({ length: count }, (_, i) => addMonths(first, 12 * i));
}

/** Seeded PRNG (mulberry32 over a string hash) for "random-looking" but repeatable noise. */
export function seeded(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ChargeOptions {
  /** Labels the charges as part of an expected subscription. Leave unset for noise. */
  sub?: string;
  /** Id prefix; ids must be unique within a case. Defaults to the sub label or "noise". */
  prefix?: string;
  paymentMethod?: string;
}

/**
 * One charge per date. `amount` is a fixed price, a list (one per date), or a function of the index,
 * so price increases and tax wobble read naturally in the fixture.
 */
export function charges(
  description: string,
  amount: number | readonly number[] | ((i: number) => number),
  dates: readonly ISODate[],
  opts: ChargeOptions = {},
): LabeledTransactionInput[] {
  const prefix = opts.prefix ?? opts.sub ?? 'noise';
  return dates.map((date, i) => {
    const cents = typeof amount === 'number' ? amount : typeof amount === 'function' ? amount(i) : amount[i];
    if (cents === undefined) throw new Error(`fixture: no amount for charge ${i} of "${description}"`);
    return {
      id: `${prefix}-${i + 1}`,
      date,
      amountCents: cents,
      description,
      sub: opts.sub,
      ...(opts.paymentMethod ? { paymentMethod: opts.paymentMethod } : {}),
    };
  });
}

/** Charges sorted by date, as a bank feed would deliver them. */
export function feed(...groups: LabeledTransactionInput[][]): LabeledTransactionInput[] {
  return groups.flat().sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

/** Builds an email input; `body` lines are joined with newlines so fixtures stay readable. */
export function mail(id: string, from: string, subject: string, date: string, body: string | readonly string[]): EmailInput {
  return { id, from, subject, date, body: typeof body === 'string' ? body : body.join('\n') };
}
