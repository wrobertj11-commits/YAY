import { addDays, addMonths, toISODate } from './dates.ts';
import { localDate } from './tz.ts';
import { merchantsByEmailDomain, resolveMerchant } from './merchants.ts';
import { parseMoney } from './money.ts';
import type { Cadence, EmailMessage, EmailSignal, EmailSignalKind, ISODate } from './types.ts';

/**
 * Privacy principle: only emails whose sender or subject look like receipts, signups,
 * renewals or price notices are ever read. This is the same filter shown to users on the
 * "which emails we read" screen and the query sent to the Gmail / Outlook APIs.
 */
export const SUBJECT_PATTERNS: RegExp[] = [
  /free trial/i,
  /\btrial\b/i,
  /receipt/i,
  /subscription/i,
  /membership/i,
  /\brenew(al|s|ed|ing)?\b/i,
  /price (change|increase|update)/i,
  /(changes|update) to your (plan|price|subscription|membership)/i,
  /welcome to/i,
  /your (plan|order|payment|invoice)/i,
  /cancel(l)?ation|cancel(l)?ed/i,
  /\binvoice\b/i,
  /payment (confirmation|received)/i,
];

/** Plain-language version of SUBJECT_PATTERNS for the "which emails we read" screen. */
export const READABLE_SUBJECT_TERMS = [
  'free trial', 'trial', 'receipt', 'subscription', 'membership', 'renewal', 'price change or increase',
  'changes to your plan', 'welcome to…', 'your plan / order / payment / invoice', 'cancellation', 'payment confirmation',
];

export const RECEIPT_SENDER_PATTERN = /(billing|receipts?|invoice|payments?|noreply|no-reply|account|members?hip|subscriptions?)@/i;

/** Search query for Gmail (`q=`); mirrors SUBJECT_PATTERNS so we never list unrelated mail. */
export const GMAIL_QUERY =
  'newer_than:120d (subject:(trial OR receipt OR subscription OR membership OR renewal OR renews OR "price change" OR "price increase" OR "welcome to" OR invoice OR cancellation OR cancelled OR canceled))';

const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/**
 * The sender's bare address from a From header. Uses the angle-bracketed address at the end, so a
 * display name such as `"billing@netflix.com" <x@attacker.example>` can't pass for the real sender.
 */
export function senderAddressOf(from: string): string | undefined {
  const bracketed = from.match(/<([^<>]*)>\s*$/)?.[1];
  const candidate = (bracketed ?? from.trim().split(/\s+/).pop() ?? '').trim().toLowerCase();
  const at = candidate.lastIndexOf('@');
  if (at < 1 || !DOMAIN_RE.test(candidate.slice(at + 1))) return undefined;
  return candidate;
}

/** Lower-case domain of the sender's address, or undefined when the From header has no usable address. */
export function senderDomainOf(from: string): string | undefined {
  const address = senderAddressOf(from);
  return address?.slice(address.lastIndexOf('@') + 1);
}

export function isRelevantEmail(from: string, subject: string): boolean {
  if (SUBJECT_PATTERNS.some((p) => p.test(subject))) return true;
  return RECEIPT_SENDER_PATTERN.test(from) || merchantsByEmailDomain(from).length > 0;
}

// ---------- field parsers ----------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';

interface FoundDate {
  date: ISODate;
  index: number;
}

function makeDate(y: number, m: number, d: number): ISODate | undefined {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return undefined;
  if (m < 0 || m > 11 || d < 1 || d > 31) return undefined;
  const dt = new Date(Date.UTC(y, m, d));
  if (dt.getUTCMonth() !== m) return undefined;
  return toISODate(dt);
}

