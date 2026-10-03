import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

process.env.TRIALGUARD_DISABLE_LLM = '1';
process.env.TRIALGUARD_JOBS = '0';

const { createApp } = await import('../src/app.ts');
const { defaultDeps } = await import('../src/pipeline.ts');
const { dispatchDueAlerts } = await import('../src/jobs.ts');
const { Store } = await import('../src/store.ts');

let now = new Date('2026-10-03T15:00:00Z');
const deps = { ...defaultDeps, llm: undefined, notifier: undefined, clock: () => now };
const store = new Store();
let server: Server;
let base: string;
let token = '';

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

before(async () => {
  server = createServer(createApp(store, deps));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

describe('Trialguard API (sandbox data)', () => {
  it('signs up and requires auth', async () => {
    assert.equal((await api('GET', '/api/me')).status, 401);
    const r = await api('POST', '/api/auth/signup', { email: 'wyatt@example.com', state: 'CA' });
    assert.equal(r.status, 200);
    token = r.json.token;
    assert.match(r.json.user.forwardingAddress, /^u-.+@in\.trialguard\.app$/);
    assert.equal(r.json.user.plan, 'free');
  });

  it('connecting a bank and an inbox finds subscriptions and trials', async () => {
    const bank = await api('POST', '/api/connections', { type: 'bank' });
    assert.equal(bank.status, 200);
    assert.ok(bank.json.summary.itemsFound >= 6);
    const inbox = await api('POST', '/api/connections', { type: 'gmail' });
    assert.equal(inbox.status, 200);
    assert.equal(inbox.json.summary.trials, 4);

    const items = (await api('GET', '/api/items')).json as any[];
    const names = items.map((i) => i.name).sort();
    for (const expected of ['Netflix', 'Spotify', 'ChatGPT Plus', 'The New York Times', 'Amazon Prime', 'Headspace', 'Max', 'Duolingo Super', 'Peloton', 'HelloFresh']) {
      assert.ok(names.includes(expected), `missing ${expected}: ${names.join(', ')}`);
    }
    assert.ok(names.some((n) => n.startsWith('Crunch Fitness')), 'unknown gym detected from cadence alone');
    assert.equal(items.filter((i) => i.merchantId === 'apple-app-store').length, 2);
    assert.ok(!names.includes('Hulu'), 'lapsed subscription is not listed');
    assert.ok(!names.some((n) => /starbucks|uber|whole/i.test(n)), 'noise is not listed');

    const netflix = items.find((i) => i.name === 'Netflix');
    assert.equal(netflix.amountCents, 1799);
    assert.equal(netflix.priceChange.oldCents, 1549);
    assert.equal(items.filter((i) => i.name === 'Netflix').length, 1, 'email + bank merged');

    const spotify = items.find((i) => i.name === 'Spotify');
    assert.equal(spotify.rail, 'paypal');

    const headspace = items.find((i) => i.name === 'Headspace');
    assert.equal(headspace.status, 'trial');
    assert.equal(headspace.daysUntilCharge, 2);
    assert.equal(headspace.amountCents, 6999);
    assert.equal(headspace.cadence, 'annual');
  });

  it('enforces Free plan connection limits', async () => {
    const r = await api('POST', '/api/connections', { type: 'outlook' });
    assert.equal(r.status, 402);
  });

  it('schedules trial alerts (Free: 3 soonest trials) and sends due ones', async () => {
    const items = (await api('GET', '/api/items')).json as any[];
    const trials = items.filter((i) => i.status === 'trial');
    assert.equal(trials.filter((t) => t.alertsOn).length, 3);
    assert.equal(trials.find((t) => t.name === 'Peloton').alertsOn, false, 'latest-ending trial is over the Free cap');

    const sent = await dispatchDueAlerts(store, { send: async () => {} }, now);
    assert.ok(sent >= 1, 'Headspace converts in 2 days, so its 48h alert is due now');
    const alerts = (await api('GET', '/api/alerts')).json;
    assert.ok(alerts.inbox.some((a: any) => /Headspace trial ends/.test(a.title)));
    assert.ok(alerts.upcoming.some((a: any) => /Max trial ends/.test(a.title)));
  });

  it('shows the cancel plan with state rights', async () => {
    const items = (await api('GET', '/api/items')).json as any[];
    const headspace = items.find((i) => i.name === 'Headspace');
    const plan = (await api('GET', `/api/items/${headspace.id}/cancel`)).json;
    assert.equal(plan.method, 'deep_link');
    assert.match(plan.url, /headspace\.com/);
    assert.match(plan.rights[0].law, /California/);

    const app = items.find((i) => i.merchantId === 'apple-app-store');
    assert.equal((await api('GET', `/api/items/${app.id}/cancel`)).json.method, 'app_store');
  });

  it('cancel → pending → verified once the trial date passes with no charge', async () => {
    await api('PATCH', '/api/me', { plan: 'plus' });
    let items = (await api('GET', '/api/items')).json as any[];
    const headspace = items.find((i) => i.name === 'Headspace');
    const r = await api('POST', `/api/items/${headspace.id}/cancel`, { action: 'completed' });
    assert.equal(r.json.status, 'cancel_pending');

    now = new Date('2026-10-12T15:00:00Z');
    await api('POST', '/api/sync');
    items = (await api('GET', '/api/items')).json as any[];
    assert.equal(items.find((i) => i.name === 'Headspace').status, 'cancel_verified');

    const summary = (await api('GET', '/api/summary')).json;
    assert.equal(summary.savedSoFarCents, 6999);
    assert.ok(summary.monthlyCents > 0);
  });

  it('adds a trial by forwarding or pasting an email', async () => {
    const r = await api('POST', '/api/forward', {
      from: 'Calm <hello@calm.com>',
      subject: 'Your Calm free trial',
      text: 'Your 7-day free trial ends on October 19, 2026. Then $69.99/year.',
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.item.name, 'Calm');
    assert.equal(r.json.item.trialEndsAt, '2026-10-19');

    const bad = await api('POST', '/api/forward', { text: 'hey, lunch tomorrow?' });
    assert.equal(bad.status, 422);
  });

  it('adds by hand, confirms and dismisses', async () => {
    const r = await api('POST', '/api/items', { name: 'Local CSA box', amountCents: 3500, cadence: 'monthly', date: '2026-11-01', isTrial: false });
    assert.equal(r.status, 200);
    const items = (await api('GET', '/api/items')).json as any[];
    const gym = items.find((i) => i.name.startsWith('Crunch'));
    assert.equal((await api('PATCH', `/api/items/${gym.id}`, { dismiss: true })).json.status, 'dismissed');
    await api('POST', '/api/sync');
    const after = (await api('GET', '/api/items')).json as any[];
    assert.equal(after.find((i: any) => i.id === gym.id).status, 'dismissed', 'dismissal survives re-sync');
  });

  it('deletes the account and all data', async () => {
    const userId = (await api('GET', '/api/me')).json.id;
    assert.equal((await api('DELETE', '/api/me')).json.deleted, true);
    assert.equal(store.data.items.filter((i) => i.userId === userId).length, 0);
    assert.equal(store.data.transactions.filter((t) => t.userId === userId).length, 0);
    assert.equal((await api('GET', '/api/me')).status, 401);
  });
});
