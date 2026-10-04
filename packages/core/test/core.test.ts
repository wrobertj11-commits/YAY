import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addMonths,
  buildCancelPlan,
  conciergeFeeCents,
  createManualItem,
  detectRecurring,
  extractEmailSignal,
  findDates,
  isRelevantEmail,
  markCancelled,
  normalizeAlertPrefs,
  normalizeMerchant,
  reconcile,
  scheduleAlerts,
  alertsForEvents,
  summarize,
  type EmailMessage,
  type Transaction,
  type TrackedItem,
} from '../src/index.ts';

const NOW = '2026-10-03T15:00:00Z';

/** Indexed access that fails the test (instead of returning undefined) when the element is missing. */
function at<T>(list: readonly T[], i: number): T {
  const v = list[i];
  assert.ok(v !== undefined, `expected an element at index ${i} (length ${list.length})`);
  return v;
}
const TODAY = '2026-10-03';
let seq = 0;
const newId = () => `item_${++seq}`;

function txn(date: string, description: string, amountCents: number, id = `${description}-${date}`): Transaction {
  return { id, accountId: 'acc', date, description, amountCents, paymentMethod: 'Visa ••4242' };
}

function email(partial: Partial<EmailMessage> & Pick<EmailMessage, 'subject' | 'body' | 'from'>): EmailMessage {
  return { id: `em-${++seq}`, date: '2026-10-01T10:00:00Z', ...partial };
}

describe('dates', () => {
  it('clamps month ends', () => {
    assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
    assert.equal(addMonths('2026-02-28', 1, 31), '2026-03-31');
  });
});

describe('normalizeMerchant', () => {
  it('maps messy descriptors to catalog merchants', () => {
    assert.equal(normalizeMerchant('NFLX*Netflix 866-579-7172 CA').name, 'Netflix');
    assert.equal(normalizeMerchant('NETFLIX.COM LOS GATOS CA').merchantId, 'netflix');
  });
  it('sees through PayPal and flags the rail', () => {
    const n = normalizeMerchant('PAYPAL *SPOTIFY 4029357733');
    assert.equal(n.merchantId, 'spotify');
    assert.equal(n.rail, 'paypal');
  });
  it('recognizes app store billing', () => {
    const n = normalizeMerchant('APPLE.COM/BILL 866-712-7753 CA');
    assert.equal(n.rail, 'app_store');
    assert.equal(n.merchantId, 'apple-app-store');
  });
  it('cleans unknown merchants into a stable key', () => {
    const a = normalizeMerchant('POS DEBIT CRUNCH FITNESS #1234 BROOKLYN NY');
    const b = normalizeMerchant('CRUNCH FITNESS #1234 BROOKLYN NY 07/02');
    assert.equal(a.key, b.key);
    assert.match(a.name, /^Crunch Fitness/);
  });
});

