import { advanceByCadence, cadenceDays, daysBetween, median, nextOnOrAfter, toDate } from './dates.ts';
import { getMerchant } from './merchants.ts';
import { normalizeMerchant } from './normalize.ts';
import type { Cadence, ISODate, NormalizedMerchant, PricePoint, RecurringCharge, Transaction } from './types.ts';

const CADENCE_WINDOWS: Record<Cadence, [number, number]> = {
  weekly: [5, 9],
  monthly: [26, 35],
  quarterly: [84, 98],
  annual: [350, 380],
};

const MIN_CHARGES: Record<Cadence, number> = { weekly: 3, monthly: 2, quarterly: 2, annual: 2 };

/** Two charges are "the same price" within this ratio; anything larger counts as a price change. */
const AMOUNT_TOLERANCE = 0.2;

export interface DetectOptions {
  today: ISODate;
}

interface Group {
  merchant: NormalizedMerchant;
  txns: Transaction[];
}

export function groupByMerchant(transactions: Transaction[]): Map<string, Group> {
  const groups = new Map<string, Group>();
  for (const t of transactions) {
    if (t.amountCents <= 0) continue;
    let merchant = normalizeMerchant(t.description);
    // App stores bill many unrelated subscriptions under one descriptor; split them by price.
    if (merchant.merchantId === 'apple-app-store' || merchant.merchantId === 'google-play') {
      merchant = { ...merchant, key: `${merchant.key}:${t.amountCents}` };
    }
    const g = groups.get(merchant.key) ?? { merchant, txns: [] };
    g.txns.push(t);
    groups.set(merchant.key, g);
  }
  for (const g of groups.values()) g.txns.sort((a, b) => a.date.localeCompare(b.date));
  return groups;
}

function similar(a: number, b: number): boolean {
  return Math.abs(a - b) <= AMOUNT_TOLERANCE * Math.max(a, b);
}

function bestCadence(intervals: number[]): { cadence: Cadence; fit: number } | undefined {
  let best: { cadence: Cadence; fit: number } | undefined;
  for (const cadence of Object.keys(CADENCE_WINDOWS) as Cadence[]) {
    const [lo, hi] = CADENCE_WINDOWS[cadence];
    const fit = intervals.filter((d) => d >= lo && d <= hi).length / intervals.length;
    if (!best || fit > best.fit) best = { cadence, fit };
  }
  return best;
}

function priceHistory(txns: Transaction[]): PricePoint[] {
  const points: PricePoint[] = [];
  for (const t of txns) {
    const last = points[points.length - 1];
    if (!last || last.amountCents !== t.amountCents) points.push({ date: t.date, amountCents: t.amountCents });
  }
  return points;
}

/**
 * Picks the charges that look like the subscription out of everything billed by a merchant:
 * the run of charges, newest first, whose amounts stay close to the latest charge or to each other.
 * This keeps a price increase in the run while dropping one-off purchases of a different size.
 */
function recurringRun(txns: Transaction[]): Transaction[] {
  const newest = txns[txns.length - 1];
  if (!newest) return [];
  const run: Transaction[] = [newest];
  let prev = newest;
  for (const t of txns.slice(0, -1).reverse()) {
    if (t.date === prev.date) continue; // same-day duplicate (auth + capture)
    if (similar(t.amountCents, prev.amountCents) || similar(t.amountCents, newest.amountCents)) {
      run.push(t);
      prev = t;
    }
  }
  return run.reverse();
}

function guessSingleChargeCadence(amountCents: number): Cadence {
  return amountCents >= 5000 ? 'annual' : 'monthly';
}

/**
 * F1: detect recurring charges by merchant, amount and cadence.
 * Returns only subscriptions that still look alive (charged within ~1.5 periods of today).
 */
export function detectRecurring(transactions: Transaction[], { today }: DetectOptions): RecurringCharge[] {
  const results: RecurringCharge[] = [];

  for (const { merchant, txns } of groupByMerchant(transactions).values()) {
    const known = Boolean(merchant.merchantId);
    const run = recurringRun(txns);
    const last = run[run.length - 1];
    if (!last) continue;

    let cadence: Cadence;
    let confidence: number;

    if (run.length >= 2) {
      const intervals = run.slice(1).map((t, i) => daysBetween((run[i] as Transaction).date, t.date));
      const best = bestCadence(intervals);
      if (!best || best.fit < 0.6) continue;
      cadence = best.cadence;
      if (run.length < MIN_CHARGES[cadence] + (known ? 0 : 1)) continue;
      // Habitual spending (coffee, groceries) has many other purchases between the "regular" ones.
      // A subscription is most of what an unknown merchant bills over the same span.
      const first = run[0] as Transaction;
      const inSpan = txns.filter((t) => t.date >= first.date && t.date <= last.date).length;
      if (!known && run.length / inSpan < 0.8) continue;
      const consistency = 1 - Math.min(1, Math.abs(median(intervals) - cadenceDays(cadence)) / cadenceDays(cadence));
      confidence = Math.min(0.99, (0.45 + 0.1 * Math.min(run.length - 1, 4) + (known ? 0.15 : 0)) * best.fit * consistency);
    } else {
      // A single charge from a known subscription merchant is worth surfacing for confirmation.
      const merchantInfo = getMerchant(merchant.merchantId);
      if (!merchantInfo || merchantInfo.category === 'App stores') continue;
      cadence = guessSingleChargeCadence(last.amountCents);
      if (daysBetween(last.date, today) > cadenceDays(cadence) + 5) continue;
      confidence = 0.4;
    }

    // Lapsed: no charge for 1.5 periods plus a week of grace.
    if (daysBetween(last.date, today) > cadenceDays(cadence) * 1.5 + 7) continue;

    const anchorDay = toDate(last.date).getUTCDate();
    results.push({
      key: merchant.key,
      merchantId: merchant.merchantId,
      name: merchant.name,
      rail: merchant.rail,
      cadence,
      amountCents: last.amountCents,
      lastChargeDate: last.date,
      nextChargeDate: nextOnOrAfter(advanceByCadence(last.date, cadence, anchorDay), cadence, today, anchorDay),
      paymentMethod: last.paymentMethod,
      transactionIds: run.map((t) => t.id),
      priceHistory: priceHistory(run),
      confidence: Math.round(Math.max(0.3, confidence) * 100) / 100,
    });
  }

  return results.sort((a, b) => a.nextChargeDate.localeCompare(b.nextChargeDate));
}
