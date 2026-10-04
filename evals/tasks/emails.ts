import { extractEmailSignal, isRelevantEmail, type EmailMessage, type EmailSignal } from '../../packages/core/src/index.ts';
import {
  accuracy,
  binaryCounts,
  classCounts,
  confusion,
  macroF1,
  prf,
  scoreField,
  tally,
  zeroTally,
  type Confusion,
  type Counts,
  type FieldOutcome,
  type PRF,
  type Tally,
} from '../metrics.ts';
import { EMAIL_KINDS, type EmailCase, type EmailGold, type EmailKindLabel } from '../types.ts';

/** Turns one email into a signal (or nothing). Sync for the rules, async for anything calling a model. */
export type Extractor = (email: EmailMessage) => EmailSignal | undefined | Promise<EmailSignal | undefined>;

/**
 * The rules path exactly as the API runs it (pipeline.ts): emails that fail the relevance filter are
 * never read, so they can't produce a signal however good the extractor is.
 */
export function rulesExtract(email: EmailMessage): EmailSignal | undefined {
  return isRelevantEmail(email.from, email.subject) ? extractEmailSignal(email) : undefined;
}

export const rulesExtractor: Extractor = rulesExtract;

export const EMAIL_FIELDS = ['merchant', 'priceCents', 'oldPriceCents', 'cadence', 'trialDays', 'chargeDate', 'effectiveDate'] as const;
export type EmailField = (typeof EMAIL_FIELDS)[number];

export interface EmailFailure {
  caseId: string;
  detail: string;
}

/** What one extractor produced for one case, without the email text (safe to write to the report). */
export interface EmailPrediction {
  caseId: string;
  gold: EmailKindLabel;
  kind: EmailKindLabel;
  merchantId?: string;
  serviceName?: string;
  priceCents?: number;
  oldPriceCents?: number;
  cadence?: string;
  trialDays?: number;
  chargeDate?: string;
  effectiveDate?: string;
  extractedBy?: string;
}

