import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

// config reads the environment at import, so these must be set before the app is loaded.
const ADMIN_TOKEN = 'test-admin-token-0123456789abcdef';
process.env.ADMIN_TOKEN = ADMIN_TOKEN;
process.env.TRIALGUARD_DISABLE_LLM = '1';
process.env.TRIALGUARD_JOBS = '0';

const { createApp } = await import('../src/app.ts');
const { config } = await import('../src/config.ts');
const { defaultDeps } = await import('../src/pipeline.ts');
const { RateLimiter } = await import('../src/ratelimit.ts');
const { Store } = await import('../src/store.ts');
const { AUTHORIZATION_TEXT_VERSION, authorizationText } = await import('../src/concierge/authorization.ts');
const { canTransition } = await import('../src/concierge/requests.ts');

let now = new Date('2026-10-04T15:00:00Z');
const tick = () => (now = new Date(now.getTime() + 60_000));
const deps = { ...defaultDeps, llm: undefined, notifier: undefined, clock: () => now };
const store = new Store();
let server: Server;
let base: string;

const USER_AGENT = 'TrialguardTest/1.0 (concierge)';

interface Res {
  status: number;
  json: any;
  text: string;
}

async function call(method: string, path: string, opts: { body?: unknown; token?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined, text };
}

/** An ops call: admin bearer plus the acting staff member's handle. */
function admin(method: string, path: string, staff: string | null = 'sam', body?: unknown, token = ADMIN_TOKEN) {
  return call(method, path, { body, token, headers: staff === null ? {} : { 'X-Staff-Id': staff } });
}

let alice = { token: '', id: '', email: 'alice@example.com' };
let bob = { token: '', id: '', email: 'bob@example.com' };

async function signup(email: string) {
  const r = await call('POST', '/api/auth/signup', { body: { email, state: 'CA' } });
  assert.equal(r.status, 200);
  return { token: r.json.token as string, id: r.json.user.id as string, email };
}

async function addItem(token: string, merchantId: string, name: string, amountCents = 1799) {
  const r = await call('POST', '/api/items', { token, body: { name, merchantId, amountCents, cadence: 'monthly', date: '2026-10-20' } });
  assert.equal(r.status, 200, r.text);
  return r.json.id as string;
}

const sign = (overrides: Record<string, unknown> = {}) => ({ textVersion: AUTHORIZATION_TEXT_VERSION, signedName: 'Alice Example', agree: true, ...overrides });

function auditFor(subjectId: string) {
  return store.data.audit.filter((e) => e.subject?.id === subjectId);
}

before(async () => {
  const limiter = new RateLimiter({ auth: { capacity: 1000, per: 60 }, sync: { capacity: 1000, per: 60 }, default: { capacity: 10_000, per: 60 } });
  server = createServer(createApp(store, deps, limiter));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  alice = await signup(alice.email);
  bob = await signup(bob.email);
  // A bank connection gives Alice transactions, and a sealed token to make sure ops never sees either.
  assert.equal((await call('POST', '/api/connections', { token: alice.token, body: { type: 'bank' } })).status, 200);
  const conn = store.data.connections.find((c) => c.userId === alice.id);
  assert.ok(conn);
  conn.sealedToken = 'v1:sealed-provider-token-marker';
});
after(() => server.close());

describe('concierge authorization text', () => {
  it('is a versioned, draft, merchant-specific limited authorization', async () => {
    const r = await call('GET', '/api/concierge/authorization-text?merchantId=netflix');
    assert.equal(r.status, 200);
    assert.equal(r.json.version, AUTHORIZATION_TEXT_VERSION);
    assert.equal(r.json.draft, true);
    assert.equal(r.json.merchantName, 'Netflix');
    assert.equal(r.json.text, authorizationText('Netflix'));
    assert.match(r.json.text, /^DRAFT/);
    assert.match(r.json.text, /one purpose only: to cancel my Netflix subscription/);
    assert.match(r.json.text, /refund/);
    assert.match(r.json.text, /will not do/);
    assert.match(r.json.text, /withdraw/i);

    const generic = await call('GET', '/api/concierge/authorization-text');
    assert.equal(generic.json.merchantName, null);
    assert.match(generic.json.text, /the company named in your request/);
  });
});

