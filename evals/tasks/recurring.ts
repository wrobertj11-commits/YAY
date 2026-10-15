import { detectRecurring, formatCents, type RecurringCharge, type Transaction } from '../../packages/core/src/index.ts';
import { addCounts, matchByOverlap, prf, scoreField, tally, zeroCounts, zeroTally, type Counts, type FieldOutcome, type PRF, type Tally } from '../metrics.ts';
import type { ExpectedRecurring, LabeledTransaction, RecurringCase } from '../types.ts';

/** Anything that turns a bank feed into recurring charges; `detectRecurring` by default. */
export type Detector = (transactions: Transaction[], today: string) => RecurringCharge[];

export const rulesDetector: Detector = (transactions, today) => detectRecurring(transactions, { today });

export const RECURRING_FIELDS = ['merchant', 'cadence', 'amountCents', 'nextChargeDate'] as const;
export type RecurringField = (typeof RECURRING_FIELDS)[number];

export interface RecurringFailure {
  caseId: string;
  type: 'missed' | 'false_positive' | 'field';
  detail: string;
}

export interface RecurringResult {
  cases: number;
  /** Labeled subscriptions across all cases. */
  subscriptions: number;
  negativeCases: number;
  counts: Counts;
  prf: PRF;
  /** Scored on detected subscriptions only: a miss already counts against recall. */
  fields: Record<RecurringField, Tally>;
  /** Cases with no miss, no false positive and every field right. */
  casePass: Tally;
  /** Negative cases where nothing was detected. */
  negativePass: Tally;
  byTag: Record<string, Tally>;
  failures: RecurringFailure[];
}

export function toTransaction({ sub: _sub, ...t }: LabeledTransaction): Transaction {
  return t;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Catalog merchants must match by id; others by name, and must not be pinned to some catalog merchant. */
function merchantOutcome(gold: ExpectedRecurring, d: RecurringCharge): FieldOutcome {
  if (gold.merchantId) return scoreField(gold.merchantId, d.merchantId);
  return !d.merchantId && norm(d.name).includes(norm(gold.name ?? '')) ? 'correct' : 'wrong';
}

const describe = (d: RecurringCharge) => `"${d.name}" ${d.cadence} ${formatCents(d.amountCents)} next ${d.nextChargeDate}`;
const describeGold = (g: ExpectedRecurring) =>
  `${g.merchantId ?? `"${g.name}"`} ${g.cadence ?? '(no cadence)'} ${g.amountCents !== undefined ? formatCents(g.amountCents) : ''}`.trim();

/**
 * Runs the detector on each case's feed and matches detections to labeled subscriptions by the
 * transactions they share (see matchByOverlap), so a detection counts as finding a subscription only
 * if it is built from that subscription's charges, whatever it is named.
 */
export function evaluateRecurring(cases: readonly RecurringCase[], detect: Detector = rulesDetector): RecurringResult {
  let counts = zeroCounts();
  const fields = Object.fromEntries(RECURRING_FIELDS.map((f) => [f, zeroTally()])) as Record<RecurringField, Tally>;
  let casePass = zeroTally();
  let negativePass = zeroTally();
  const byTag: Record<string, Tally> = {};
  const failures: RecurringFailure[] = [];

  for (const c of cases) {
    const detections = detect(c.transactions.map(toTransaction), c.today);
    const goldIds = c.expected.map((g) => c.transactions.filter((t) => t.sub === g.sub).map((t) => t.id));
    const { matches, unmatchedPreds, unmatchedGolds } = matchByOverlap(
      detections.map((d) => d.transactionIds),
      goldIds,
    );
    const caseFailures: RecurringFailure[] = [];

    for (const gi of unmatchedGolds) {
      const g = c.expected[gi];
      if (g) caseFailures.push({ caseId: c.id, type: 'missed', detail: `missed ${g.sub}: ${describeGold(g)}` });
    }
    for (const pi of unmatchedPreds) {
      const d = detections[pi];
      if (d) caseFailures.push({ caseId: c.id, type: 'false_positive', detail: `false positive: ${describe(d)}` });
    }
    for (const m of matches) {
      const g = c.expected[m.gold];
      const d = detections[m.pred];
      if (!g || !d) continue;
      const outcomes: [RecurringField, FieldOutcome, string, string][] = [
        ['merchant', merchantOutcome(g, d), g.merchantId ?? `name containing "${g.name}"`, d.merchantId ?? `"${d.name}"`],
        ['cadence', scoreField(g.cadence, d.cadence), String(g.cadence), d.cadence],
        ['amountCents', scoreField(g.amountCents, d.amountCents), String(g.amountCents), String(d.amountCents)],
        ['nextChargeDate', scoreField(g.nextChargeDate, d.nextChargeDate), String(g.nextChargeDate), d.nextChargeDate],
      ];
      for (const [field, outcome, want, got] of outcomes) {
        fields[field] = tally(fields[field], outcome);
        if (outcome === 'wrong') caseFailures.push({ caseId: c.id, type: 'field', detail: `${g.sub} ${field}: expected ${want}, got ${got}` });
      }
    }

    counts = addCounts(counts, { tp: matches.length, fp: unmatchedPreds.length, fn: unmatchedGolds.length });
    const pass = caseFailures.length === 0 ? 'correct' : 'wrong';
    casePass = tally(casePass, pass);
    if (!c.expected.length) negativePass = tally(negativePass, unmatchedPreds.length ? 'wrong' : 'correct');
    for (const tag of c.tags) byTag[tag] = tally(byTag[tag] ?? zeroTally(), pass);
    failures.push(...caseFailures);
  }

  return {
    cases: cases.length,
    subscriptions: cases.reduce((s, c) => s + c.expected.length, 0),
    negativeCases: cases.filter((c) => !c.expected.length).length,
    counts,
    prf: prf(counts),
    fields,
    casePass,
    negativePass,
    byTag,
    failures,
  };
}