export interface EmailResult {
  cases: number;
  confusion: Confusion<EmailKindLabel>;
  kindAccuracy: number;
  /** Mean F1 over the five kinds (including "none"). */
  kindMacroF1: number;
  perKind: Record<EmailKindLabel, PRF & { support: number }>;
  /** One-vs-rest for trial_signup: the signal Trialguard's alerts depend on most. */
  trial: PRF & Counts;
  /** "Is this a subscription email at all?" (any kind other than none). */
  detect: PRF & Counts;
  /** End-to-end: a labeled field counts as wrong when the email produced no signal. */
  fields: Record<EmailField, Tally>;
  /** Subscription emails that pass the relevance filter (the rest are never read). */
  gate: Tally;
  /** Cases where the kind and every labeled field are right. */
  casePass: Tally;
  byTag: Record<string, Tally>;
  failures: EmailFailure[];
  predictions: EmailPrediction[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Catalog merchants by id; merchants outside the catalog by name, with no catalog id claimed. */
function merchantOutcome(gold: EmailGold, s: EmailSignal | undefined): FieldOutcome {
  if (gold.merchantId === undefined) return 'unscored';
  if (gold.merchantId !== null) return scoreField(gold.merchantId, s?.merchantId);
  if (!s) return 'wrong';
  return !s.merchantId && norm(s.serviceName).includes(norm(gold.serviceName ?? '')) ? 'correct' : 'wrong';
}

function fieldOutcomes(gold: EmailGold, s: EmailSignal | undefined): [EmailField, FieldOutcome, unknown, unknown][] {
  const merchantWant = gold.merchantId === null ? `"${gold.serviceName}" (not in catalog)` : gold.merchantId;
  const merchantGot = s ? (s.merchantId ?? `"${s.serviceName}"`) : undefined;
  return [
    ['merchant', merchantOutcome(gold, s), merchantWant, merchantGot],
    ['priceCents', scoreField(gold.priceCents, s?.priceCents), gold.priceCents, s?.priceCents],
    ['oldPriceCents', scoreField(gold.oldPriceCents, s?.oldPriceCents), gold.oldPriceCents, s?.oldPriceCents],
    ['cadence', scoreField(gold.cadence, s?.cadence), gold.cadence, s?.cadence],
    ['trialDays', scoreField(gold.trialDays, s?.trialDays), gold.trialDays, s?.trialDays],
    ['chargeDate', scoreField(gold.chargeDate, s?.chargeDate), gold.chargeDate, s?.chargeDate],
    ['effectiveDate', scoreField(gold.effectiveDate, s?.effectiveDate), gold.effectiveDate, s?.effectiveDate],
  ];
}

const show = (v: unknown) => (v === undefined || v === null ? 'nothing' : String(v));

export function toEmailMessage(c: EmailCase): EmailMessage {
  return { ...c.email };
}

/** Scores precomputed signals (one per case, same order). Split from evaluateEmails so the LLM run can reuse results. */
export function scoreEmails(cases: readonly EmailCase[], signals: readonly (EmailSignal | undefined)[]): EmailResult {
  const pairs: [EmailKindLabel, EmailKindLabel][] = [];
  const fields = Object.fromEntries(EMAIL_FIELDS.map((f) => [f, zeroTally()])) as Record<EmailField, Tally>;
  let gate = zeroTally();
  let casePass = zeroTally();
  const byTag: Record<string, Tally> = {};
  const failures: EmailFailure[] = [];
  const predictions: EmailPrediction[] = [];

  cases.forEach((c, i) => {
    const s = signals[i];
    const kind: EmailKindLabel = s?.kind ?? 'none';
    pairs.push([c.gold.kind, kind]);
    const caseFailures: EmailFailure[] = [];
    if (kind !== c.gold.kind) caseFailures.push({ caseId: c.id, detail: `kind: expected ${c.gold.kind}, got ${kind}` });
    if (c.gold.kind !== 'none') {
      gate = tally(gate, isRelevantEmail(c.email.from, c.email.subject) ? 'correct' : 'wrong');
      for (const [field, outcome, want, got] of fieldOutcomes(c.gold, s)) {
        fields[field] = tally(fields[field], outcome);
        if (outcome === 'wrong') caseFailures.push({ caseId: c.id, detail: `${field}: expected ${show(want)}, got ${show(got)}` });
      }
    }
    const pass = caseFailures.length ? 'wrong' : 'correct';
    casePass = tally(casePass, pass);
    for (const tag of c.tags) byTag[tag] = tally(byTag[tag] ?? zeroTally(), pass);
    failures.push(...caseFailures);
    predictions.push({
      caseId: c.id,
      gold: c.gold.kind,
      kind,
      merchantId: s?.merchantId,
      serviceName: s?.serviceName,
      priceCents: s?.priceCents,
      oldPriceCents: s?.oldPriceCents,
      cadence: s?.cadence,
      trialDays: s?.trialDays,
      chargeDate: s?.chargeDate,
      effectiveDate: s?.effectiveDate,
      extractedBy: s?.extractedBy,
    });
  });

  const m = confusion(EMAIL_KINDS, pairs);
  const perKind = Object.fromEntries(
    EMAIL_KINDS.map((k) => {
      const cc = classCounts(m, k);
      return [k, { ...prf(cc), support: cc.tp + cc.fn }];
    }),
  ) as Record<EmailKindLabel, PRF & { support: number }>;
  const trialCounts = classCounts(m, 'trial_signup');
  const detectCounts = binaryCounts(m, (k) => k !== 'none');
  return {
    cases: cases.length,
    confusion: m,
    kindAccuracy: accuracy(m),
    kindMacroF1: macroF1(m, EMAIL_KINDS),
    perKind,
    trial: { ...prf(trialCounts), ...trialCounts },
    detect: { ...prf(detectCounts), ...detectCounts },
    fields,
    gate,
    casePass,
    byTag,
    failures,
    predictions,
  };
}

export async function evaluateEmails(cases: readonly EmailCase[], extract: Extractor = rulesExtractor): Promise<EmailResult> {
  const signals: (EmailSignal | undefined)[] = [];
  for (const c of cases) signals.push(await extract(toEmailMessage(c)));
  return scoreEmails(cases, signals);
}
