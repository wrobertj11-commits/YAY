/**
 * Scoring primitives for the accuracy evals. Pure functions with no knowledge of Trialguard types,
 * so they can be unit-tested on their own (metrics.test.ts) and reused by every task.
 */

// ---------- precision / recall / F1 ----------

export interface Counts {
  tp: number;
  fp: number;
  fn: number;
}

export interface PRF {
  precision: number;
  recall: number;
  f1: number;
}

export const zeroCounts = (): Counts => ({ tp: 0, fp: 0, fn: 0 });

export function addCounts(a: Counts, b: Counts): Counts {
  return { tp: a.tp + b.tp, fp: a.fp + b.fp, fn: a.fn + b.fn };
}

/**
 * Precision, recall and F1 from raw counts.
 * An empty denominator scores 1 only when there was nothing to find and nothing was predicted
 * (tp = fp = fn = 0); otherwise it scores 0. That keeps a detector that predicts nothing from
 * getting perfect precision for free, and keeps an empty slice from dragging an average down.
 */
export function prf({ tp, fp, fn }: Counts): PRF {
  const empty = tp + fp + fn === 0 ? 1 : 0;
  const precision = tp + fp === 0 ? empty : tp / (tp + fp);
  const recall = tp + fn === 0 ? empty : tp / (tp + fn);
  return { precision, recall, f1: f1(precision, recall) };
}