describe('concierge requests (user)', () => {
  let netflixId = '';
  let requestId = '';

  before(async () => {
    const items = (await call('GET', '/api/items', { token: alice.token })).json as any[];
    const netflix = items.find((i) => i.merchantId === 'netflix');
    assert.ok(netflix, 'sandbox bank has Netflix');
    netflixId = netflix.id;
  });

  it('requires the written authorization', async () => {
    const path = `/api/items/${netflixId}/concierge`;
    const bad: [unknown, number][] = [
      [{}, 400],
      [sign({ agree: false }), 400],
      [sign({ agree: undefined }), 400],
      [sign({ signedName: 'A' }), 400],
      [sign({ signedName: '12345' }), 400],
      [sign({ signedName: 'Alice\nExample' }), 400],
      [sign({ signedName: 'x'.repeat(81) }), 400],
      [sign({ textVersion: undefined }), 400],
      [sign({ extra: 1 }), 400],
      [sign({ textVersion: '2020-01-01' }), 409],
    ];
    for (const [body, status] of bad) {
      const r = await call('POST', path, { token: alice.token, body });
      assert.equal(r.status, status, `${JSON.stringify(body)} -> ${r.text}`);
    }
    assert.equal(store.data.concierge.length, 0, 'nothing queued without a valid authorization');
    assert.equal(store.data.audit.filter((e) => e.action.startsWith('concierge.')).length, 0);
  });

  it('records the signature as evidence and audits the request', async () => {
    tick();
    const r = await call('POST', `/api/items/${netflixId}/concierge`, { token: alice.token, body: sign({ signedName: '  Alice Example  ' }) });
    assert.equal(r.status, 200, r.text);
    const c = r.json.concierge;
    requestId = c.id;
    assert.equal(c.status, 'queued');
    assert.equal(c.itemId, netflixId);
    assert.equal(c.merchantName, 'Netflix');
    assert.equal(c.feeCents, 2000, '30% of 12 x $17.99 is over the $20 cap');
    assert.deepEqual(c.authorization, { textVersion: AUTHORIZATION_TEXT_VERSION, signedName: 'Alice Example', signedAt: now.toISOString() });
    assert.equal(c.assignedTo, undefined, 'staff identity is not shown to users');

    const stored = store.data.concierge.find((x) => x.id === requestId);
    assert.ok(stored?.authorization);
    assert.equal(stored.authorization.signedName, 'Alice Example');
    assert.equal(stored.authorization.merchantName, 'Netflix');
    assert.equal(stored.authorization.textSha256, createHash('sha256').update(authorizationText('Netflix')).digest('hex'));
    assert.equal(stored.authorization.userAgent, USER_AGENT);
    assert.ok(stored.authorization.ip, 'ip recorded');
    assert.equal(store.data.items.find((i) => i.id === netflixId)?.cancelStartedAt, now.toISOString());

    const [entry, ...rest] = auditFor(requestId);
    assert.equal(rest.length, 0);
    assert.ok(entry);
    assert.equal(entry.action, 'concierge.requested');
    assert.deepEqual(entry.actor, { type: 'user', id: alice.id });
    assert.equal(entry.userId, alice.id);
    assert.deepEqual(entry.subject, { type: 'concierge_request', id: requestId });
    assert.equal(entry.details?.textVersion, AUTHORIZATION_TEXT_VERSION);
    const details = JSON.stringify(entry.details);
    assert.ok(!details.includes('Alice') && !details.includes(USER_AGENT), 'no signature data in audit details');
  });

  it('rejects a second open request for the same item', async () => {
    const r = await call('POST', `/api/items/${netflixId}/concierge`, { token: alice.token, body: sign() });
    assert.equal(r.status, 409);
    assert.equal(store.data.concierge.length, 1);
  });

  it('refuses services without done-for-you cancellation, and other users’ items', async () => {
    const maxId = await addItem(alice.token, 'max', 'Max', 1699);
    assert.equal((await call('POST', `/api/items/${maxId}/concierge`, { token: alice.token, body: sign() })).status, 400);
    assert.equal((await call('POST', `/api/items/${netflixId}/concierge`, { token: bob.token, body: sign({ signedName: 'Bob' }) })).status, 404);
    assert.equal((await call('POST', `/api/items/${netflixId}/concierge`, { body: sign() })).status, 401);
  });

  it('lists only the user’s own requests', async () => {
    const mine = await call('GET', '/api/concierge', { token: alice.token });
    assert.deepEqual(
      mine.json.requests.map((r: any) => r.id),
      [requestId],
    );
    assert.equal(mine.json.requests[0].itemName, 'Netflix');
    assert.equal((await call('GET', `/api/concierge?itemId=${netflixId}`, { token: alice.token })).json.requests.length, 1);
    assert.equal((await call('GET', '/api/concierge?itemId=itm_other', { token: alice.token })).json.requests.length, 0);
    assert.equal((await call('GET', '/api/concierge', { token: bob.token })).json.requests.length, 0);
  });

  it('withdrawing revokes the authorization and frees the item for a new request', async () => {
    assert.equal((await call('POST', `/api/concierge/${requestId}/withdraw`, { token: bob.token })).status, 404, 'not Bob’s request');
    tick();
    const r = await call('POST', `/api/concierge/${requestId}/withdraw`, { token: alice.token });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.concierge.status, 'cancelled');
    assert.equal(r.json.concierge.authorization.revokedAt, now.toISOString());
    assert.equal(r.json.concierge.closedAt, now.toISOString());
    assert.equal((await call('POST', `/api/concierge/${requestId}/withdraw`, { token: alice.token })).status, 409, 'already withdrawn');

    assert.deepEqual(
      auditFor(requestId).map((e) => e.action),
      ['concierge.requested', 'concierge.withdrawn'],
    );
    const withdrawn = auditFor(requestId)[1];
    assert.deepEqual(withdrawn?.actor, { type: 'user', id: alice.id });
    assert.deepEqual(withdrawn?.details, { from: 'queued', to: 'cancelled', authorizationRevoked: true });

    tick();
    const again = await call('POST', `/api/items/${netflixId}/concierge`, { token: alice.token, body: sign() });
    assert.equal(again.status, 200, again.text);
    const list = (await call('GET', '/api/concierge', { token: alice.token })).json.requests;
    assert.deepEqual(
      list.map((x: any) => x.status),
      ['queued', 'cancelled'],
      'newest first',
    );
  });
});

