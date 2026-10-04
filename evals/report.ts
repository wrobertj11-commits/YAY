import { createHash } from 'node:crypto';
import { formatCents } from '../packages/core/src/index.ts';
import { rate, round, type GateResult, type MetricSnapshot, type Tally } from './metrics.ts';
import type { Dataset } from './dataset.ts';
import type { E2EResult } from './tasks/e2e.ts';
import { EMAIL_FIELDS, type EmailResult } from './tasks/emails.ts';
import { RECURRING_FIELDS, type RecurringResult } from './tasks/recurring.ts';
import { EMAIL_KINDS } from './types.ts';

/**
 * Turning results into the three outputs of a run: the flat metric snapshot the baseline gate
 * compares, compact text tables for the terminal, and (via run.ts) the JSON report.
 */

// ---------- snapshot ----------

/** JSON with object keys sorted, so the hash doesn't depend on the order a parser happens to emit keys in. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
  );
}

/** Short content hash: changes whenever a case, label or default changes. */
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 16);
}

export function datasetFingerprints(ds: Dataset): Record<string, string> {
  return { recurring: fingerprint(ds.recurring), emails: fingerprint(ds.emails), e2e: fingerprint(ds.scenarios) };
}

type Flat = Record<string, number>;

/** Adds `value` under `key` rounded to 4 decimals; unscored (undefined) metrics are left out, never gated. */
function put(out: Flat, key: string, value: number | undefined): void {
  if (value !== undefined) out[key] = round(value);
}

export function recurringMetrics(r: RecurringResult): Flat {
  const out: Flat = {};
  put(out, 'recurring.precision', r.prf.precision);
  put(out, 'recurring.recall', r.prf.recall);
  put(out, 'recurring.f1', r.prf.f1);
  for (const f of RECURRING_FIELDS) put(out, `recurring.field.${f}`, rate(r.fields[f]));
  put(out, 'recurring.negativePass', rate(r.negativePass));
  put(out, 'recurring.casePass', rate(r.casePass));
  return out;
}

export function emailMetrics(e: EmailResult, prefix = 'emails'): Flat {
  const out: Flat = {};
  put(out, `${prefix}.kind.accuracy`, e.kindAccuracy);
  put(out, `${prefix}.kind.macroF1`, e.kindMacroF1);
  put(out, `${prefix}.trial.precision`, e.trial.precision);
  put(out, `${prefix}.trial.recall`, e.trial.recall);
  put(out, `${prefix}.trial.f1`, e.trial.f1);
  put(out, `${prefix}.detect.precision`, e.detect.precision);
  put(out, `${prefix}.detect.recall`, e.detect.recall);
  put(out, `${prefix}.detect.f1`, e.detect.f1);
  for (const f of EMAIL_FIELDS) put(out, `${prefix}.field.${f}`, rate(e.fields[f]));
  put(out, `${prefix}.gate.recall`, rate(e.gate));
  put(out, `${prefix}.casePass`, rate(e.casePass));
  return out;
}

export function e2eMetrics(r: E2EResult): Flat {
  const out: Flat = {};
  put(out, 'e2e.scenarioPass', rate(r.scenarioPass));
  put(out, 'e2e.checkPass', rate(r.checks));
  return out;
}

export function snapshotOf(ds: Dataset, r: { recurring: RecurringResult; emails: EmailResult; e2e: E2EResult }): MetricSnapshot {
  return {
    datasets: datasetFingerprints(ds),
    metrics: { ...recurringMetrics(r.recurring), ...emailMetrics(r.emails), ...e2eMetrics(r.e2e) },
  };
}

// ---------- text ----------

const num = (v: number | undefined) => (v === undefined ? 'n/a' : v.toFixed(3));
const frac = (t: Tally) => `${t.correct}/${t.total}`;

const NUMERIC_CELL = /^([-+<]?\$?[\d.,/]+|n\/a)$/;

/** Columns whose cells are all numbers (or n/a) are right-aligned, the rest left-aligned; widths fit the content. */
export function table(headers: readonly string[], rows: readonly (readonly string[])[], indent = '  '): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const numeric = headers.map((_, i) => i > 0 && rows.every((r) => !r[i] || NUMERIC_CELL.test(r[i] ?? '')));
  const line = (cells: readonly string[]) =>
    indent +
    cells
      .map((c, i) => (numeric[i] ? c.padStart(widths[i] ?? 0) : c.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}

/** "tag 3/4, tag 1/2, ..." wrapped to the terminal-friendly width under a label. */
function tagLines(label: string, byTag: Record<string, Tally>, width = 110): string[] {
  const parts = Object.entries(byTag)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tag, t]) => `${tag} ${frac(t)}`);
  const lines: string[] = [];
  let current = `  ${label}:`;
  for (const p of parts) {
    if (current.length + p.length + 2 > width) {
      lines.push(`${current},`);
      current = `    ${p}`;
    } else {
      current = current.endsWith(':') ? `${current} ${p}` : `${current}, ${p}`;
    }
  }
  lines.push(current);
  return lines;
}

function listFailures(items: readonly { id: string; detail: string }[], limit: number): string[] {
  if (!items.length) return ['    none'];
  const width = Math.min(34, Math.max(...items.map((f) => f.id.length)));
  const shown = items.slice(0, limit).map((f) => `    ${f.id.padEnd(width)}  ${f.detail}`);
  if (items.length > limit) shown.push(`    ... and ${items.length - limit} more (see the JSON report)`);
  return shown;
}

export interface PrintOptions {
  /** Max failure lines per task; 0 hides them. */
  failureLimit: number;
}

