import assert from 'node:assert/strict';
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { BankProvider, PlaidSettings } from '../src/providers/bank.ts';
import type { PlaidRouteOptions } from '../src/routes/plaid.ts';
import type { Connection, User } from '../src/store.ts';

process.env.TRIALGUARD_DISABLE_LLM = '1';
process.env.TRIALGUARD_JOBS = '0';

const { normalizeAlertPrefs } = await import('@trialguard/core');
const { Router } = await import('../src/http.ts');
const { register: registerPlaid } = await import('../src/routes/plaid.ts');
const { PlaidBank } = await import('../src/providers/bank.ts');
const { KeyUnavailableError, PlaidWebhookVerifier, plaidKeySource } = await import('../src/plaid/verify.ts');
const { defaultDeps, syncUser } = await import('../src/pipeline.ts');
const { Store } = await import('../src/store.ts');
const { StaticKeyring } = await import('../src/keyring.ts');
const { encrypt, setKeyring } = await import('../src/crypto.ts');
const { RateLimiter } = await import('../src/ratelimit.ts');
const { sandboxTransactions } = await import('../src/sandbox.ts');
const { counterValue } = await import('../src/metrics.ts');

// Provider tokens are sealed with a throwaway key, never the dev keyring file.
setKeyring(new StaticKeyring({ t: randomBytes(32).toString('hex') }, 't'));

const now = new Date('2026-10-03T15:00:00Z');
const clock = () => now;
const nowSeconds = () => Math.floor(now.getTime() / 1000);

// ---------- a fake Plaid, signing like the real one ----------

const KID = 'kid-current';
const signing = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = signing.publicKey.export({ format: 'jwk' });
const SETTINGS: PlaidSettings = { clientId: 'client-test', secret: 'secret-test', env: 'sandbox', webhookUrl: 'https://api.example.test/api/webhooks/plaid' };