/** Finds calendar dates in text. Dates without a year resolve to the next occurrence after `reference`. */
export function findDates(text: string, reference: ISODate): FoundDate[] {
  const out: FoundDate[] = [];
  const refYear = Number(reference.slice(0, 4));
  const withYear = (m: number, d: number, y?: number): ISODate | undefined => {
    if (y !== undefined) return makeDate(y < 100 ? 2000 + y : y, m, d);
    const thisYear = makeDate(refYear, m, d);
    if (!thisYear) return undefined;
    // An unqualified date more than ~2 months in the past means next year.
    return thisYear < addDays(reference, -60) ? makeDate(refYear + 1, m, d) : thisYear;
  };

  // Missing groups become NaN / -1, which makeDate rejects.
  const num = (s: string | undefined) => (s === undefined ? NaN : Number(s));
  const month = (s: string | undefined) => (s === undefined ? -1 : MONTHS.indexOf(s.slice(0, 3).toLowerCase()));
  const patterns: [RegExp, (m: RegExpExecArray) => ISODate | undefined][] = [
    [/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => makeDate(num(m[1]), num(m[2]) - 1, num(m[3]))],
    [/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/g, (m) => withYear(num(m[1]) - 1, num(m[2]), num(m[3]))],
    [
      new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`, 'gi'),
      (m) => withYear(month(m[1]), num(m[2]), m[3] ? num(m[3]) : undefined),
    ],
    [
      new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}(?:,?\\s+(\\d{4}))?`, 'gi'),
      (m) => withYear(month(m[2]), num(m[1]), m[3] ? num(m[3]) : undefined),
    ],
  ];

  for (const [re, build] of patterns) {
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const date = build(m);
      if (date && !out.some((f) => f.index === m!.index)) out.push({ date, index: m.index });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

interface FoundPrice {
  cents: number;
  cadence?: Cadence;
  index: number;
}

const CADENCE_WORDS: [RegExp, Cadence][] = [
  [/^(\/|per |a |each |every )?\s*(week|wk)\b|^weekly/i, 'weekly'],
  [/^(\/|per |a |each |every )?\s*(month|mo)\b|^monthly/i, 'monthly'],
  [/^(\/|per |a |each |every )?\s*(quarter|3 months)\b|^quarterly/i, 'quarterly'],
  [/^(\/|per |a |each |every )?\s*(year|yr|annum)\b|^(annually|yearly)/i, 'annual'],
];

export function findPrices(text: string): FoundPrice[] {
  const out: FoundPrice[] = [];
  // The lookbehind makes the bare-number branch start only at the beginning of a digit run; without it the engine
  // retries from every digit of a long run, which is quadratic (a 100k-digit email body blocked the server ~5s).
  const re = /(?:US)?\$\s?(\d[\d,]*(?:\.\d{1,2})?)|(?<![\d,.])(\d[\d,]*\.\d{2})\s?(?:USD|dollars)/gi;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const cents = parseMoney(m[1] ?? m[2] ?? '');
    if (cents === undefined || cents === 0) continue;
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 20).trimStart().replace(/^(plus tax|\+ ?tax)\s*/i, '');
    const cadence = CADENCE_WORDS.find(([p]) => p.test(after))?.[1];
    out.push({ cents, cadence, index: m.index });
  }
  return out;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, fourteen: 14, thirty: 30, a: 1,
};

/** "7-day free trial", "free for 2 weeks", "one month free" -> days (months counted as 30 for display; dates use calendar months). */
export function findTrialLength(text: string): { days: number; months?: number } | undefined {
  const num = '(\\d{1,3}|one|two|three|four|five|six|seven|ten|fourteen|thirty|a)';
  const unit = '(day|week|month)s?';
  const patterns = [
    new RegExp(`${num}[\\s-]+${unit}[\\s-]+(?:free[\\s-]+)?trial`, 'i'),
    new RegExp(`free (?:for|trial of) ${num}[\\s-]+${unit}`, 'i'),
    new RegExp(`${num}[\\s-]+${unit}[\\s-]+(?:for )?free`, 'i'),
    new RegExp(`trial (?:lasts|period of|is|for) ${num}[\\s-]+${unit}`, 'i'),
  ];
  for (const p of patterns) {
    const m = text.match(p);
    const count = m?.[1];
    const u = m?.[2]?.toLowerCase();
    if (!count || !u) continue;
    const n = /^\d+$/.test(count) ? Number(count) : NUMBER_WORDS[count.toLowerCase()];
    if (!n) continue;
    if (u === 'month') return { days: n * 30, months: n };
    return { days: u === 'week' ? n * 7 : n };
  }
  return undefined;
}

