import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

process.env.TRIALGUARD_DISABLE_LLM = '1';
process.env.TRIALGUARD_JOBS = '0';

const { normalizeAlertPrefs } = await import('@trialguard/core');
const { createApp } = await import('../src/app.ts');
const { defaultDeps } = await import('../src/pipeline.ts');
const { Store } = await import('../src/store.ts');
const { LIMITS } = await import('../src/ratelimit.ts');

type StoreT = InstanceType<typeof Store>;
type Data = StoreT['data'];
type User = Data['users'][number];

const NOW = new Date('2026-10-04T09:30:00Z');
const T = NOW.toISOString();
const deps = { ...defaultDeps, llm: undefined, notifier: undefined, clock: () => NOW };

/** Strings that must never appear in an export: credentials, full tokens, internals, staff identity. */
const SECRETS = {
  token: 'tok_a_SECRET_SESSION',
  sealedToken: 'v2.k1.SEALED-PROVIDER-TOKEN',
  cursor: 'PLAID-CURSOR-INTERNAL',
  pushToken: 'apnsPUSHTOKENfull0000000000000000000000001234',
  purchaseToken: 'PLAY-PURCHASE-TOKEN-full-5678',
  billingAccountToken: '7d1c2a9e-6b1f-4c33-9d70-0000000abcd',
  staff: 'staff_jane@trialguard.internal',
  worker: 'worker-host-17',
  providerError: 'upstream 10.2.3.4 refused',
};

function user(id: string, token: string, extra: Partial<User> = {}): User {
  return { id, email: `${id}@example.com`, token, plan: 'plus', forwardToken: `fwd${id}`, alertPrefs: normalizeAlertPrefs({ timeZone: 'America/Chicago' }), createdAt: T, ...extra };
}

/** Every collection gets a row for the exporting user and one for someone else (marked OTHER-USER). */
function seed(store: StoreT, id: string, mark: string): void {
  const d = store.data;
  d.connections.push({ id: `con_${id}`, userId: id, type: 'gmail', provider: 'gmail', label: `Gmail ${mark}`, sealedToken: SECRETS.sealedToken, externalId: `ext-${id}-0000009999`, cursor: SECRETS.cursor, status: 'active', createdAt: T });
  d.transactions.push({ id: `txn_${id}`, accountId: `acc_${id}`, date: '2026-10-01', amountCents: 1799, description: `NETFLIX ${mark}`, paymentMethod: 'Visa ••4242', userId: id, connectionId: `con_${id}` });
  d.signals.push({ kind: 'receipt', emailId: `gmail:${id}`, merchantId: 'netflix', serviceName: `Netflix ${mark}`, receivedAt: '2026-10-01', priceCents: 1799, confidence: 0.8, extractedBy: 'rules', senderDomain: 'netflix.com', userId: id, source: 'email' });
  d.items.push({
    id: `itm_${id}`,
    userId: id,
    matchKey: 'netflix',
    merchantId: 'netflix',
    name: `Netflix ${mark}`,
    kind: 'subscription',
    status: 'active',
    amountCents: 1799,
    cadence: 'monthly',
    nextChargeDate: '2026-11-01',
    rail: 'card',
    sources: ['email'],
    confidence: 0.8,
    confirmedByUser: false,
    transactionIds: [`txn_${id}`],
    emailIds: [`gmail:${id}`],
    priceHistory: [],
    createdAt: T,
    updatedAt: T,
  });
  d.alerts.push({
    id: `alr_${id}`,
    userId: id,
    itemId: `itm_${id}`,
    type: 'renewal',
    channel: 'push',
    sendAt: T,
    title: `Netflix renews ${mark}`,
    body: 'Netflix renews tomorrow for $17.99.',
    status: 'failed',
    attempts: 3,
    claimedBy: SECRETS.worker,
    claimedAt: T,
    lastError: SECRETS.providerError,
  });
  d.devices.push({ id: `dev_${id}`, userId: id, platform: 'ios', pushToken: SECRETS.pushToken, appVersion: '1.0.0', createdAt: T, lastSeenAt: T });
  d.billing.push({ id: `bil_${id}`, userId: id, platform: 'google_play', productId: 'plus_monthly', externalId: SECRETS.purchaseToken, status: 'active', expiresAt: '2026-11-04T00:00:00Z', updatedAt: T });
  d.concierge.push({
    id: `cnc_${id}`,
    userId: id,
    itemId: `itm_${id}`,
    feeCents: 1200,
    status: 'in_progress',
    authorization: { textVersion: '1', signedName: `Signer ${mark}`, signedAt: T, ip: '203.0.113.9', userAgent: 'Safari' },
    assignedTo: SECRETS.staff,
    createdAt: T,
  });
  d.brokenLinks.push({ merchantId: 'netflix', userId: id, note: `Link 404s ${mark}`, createdAt: T });
  d.audit.push({ id: `aud_${id}_1`, at: T, actor: { type: 'staff', id: SECRETS.staff }, action: 'concierge.assigned', userId: id, subject: { type: 'concierge', id: `cnc_${id}` } });
}

