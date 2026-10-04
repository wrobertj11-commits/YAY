import type { EmailInput, ScenarioInput } from '../types.ts';
import { charges, monthly } from './build.ts';
import { EMAIL_CASES } from './emails.ts';

/**
 * End-to-end scenarios: emails and bank charges arrive over several syncs and must reconcile into
 * one item per subscription with the right lifecycle state. Each step runs the same path as the API's
 * sync (relevance filter, rules extraction, detectRecurring, reconcile) and checks the items after it.
 *
 * Emails are taken from the labeled email set by case id, so each email is written (and labeled) once.
 */

function email(caseId: string): EmailInput {
  const found = EMAIL_CASES.find((c) => c.id === caseId);
  if (!found) throw new Error(`scenario fixture: no email case "${caseId}"`);
  return found.email;
}

export const SCENARIOS: ScenarioInput[] = [
  {
    id: 'max-trial-then-charge',
    note: 'Trial email, then the first charge from a catalog merchant: one item that converts to active.',
    tags: ['trial-conversion', 'catalog'],
    steps: [
      {
        today: '2026-09-20',
        emails: [email('trial-max-words')],
        expect: { itemCount: 1, items: [{ merchantId: 'max', status: 'trial', kind: 'trial', amountCents: 1699, nextChargeDate: '2026-09-27', sources: ['email'] }] },
      },
      {
        today: '2026-09-30',
        transactions: charges('WBD MAX 800-555-0120', 1699, ['2026-09-27'], { sub: 'max' }),
        expect: {
          itemCount: 1,
          items: [{ merchantId: 'max', status: 'active', kind: 'subscription', amountCents: 1699, cadence: 'monthly', nextChargeDate: '2026-10-27', sources: ['email', 'bank'] }],
        },
      },
    ],
  },
  {
    id: 'spotify-trial-paypal-charge',
    note: 'Trial email, then the first charge arrives through PayPal.',
    tags: ['trial-conversion', 'paypal'],
    steps: [
      {
        today: '2026-09-14',
        emails: [email('trial-spotify-iso')],
        expect: { itemCount: 1, items: [{ merchantId: 'spotify', status: 'trial', nextChargeDate: '2026-10-14' }] },
      },
      {
        today: '2026-10-16',
        transactions: charges('PAYPAL *SPOTIFY 8005550142', 1199, ['2026-10-14'], { sub: 'spotify' }),
        expect: {
          itemCount: 1,
          items: [{ merchantId: 'spotify', status: 'active', amountCents: 1199, nextChargeDate: '2026-11-14', sources: ['email', 'bank'] }],
        },
      },
    ],
  },
  {
    id: 'unknown-trial-then-bank',
    note: 'Trial from a merchant outside the catalog; the bank descriptor names it slightly differently.',
    tags: ['trial-conversion', 'unknown-merchant'],
    steps: [
      {
        today: '2026-09-15',
        emails: [email('trial-html')],
        expect: { itemCount: 1, items: [{ name: 'Brightline Yoga', status: 'trial', nextChargeDate: '2026-09-25' }] },
      },
      {
        today: '2026-09-28',
        transactions: charges('BRIGHTLINE YOGA STUDIO 0042', 2900, ['2026-09-25'], { sub: 'yoga' }),
        expect: { itemCount: 1, items: [{ name: 'Brightline Yoga', status: 'active', amountCents: 2900, sources: ['email', 'bank'] }] },
      },
      {
        today: '2026-11-28',
        transactions: charges('BRIGHTLINE YOGA STUDIO 0042', 2900, ['2026-10-25', '2026-11-25'], { sub: 'yoga', prefix: 'yoga-later' }),
        expect: {
          itemCount: 1,
          items: [{ name: 'Brightline Yoga', status: 'active', amountCents: 2900, nextChargeDate: '2026-12-25', sources: ['email', 'bank'] }],
        },
      },
    ],
  },
  {
    id: 'trial-cancelled-verified',
    note: 'Trial, a cancellation email from the merchant, then no charge: verified cancelled.',
    tags: ['cancellation'],
    steps: [
      {
        today: '2026-09-01',
        emails: [email('trial-thirty-days-free')],
        expect: { itemCount: 1, items: [{ merchantId: 'peacock', status: 'trial', nextChargeDate: '2026-10-01' }] },
      },
      {
        today: '2026-09-20',
        emails: [email('cancel-trial-canceled')],
        expect: { itemCount: 1, items: [{ merchantId: 'peacock', status: 'cancel_pending' }] },
      },
      {
        today: '2026-10-10',
        expect: { itemCount: 1, items: [{ merchantId: 'peacock', status: 'cancel_verified' }] },
      },
    ],
  },
  {
    id: 'cancelled-but-charged',
    note: 'User cancels the trial in the app, but the merchant charges anyway.',
    tags: ['cancellation', 'post-cancel-charge'],
    steps: [
      {
        today: '2026-09-17',
        emails: [email('trial-zero-today')],
        expect: { itemCount: 1, items: [{ merchantId: 'hulu', status: 'trial', amountCents: 1899, nextChargeDate: '2026-10-17' }] },
      },
      {
        today: '2026-09-30',
        userCancels: 'hulu',
        expect: { itemCount: 1, items: [{ merchantId: 'hulu', status: 'cancel_pending' }] },
      },
      {
        today: '2026-10-19',
        transactions: charges('HULU 800-555-0102 HULU.COM', 1899, ['2026-10-17'], { sub: 'hulu' }),
        expect: { itemCount: 1, items: [{ merchantId: 'hulu', status: 'charged_after_cancel' }] },
      },
    ],
  },
  {
    id: 'price-increase-email-then-charge',
    note: 'Price-increase email for an existing subscription, then the first charge at the new price.',
    tags: ['price-increase'],
    steps: [
      {
        today: '2026-09-12',
        transactions: charges('NETFLIX.COM 800-555-0101 CA', 1549, monthly('2026-04-12', 6), { sub: 'netflix' }),
        emails: [email('price-netflix')],
        expect: { itemCount: 1, items: [{ merchantId: 'netflix', status: 'active', amountCents: 1549, priceChange: { oldCents: 1549, newCents: 1799 } }] },
      },
      {
        today: '2026-10-14',
        transactions: charges('NETFLIX.COM 800-555-0101 CA', 1799, ['2026-10-12'], { sub: 'netflix', prefix: 'netflix-new' }),
        expect: {
          itemCount: 1,
          items: [
            {
              merchantId: 'netflix',
              status: 'active',
              amountCents: 1799,
              nextChargeDate: '2026-11-12',
              sources: ['email', 'bank'],
              priceChange: { oldCents: 1549, newCents: 1799 },
            },
          ],
        },
      },
    ],
  },
  {
    id: 'prime-receipt-and-charge',
    note: 'Annual renewal seen in both the receipt email and the bank feed: one item.',
    tags: ['annual', 'dedupe'],
    steps: [
      {
        today: '2026-09-21',
        emails: [email('receipt-prime-annual')],
        transactions: charges('AMAZON PRIME*AB12CD34E', 13900, ['2025-09-20', '2026-09-20'], { sub: 'prime' }),
        expect: {
          itemCount: 1,
          items: [{ merchantId: 'amazon-prime', status: 'active', cadence: 'annual', amountCents: 13900, nextChargeDate: '2027-09-20', sources: ['email', 'bank'] }],
        },
      },
    ],
  },
  {
    id: 'kindle-trial-amazon-domain',
    note: 'Kindle Unlimited trial from amazon.com (a domain Amazon Prime shares), then the Kindle charge.',
    tags: ['trial-conversion', 'sender-domain'],
    steps: [
      {
        today: '2026-09-10',
        emails: [email('trial-kindle-amazon-domain')],
        expect: { itemCount: 1, items: [{ merchantId: 'kindle-unlimited', status: 'trial', nextChargeDate: '2026-10-10' }] },
      },
      {
        today: '2026-10-12',
        transactions: charges('KINDLE UNLTD*AB12CD34E', 1199, ['2026-10-10'], { sub: 'kindle' }),
        expect: { itemCount: 1, items: [{ merchantId: 'kindle-unlimited', status: 'active', amountCents: 1199, sources: ['email', 'bank'] }] },
      },
    ],
  },
];
