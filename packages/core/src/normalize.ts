import { MERCHANTS } from './merchants.ts';
import type { NormalizedMerchant, PaymentRail } from './types.ts';

const NOISE_TOKENS = new Set([
  'POS', 'DEBIT', 'CREDIT', 'PURCHASE', 'RECURRING', 'PAYMENT', 'CARD', 'ACH', 'ONLINE', 'WWW', 'COM',
  'CHECKCARD', 'VISA', 'MC', 'DDA', 'SQ', 'TST', 'INC', 'LLC', 'CO', 'CORP', 'SUBSCRIPTION', 'MEMBERSHIP', 'BILL',
]);

const STATE_CODES = new Set(
  'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '),
);

// Longest pattern first so "GOOGLE *YOUTUBE" beats "GOOGLE *PLAY"-style catch-alls.
const PATTERN_INDEX = MERCHANTS.flatMap((m) => m.patterns.map((p) => ({ pattern: p, merchant: m }))).sort(
  (a, b) => b.pattern.length - a.pattern.length,
);

function detectRail(upper: string): PaymentRail {
  if (/\bPAYPAL\b|^PP\*/.test(upper)) return 'paypal';
  if (/APPLE\.COM\/BILL|APPLE COM BILL|ITUNES\.COM/.test(upper)) return 'app_store';
  if (/GOOGLE \*?PLAY|GOOGLE PLAY/.test(upper)) return 'google_play';
  return 'card';
}

/** Strips rail prefixes, reference numbers, phone numbers and locations from a bank descriptor. */
export function cleanDescriptor(description: string): string {
  let s = description.toUpperCase();
  s = s.replace(/^(PAYPAL \*|PAYPAL\*|PP\*)/, '');
  s = s.replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, ' '); // phone numbers
  s = s.replace(/#\s?\d+/g, ' '); // store / reference numbers
  s = s.replace(/\b[A-Z]*\d[A-Z\d]{5,}\b/g, ' '); // long alphanumeric ids
  s = s.replace(/\b\d+\b/g, ' ');
  s = s.replace(/[^A-Z+&.\s/*]/g, ' ');
  s = s.replace(/[*/]/g, ' ');
  const tokens = s
    .split(/\s+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter((t) => t && !NOISE_TOKENS.has(t));
  // Drop a trailing state code (and the city before it is usually unrecoverable, so keep it simple).
  while (tokens.length > 1 && STATE_CODES.has(tokens[tokens.length - 1] ?? '')) tokens.pop();
  return tokens.join(' ').trim();
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .slice(0, 3)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * "NFLX*Netflix 866-579-7172 CA" -> Netflix. "PAYPAL *SPOTIFY" -> Spotify via PayPal.
 * "APPLE.COM/BILL 866-712-7753" -> App Store subscription (true merchant hidden by Apple).
 */
export function normalizeMerchant(description: string): NormalizedMerchant {
  const upper = description.toUpperCase();
  const rail = detectRail(upper);
  const stripped = upper.replace(/^(PAYPAL \*|PAYPAL\*|PP\*)/, '');

  for (const { pattern, merchant } of PATTERN_INDEX) {
    if (stripped.includes(pattern)) {
      return { merchantId: merchant.id, name: merchant.name, rail, key: merchant.id };
    }
  }

  const cleaned = cleanDescriptor(description);
  if (!cleaned) return { name: 'Unknown merchant', rail, key: `raw:${upper.trim()}` };
  const keyTokens = cleaned.split(' ').slice(0, 2).join(' ');
  return { name: titleCase(cleaned), rail, key: `raw:${keyTokens}` };
}