describe('concierge ops queue (admin)', () => {
  let netflixId = '';
  let requestId = '';

  before(() => {
    const open = store.data.concierge.find((r) => r.userId === alice.id && r.status === 'queued');
    assert.ok(open);
    requestId = open.id;
    netflixId = open.itemId;
  });

  it('is 404 when ADMIN_TOKEN is unset and 401 with a wrong or missing token', async () => {
    const saved = config.adminToken;
    config.adminToken = undefined;
    try {
      assert.equal((await admin('GET', '/api/admin/concierge')).status, 404);
      assert.equal((await admin('GET', '/api/admin/audit')).status, 404);
      assert.equal((await admin('POST', `/api/admin/concierge/${requestId}/claim`, 'sam', {})).status, 404);
    } finally {
      config.adminToken = saved;
    }
    assert.equal((await admin('GET', '/api/admin/concierge', 'sam', undefined, 'wrong-token')).status, 401);
    assert.equal((await admin('GET', '/api/admin/concierge', 'sam', undefined, `${ADMIN_TOKEN}x`)).status, 401);
    assert.equal((await call('GET', '/api/admin/concierge', { headers: { 'X-Staff-Id': 'sam' } })).status, 401);
    assert.equal((await admin('GET', '/api/admin/concierge', 'sam', undefined, alice.token)).status, 401, 'a user token is not an admin token');
    assert.equal((await admin('POST', `/api/admin/concierge/${requestId}/claim`, 'sam', {}, 'wrong-token')).status, 401);
  });

  it('requires a well-formed X-Staff-Id on every endpoint', async () => {
    for (const staff of [null, '', 'a', 'sam@example.com', 'sam smith', 'x'.repeat(65), '-sam']) {
      assert.equal((await admin('GET', '/api/admin/concierge', staff)).status, 400, `staff id ${JSON.stringify(staff)}`);
    }
    assert.equal((await admin('GET', `/api/admin/concierge/${requestId}`, null)).status, 400);
    assert.equal((await admin('POST', `/api/admin/concierge/${requestId}/claim`, null, {})).status, 400);
    assert.equal((await admin('POST', `/api/admin/concierge/${requestId}/status`, null, { status: 'in_progress' })).status, 400);
    assert.equal((await admin('GET', '/api/admin/audit', null)).status, 400);
    assert.equal(store.data.concierge.find((r) => r.id === requestId)?.status, 'queued', 'nothing changed');
  });

  it('lists the queue with the minimum needed: no transactions, tokens, contact details or signature data', async () => {
    const r = await admin('GET', '/api/admin/concierge?status=queued');
    assert.equal(r.status, 200);
    assert.deepEqual(
      r.json.requests.map((x: any) => x.id),
      [requestId],
      'withdrawn requests are not in the queue',
    );
    const row = r.json.requests[0];
    assert.deepEqual(row.merchant, { id: 'netflix', name: 'Netflix', cancelUrl: 'https://www.netflix.com/cancelplan', difficulty: 'easy' });
    assert.deepEqual(row.item, { name: 'Netflix', amountCents: 1799, cadence: 'monthly' });
    assert.deepEqual(row.authorization, { textVersion: AUTHORIZATION_TEXT_VERSION, signedAt: row.authorization.signedAt, revoked: false });
    assert.equal(row.feeCents, 2000);
    assertNoPrivateData(r.text);
    assert.ok(!r.text.includes(alice.email) && !r.text.includes('Alice Example'), 'no contact details in the list');

    assert.equal((await admin('GET', '/api/admin/concierge?status=in_progress')).json.requests.length, 0);
    assert.equal((await admin('GET', '/api/admin/concierge?status=cancelled')).status, 400);
  });

  it('claims: queued -> in_progress for the caller; someone else’s claim is refused', async () => {
    tick();
    const r = await admin('POST', `/api/admin/concierge/${requestId}/claim`, 'Sam', {});
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.request.status, 'in_progress');
    assert.equal(r.json.request.assignedTo, 'sam', 'handles are case-insensitive');
    assert.equal(r.json.request.contactEmail, alice.email, 'the assignee can identify the account');
    assert.equal(r.json.request.authorization.signedName, 'Alice Example');
    assert.equal(r.json.request.item.status, 'active');
    assert.ok(r.json.request.merchant.steps.length > 0);
    assertNoPrivateData(r.text);

    assert.equal((await admin('POST', `/api/admin/concierge/${requestId}/claim`, 'alex', {})).status, 409, 'already claimed by sam');
    assert.equal((await admin('POST', `/api/admin/concierge/${requestId}/status`, 'alex', { status: 'in_progress' })).status, 409);
    assert.equal((await admin('POST', `/api/admin/concierge/${requestId}/claim`, 'sam', {})).status, 409, 'not a valid transition twice');
    assert.equal((await admin('POST', '/api/admin/concierge/cnc_missing/claim', 'sam', {})).status, 404);

    const queued = await admin('GET', '/api/admin/concierge?status=in_progress');
    assert.equal(queued.json.requests[0].assignedTo, 'sam');
  });

  it('shows the full request only through the audited detail view, with contact details for the assignee only', async () => {
    const before = auditFor(requestId).length;
    const other = await admin('GET', `/api/admin/concierge/${requestId}`, 'alex');
    assert.equal(other.status, 200);
    assert.equal(other.json.request.contactEmail, undefined);
    assert.equal(other.json.request.authorization.signedName, 'Alice Example');
    assertNoPrivateData(other.text);
    const viewed = auditFor(requestId).slice(before);
    assert.equal(viewed.length, 1);
    assert.equal(viewed[0]?.action, 'concierge.viewed');
    assert.deepEqual(viewed[0]?.actor, { type: 'staff', id: 'alex' });
    assert.equal(viewed[0]?.userId, alice.id);
    assert.equal((await admin('GET', '/api/admin/concierge/cnc_missing', 'alex')).status, 404);
  });

  it('validates status changes: proof for done, a note for failed, assignee only', async () => {
    const path = `/api/admin/concierge/${requestId}/status`;
    assert.equal((await admin('POST', path, 'sam', { status: 'done' })).status, 400, 'done needs proof');
    assert.equal((await admin('POST', path, 'sam', { status: 'done', proof: '   ' })).status, 400, 'blank proof');
    assert.equal((await admin('POST', path, 'sam', { status: 'failed' })).status, 400, 'failed needs a note');
    assert.equal((await admin('POST', path, 'sam', { status: 'cancelled' })).status, 400, 'only users withdraw');
    assert.equal((await admin('POST', path, 'sam', { status: 'queued' })).status, 400);
    assert.equal((await admin('POST', path, 'alex', { status: 'done', proof: 'CXL-1' })).status, 409, 'not the assignee');
    assert.equal(store.data.concierge.find((r) => r.id === requestId)?.status, 'in_progress');
  });

  it('done marks the item cancel_pending with the proof, and closes the request for good', async () => {
    tick();
    const r = await admin('POST', `/api/admin/concierge/${requestId}/status`, 'sam', { status: 'done', proof: 'CXL-48213', note: 'Cancelled by chat. Access ends Oct 20.' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.request.status, 'done');
    assert.equal(r.json.request.proof, 'CXL-48213');
    assert.equal(r.json.request.contactEmail, undefined, 'closed: no contact details any more');

    const item = (await call('GET', `/api/items/${netflixId}`, { token: alice.token })).json;
    assert.equal(item.status, 'cancel_pending');
    assert.match(item.cancelProof, /CXL-48213/);
    assert.match(item.cancelProof, /concierge/i);
    assert.equal(item.cancelledAt, now.toISOString().slice(0, 10));

    const mine = (await call('GET', `/api/concierge?itemId=${netflixId}`, { token: alice.token })).json.requests[0];
    assert.equal(mine.status, 'done');
    assert.equal(mine.proof, 'CXL-48213');
    assert.equal(mine.note, 'Cancelled by chat. Access ends Oct 20.');

    // Final: no further moves by anyone.
    assert.equal((await admin('POST', `/api/admin/concierge/${requestId}/status`, 'sam', { status: 'failed', note: 'oops' })).status, 409);
    assert.equal((await admin('POST', `/api/admin/concierge/${requestId}/claim`, 'sam', {})).status, 409);
    assert.equal((await call('POST', `/api/concierge/${requestId}/withdraw`, { token: alice.token })).status, 409);

    const changed = auditFor(requestId).find((e) => e.action === 'concierge.status_changed');
    assert.deepEqual(changed?.actor, { type: 'staff', id: 'sam' });
    assert.deepEqual(changed?.details, { from: 'in_progress', to: 'done', hasProof: true, hasNote: true, itemCancelled: true });
    assert.ok(!JSON.stringify(changed).includes('CXL-48213'), 'proof stays out of the audit details');
  });

  it('enforces the state machine for every other path', async () => {
    const spotifyId = (((await call('GET', '/api/items', { token: alice.token })).json as any[]).find((i) => i.merchantId === 'spotify') ?? {}).id as string | undefined;
    const itemId = spotifyId ?? (await addItem(alice.token, 'spotify', 'Spotify', 1199));
    const create = async () => {
      tick();
      const r = await call('POST', `/api/items/${itemId}/concierge`, { token: alice.token, body: sign() });
      assert.equal(r.status, 200, r.text);
      return r.json.concierge.id as string;
    };

    // queued -> done is not a move: it must be claimed first.
    const a = await create();
    assert.equal((await admin('POST', `/api/admin/concierge/${a}/status`, 'sam', { status: 'done', proof: 'CXL-2' })).status, 409);
    assert.equal((await admin('POST', `/api/admin/concierge/${a}/status`, 'sam', { status: 'failed', note: 'n/a' })).status, 409);
    // in_progress via the status endpoint is a claim.
    const claimed = await admin('POST', `/api/admin/concierge/${a}/status`, 'alex', { status: 'in_progress' });
    assert.equal(claimed.status, 200);
    assert.equal(claimed.json.request.assignedTo, 'alex');
    // The user can still withdraw while staff work it; staff then can't finish it.
    assert.equal((await call('POST', `/api/concierge/${a}/withdraw`, { token: alice.token })).status, 200);
    assert.equal((await admin('POST', `/api/admin/concierge/${a}/status`, 'alex', { status: 'done', proof: 'CXL-3' })).status, 409);
    assert.equal(store.data.items.find((i) => i.id === itemId)?.status, 'active', 'a withdrawn request never cancels the item');
    assert.deepEqual(
      auditFor(a).map((e) => `${e.actor.type}:${e.action}`),
      ['user:concierge.requested', 'staff:concierge.claimed', 'user:concierge.withdrawn'],
    );

    // A withdrawn request can't be picked back up.
    assert.equal((await admin('POST', `/api/admin/concierge/${a}/claim`, 'sam', {})).status, 409);

    // failed: closes the request with a note the user sees; the item stays as it was.
    const b = await create();
    assert.equal((await admin('POST', `/api/admin/concierge/${b}/claim`, 'sam', {})).status, 200);
    const failed = await admin('POST', `/api/admin/concierge/${b}/status`, 'sam', { status: 'failed', note: 'Spotify needs you to sign in yourself.' });
    assert.equal(failed.status, 200);
    assert.equal(store.data.items.find((i) => i.id === itemId)?.status, 'active');
    const mine = (await call('GET', `/api/concierge?itemId=${itemId}`, { token: alice.token })).json.requests[0];
    assert.equal(mine.status, 'failed');
    assert.equal(mine.note, 'Spotify needs you to sign in yourself.');
    assert.equal((await admin('GET', '/api/admin/concierge?status=failed')).json.requests[0].id, b);

    // Requests queued before written authorization existed can't be worked.
    store.data.concierge.push({ id: 'cnc_legacy', userId: alice.id, itemId, feeCents: 300, status: 'queued', createdAt: now.toISOString() });
    assert.equal((await admin('POST', '/api/admin/concierge/cnc_legacy/claim', 'sam', {})).status, 409);
    assert.equal(store.data.concierge.find((r) => r.id === 'cnc_legacy')?.status, 'queued');
  });

  it('transition table: forward by staff, withdrawal by the user, nothing out of a closed state', () => {
    assert.ok(canTransition('queued', 'in_progress', 'staff'));
    assert.ok(canTransition('in_progress', 'done', 'staff'));
    assert.ok(canTransition('in_progress', 'failed', 'staff'));
    assert.ok(canTransition('queued', 'cancelled', 'user'));
    assert.ok(canTransition('in_progress', 'cancelled', 'user'));
    assert.ok(!canTransition('queued', 'cancelled', 'staff'));
    assert.ok(!canTransition('queued', 'in_progress', 'user'));
    assert.ok(!canTransition('queued', 'done', 'staff'));
    for (const closed of ['done', 'failed', 'cancelled'] as const) {
      for (const to of ['queued', 'in_progress', 'done', 'failed', 'cancelled'] as const) {
        assert.ok(!canTransition(closed, to, 'staff') && !canTransition(closed, to, 'user'), `${closed} -> ${to}`);
      }
    }
  });

  it('serves the audit trail by user, newest first, and records that it was read', async () => {
    const r = await admin('GET', `/api/admin/audit?userId=${alice.id}&limit=500`, 'auditor');
    assert.equal(r.status, 200);
    const entries = r.json.entries as any[];
    assert.ok(entries.every((e) => e.userId === alice.id));
    const times = entries.map((e) => e.at);
    assert.deepEqual(times, [...times].sort().reverse(), 'newest first');
    const actions = new Set(entries.map((e) => e.action));
    for (const a of ['concierge.requested', 'concierge.withdrawn', 'concierge.claimed', 'concierge.status_changed', 'concierge.viewed']) assert.ok(actions.has(a), a);
    for (const e of entries.filter((x) => x.action.startsWith('concierge.'))) {
      assert.equal(e.subject.type, 'concierge_request');
      assert.ok(['user', 'staff'].includes(e.actor.type));
      const text = JSON.stringify(e.details ?? {});
      assert.ok(!/Alice Example|alice@example\.com|CXL-|TrialguardTest/.test(text), `sensitive data in ${e.action} details`);
    }

    const last = store.data.audit.at(-1);
    assert.equal(last?.action, 'audit.viewed');
    assert.deepEqual(last?.actor, { type: 'staff', id: 'auditor' });
    assert.equal(last?.userId, alice.id);

    assert.equal((await admin('GET', `/api/admin/audit?userId=${alice.id}&limit=2`)).json.entries.length, 2);
    assert.equal((await admin('GET', `/api/admin/audit?userId=${bob.id}`)).json.entries.length, 0);
    assert.equal((await admin('GET', '/api/admin/audit?limit=0')).status, 400);
    assert.ok((await admin('GET', `/api/admin/audit?subjectId=${requestId}`)).json.entries.every((e: any) => e.subject?.id === requestId));
  });
});