/** Where each store collection appears in the export. Typed over every collection, so a new one must be placed here. */
const EXPORT_KEY: Record<keyof Data, string | null> = {
  users: 'profile',
  connections: 'connections',
  transactions: 'transactions',
  signals: 'emailSignals',
  items: 'items',
  alerts: 'alerts',
  devices: 'devices',
  billing: 'billing',
  webhookEvents: null, // dedupe ids, not linked to any account
  audit: 'audit',
  concierge: 'concierge',
  brokenLinks: 'brokenLinkReports',
};

const store = new Store();
store.data.users.push(
  user('usr_a', SECRETS.token, { state: 'CA', billingAccountToken: SECRETS.billingAccountToken }),
  user('usr_b', 'tok_b', { email: 'OTHER-USER@example.com' }),
  user('usr_c', 'tok_c'),
);
seed(store, 'usr_a', 'mine');
seed(store, 'usr_b', 'OTHER-USER');
store.data.webhookEvents.push({ id: 'evt_1', provider: 'inbound_email', receivedAt: T });

let server: Server;
let base: string;
let exp: { status: number; headers: Headers; text: string; json: Record<string, any> };

const get = async (path: string, token?: string) => {
  const res = await fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: JSON.parse(text) as Record<string, any> };
};

before(async () => {
  server = createServer(createApp(store, deps));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  exp = await get('/api/me/export', SECRETS.token);
});
after(() => server.close());