describe('detectRecurring', () => {
  const months = ['2026-05-15', '2026-06-15', '2026-07-15', '2026-08-15', '2026-09-15'];

  it('finds monthly subscriptions and predicts the next charge', () => {
    const rc = at(detectRecurring(months.map((d) => txn(d, 'NETFLIX.COM', 1549)), { today: TODAY }), 0);
    assert.equal(rc.name, 'Netflix');
    assert.equal(rc.cadence, 'monthly');
    assert.equal(rc.nextChargeDate, '2026-10-15');
    assert.ok(rc.confidence > 0.7);
  });

  it('keeps a price increase in the series and records the history', () => {
    const t = months.map((d, i) => txn(d, 'NETFLIX.COM', i < 4 ? 1549 : 1799));
    const rc = at(detectRecurring(t, { today: TODAY }), 0);
    assert.equal(rc.amountCents, 1799);
    assert.deepEqual(rc.priceHistory.map((p) => p.amountCents), [1549, 1799]);
  });

  it('ignores irregular spending', () => {
    const t = [
      txn('2026-09-01', 'STARBUCKS STORE 123', 645),
      txn('2026-09-03', 'STARBUCKS STORE 123', 512),
      txn('2026-09-11', 'STARBUCKS STORE 123', 780),
      txn('2026-09-12', 'STARBUCKS STORE 123', 645),
      txn('2026-09-29', 'STARBUCKS STORE 123', 1020),
    ];
    assert.equal(detectRecurring(t, { today: TODAY }).length, 0);
  });

  it('does not mistake a frequent habit for a weekly subscription', () => {
    const t = Array.from({ length: 30 }, (_, i) => txn(`2026-${String(7 + Math.floor(i / 10)).padStart(2, '0')}-${String(1 + (i % 10) * 3).padStart(2, '0')}`, 'STARBUCKS STORE 10223', 450 + ((i * 313) % 600)));
    assert.equal(detectRecurring(t, { today: TODAY }).length, 0);
  });

  it('requires 3 charges for unknown merchants but 2 for catalog ones', () => {
    const two = ['2026-08-02', '2026-09-02'];
    assert.equal(detectRecurring(two.map((d) => txn(d, 'CRUNCH FITNESS BROOKLYN NY', 2499)), { today: TODAY }).length, 0);
    assert.equal(detectRecurring(two.map((d) => txn(d, 'SPOTIFY USA', 1199)), { today: TODAY }).length, 1);
  });

  it('drops lapsed subscriptions', () => {
    const t = ['2026-03-01', '2026-04-01', '2026-05-01'].map((d) => txn(d, 'HULU 877-8244858 CA', 1799));
    assert.equal(detectRecurring(t, { today: TODAY }).length, 0);
  });

  it('splits multiple App Store subscriptions by price', () => {
    const t = ['2026-08-05', '2026-09-05'].flatMap((d) => [
      txn(d, 'APPLE.COM/BILL', 999, `a${d}`),
      txn(d, 'APPLE.COM/BILL', 299, `b${d}`),
    ]);
    assert.equal(detectRecurring(t, { today: TODAY }).length, 2);
  });
});

describe('email extraction', () => {
  it('only reads subscription-shaped emails', () => {
    assert.ok(isRelevantEmail('Headspace <hello@headspace.com>', 'Your free trial has started'));
    assert.ok(!isRelevantEmail('Mom <mom@gmail.com>', 'Dinner Sunday?'));
  });

  it('parses dates with and without years', () => {
    const found = findDates('ends on October 10, 2026 or 10/12/2026 or Nov 3', '2026-10-01').map((d) => d.date);
    assert.deepEqual(found, ['2026-10-10', '2026-10-12', '2026-11-03']);
  });

  it('extracts a trial: service, price after trial, conversion date', () => {
    const s = extractEmailSignal(
      email({
        from: 'Headspace <hello@headspace.com>',
        subject: 'Your 7-day free trial has started',
        body: 'Welcome! Your free trial ends on October 8, 2026. After that, you will be charged $69.99/year unless you cancel.',
      }),
    )!;
    assert.equal(s.kind, 'trial_signup');
    assert.equal(s.merchantId, 'headspace');
    assert.equal(s.chargeDate, '2026-10-08');
    assert.equal(s.priceCents, 6999);
    assert.equal(s.cadence, 'annual');
    assert.equal(s.trialDays, 7);
    assert.ok(s.confidence >= 0.9);
  });

  it('derives the conversion date from trial length when no date is given', () => {
    const s = extractEmailSignal(
      email({
        from: 'Max <no-reply@max.com>',
        subject: 'Welcome to Max',
        body: 'Enjoy your 7 day free trial. Then $16.99 per month.',
        date: '2026-10-02T09:00:00Z',
      }),
    )!;
    assert.equal(s.chargeDate, '2026-10-09');
    assert.equal(s.priceCents, 1699);
    assert.equal(s.cadence, 'monthly');
  });

  it('extracts a price increase with old and new prices', () => {
    const s = extractEmailSignal(
      email({
        from: 'Netflix <info@account.netflix.com>',
        subject: 'An update to your Netflix price',
        body: 'Your price is going up from $15.49 to $17.99/month starting on your billing date, October 15, 2026.',
      }),
    )!;
    assert.equal(s.kind, 'price_increase');
    assert.equal(s.oldPriceCents, 1549);
    assert.equal(s.priceCents, 1799);
    assert.equal(s.effectiveDate, '2026-10-15');
  });

  it('recognizes cancellation confirmations', () => {
    const s = extractEmailSignal(
      email({ from: 'Spotify <no-reply@spotify.com>', subject: 'Your Premium subscription has been cancelled', body: 'Sorry to see you go.' }),
    )!;
    assert.equal(s.kind, 'cancellation_confirmation');
    assert.equal(s.merchantId, 'spotify');
  });

  it('ignores marketing email', () => {
    assert.equal(extractEmailSignal(email({ from: 'Shop <news@shop.com>', subject: 'Our fall sale', body: '20% off everything' })), undefined);
  });
});