export function formatRecurring(r: RecurringResult, opts: PrintOptions): string {
  const rows: string[][] = [
    ['precision', num(r.prf.precision), `tp ${r.counts.tp}, fp ${r.counts.fp}`],
    ['recall', num(r.prf.recall), `fn ${r.counts.fn}`],
    ['f1', num(r.prf.f1), ''],
    ...RECURRING_FIELDS.map((f) => [`field: ${f}`, num(rate(r.fields[f])), frac(r.fields[f])]),
    ['negative series left alone', num(rate(r.negativePass)), frac(r.negativePass)],
    ['series fully right', num(rate(r.casePass)), frac(r.casePass)],
  ];
  const lines = [
    `Recurring-charge detection: ${r.cases} series, ${r.subscriptions} labeled subscriptions, ${r.negativeCases} negative series`,
    table(['metric', 'value', 'detail'], rows),
    ...tagLines('by tag (series fully right)', r.byTag),
  ];
  if (opts.failureLimit > 0) {
    lines.push(`  misses, false positives and wrong fields (${r.failures.length}):`);
    lines.push(...listFailures(r.failures.map((f) => ({ id: f.caseId, detail: f.detail })), opts.failureLimit));
  }
  return lines.join('\n');
}

const KIND_SHORT: Record<string, string> = {
  trial_signup: 'trial',
  receipt: 'receipt',
  price_increase: 'price',
  cancellation_confirmation: 'cancel',
  none: 'none',
};

export function formatEmails(e: EmailResult, opts: PrintOptions): string {
  const rows: string[][] = [
    ['kind accuracy', num(e.kindAccuracy), ''],
    ['kind macro-F1', num(e.kindMacroF1), ''],
    ['trial precision', num(e.trial.precision), `tp ${e.trial.tp}, fp ${e.trial.fp}`],
    ['trial recall', num(e.trial.recall), `fn ${e.trial.fn}`],
    ['trial f1', num(e.trial.f1), ''],
    ['subscription-email f1', num(e.detect.f1), `p ${num(e.detect.precision)}, r ${num(e.detect.recall)}`],
    ...EMAIL_FIELDS.map((f) => [`field: ${f}`, num(rate(e.fields[f])), frac(e.fields[f])]),
    ['relevance filter recall', num(rate(e.gate)), frac(e.gate)],
    ['emails fully right', num(rate(e.casePass)), frac(e.casePass)],
  ];
  const matrix = EMAIL_KINDS.map((g) => [g, ...EMAIL_KINDS.map((p) => String(e.confusion[g][p]))]);
  const lines = [
    `Email extraction: ${e.cases} emails`,
    table(['metric', 'value', 'detail'], rows),
    '  confusion (rows: labeled kind, columns: predicted kind)',
    table(['', ...EMAIL_KINDS.map((k) => KIND_SHORT[k] ?? k)], matrix, '    '),
    ...tagLines('by tag (emails fully right)', e.byTag),
  ];
  if (opts.failureLimit > 0) {
    lines.push(`  wrong kinds and fields (${e.failures.length}):`);
    lines.push(...listFailures(e.failures.map((f) => ({ id: f.caseId, detail: f.detail })), opts.failureLimit));
  }
  return lines.join('\n');
}

export function formatE2E(r: E2EResult, opts: PrintOptions): string {
  const rows: string[][] = [
    ['scenarios fully right', num(rate(r.scenarioPass)), frac(r.scenarioPass)],
    ['checks passed', num(rate(r.checks)), frac(r.checks)],
    ['steps with duplicate items', String(r.duplicateSteps), ''],
  ];
  const lines = [`End-to-end reconcile: ${r.scenarios} scenarios`, table(['metric', 'value', 'detail'], rows), ...tagLines('by tag', r.byTag)];
  if (opts.failureLimit > 0) {
    const failed = r.results.filter((c) => !c.pass);
    lines.push(`  failed checks (${failed.length}):`);
    lines.push(
      ...listFailures(
        failed.map((c) => ({ id: `${c.scenarioId}#${c.step}`, detail: `${c.check}: expected ${c.expected}, got ${c.actual}` })),
        opts.failureLimit,
      ),
    );
  }
  return lines.join('\n');
}

export function formatGate(g: GateResult, tolerance: number): string {
  const lines: string[] = [];
  if (g.changedDatasets.length) {
    lines.push(`  dataset changed since the baseline: ${g.changedDatasets.join(', ')}`);
    lines.push('  Cases were added or relabeled. Re-record with `npm run eval -- --update-baseline` and commit evals/baseline.json with them.');
  }
  for (const m of g.missing) lines.push(`  missing metric: ${m} (in the baseline, not produced by this run)`);
  if (g.regressions.length) {
    lines.push(`  regressions (dropped more than ${tolerance}):`);
    lines.push(table(['metric', 'baseline', 'now', 'delta'], g.regressions.map((d) => [d.key, num(d.baseline), num(d.current), d.delta.toFixed(3)]), '    '));
  }
  if (g.improvements.length) {
    lines.push('  improvements (record them with --update-baseline so they are protected):');
    lines.push(table(['metric', 'baseline', 'now', 'delta'], g.improvements.map((d) => [d.key, num(d.baseline), num(d.current), `+${d.delta.toFixed(3)}`]), '    '));
  }
  lines.unshift(g.ok ? `Baseline gate: pass (tolerance ${tolerance})` : `Baseline gate: FAIL (tolerance ${tolerance})`);
  return lines.join('\n');
}

export const usd = (dollars: number | undefined) => (dollars === undefined ? 'unknown' : dollars < 0.01 ? `<${formatCents(1)}` : `$${dollars.toFixed(2)}`);