const b64json = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function signWebhook(body: string, opts: { iat?: number; kid?: string; key?: KeyObject; hash?: string } = {}): string {
  const header = b64json({ alg: 'ES256', kid: opts.kid ?? KID, typ: 'JWT' });
  const payload = b64json({ iat: opts.iat ?? nowSeconds(), request_body_sha256: opts.hash ?? sha256(body) });
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), { key: opts.key ?? signing.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${header}.${payload}.${signature.toString('base64url')}`;
}

function fakePlaid() {
  const calls: { endpoint: string; body: any }[] = [];
  const keys = new Map<string, Record<string, unknown>>([[KID, { ...jwk, kid: KID, alg: 'ES256', use: 'sig', created_at: 1_790_000_000, expired_at: null }]]);
  let keyOutage = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    const endpoint = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body));
    calls.push({ endpoint, body });
    if (endpoint === '/webhook_verification_key/get') {
      if (keyOutage) return Response.json({ error_type: 'API_ERROR', error_message: 'internal' }, { status: 500 });
      const key = keys.get(body.key_id);
      return key ? Response.json({ key, request_id: 'req-key' }) : Response.json({ error_type: 'INVALID_INPUT', error_message: 'no such key' }, { status: 400 });
    }
    if (endpoint === '/link/token/create') return Response.json({ link_token: 'link-sandbox-update-1', request_id: 'req-link' });
    return Response.json({ error_message: `unexpected ${endpoint}` }, { status: 500 });
  };
  const keyFetches = () => calls.filter((c) => c.endpoint === '/webhook_verification_key/get').length;
  return { calls, keys, fetch: fetchImpl, keyFetches, setKeyOutage: (v: boolean) => (keyOutage = v) };
}

// ---------- verification ----------

describe('Plaid webhook signature verification', () => {
  const body = JSON.stringify({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'item-1' }, null, 2);
  const raw = Buffer.from(body);

  function setup() {
    const plaid = fakePlaid();
    const bank = new PlaidBank({ settings: SETTINGS, fetch: plaid.fetch });
    return { plaid, verifier: new PlaidWebhookVerifier({ fetchKey: plaidKeySource(bank), clock }) };
  }

  it('accepts a valid ES256 signature over the exact body', async () => {
    const { plaid, verifier } = setup();
    const result = await verifier.verify(signWebhook(body), raw);
    assert.equal(result.ok, true);
    const keyCall = plaid.calls.find((c) => c.endpoint === '/webhook_verification_key/get');
    assert.deepEqual(keyCall?.body, { client_id: 'client-test', secret: 'secret-test', key_id: KID });
  });

  it('rejects alg none and HS256 before fetching any key', async () => {
    const { plaid, verifier } = setup();
    const payload = b64json({ iat: nowSeconds(), request_body_sha256: sha256(body) });

    const noneHeader = b64json({ alg: 'none', kid: KID });
    assert.deepEqual(await verifier.verify(`${noneHeader}.${payload}.`, raw), { ok: false, reason: 'malformed' });
    assert.deepEqual(await verifier.verify(`${noneHeader}.${payload}.AAAA`, raw), { ok: false, reason: 'alg' });

    // Classic algorithm confusion: an HMAC keyed with the (public) key material.
    const hsHeader = b64json({ alg: 'HS256', kid: KID });
    const mac = createHmac('sha256', JSON.stringify(jwk)).update(`${hsHeader}.${payload}`).digest('base64url');
    assert.deepEqual(await verifier.verify(`${hsHeader}.${payload}.${mac}`, raw), { ok: false, reason: 'alg' });

    assert.equal(plaid.keyFetches(), 0);
  });

  it('rejects a body that differs from the signed hash, even by whitespace', async () => {
    const { verifier } = setup();
    const jwt = signWebhook(body);
    assert.deepEqual(await verifier.verify(jwt, Buffer.from(JSON.stringify(JSON.parse(body)))), { ok: false, reason: 'body_hash' });
    assert.deepEqual(await verifier.verify(jwt, Buffer.from(body.replace('item-1', 'item-2'))), { ok: false, reason: 'body_hash' });
  });

  it('rejects a stale (or future) iat', async () => {
    const { verifier } = setup();
    assert.deepEqual(await verifier.verify(signWebhook(body, { iat: nowSeconds() - 301 }), raw), { ok: false, reason: 'stale' });
    assert.deepEqual(await verifier.verify(signWebhook(body, { iat: nowSeconds() + 600 }), raw), { ok: false, reason: 'stale' });
    assert.equal((await verifier.verify(signWebhook(body, { iat: nowSeconds() - 290 }), raw)).ok, true);
  });

  it('rejects a signature made with a different key, or a tampered payload', async () => {
    const { verifier } = setup();
    assert.deepEqual(await verifier.verify(signWebhook(body, { key: other.privateKey }), raw), { ok: false, reason: 'signature' });
    const [h, p, s] = signWebhook(body).split('.');
    const forged = b64json({ iat: nowSeconds(), request_body_sha256: sha256('{"webhook_type":"ITEM"}') });
    assert.deepEqual(await verifier.verify(`${h}.${forged}.${s}`, raw), { ok: false, reason: 'signature' });
    assert.deepEqual(await verifier.verify(`${h}.${p}.${Buffer.alloc(64).toString('base64url')}`, raw), { ok: false, reason: 'signature' });
    assert.deepEqual(await verifier.verify(`${h}.${p}.${Buffer.alloc(70, 1).toString('base64url')}`, raw), { ok: false, reason: 'signature' }, 'DER-length signatures are not ES256');
  });

  it('fetches an unknown kid once, then serves it from the cache', async () => {
    const { plaid, verifier } = setup();
    const results = await Promise.all([verifier.verify(signWebhook(body), raw), verifier.verify(signWebhook(body), raw)]);
    assert.ok(results.every((r) => r.ok));
    assert.equal((await verifier.verify(signWebhook(body), raw)).ok, true);
    assert.equal(plaid.keyFetches(), 1);

    // A kid Plaid doesn't know is remembered too, so junk kids can't make us call Plaid each time.
    assert.deepEqual(await verifier.verify(signWebhook(body, { kid: 'kid-bogus' }), raw), { ok: false, reason: 'unknown_key' });
    assert.deepEqual(await verifier.verify(signWebhook(body, { kid: 'kid-bogus' }), raw), { ok: false, reason: 'unknown_key' });
    assert.equal(plaid.keyFetches(), 2);
  });

  it('respects expired_at on a retired key', async () => {
    const { plaid, verifier } = setup();
    plaid.keys.set('kid-retired', { ...jwk, kid: 'kid-retired', alg: 'ES256', use: 'sig', created_at: 1_700_000_000, expired_at: nowSeconds() - 60 });
    assert.deepEqual(await verifier.verify(signWebhook(body, { kid: 'kid-retired' }), raw), { ok: false, reason: 'key_expired' });
  });

  it('treats a Plaid outage as retryable, not as a bad signature', async () => {
    const { plaid, verifier } = setup();
    plaid.setKeyOutage(true);
    await assert.rejects(verifier.verify(signWebhook(body), raw), KeyUnavailableError);
    plaid.setKeyOutage(false);
    assert.equal((await verifier.verify(signWebhook(body), raw)).ok, true, 'outages are not cached');
  });

  it('rejects a missing or malformed header', async () => {
    const { verifier } = setup();
    assert.deepEqual(await verifier.verify(undefined, raw), { ok: false, reason: 'missing' });
    assert.deepEqual(await verifier.verify('not-a-jwt', raw), { ok: false, reason: 'malformed' });
    assert.deepEqual(await verifier.verify('a.b.c.d', raw), { ok: false, reason: 'malformed' });
  });
});

// ---------- webhooks and update mode over HTTP ----------

describe('Plaid webhooks and update mode', () => {
  const store = new Store();
  const bankCalls: { connectionId: string; accessToken?: string }[] = [];
  const defaultSync: BankProvider['sync'] = async (opts) => ({ transactions: sandboxTransactions(opts.today, opts.connectionId), removedIds: [], cursor: 'cursor-1' });
  let syncImpl = defaultSync;
  const fakeBank: BankProvider = {
    sync: (opts) => {
      bankCalls.push({ connectionId: opts.connectionId, accessToken: opts.accessToken });
      return syncImpl(opts);
    },
  };
  const deps = { ...defaultDeps, llm: undefined, notifier: undefined, clock, bank: () => fakeBank };
  const plaid = fakePlaid();
  const plaidClient = new PlaidBank({ settings: SETTINGS, fetch: plaid.fetch });

  function addUser(id: string): User {
    const user: User = { id, email: `${id}@example.com`, token: `tok-${id}`, plan: 'plus', forwardToken: id, alertPrefs: normalizeAlertPrefs(undefined), createdAt: now.toISOString() };
    store.data.users.push(user);
    return user;
  }
  const alice = addUser('usr_alice');
  addUser('usr_bob');
  const bank: Connection = { id: 'con_alice_plaid', userId: alice.id, type: 'bank', provider: 'plaid', label: 'Chase', externalId: 'item-alice', status: 'active', createdAt: now.toISOString() };
  const demo: Connection = { id: 'con_alice_demo', userId: alice.id, type: 'bank', provider: 'sandbox', label: 'Demo Bank (sandbox)', status: 'active', createdAt: now.toISOString() };
  store.data.connections.push(bank, demo);

  const servers: Server[] = [];
  async function serve(overrides: Partial<PlaidRouteOptions>): Promise<string> {
    const router = new Router(store, new RateLimiter());
    registerPlaid({ router, store, deps }, overrides);
    const server = createServer((req, res) => {
      void router.handle(req, res).then((handled) => {
        if (!handled) res.writeHead(404).end();
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, r));
    return `http://localhost:${(server.address() as AddressInfo).port}`;
  }

  let live = '';
  let slow = '';
  let devDemo = '';
  let unconfigured = '';
  before(async () => {
    live = await serve({ plaid: plaidClient, requireSignature: true, inlineTimeoutMs: 5_000 });
    slow = await serve({ plaid: plaidClient, requireSignature: true, inlineTimeoutMs: 30 });
    devDemo = await serve({ plaid: undefined, requireSignature: false });
    // What production looks like with Plaid credentials missing: nothing to verify against.
    unconfigured = await serve({ plaid: undefined, requireSignature: true });
  });
  after(() => servers.forEach((s) => s.close()));

  beforeEach(() => {
    Object.assign(bank, { status: 'active', error: undefined, sealedToken: encrypt('access-alice'), cursor: undefined, lastSyncedAt: undefined });
    Object.assign(demo, { status: 'active', error: undefined });
    bankCalls.length = 0;
    syncImpl = defaultSync;
  });

  let deliveries = 0;
  async function webhook(base: string, payload: Record<string, unknown>, opts: { signed?: boolean; jwt?: string } = {}) {
    const body = JSON.stringify(payload, null, 2);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts.jwt) headers['Plaid-Verification'] = opts.jwt;
    // Each call is a distinct delivery (Plaid stamps a fresh iat); identical signed content is a replay by design.
    else if (opts.signed !== false) headers['Plaid-Verification'] = signWebhook(body, { iat: nowSeconds() - (deliveries++ % 250) });
    const res = await fetch(`${base}/api/webhooks/plaid`, { method: 'POST', headers, body });
    return { status: res.status, json: (await res.json()) as any };
  }

  async function call(base: string, path: string, token?: string) {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: res.status, json: (await res.json()) as any };
  }

  const syncAvailable = { webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'item-alice', initial_update_complete: true, historical_update_complete: false, environment: 'sandbox' };
  const loginRequired = {
    webhook_type: 'ITEM',
    webhook_code: 'ERROR',
    item_id: 'item-alice',
    error: { error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'the login details of this item have changed', display_message: null },
    environment: 'sandbox',
  };
  const item = (code: string) => ({ webhook_type: 'ITEM', webhook_code: code, item_id: 'item-alice', error: null, environment: 'sandbox' });

  it('rejects unsigned and mis-signed webhooks with 401 and changes nothing', async () => {
    assert.equal((await webhook(live, loginRequired, { signed: false })).status, 401);
    assert.equal((await webhook(live, loginRequired, { jwt: signWebhook('{"other":"body"}') })).status, 401);
    assert.equal((await webhook(unconfigured, loginRequired, { signed: false })).status, 401, 'production never accepts unsigned webhooks');
    assert.equal(bank.status, 'active');
    assert.ok(counterValue('plaid_webhooks_total', { type: 'ITEM', code: 'ERROR', result: 'unverified' }) >= 3);
  });

  it('SYNC_UPDATES_AVAILABLE pulls that connection now and recomputes the user', async () => {
    const r = await webhook(live, syncAvailable);
    assert.equal(r.status, 200);
    assert.deepEqual(bankCalls, [{ connectionId: bank.id, accessToken: 'access-alice' }]);
    assert.equal(bank.cursor, 'cursor-1');
    assert.equal(bank.lastSyncedAt, now.toISOString());
    assert.ok(store.itemsFor(alice.id).some((i) => i.name === 'Netflix'), 'detection ran on the pulled transactions');
    assert.ok(counterValue('plaid_webhooks_total', { type: 'TRANSACTIONS', code: 'SYNC_UPDATES_AVAILABLE', result: 'processed' }) >= 1);
  });

  it('acknowledges a replayed delivery without processing it again', async () => {
    const body = JSON.stringify(syncAvailable, null, 2);
    const jwt = signWebhook(body, { iat: nowSeconds() - 10 });
    const send = () => fetch(`${live}/api/webhooks/plaid`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Plaid-Verification': jwt }, body });
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 200);
    assert.equal(bankCalls.length, 1);
  });

  it('acknowledges within the bound when the pull is slow, and the pull still completes', async () => {
    let release = () => {};
    syncImpl = (opts) => new Promise((resolve) => (release = () => resolve(defaultSync(opts))));
    const started = Date.now();
    assert.equal((await webhook(slow, syncAvailable)).status, 200);
    assert.ok(Date.now() - started < 2_000);
    assert.equal(bank.lastSyncedAt, undefined, 'pull still running');
    release();
    for (let i = 0; i < 50 && !bank.lastSyncedAt; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(bank.lastSyncedAt, now.toISOString());
    assert.ok(counterValue('plaid_webhooks_total', { type: 'TRANSACTIONS', code: 'SYNC_UPDATES_AVAILABLE', result: 'timeout' }) >= 1);
  });

  it('a failed pull is recorded on the connection but still acknowledged', async () => {
    syncImpl = async () => {
      throw new Error('institution down');
    };
    assert.equal((await webhook(live, syncAvailable)).status, 200);
    assert.equal(bank.status, 'error');
    assert.match(bank.error ?? '', /institution down/);
  });

  it('ITEM_LOGIN_REQUIRED marks the connection reauth_required, and syncUser then skips it', async () => {
    assert.equal((await webhook(live, loginRequired)).status, 200);
    assert.equal(bank.status, 'reauth_required');
    assert.match(bank.error ?? '', /sign in again/);

    const summary = await syncUser(store, alice, deps);
    assert.ok(!bankCalls.some((c) => c.connectionId === bank.id), 'no pull for a connection waiting on the user');
    assert.ok(summary.errors.some((e) => /Chase: needs to be reconnected/.test(e)));

    // A sync webhook for it is ignored too.
    bankCalls.length = 0;
    assert.equal((await webhook(live, syncAvailable)).status, 200);
    assert.equal(bankCalls.length, 0);
  });

  it('LOGIN_REPAIRED restores the connection', async () => {
    await webhook(live, loginRequired);
    assert.equal((await webhook(live, item('LOGIN_REPAIRED'))).status, 200);
    assert.equal(bank.status, 'active');
    assert.equal(bank.error, undefined);
  });

  it('PENDING_EXPIRATION stays until the user re-links, even across good syncs', async () => {
    assert.equal((await webhook(live, { ...item('PENDING_EXPIRATION'), consent_expiration_time: '2026-10-20T00:00:00Z' })).status, 200);
    assert.equal(bank.status, 'pending_expiration');
    await syncUser(store, alice, deps);
    assert.ok(bankCalls.some((c) => c.connectionId === bank.id), 'still syncing until consent runs out');
    assert.equal(bank.status, 'pending_expiration');
    await webhook(live, item('LOGIN_REPAIRED'));
    assert.equal(bank.status, 'pending_expiration', 'a repaired login does not renew consent');

    // A login problem is the stronger state; a later expiry notice doesn't hide it.
    await webhook(live, loginRequired);
    await webhook(live, item('PENDING_DISCONNECT'));
    assert.equal(bank.status, 'reauth_required');
  });

  it('USER_PERMISSION_REVOKED deletes the stored token', async () => {
    assert.equal((await webhook(live, item('USER_PERMISSION_REVOKED'))).status, 200);
    assert.equal(bank.sealedToken, undefined);
    assert.equal(bank.status, 'error');
    assert.match(bank.error ?? '', /turned off/);
    assert.ok(store.data.audit.some((a) => a.action === 'connection.revoked' && a.subject?.id === bank.id));

    await webhook(live, item('LOGIN_REPAIRED'));
    assert.equal(bank.status, 'error', 'nothing to repair without a token');
    await webhook(live, loginRequired);
    assert.equal(bank.status, 'error', 'no Reconnect button for something update mode cannot fix');
    assert.ok(counterValue('plaid_webhooks_total', { type: 'ITEM', code: 'LOGIN_REPAIRED', result: 'ignored' }) >= 1);
    assert.equal((await call(live, `/api/connections/${bank.id}/relinked`, alice.token)).status, 409);
  });

  it('acknowledges unknown items and codes without acting on them', async () => {
    assert.equal((await webhook(live, { ...syncAvailable, item_id: 'item-nobody' })).status, 200);
    assert.equal((await webhook(live, item('WEBHOOK_UPDATE_ACKNOWLEDGED'))).status, 200);
    assert.equal((await webhook(live, { ...loginRequired, error: { error_code: 'INSTITUTION_DOWN' } })).status, 200);
    assert.equal(bankCalls.length, 0);
    assert.equal(bank.status, 'active');
    assert.ok(counterValue('plaid_webhooks_total', { type: 'TRANSACTIONS', code: 'SYNC_UPDATES_AVAILABLE', result: 'unknown_item' }) >= 1);
    assert.ok(counterValue('plaid_webhooks_total', { type: 'ITEM', code: 'other', result: 'ignored' }) >= 1);
  });

  it('dev without Plaid accepts unsigned webhooks so the flow can be demoed', async () => {
    const r = await webhook(devDemo, { ...loginRequired, item_id: demo.id }, { signed: false });
    assert.equal(r.status, 200);
    assert.equal(demo.status, 'reauth_required');
    // Signed mode never addresses connections by our own id.
    await webhook(live, { ...item('LOGIN_REPAIRED'), item_id: demo.id });
    assert.equal(demo.status, 'reauth_required');
  });

  it('update-mode link token: owner only, only when needed, 501 without Plaid', async () => {
    const path = `/api/connections/${bank.id}/link-token`;
    assert.equal((await call(live, path)).status, 401);
    assert.equal((await call(live, path, alice.token)).status, 409, 'an active connection needs no re-link');

    await webhook(live, loginRequired);
    assert.equal((await call(live, path, 'tok-usr_bob')).status, 404, "another user's connection is not found");
    const r = await call(live, path, alice.token);
    assert.equal(r.status, 200);
    assert.equal(r.json.linkToken, 'link-sandbox-update-1');
    const sent = plaid.calls.findLast((c) => c.endpoint === '/link/token/create')?.body;
    assert.equal(sent.access_token, 'access-alice');
    assert.equal(sent.products, undefined, 'update mode passes the access token instead of products');
    assert.equal(sent.webhook, SETTINGS.webhookUrl);
    assert.deepEqual(sent.user, { client_user_id: alice.id });

    assert.equal((await call(devDemo, path, alice.token)).status, 501);
  });

  it('relinked: owner only, marks active and runs a sync', async () => {
    await webhook(live, loginRequired);
    const path = `/api/connections/${bank.id}/relinked`;
    assert.equal((await call(live, path, 'tok-usr_bob')).status, 404);
    assert.equal(bank.status, 'reauth_required');

    const r = await call(live, path, alice.token);
    assert.equal(r.status, 200);
    assert.equal(r.json.connection.status, 'active');
    assert.equal(bank.status, 'active');
    assert.equal(bank.error, undefined);
    assert.ok(bankCalls.some((c) => c.connectionId === bank.id));
    assert.ok(r.json.summary.itemsFound > 0);
  });
});