describe('reconcile: one item tracks its whole life', () => {
  const trialEmail = email({
    id: 'trial-email',
    from: 'Headspace <hello@headspace.com>',
    subject: 'Your 7-day free trial has started',
    body: 'Your free trial ends on October 8, 2026, then $12.99/month.',
    date: '2026-10-01T10:00:00Z',
  });
  const signal = extractEmailSignal(trialEmail)!;

  it('creates a trial from email, then converts it when the first bank charge lands', () => {
    const first = reconcile({ items: [], transactions: [], recurring: [], signals: [signal], today: TODAY, now: NOW, newId });
    assert.equal(first.items.length, 1);
    const trial = at(first.items, 0);
    assert.equal(trial.status, 'trial');
    assert.equal(trial.trialEndsAt, '2026-10-08');
    assert.equal(at(first.events, 0).type, 'new_item');

    const charge = txn('2026-10-08', 'HEADSPACE.COM', 1299, 'hs1');
    const later = reconcile({ items: first.items, transactions: [charge], recurring: [], signals: [signal], today: '2026-10-09', now: NOW, newId });
    assert.equal(later.items.length, 1, 'email trial and bank charge merge into one item');
    assert.equal(at(later.items, 0).status, 'active');
    assert.equal(at(later.items, 0).nextChargeDate, '2026-11-08');
    assert.deepEqual(later.events.map((e) => e.type), ['trial_converted']);
  });

  it('is idempotent', () => {
    const a = reconcile({ items: [], transactions: [], recurring: [], signals: [signal], today: TODAY, now: NOW, newId });
    const b = reconcile({ items: a.items, transactions: [], recurring: [], signals: [signal], today: TODAY, now: NOW, newId });
    assert.equal(b.items.length, 1);
    assert.equal(b.events.length, 0);
  });

  it('verifies a cancellation once the expected charge date passes with no charge', () => {
    const { items } = reconcile({ items: [], transactions: [], recurring: [], signals: [signal], today: TODAY, now: NOW, newId });
    const cancelled = markCancelled(at(items, 0), TODAY, NOW);
    const pending = reconcile({ items: [cancelled], transactions: [], recurring: [], signals: [], today: '2026-10-10', now: NOW, newId });
    assert.equal(at(pending.items, 0).status, 'cancel_pending');
    const done = reconcile({ items: pending.items, transactions: [], recurring: [], signals: [], today: '2026-10-14', now: NOW, newId });
    assert.equal(at(done.items, 0).status, 'cancel_verified');
    assert.equal(at(done.events, 0).type, 'cancel_verified');
  });

  it('flags a charge after cancellation (post-cancel check)', () => {
    const { items } = reconcile({ items: [], transactions: [], recurring: [], signals: [signal], today: TODAY, now: NOW, newId });
    const cancelled = markCancelled(at(items, 0), TODAY, NOW);
    const res = reconcile({
      items: [cancelled],
      transactions: [txn('2026-10-08', 'HEADSPACE.COM', 1299, 'sneaky')],
      recurring: [],
      signals: [],
      today: '2026-10-09',
      now: NOW,
      newId,
    });
    assert.equal(at(res.items, 0).status, 'charged_after_cancel');
    assert.deepEqual(at(res.items, 0).postCancelChargeIds, ['sneaky']);
  });

  it('turns a charge-history price increase into a price change', () => {
    const t = ['2026-06-15', '2026-07-15', '2026-08-15', '2026-09-15'].map((d, i) => txn(d, 'NETFLIX.COM', i < 3 ? 1549 : 1799));
    const recurring = detectRecurring(t, { today: TODAY });
    const res = reconcile({ items: [], transactions: t, recurring, signals: [], today: TODAY, now: NOW, newId });
    assert.deepEqual(at(res.items, 0).priceChange, { oldCents: 1549, newCents: 1799, effectiveDate: '2026-09-15', detectedFrom: 'charges' });
    assert.ok(res.events.some((e) => e.type === 'price_increase'));
  });

  it('respects a dismissed item', () => {
    const t = ['2026-08-15', '2026-09-15'].map((d) => txn(d, 'SPOTIFY', 1199));
    const recurring = detectRecurring(t, { today: TODAY });
    const first = reconcile({ items: [], transactions: t, recurring, signals: [], today: TODAY, now: NOW, newId });
    const dismissed: TrackedItem = { ...at(first.items, 0), status: 'dismissed' };
    const again = reconcile({ items: [dismissed], transactions: t, recurring, signals: [], today: TODAY, now: NOW, newId });
    assert.equal(again.items.length, 1);
    assert.equal(at(again.items, 0).status, 'dismissed');
  });
});

