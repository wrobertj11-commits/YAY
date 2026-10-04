import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createManualItem,
  detectRecurring,
  extractEmailSignal,
  markCancelled,
  reconcile,
  resolveMerchant,
  type EmailMessage,
  type TrackedItem,
  type Transaction,
} from '../src/index.ts';

const NOW = '2026-10-04T15:00:00Z';
const TODAY = '2026-10-04';
let seq = 0;
const newId = () => `itm_${++seq}`;
const txn = (id: string, date: string, description: string, amountCents: number): Transaction => ({ id, accountId: 'a', date, description, amountCents, paymentMethod: 'Visa' });
const mail = (from: string, subject: string, body = '', date = NOW): EmailMessage => ({ id: `m${++seq}`, from, subject, body, date });

describe('App Store items are one price each', () => {
  it("a different App Store subscription's charge is not a charge after cancelling", () => {
    const t: Transaction[] = ['2026-08-15', '2026-09-15'].flatMap((d) => [txn(`a${d}`, d, 'APPLE.COM/BILL', 299), txn(`b${d}`, d, 'APPLE.COM/BILL', 1499)]);
    const first = reconcile({ items: [], transactions: t, recurring: detectRecurring(t, { today: '2026-09-20' }), signals: [], today: '2026-09-20', now: NOW, newId });
    const calm = first.items.find((i) => i.amountCents === 1499);
    assert.ok(calm);
    const cancelled = markCancelled(calm, '2026-09-25', NOW);
    const others = first.items.filter((i) => i !== calm);
    const later = [...t, txn('icloud-oct', '2026-10-15', 'APPLE.COM/BILL', 299)];
    const r = reconcile({ items: [...others, cancelled], transactions: later, recurring: detectRecurring(later, { today: '2026-10-16' }), signals: [], today: '2026-10-16', now: NOW, newId });
    assert.equal(r.items.find((i) => i.id === calm.id)?.status, 'cancel_pending', 'the $2.99 iCloud charge is not Calm');
  });
});

describe('shared sender domains', () => {
  it('a Kindle Unlimited cancellation from amazon.com is not an Amazon Prime cancellation', () => {
    const s = extractEmailSignal(mail('Amazon <digital-no-reply@amazon.com>', 'Your Kindle Unlimited membership has been cancelled'));
    assert.equal(s?.merchantId, 'kindle-unlimited');
  });

  it('an unnamed service on a shared domain stays unattributed rather than guessed', () => {
    assert.equal(resolveMerchant('no-reply@amazon.com', 'Your membership has been cancelled'), undefined);
    assert.equal(resolveMerchant('info@account.netflix.com', 'anything')?.id, 'netflix');
  });
});

describe('old cancellations from a stint that ended', () => {
  it('a June cancellation does not cancel a subscription that has charged twice since', () => {
    const t = ['2026-08-15', '2026-09-15'].map((d, i) => txn(`n${i}`, d, 'NETFLIX.COM', 1799));
    const cancel = extractEmailSignal(mail('Netflix <info@account.netflix.com>', 'Your membership has been cancelled', '', '2026-06-20T10:00:00Z'));
    assert.ok(cancel);
    const run = (items: TrackedItem[]) => reconcile({ items, transactions: t, recurring: detectRecurring(t, { today: TODAY }), signals: [cancel], today: TODAY, now: NOW, newId });
    const first = run([]);
    const second = run(first.items);
    assert.equal(second.items[0]?.status, 'active');
  });
});

describe('re-cancelling after a charge-after-cancel', () => {
  it('waits for the next real charge date instead of verifying instantly', () => {
    const item: TrackedItem = {
      ...createManualItem({ name: 'Netflix', merchantId: 'netflix', amountCents: 1799, cadence: 'monthly', date: '2026-09-01', isTrial: false }, 'n', NOW),
      status: 'charged_after_cancel',
      cancelledAt: '2026-08-10',
    };
    const again = markCancelled(item, TODAY, NOW);
    assert.equal(again.nextChargeDate, '2026-11-01', 'Sep 1 rolled forward past today (Oct 4)');
    const r = reconcile({ items: [again], transactions: [], recurring: [], signals: [], today: TODAY, now: NOW, newId });
    assert.equal(r.items[0]?.status, 'cancel_pending');
    assert.equal(r.events.length, 0);
  });
});

describe('price warnings follow corrected charges', () => {
  it('drops a charge-based price increase once the bank corrects the amount', () => {
    const series = (last: number) => ['2026-06-15', '2026-07-15', '2026-08-15', '2026-09-15'].map((d, i) => txn(`p${i}`, d, 'NETFLIX.COM', i < 3 ? 1549 : last));
    const raised = series(1799);
    const first = reconcile({ items: [], transactions: raised, recurring: detectRecurring(raised, { today: TODAY }), signals: [], today: TODAY, now: NOW, newId });
    assert.ok(first.items[0]?.priceChange);
    const corrected = series(1549);
    const second = reconcile({ items: first.items, transactions: corrected, recurring: detectRecurring(corrected, { today: TODAY }), signals: [], today: TODAY, now: NOW, newId });
    assert.equal(second.items[0]?.priceChange, undefined);
    assert.equal(second.items[0]?.amountCents, 1549);
  });
});
