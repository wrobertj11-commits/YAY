import { z } from 'zod';

/**
 * Labeled-case shapes for every eval task. They are zod schemas (not just types) because the same
 * shapes are loaded from JSON sample files (fixtures/samples/*.json, or --samples <dir>) that people
 * write by hand; a typo in a label must fail loudly instead of silently scoring as "unlabeled".
 */

const isoDate = z.iso.date();
const cents = z.number().int().positive();
const cadence = z.enum(['weekly', 'monthly', 'quarterly', 'annual']);
const tags = z.array(z.string().min(1)).default([]);

/** Gold labels accept `null` to mean "must be absent" (see scoreField in metrics.ts). */
const nullable = <T extends z.ZodType>(t: T) => t.nullable().optional();

// ---------- recurring-charge detection ----------

export const LabeledTransaction = z.strictObject({
  id: z.string().min(1),
  date: isoDate,
  /** Positive for a debit, negative for a refund or credit (same convention as core's Transaction). */
  amountCents: z.number().int(),
  description: z.string().min(1),
  paymentMethod: z.string().default('Visa ••4242'),
  accountId: z.string().default('acct-1'),
  /** Which expected subscription this charge belongs to (`ExpectedRecurring.sub`). Unset for noise. */
  sub: z.string().optional(),
});
export type LabeledTransaction = z.infer<typeof LabeledTransaction>;

export const ExpectedRecurring = z.strictObject({
  /** Matches `LabeledTransaction.sub` on the charges that make up this subscription. */
  sub: z.string().min(1),
  /** Catalog merchant id (packages/core/src/merchants.ts). Use `name` instead for merchants outside the catalog. */
  merchantId: z.string().optional(),
  /** For non-catalog merchants: a word or phrase the detected name must contain (case and punctuation ignored). */
  name: z.string().optional(),
  /** Unset when the true cadence has no enum value (every 2 weeks, every 6 months). */
  cadence: cadence.optional(),
  /** The current price: the latest charge, after any price change. */
  amountCents: cents.optional(),
  nextChargeDate: isoDate.optional(),
});
export type ExpectedRecurring = z.infer<typeof ExpectedRecurring>;

export const RecurringCase = z.strictObject({
  id: z.string().min(1),
  note: z.string(),
  tags,
  today: isoDate,
  transactions: z.array(LabeledTransaction).min(1),
  /** Every live subscription in these transactions. Empty for a negative case (nothing should be detected). */
  expected: z.array(ExpectedRecurring),
});
export type RecurringCase = z.infer<typeof RecurringCase>;

// ---------- email extraction ----------

export const EMAIL_KINDS = ['trial_signup', 'receipt', 'price_increase', 'cancellation_confirmation', 'none'] as const;
export type EmailKindLabel = (typeof EMAIL_KINDS)[number];

export const EmailInput = z.strictObject({
  id: z.string().min(1),
  from: z.string().min(1),
  subject: z.string(),
  /** ISO timestamp the email was received. Dates without a year are resolved against it. */
  date: z.iso.datetime({ offset: true }),
  body: z.string(),
});

export const EmailGold = z.strictObject({
  kind: z.enum(EMAIL_KINDS),
  /** Catalog merchant id, or null when the service is not in the catalog (then label `serviceName`). */
  merchantId: nullable(z.string()),
  serviceName: z.string().optional(),
  /** USD cents per billing period (after the trial; the new price for a price increase). null when the price isn't in USD. */
  priceCents: nullable(cents),
  oldPriceCents: nullable(cents),
  cadence: nullable(cadence),
  trialDays: nullable(z.number().int().positive()),
  /** Trial conversion date, or the next renewal date stated in a receipt. */
  chargeDate: nullable(isoDate),
  effectiveDate: nullable(isoDate),
});
export type EmailGold = z.infer<typeof EmailGold>;

export const EmailCase = z.strictObject({
  id: z.string().min(1),
  note: z.string(),
  tags,
  email: EmailInput,
  gold: EmailGold,
});
export type EmailCase = z.infer<typeof EmailCase>;

// ---------- end-to-end reconcile ----------

const ITEM_STATUSES = ['active', 'trial', 'cancel_pending', 'cancel_verified', 'charged_after_cancel', 'dismissed'] as const;
const SOURCES = ['bank', 'email', 'forwarded', 'manual', 'app_store', 'google_play'] as const;

export const ExpectedItem = z.strictObject({
  /** Identify the item by catalog id, or by a phrase its name must contain. */
  merchantId: z.string().optional(),
  name: z.string().optional(),
  status: z.enum(ITEM_STATUSES),
  kind: z.enum(['subscription', 'trial']).optional(),
  amountCents: cents.optional(),
  cadence: cadence.optional(),
  nextChargeDate: isoDate.optional(),
  /** Exact set of sources, order ignored. */
  sources: z.array(z.enum(SOURCES)).optional(),
  /** A price change the item should be carrying. */
  priceChange: z.strictObject({ oldCents: cents, newCents: cents }).optional(),
});
export type ExpectedItem = z.infer<typeof ExpectedItem>;

export const ScenarioStep = z.strictObject({
  today: isoDate,
  emails: z.array(EmailInput).default([]),
  transactions: z.array(LabeledTransaction).default([]),
  /** Simulates the user tapping "I cancelled" on the item with this merchant id or name. */
  userCancels: z.string().optional(),
  /** Checked after this step. `itemCount` counts items that aren't dismissed. */
  expect: z.strictObject({ itemCount: z.number().int().nonnegative().optional(), items: z.array(ExpectedItem).default([]) }).optional(),
});
export type ScenarioStep = z.infer<typeof ScenarioStep>;

export const Scenario = z.strictObject({
  id: z.string().min(1),
  note: z.string(),
  tags,
  steps: z.array(ScenarioStep).min(1),
});
export type Scenario = z.infer<typeof Scenario>;

// ---------- sample files ----------

/** A JSON sample file may hold any mix of the three case types. */
export const SampleFile = z.strictObject({
  $comment: z.string().optional(),
  recurring: z.array(RecurringCase).default([]),
  emails: z.array(EmailCase).default([]),
  scenarios: z.array(Scenario).default([]),
});
export type SampleFile = z.infer<typeof SampleFile>;

/** What a fixture author writes: defaults (payment method, tags, empty lists) may be left out. */
export type RecurringCaseInput = z.input<typeof RecurringCase>;
export type LabeledTransactionInput = z.input<typeof LabeledTransaction>;
export type EmailCaseInput = z.input<typeof EmailCase>;
export type EmailInput = z.input<typeof EmailInput>;
export type ScenarioInput = z.input<typeof Scenario>;