describe('alerts', () => {
  const now = new Date(NOW);
  const trial = (id: string, ends: string): TrackedItem =>
    createManualItem({ name: id, amountCents: 999, cadence: 'monthly', date: ends, isTrial: true }, id, NOW);

  it('schedules 48h and 24h alerts before a trial converts', () => {
    const alerts = scheduleAlerts([trial('t1', '2026-10-10')], 'plus', now, normalizeAlertPrefs({ push: true, email: false }));
    assert.deepEqual(alerts.map((a) => [a.leadHours, a.sendAt]), [
      [48, '2026-10-08T12:00:00.000Z'],
      [24, '2026-10-09T12:00:00.000Z'],
    ]);
  });

  it('sends a single catch-up alert when found inside the 48h window', () => {
    const alerts = scheduleAlerts([trial('t1', '2026-10-05')], 'plus', now, normalizeAlertPrefs({ push: true, email: false }));
    assert.equal(alerts.length, 2);
    assert.equal(at(alerts, 0).sendAt, now.toISOString());
    assert.equal(at(alerts, 1).leadHours, 24);
  });

  it('caps Free plan trial alerts at the 3 soonest trials', () => {
    const items = ['2026-10-20', '2026-10-06', '2026-10-30', '2026-10-12'].map((d, i) => trial(`t${i}`, d));
    const ids = new Set(scheduleAlerts(items, 'free', now).map((a) => a.itemId));
    assert.deepEqual([...ids].sort(), ['t0', 't1', 't3']);
  });

  it('gates price-hike alerts to Plus', () => {
    const item: TrackedItem = {
      ...createManualItem({ name: 'Netflix', merchantId: 'netflix', amountCents: 1799, cadence: 'monthly', date: '2026-10-15', isTrial: false }, 'n', NOW),
      priceChange: { oldCents: 1549, newCents: 1799, detectedFrom: 'email' },
    };
    const ev = [{ type: 'price_increase' as const, itemId: 'n' }];
    assert.equal(alertsForEvents(ev, [item], 'free', now).length, 0);
    const a = at(alertsForEvents(ev, [item], 'plus', now, normalizeAlertPrefs({ push: true, email: false })), 0);
    assert.match(a.body, /\$15\.49 → \$17\.99\/mo/);
    assert.match(a.body, /\$30\.00 more a year/);
  });
});

describe('savings and cancel plans', () => {
  it('totals monthly spend and savings from cancellations', () => {
    const active = createManualItem({ name: 'A', amountCents: 1200, cadence: 'annual', date: '2026-12-01', isTrial: false }, 'a', NOW);
    const monthly = createManualItem({ name: 'B', amountCents: 1000, cadence: 'monthly', date: '2026-10-20', isTrial: false }, 'b', NOW);
    const cancelled: TrackedItem = { ...monthly, id: 'c', status: 'cancel_verified', cancelledAt: '2026-07-10', nextChargeDate: '2026-07-20' };
    const s = summarize([active, monthly, cancelled], TODAY);
    assert.equal(s.monthlyCents, 1100);
    assert.equal(s.yearlyCents, 13200);
    assert.equal(s.savedSoFarCents, 3000); // Jul 20, Aug 20, Sep 20 skipped
    assert.equal(s.verifiedSavedCents, 3000);
  });

  it('routes app-store billed items to the store, and cites state rights', () => {
    const item: TrackedItem = { ...createManualItem({ name: 'X', amountCents: 999, cadence: 'monthly', date: TODAY, isTrial: false }, 'x', NOW), rail: 'app_store' };
    const plan = buildCancelPlan(item, 'CA');
    assert.equal(plan.method, 'app_store');
    assert.match(at(plan.rights, 0).law, /California/);
  });

  it('caps the concierge fee at $20', () => {
    assert.equal(conciergeFeeCents(3000), 900);
    assert.equal(conciergeFeeCents(50000), 2000);
  });
});