describe('GET /api/me/export', () => {
  it('requires sign-in', async () => {
    assert.equal((await get('/api/me/export')).status, 401);
  });

  it('downloads as an attachment named for the date', () => {
    assert.equal(exp.status, 200);
    assert.equal(exp.headers.get('content-disposition'), 'attachment; filename="trialguard-export-2026-10-04.json"');
    assert.match(exp.headers.get('content-type') ?? '', /^application\/json/);
    assert.equal(exp.headers.get('cache-control'), 'no-store');
    assert.equal(exp.json.format, 'trialguard-export');
    assert.equal(exp.json.exportedAt, T);
  });

  it('contains every collection held for the user', () => {
    for (const [collection, key] of Object.entries(EXPORT_KEY) as [keyof Data, string | null][]) {
      if (!key || collection === 'users') continue;
      // The export's own audit entry is written after the file is built, so it is not in this file.
      const held = (store.data[collection] as { userId?: string; action?: string }[]).filter((r) => r.userId === 'usr_a' && r.action !== 'data.exported');
      const exported = exp.json[key] as unknown[];
      assert.ok(Array.isArray(exported), `${key} is exported`);
      assert.ok(held.length > 0, `fixture seeds ${collection}`);
      assert.equal(exported.length, held.length, `${collection}: every row`);
    }
    assert.equal(exp.json.profile.id, 'usr_a');
    assert.equal(exp.json.profile.email, 'usr_a@example.com');
    assert.equal(exp.json.profile.state, 'CA');
    assert.match(exp.json.profile.forwardingAddress, /^u-fwdusr_a@/);
    assert.equal(exp.json.alertPrefs.timeZone, 'America/Chicago');
    assert.equal(exp.json.emailSignals[0].senderDomain, 'netflix.com');
    assert.equal(exp.json.items[0].name, 'Netflix mine');
    assert.equal(exp.json.concierge[0].authorization.signedName, 'Signer mine', "the user's own signature is theirs to see");
  });

  it('contains nothing from other users', () => {
    assert.ok(!exp.text.includes('OTHER-USER'), 'no rows of user B');
    assert.ok(!exp.text.includes('usr_b'), 'no ids of user B');
    assert.ok(!exp.text.includes('usr_c'));
  });

  it('leaves out credentials and internals, and masks tokens', () => {
    for (const [name, secret] of Object.entries(SECRETS)) assert.ok(!exp.text.includes(secret), `${name} must not be exported`);
    for (const field of ['"token"', '"sealedToken"', '"cursor"', '"forwardToken"', '"claimedBy"', '"lastError"', '"assignedTo"']) {
      assert.ok(!exp.text.includes(field), `${field} field must not be exported`);
    }
    assert.equal(exp.json.devices[0].pushToken, '…1234');
    assert.equal(exp.json.billing[0].externalId, '…5678');
    assert.equal(exp.json.profile.billingAccountToken, '…abcd');
    assert.deepEqual(exp.json.audit[0].actor, { type: 'staff' }, 'staff appear by role only');
    assert.equal(exp.json.alerts[0].status, 'failed', 'delivery outcome is still reported');
  });

  it('lists the processors and what each receives', () => {
    const d = exp.json.disclosures;
    assert.equal(d.llmExtraction, false);
    const names = (d.processors as { name: string; receives: string[] }[]).map((p) => p.name);
    for (const expected of ['Plaid', 'Google (Gmail API)', 'Microsoft (Microsoft Graph)', 'Anthropic', 'Postmark']) assert.ok(names.includes(expected), expected);
    assert.ok(names.some((n) => /Apple Push|Firebase/.test(n)));
    for (const p of d.processors) assert.ok(p.receives.length > 0, `${p.name} says what it receives`);
  });

  it('is audited', () => {
    const entries = store.data.audit.filter((a) => a.userId === 'usr_a' && a.action === 'data.exported');
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0]?.actor, { type: 'user', id: 'usr_a' });
    assert.equal(entries[0]?.at, T);
  });

  it('is rate limited by the export bucket, and refused requests are not audited', async () => {
    const allowed = LIMITS.export.capacity;
    assert.ok(allowed < LIMITS.default.capacity, 'export has its own, tighter bucket');
    const statuses: number[] = [];
    for (let i = 0; i < allowed + 2; i++) statuses.push((await get('/api/me/export', 'tok_c')).status);
    assert.deepEqual(statuses, [...Array<number>(allowed).fill(200), 429, 429]);
    const limited = await get('/api/me/export', 'tok_c');
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal(store.data.audit.filter((a) => a.userId === 'usr_c' && a.action === 'data.exported').length, allowed);
  });

  it('a user with no data still gets a complete, well-formed file', async () => {
    const fresh = new Store();
    fresh.data.users.push(user('usr_new', 'tok_new'));
    const srv = createServer(createApp(fresh, deps));
    await new Promise<void>((r) => srv.listen(0, r));
    try {
      const res = await fetch(`http://localhost:${(srv.address() as AddressInfo).port}/api/me/export`, { headers: { Authorization: 'Bearer tok_new' } });
      const json = (await res.json()) as Record<string, unknown>;
      for (const key of Object.values(EXPORT_KEY)) if (key && key !== 'profile') assert.deepEqual(json[key], [], key);
    } finally {
      srv.close();
    }
  });
});

describe('privacy disclosures', () => {
  it('without LLM extraction, the copy does not mention an AI provider', async () => {
    const filter = await get('/api/connections/email-filter');
    assert.equal(filter.json.llmExtraction, false);
    assert.doesNotMatch(filter.json.description, /Anthropic|AI provider/);
    assert.match(filter.json.description, /email itself is not stored/);
    const privacy = await get('/api/privacy');
    assert.equal(privacy.status, 200);
    assert.equal(privacy.json.llmExtraction, false);
  });

  it('with LLM extraction, the copy says email text goes to Anthropic', async () => {
    const llmDeps = { ...deps, llm: async () => undefined };
    const srv = createServer(createApp(new Store(), llmDeps));
    await new Promise<void>((r) => srv.listen(0, r));
    try {
      const url = `http://localhost:${(srv.address() as AddressInfo).port}`;
      const filter = (await (await fetch(`${url}/api/connections/email-filter`)).json()) as { description: string; llmExtraction: boolean };
      assert.equal(filter.llmExtraction, true);
      assert.match(filter.description, /sent to Anthropic, an AI provider, to extract the service, price and dates/);
      assert.match(filter.description, /keeps only the extracted fields/);
      assert.doesNotMatch(filter.description, /in memory and dropped/);
      const privacy = (await (await fetch(`${url}/api/privacy`)).json()) as { llmExtraction: boolean; processors: { name: string; enabled?: boolean }[] };
      assert.equal(privacy.llmExtraction, true);
      assert.equal(privacy.processors.find((p) => p.name === 'Anthropic')?.enabled, true);
    } finally {
      srv.close();
    }
  });
});