describe('Plaid verifier under attack', () => {
  const body = JSON.stringify({ webhook_type: 'ITEM', webhook_code: 'ERROR', item_id: 'item-1', error: { error_code: 'ITEM_LOGIN_REQUIRED' } });
  const raw = Buffer.from(body);

  it('a flood of unknown key ids cannot evict the real key', async () => {
    const plaid = fakePlaid();
    const verifier = new PlaidWebhookVerifier({ fetchKey: plaidKeySource(new PlaidBank({ settings: SETTINGS, fetch: plaid.fetch })), clock });
    assert.equal((await verifier.verify(signWebhook(body), raw)).ok, true);
    for (let i = 0; i < 200; i++) {
      // Junk kids need no valid signature: the lookup happens first. Throttled lookups throw; that's fine.
      await verifier.verify(signWebhook(body, { kid: `junk-${i}` }), raw).catch(() => undefined);
    }
    const before = plaid.keyFetches();
    assert.equal((await verifier.verify(signWebhook(body), raw)).ok, true, 'real key still cached');
    assert.equal(plaid.keyFetches(), before, 'no new lookup needed for the real key');
  });

  it('a re-encoded (high-S) copy of a delivery gets the same replay id', async () => {
    const plaid = fakePlaid();
    const verifier = new PlaidWebhookVerifier({ fetchKey: plaidKeySource(new PlaidBank({ settings: SETTINGS, fetch: plaid.fetch })), clock });
    const jwt = signWebhook(body);
    const [h, p, s = ''] = jwt.split('.');
    const sig = Buffer.from(s, 'base64url');
    const n = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551');
    const highS = n - BigInt(`0x${sig.subarray(32).toString('hex')}`);
    const malleated = Buffer.concat([sig.subarray(0, 32), Buffer.from(highS.toString(16).padStart(64, '0'), 'hex')]);
    const a = await verifier.verify(jwt, raw);
    const b = await verifier.verify(`${h}.${p}.${malleated.toString('base64url')}`, raw);
    assert.ok(a.ok);
    // Either rejected outright or recognised as the same delivery: never a fresh one.
    if (b.ok) assert.equal(b.tokenId, a.tokenId);
  });
});