const CHARGE_TRIGGERS =
  /(trial (?:ends|will end|expires|is over)|(?:will|we'll) (?:be )?(?:charge|bill)|(?:first|next) (?:charge|payment|billing date|bill)|renews?(?: on)?|auto-?renew|billed on|charged on|starting|effective|beginning|until)/gi;

function dateNearTrigger(text: string, dates: FoundDate[], after: ISODate): ISODate | undefined {
  const future = dates.filter((d) => d.date >= after);
  if (!future.length) return undefined;
  let best: { date: ISODate; distance: number } | undefined;
  for (let m = CHARGE_TRIGGERS.exec(text); m; m = CHARGE_TRIGGERS.exec(text)) {
    for (const d of future) {
      const distance = d.index - (m.index + m[0].length);
      if (distance >= -40 && distance <= 140 && (!best || Math.abs(distance) < best.distance)) {
        best = { date: d.date, distance: Math.abs(distance) };
      }
    }
  }
  CHARGE_TRIGGERS.lastIndex = 0;
  return best?.date ?? (future.length === 1 ? future[0]?.date : undefined);
}

function displayName(from: string): string | undefined {
  const m = from.match(/^\s*"?([^"<]+?)"?\s*</);
  const name = m?.[1]?.trim();
  if (!name || /^(no-?reply|billing|team|support|info)$/i.test(name)) return undefined;
  return name.replace(/\s+(team|billing|support)$/i, '');
}

function classify(subject: string, body: string): EmailSignalKind | undefined {
  const text = `${subject}\n${body}`;
  if (/(subscription|membership|plan|trial)[^.\n]{0,40}(has been|is now|was|is) cancel(l)?ed|cancel(l)?ation (is )?confirm|you('ve| have) cancel(l)?ed/i.test(text)) {
    return 'cancellation_confirmation';
  }
  if (/price (change|increase|update)|new (monthly )?price|(price|rate) (is|will be) (going up|increasing|changing)|(changes|update) to your (plan|price)/i.test(text)) {
    return 'price_increase';
  }
  if (/free trial|trial (period|ends|will end|has started|starts)|start(ed)? your trial|your trial/i.test(text)) return 'trial_signup';
  if (/receipt|invoice|payment (received|confirmation|successful)|(you('ve| have) been|we('ve| have)) (charged|billed)|thanks for (your payment|subscribing)|renew|subscription|membership/i.test(text)) {
    return 'receipt';
  }
  return undefined;
}

/**
 * Rules-first extraction (detection pipeline step 3). Returns undefined when the email is not a
 * subscription email. Low-confidence results are candidates for the LLM extraction step.
 */
export function extractEmailSignal(email: EmailMessage, opts: { timeZone?: string } = {}): EmailSignal | undefined {
  // The user's calendar date when the mail arrived: providers stamp UTC, and "7-day trial" counts from the
  // user's own day (an evening sign-up in Los Angeles is already tomorrow in UTC).
  const receivedAt = receivedDate(email.date, opts.timeZone);
  const text = `${email.subject}\n${email.body}`.replace(/\s+/g, ' ');
  const kind = classify(email.subject, email.body);
  if (!kind) return undefined;

  // Attribute by the real address, not the display name (which the sender chooses freely).
  const sender = senderAddressOf(email.from);
  const merchant =
    resolveMerchant(sender, email.subject, email.body.slice(0, 400));
  const subjectName = email.subject.match(/welcome to ([A-Z][\w+&' ]{1,30}?)(?:[!.,:]|$| -)/i)?.[1]?.trim();
  // Without a catalog match the name comes from text the sender controls: keep it only if it is plainly a name.
  const serviceName = merchant?.name ?? safeServiceName(subjectName) ?? safeServiceName(displayName(email.from)) ?? 'Unknown service';

  const prices = findPrices(text);
  const dates = findDates(text, receivedAt);
  let confidence = merchant ? 0.5 : 0.3;
  const signal: EmailSignal = {
    kind,
    emailId: email.id,
    merchantId: merchant?.id,
    serviceName,
    receivedAt,
    confidence,
    extractedBy: 'rules',
    senderDomain: senderDomainOf(email.from),
  };

  if (kind === 'trial_signup') {
    const trial = findTrialLength(text);
    const afterTrial = prices.find((p) => p.cadence) ?? prices[0];
    signal.trialDays = trial?.days;
    signal.priceCents = afterTrial?.cents;
    signal.cadence = afterTrial?.cadence ?? 'monthly';
    signal.chargeDate =
      dateNearTrigger(text, dates, receivedAt) ??
      (trial ? (trial.months ? addMonths(receivedAt, trial.months) : addDays(receivedAt, trial.days)) : undefined);
    if (signal.chargeDate) confidence += 0.25;
    if (signal.priceCents) confidence += 0.15;
    if (trial) confidence += 0.05;
  } else if (kind === 'price_increase') {
    const fromTo = text.match(/from \$\s?(\d[\d,]*(?:\.\d{1,2})?)[^$]{0,40}?to \$\s?(\d[\d,]*(?:\.\d{1,2})?)/i);
    if (fromTo?.[1] && fromTo[2]) {
      signal.oldPriceCents = parseMoney(fromTo[1]);
      signal.priceCents = parseMoney(fromTo[2]);
    } else if (prices.length >= 2) {
      const sorted = [...prices].sort((a, b) => a.cents - b.cents);
      signal.oldPriceCents = sorted[0]?.cents;
      signal.priceCents = sorted[sorted.length - 1]?.cents;
    } else {
      signal.priceCents = prices[0]?.cents;
    }
    signal.cadence = prices.find((p) => p.cadence)?.cadence ?? 'monthly';
    signal.effectiveDate = dateNearTrigger(text, dates, receivedAt);
    if (signal.priceCents) confidence += 0.25;
    if (signal.oldPriceCents) confidence += 0.1;
    if (signal.effectiveDate) confidence += 0.1;
  } else if (kind === 'receipt') {
    const price = prices.find((p) => p.cadence) ?? prices[0];
    signal.priceCents = price?.cents;
    signal.cadence = price?.cadence;
    signal.chargeDate = dateNearTrigger(text, dates, addDays(receivedAt, 1));
    if (signal.priceCents) confidence += 0.2;
    if (signal.cadence) confidence += 0.1;
    if (signal.chargeDate) confidence += 0.1;
  } else {
    confidence += 0.3;
  }

  // A name only the sender vouches for (no catalog match) can't make an item count as found on its own.
  const cap = merchant ? 0.95 : UNMATCHED_MAX_CONFIDENCE;
  signal.confidence = Math.round(Math.min(cap, confidence) * 100) / 100;
  return signal;
}

const MAX_SERVICE_NAME = 60;
/** Below the needs-review threshold (0.6): the user confirms an unknown sender's "trial" before it counts. */
export const UNMATCHED_MAX_CONFIDENCE = 0.55;
/** Control characters, zero-width characters and bidi overrides: invisible text that can disguise a name. */
const INVISIBLE_RE = /[\p{Cc}\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/u;
/** Links, addresses and markup: in an alert or email these become clickable or render. */
const LINKISH_RE = /:\/\/|\bwww\.|@|[<>]|[a-z0-9-]\.[a-z]{2,}(?![a-z0-9-])/i;
/** Seven or more digits, however punctuated: a phone number ("call 1-888-…") has no place in a service name. */
const PHONEISH_RE = /(?:\d[\s().-]*){7,}/;

/**
 * A service name taken from email text (display name, subject, model output) is attacker-controlled and ends up
 * in alert titles. Accept short plain names only; anything carrying links, phone numbers or invisible characters
 * is dropped so the caller falls back to a neutral name.
 */
export function safeServiceName(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const name = v.trim().replace(/ {2,}/g, ' ');
  if (!name || name.length > MAX_SERVICE_NAME || INVISIBLE_RE.test(name) || LINKISH_RE.test(name) || PHONEISH_RE.test(name)) return undefined;
  return name;
}

/** Calendar date of a received timestamp in the user's zone (UTC when no zone is given, as stored). */
export function receivedDate(isoTimestamp: string, timeZone?: string): ISODate {
  const at = new Date(isoTimestamp);
  if (!timeZone || Number.isNaN(at.getTime())) return isoTimestamp.slice(0, 10);
  try {
    return localDate(at, timeZone);
  } catch {
    return isoTimestamp.slice(0, 10);
  }
}

/** Extraction is "complete enough" when the fields the alert depends on are present. */
export function needsLlmExtraction(signal: EmailSignal | undefined): boolean {
  if (!signal) return true;
  if (signal.kind === 'trial_signup') return !signal.chargeDate || !signal.priceCents || !signal.merchantId;
  if (signal.kind === 'price_increase') return !signal.priceCents;
  return signal.confidence < 0.6;
}
