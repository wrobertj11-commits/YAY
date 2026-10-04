import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createManualItem,
  extractEmailSignal,
  isTrustedCancellation,
  reconcile,
  scheduleAlerts,
  senderAddressOf,
  senderDomainOf,
  type EmailMessage,
  type EmailSignal,
  type Source,
  type TrackedItem,
} from '../src/index.ts';

const NOW = '2026-10-03T15:00:00Z';
const TODAY = '2026-10-03';
let seq = 0;
const newId = () => `itm_${++seq}`;

function email(from: string, subject = 'Your Netflix membership has been cancelled', body = 'We have cancelled your membership.'): EmailMessage {
  return { id: `e_${++seq}`, from, subject, date: NOW, body };
}

function netflix(): TrackedItem {
  return createManualItem({ name: 'Netflix', merchantId: 'netflix', amountCents: 1799, cadence: 'monthly', date: '2026-10-20', isTrial: false }, 'itm_netflix', NOW);
}

function only<T>(list: readonly T[]): T {
  assert.equal(list.length, 1);
  const [v] = list;
  assert.ok(v !== undefined);
  return v;
}

/** Runs one cancellation email through rules extraction and reconciliation against an active Netflix item. */
function cancelWith(from: string, source: Source = 'email', item = netflix()) {
  const signal = extractEmailSignal(email(from));
  assert.ok(signal, 'the rules recognize the email');
  assert.equal(signal.kind, 'cancellation_confirmation');
  const res = reconcile({ items: [item], transactions: [], recurring: [], signals: [{ ...signal, source }], today: TODAY, now: NOW, newId });
  return { signal, item: only(res.items), events: res.events };
}

describe('sender address parsing', () => {
  it('takes the bracketed address, never the display name', () => {
    assert.equal(senderDomainOf('Netflix <info@mailer.netflix.com>'), 'mailer.netflix.com');
    assert.equal(senderDomainOf('"billing@netflix.com" <x@attacker.example>'), 'attacker.example');
    assert.equal(senderAddressOf('"<info@netflix.com>" <x@attacker.example>'), 'x@attacker.example');
  });

  it('handles bare and odd addresses', () => {
    assert.equal(senderDomainOf('INFO@Netflix.COM'), 'netflix.com');
    assert.equal(senderDomainOf('Netflix info@netflix.com'), 'netflix.com');
    assert.equal(senderDomainOf(''), undefined);
    assert.equal(senderDomainOf('Netflix'), undefined);
    assert.equal(senderDomainOf('root@localhost'), undefined, 'no dot: not a public domain');
    assert.equal(senderDomainOf('a@b@evil.example'), 'evil.example');
  });

  it('extraction records the sender domain and attributes by the real address only', () => {
    const real = extractEmailSignal(email('Netflix <info@account.netflix.com>'));
    assert.equal(real?.senderDomain, 'account.netflix.com');
    assert.equal(real?.merchantId, 'netflix');

    // The display name claims Netflix; the subject names nobody we know. No merchant is inferred.
    const spoof = extractEmailSignal(email('"info@netflix.com" <x@attacker.example>', 'Your subscription has been cancelled', 'Done.'));
    assert.equal(spoof?.senderDomain, 'attacker.example');
    assert.equal(spoof?.merchantId, undefined);
  });
});

describe('spoofed cancellation emails', () => {
  it('a cancellation from the merchant (any subdomain) moves the item to cancel_pending', () => {
    const { item } = cancelWith('Netflix <info@account.netflix.com>');
    assert.equal(item.status, 'cancel_pending');
    assert.equal(item.cancelledAt, TODAY);
  });

  it('a cancellation for a catalog merchant from another domain is ignored', () => {
    const { signal, item, events } = cancelWith('Netflix Support <support@netflix-billing.example>');
    assert.equal(signal.merchantId, 'netflix', 'the subject still names Netflix');
    assert.equal(item.status, 'active');
    assert.equal(item.cancelledAt, undefined);
    assert.ok(!item.emailIds.includes(signal.emailId), 'the spoofed email is not attached to the item');
    assert.deepEqual(events, []);
  });

  it('look-alike domains do not match', () => {
    assert.equal(cancelWith('Netflix <info@notnetflix.com>').item.status, 'active');
    assert.equal(cancelWith('Netflix <info@netflix.com.attacker.example>').item.status, 'active');
  });

  it('a display-name spoof is ignored', () => {
    assert.equal(cancelWith('"info@netflix.com" <x@attacker.example>').item.status, 'active');
  });

  it('a spoofed cancellation does not silence renewal alerts', () => {
    const { item } = cancelWith('Netflix <billing@attacker.example>');
    const alerts = scheduleAlerts([item], 'plus', new Date('2026-10-18T15:00:00Z'));
    assert.ok(alerts.some((a) => a.type === 'renewal' && a.itemId === item.id));
  });

  it('an email the user forwarded or pasted is their own statement and is trusted', () => {
    const { item } = cancelWith('someone@attacker.example', 'forwarded');
    assert.equal(item.status, 'cancel_pending');
  });

  it('merchants outside the catalog have no domains to check, so the email counts', () => {
    const gym = createManualItem({ name: 'Crunch Fitness', amountCents: 2999, cadence: 'monthly', date: '2026-10-20', isTrial: false }, 'itm_gym', NOW);
    const signal: EmailSignal = {
      kind: 'cancellation_confirmation',
      emailId: 'e_gym',
      serviceName: 'Crunch Fitness',
      receivedAt: TODAY,
      confidence: 0.8,
      extractedBy: 'rules',
      senderDomain: 'crunch.example',
    };
    const res = reconcile({ items: [gym], transactions: [], recurring: [], signals: [signal], today: TODAY, now: NOW, newId });
    assert.equal(only(res.items).status, 'cancel_pending');
  });

  it('a stored signal without a sender domain cannot cancel a catalog merchant', () => {
    const legacy: EmailSignal = {
      kind: 'cancellation_confirmation',
      emailId: 'e_legacy',
      merchantId: 'netflix',
      serviceName: 'Netflix',
      receivedAt: TODAY,
      confidence: 0.8,
      extractedBy: 'llm',
    };
    assert.equal(isTrustedCancellation(legacy, netflix()), false);
    assert.equal(isTrustedCancellation({ ...legacy, senderDomain: 'netflix.com' }, netflix()), true);
  });

  it('checks against the tracked item when the signal names no merchant', () => {
    const signal: EmailSignal = {
      kind: 'cancellation_confirmation',
      emailId: 'e_x',
      serviceName: 'Netflix',
      receivedAt: TODAY,
      confidence: 0.8,
      extractedBy: 'rules',
      senderDomain: 'attacker.example',
    };
    assert.equal(isTrustedCancellation(signal, netflix()), false);
  });

  it('stays ignored on every re-run (reconcile is idempotent)', () => {
    const signal = extractEmailSignal(email('Netflix <billing@attacker.example>'));
    assert.ok(signal);
    let items = [netflix()];
    for (let i = 0; i < 3; i++) {
      const res = reconcile({ items, transactions: [], recurring: [], signals: [signal], today: TODAY, now: NOW, newId });
      items = res.items;
      assert.deepEqual(res.events, []);
    }
    assert.equal(only(items).status, 'active');
  });
});