/** Ops responses never carry bank transactions, provider or session tokens, or request metadata. */
function assertNoPrivateData(body: string): void {
  const user = store.data.users.find((u) => u.id === alice.id);
  assert.ok(user);
  const txs = store.data.transactions.filter((t) => t.userId === alice.id);
  assert.ok(txs.length > 0, 'fixture has transactions to leak');
  for (const t of txs) assert.ok(!body.includes(t.id) && !body.includes(t.description), `transaction ${t.id} leaked`);
  assert.ok(!/"transactions"|transactionIds|sealedToken|forwardToken/.test(body));
  assert.ok(!body.includes('sealed-provider-token-marker'));
  assert.ok(!body.includes(user.token) && !body.includes(user.forwardToken));
  assert.ok(!body.includes(USER_AGENT) && !/"ip"|userAgent/.test(body), 'ip and user agent stay in the record');
}

describe('self-cancel while a request is open', () => {
  it('closes the open request and revokes the authorization when the user cancels it themselves', async () => {
    const itemId = await addItem(bob.token, 'spotify', 'Spotify', 1199);
    const req = await call('POST', `/api/items/${itemId}/concierge`, { token: bob.token, body: sign({ signedName: 'Bob Example' }) });
    assert.equal(req.status, 200, req.text);
    const id = req.json.concierge.id as string;

    tick();
    const done = await call('POST', `/api/items/${itemId}/cancel`, { token: bob.token, body: { action: 'completed', proof: 'CXL-1' } });
    assert.equal(done.status, 200, done.text);

    const request = store.data.concierge.find((r) => r.id === id);
    assert.equal(request?.status, 'cancelled');
    assert.ok(request?.authorization?.revokedAt, 'authorization revoked');
    assert.ok(auditFor(id).some((e) => e.action === 'concierge.closed_self_cancelled' && e.actor.type === 'user'));
    // Staff can no longer pick it up.
    assert.equal((await admin('POST', `/api/admin/concierge/${id}/claim`, 'sam', {})).status, 409);
  });
});

describe('claiming a request whose item is already cancelled', () => {
  it('closes the request instead of sending staff to a finished job', async () => {
    const itemId = await addItem(bob.token, 'hulu', 'Hulu', 1799);
    const req = await call('POST', `/api/items/${itemId}/concierge`, { token: bob.token, body: sign({ signedName: 'Bob Example' }) });
    assert.equal(req.status, 200, req.text);
    const id = req.json.concierge.id as string;
    // Cancelled outside the in-app flow (e.g. the merchant's own confirmation email moved it).
    const item = store.data.items.find((i) => i.id === itemId);
    assert.ok(item);
    item.status = 'cancel_pending';
    tick();
    const claim = await admin('POST', `/api/admin/concierge/${id}/claim`, 'sam', {});
    assert.equal(claim.status, 409);
    const request = store.data.concierge.find((r) => r.id === id);
    assert.equal(request?.status, 'cancelled');
    assert.ok(request?.authorization?.revokedAt);
    assert.ok(auditFor(id).some((e) => e.action === 'concierge.closed_already_cancelled'));
  });
});