export function f1(precision: number, recall: number): number {
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

// ---------- multi-class classification ----------

/** confusion[gold][predicted] = count. Every label appears as a row and a column, even when unused. */
export type Confusion<L extends string> = Record<L, Record<L, number>>;

export function confusion<L extends string>(labels: readonly L[], pairs: Iterable<readonly [gold: L, pred: L]>): Confusion<L> {
  const row = () => Object.fromEntries(labels.map((l) => [l, 0])) as Record<L, number>;
  const m = Object.fromEntries(labels.map((l) => [l, row()])) as Confusion<L>;
  for (const [gold, pred] of pairs) {
    if (!labels.includes(gold) || !labels.includes(pred)) throw new Error(`label outside ${labels.join('|')}: ${gold} -> ${pred}`);
    m[gold][pred] += 1;
  }
  return m;
}

/** One-vs-rest counts for a single label. */
export function classCounts<L extends string>(m: Confusion<L>, label: L): Counts {
  const labels = Object.keys(m) as L[];
  const tp = m[label][label];
  const fp = labels.reduce((s, g) => s + (g === label ? 0 : m[g][label]), 0);
  const fn = labels.reduce((s, p) => s + (p === label ? 0 : m[label][p]), 0);
  return { tp, fp, fn };
}

export function accuracy<L extends string>(m: Confusion<L>): number {
  const labels = Object.keys(m) as L[];
  let right = 0;
  let total = 0;
  for (const g of labels) {
    for (const p of labels) {
      total += m[g][p];
      if (g === p) right += m[g][p];
    }
  }
  return total === 0 ? 1 : right / total;
}

/** Unweighted mean F1 over the given labels, so rare classes count as much as common ones. */
export function macroF1<L extends string>(m: Confusion<L>, labels: readonly L[]): number {
  if (!labels.length) return 1;
  return labels.reduce((s, l) => s + prf(classCounts(m, l)).f1, 0) / labels.length;
}

/**
 * Collapses a multi-class confusion into one binary question ("is it any kind of subscription email?").
 * A gold positive predicted as a *different* positive class still counts as found here.
 */
export function binaryCounts<L extends string>(m: Confusion<L>, isPositive: (l: L) => boolean): Counts {
  const labels = Object.keys(m) as L[];
  const c = zeroCounts();
  for (const g of labels) {
    for (const p of labels) {
      const n = m[g][p];
      if (isPositive(g) && isPositive(p)) c.tp += n;
      else if (!isPositive(g) && isPositive(p)) c.fp += n;
      else if (isPositive(g) && !isPositive(p)) c.fn += n;
    }
  }
  return c;
}

// ---------- field accuracy ----------

export type FieldOutcome = 'correct' | 'wrong' | 'unscored';

/**
 * Scores one extracted field against its label.
 *  - gold `undefined`: the field wasn't labeled for this case, so it isn't scored;
 *  - gold `null`: the field must be absent (e.g. a euro price must not be read as dollars);
 *  - any other gold value: the prediction must equal it. A missing prediction is wrong.
 */
export function scoreField<T>(gold: T | null | undefined, pred: T | null | undefined, equals: (a: T, b: T) => boolean = Object.is): FieldOutcome {
  if (gold === undefined) return 'unscored';
  if (gold === null) return pred === undefined || pred === null ? 'correct' : 'wrong';
  if (pred === undefined || pred === null) return 'wrong';
  return equals(gold, pred) ? 'correct' : 'wrong';
}

export interface Tally {
  correct: number;
  total: number;
}

export const zeroTally = (): Tally => ({ correct: 0, total: 0 });

export function tally(t: Tally, outcome: FieldOutcome): Tally {
  if (outcome === 'unscored') return t;
  return { correct: t.correct + (outcome === 'correct' ? 1 : 0), total: t.total + 1 };
}

/** Share of scored cases that were right, or undefined when nothing was scored (shown as n/a, never gated). */
export function rate(t: Tally): number | undefined {
  return t.total === 0 ? undefined : t.correct / t.total;
}

// ---------- entity matching ----------

export interface OverlapMatch {
  pred: number;
  gold: number;
  overlap: number;
}

export interface MatchResult {
  matches: OverlapMatch[];
  unmatchedPreds: number[];
  unmatchedGolds: number[];
}

/**
 * One-to-one matching of predicted entities to gold entities by how many member ids they share
 * (for recurring detection: the transaction ids a detection claims vs. the ones labeled as that
 * subscription). Greedy by largest overlap, ties broken by index, so results are deterministic.
 * A pair needs at least one shared id; a second prediction for an already-matched gold entity is
 * left unmatched, which scores a split subscription as a false positive.
 */
export function matchByOverlap(preds: readonly (readonly string[])[], golds: readonly (readonly string[])[]): MatchResult {
  const goldSets = golds.map((g) => new Set(g));
  const candidates: OverlapMatch[] = [];
  preds.forEach((p, pi) => {
    goldSets.forEach((g, gi) => {
      const overlap = new Set(p.filter((id) => g.has(id))).size;
      if (overlap > 0) candidates.push({ pred: pi, gold: gi, overlap });
    });
  });
  candidates.sort((a, b) => b.overlap - a.overlap || a.pred - b.pred || a.gold - b.gold);

  const usedPreds = new Set<number>();
  const usedGolds = new Set<number>();
  const matches: OverlapMatch[] = [];
  for (const c of candidates) {
    if (usedPreds.has(c.pred) || usedGolds.has(c.gold)) continue;
    usedPreds.add(c.pred);
    usedGolds.add(c.gold);
    matches.push(c);
  }
  return {
    matches: matches.sort((a, b) => a.gold - b.gold),
    unmatchedPreds: preds.map((_, i) => i).filter((i) => !usedPreds.has(i)),
    unmatchedGolds: golds.map((_, i) => i).filter((i) => !usedGolds.has(i)),
  };
}

// ---------- baseline gate ----------

/** Flat, higher-is-better metrics keyed like "emails.field.chargeDate", plus a fingerprint per dataset. */
export interface MetricSnapshot {
  datasets: Record<string, string>;
  metrics: Record<string, number>;
}

export interface Baseline extends MetricSnapshot {
  /** Largest absolute drop (0..1) tolerated before the gate fails. */
  tolerance: number;
}

export interface MetricDelta {
  key: string;
  baseline: number;
  current: number;
  delta: number;
}

export interface GateResult {
  ok: boolean;
  regressions: MetricDelta[];
  improvements: MetricDelta[];
  /** Metrics in the baseline that this run didn't produce (renamed, or a task stopped reporting it). */
  missing: string[];
  /** Datasets whose cases changed since the baseline was recorded: the numbers aren't comparable. */
  changedDatasets: string[];
}

/**
 * Compares a run with the committed baseline. Any baseline metric that dropped by more than the
 * tolerance, went missing, or was measured on a changed dataset fails the gate: when cases are
 * added or relabeled the baseline has to be re-recorded in the same change, so a quietly harder
 * (or easier) dataset can't hide a regression.
 */
export function compareToBaseline(current: MetricSnapshot, baseline: Baseline, tolerance = baseline.tolerance): GateResult {
  const regressions: MetricDelta[] = [];
  const improvements: MetricDelta[] = [];
  const missing: string[] = [];
  for (const [key, base] of Object.entries(baseline.metrics)) {
    const now = current.metrics[key];
    if (now === undefined) {
      missing.push(key);
      continue;
    }
    const d: MetricDelta = { key, baseline: base, current: now, delta: round(now - base) };
    // Rounded comparison: the baseline is stored at 4 decimals, so float noise must not count as a drop.
    if (round(base - now) > tolerance) regressions.push(d);
    else if (round(now - base) > 0) improvements.push(d);
  }
  const changedDatasets = Object.entries(baseline.datasets)
    .filter(([name, fp]) => current.datasets[name] !== fp)
    .map(([name]) => name);
  return {
    ok: !regressions.length && !missing.length && !changedDatasets.length,
    regressions,
    improvements,
    missing,
    changedDatasets,
  };
}

export function round(n: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
