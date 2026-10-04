import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeAlertPrefs, type Transaction } from '@trialguard/core';

process.env.TRIALGUARD_DISABLE_LLM = '1';
process.env.TRIALGUARD_JOBS = '0';

const { recompute, syncUser, defaultDeps } = await import('../src/pipeline.ts');
const { PlaidApiError, LOGIN_REQUIRED_MESSAGE } = await import('../src/providers/bank.ts');
const { Store } = await import('../src/store.ts');

function netflixWithPriceHike(userId: string): (Transaction & { userId: string; connectionId: string })[] {
  return ['2026-06-15', '2026-07-15', '2026-08-15', '2026-09-15'].map((date, i) => ({
    id: `t${i}`,
    userId,
    connectionId: 'c1',
    accountId: 'a1',
    date,
    description: 'NETFLIX.COM',
    amountCents: i < 3 ? 1549 : 1799,
    paymentMethod: 'Visa ••4242',
  }));
}

describe('pipeline + scheduling integration', () => {
  it('keeps an event alert held through quiet hours across later recomputes', () => {
    const store = new Store();
    const user = {
      id: 'u1',
      email: 'u1@example.com',
      token: 't',
      plan: 'plus' as const,
      forwardToken: 'f',
      createdAt: '2026-10-01T00:00:00Z',
      alertPrefs: normalizeAlertPrefs({ push: true, email: false, timeZone: 'America/New_York', quietHours: { start: '21:00', end: '08:00' } }),
    };
    store.data.users.push(user);
    store.data.transactions.push(...netflixWithPriceHike(user.id));

    // 23:00 in New York: inside quiet hours.
    const night = new Date('2026-10-04T03:00:00Z');
    const first = recompute(store, user, { clock: () => night });
    assert.ok(first.events.some((e) => e.type === 'price_increase'));
    const held = () => store.data.alerts.find((a) => a.type === 'price_increase');
    assert.equal(held()?.status, 'pending');
    assert.equal(held()?.sendAt, '2026-10-04T12:00:00.000Z', 'deferred to 08:00 New York time');

    // The event does not fire again, but the held alert must not be dropped by the rebuild.
    const later = recompute(store, user, { clock: () => new Date('2026-10-04T05:00:00Z') });
    assert.equal(later.events.filter((e) => e.type === 'price_increase').length, 0);
    assert.equal(held()?.status, 'pending');

    // Switching the type off drops it.
    user.alertPrefs = normalizeAlertPrefs({ ...user.alertPrefs, types: { ...user.alertPrefs.types, price_increase: false } });
    recompute(store, user, { clock: () => new Date('2026-10-04T06:00:00Z') });
    assert.equal(held(), undefined);
  });

  it('marks a bank connection for reconnecting when a sync hits ITEM_LOGIN_REQUIRED (webhook missed)', async () => {
    const store = new Store();
    const user = {
      id: 'u2',
      email: 'u2@example.com',
      token: 't2',
      plan: 'free' as const,
      forwardToken: 'f2',
      createdAt: '2026-10-01T00:00:00Z',
      alertPrefs: normalizeAlertPrefs({}),
    };
    store.data.users.push(user);
    store.data.connections.push({ id: 'c1', userId: 'u2', type: 'bank', provider: 'plaid', label: 'Bank', status: 'active', createdAt: '2026-10-01T00:00:00Z' });
    const failing = {
      async sync(): Promise<never> {
        throw new PlaidApiError('/transactions/sync', 400, { error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'login required' });
      },
    };
    const deps = { ...defaultDeps, llm: undefined, notifier: undefined, bank: () => failing, clock: () => new Date('2026-10-04T15:00:00Z') };
    const first = await syncUser(store, user, deps);
    const conn = store.data.connections[0];
    assert.equal(conn?.status, 'reauth_required');
    assert.equal(conn?.error, LOGIN_REQUIRED_MESSAGE);
    assert.equal(first.errors.length, 1);
    // The next sync skips it instead of hammering Plaid with a dead login.
    let calls = 0;
    const counting = { async sync(): Promise<never> { calls++; throw new Error('should not be called'); } };
    await syncUser(store, user, { ...deps, bank: () => counting });
    assert.equal(calls, 0);
  });
});
