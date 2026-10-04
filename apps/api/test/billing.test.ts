import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign, verify, X509Certificate, createPrivateKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

process.env.TRIALGUARD_DISABLE_LLM = '1';
process.env.TRIALGUARD_JOBS = '0';

const { normalizeAlertPrefs } = await import('@trialguard/core');
const { Router } = await import('../src/http.ts');
const { RateLimiter } = await import('../src/ratelimit.ts');
const { defaultDeps } = await import('../src/pipeline.ts');
const { Store } = await import('../src/store.ts');
const { registerBillingRoutes } = await import('../src/routes/billing.ts');
const { verifyAppleChain, JwsError, parseCertificates } = await import('../src/billing/appleJws.ts');
const { decodeOid, extensionOids } = await import('../src/billing/der.ts');
const { planFromRecords, sweepExpiredSubscriptions, isEntitled } = await import('../src/billing/entitlement.ts');
const { googleJwks, maxAgeMs, GOOGLE_JWKS_URL } = await import('../src/billing/googleAuth.ts');
const { playApi } = await import('../src/billing/google.ts');
const { serviceAccountTokens, ANDROID_PUBLISHER_SCOPE } = await import('../src/billing/googleAuth.ts');
const { billingFromEnv } = await import('../src/billing/config.ts');

type StoreT = InstanceType<typeof Store>;
type BillingDeps = Parameters<typeof registerBillingRoutes>[1];

// ---------- fixtures (TEST-ONLY chain, see fixtures/billing/generate.sh) ----------

const fixture = (name: string) => readFileSync(new URL(`./fixtures/billing/${name}`, import.meta.url));
const cert = (name: string) => new X509Certificate(fixture(name));
const key = (name: string) => createPrivateKey(fixture(name));
const root = cert('root.pem');
const intermediate = cert('intermediate.pem');
const leaf = cert('leaf.pem');
const leafKey = key('leaf.key');
const unmarkedLeaf = cert('leaf-unmarked.pem');
const unmarkedKey = key('leaf-unmarked.key');
const rogueRoot = cert('rogue-root.pem');
const rogueIntermediate = cert('rogue-intermediate.pem');
const rogueLeaf = cert('rogue-leaf.pem');
const rogueKey = key('rogue-leaf.key');

const x5c = (...certs: X509Certificate[]) => certs.map((c) => c.raw.toString('base64'));
const GOOD_CHAIN = x5c(leaf, intermediate, root);
const b64json = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

/** Signs a payload as an App Store JWS (ES256, raw r||s signature, x5c chain). */
function appleJws(payload: unknown, opts: { key?: KeyObject; chain?: string[]; alg?: string } = {}): string {
  const header = b64json({ alg: opts.alg ?? 'ES256', x5c: opts.chain ?? GOOD_CHAIN });
  const body = b64json(payload);
  const sig = sign('sha256', Buffer.from(`${header}.${body}`), { key: opts.key ?? leafKey, dsaEncoding: 'ieee-p1363' });
  return `${header}.${body}.${sig.toString('base64url')}`;
}

// ---------- clock, store, server ----------

let now = new Date('2027-01-15T12:00:00Z');
const deps = { ...defaultDeps, llm: undefined, notifier: undefined, clock: () => now };
const DAY = 86_400_000;
const at = (offsetMs: number) => now.getTime() + offsetMs;

const BUNDLE = 'app.trialguard.ios';
const PACKAGE = 'app.trialguard.android';
const AUDIENCE = 'https://api.trialguard.test/api/billing/google/rtdn';
const PUSH_SA = 'pubsub-push@trialguard-test.iam.gserviceaccount.com';

function addUser(store: StoreT, plan: 'free' | 'plus' = 'free') {
  const id = `usr_${randomUUID().slice(0, 8)}`;
  const user = {
    id,
    email: `${id}@example.com`,
    token: `tok_${randomUUID()}`,
    plan,
    forwardToken: id,
    alertPrefs: normalizeAlertPrefs({}),
    createdAt: now.toISOString(),
  };
  store.data.users.push(user);
  return user;
}

async function serve(store: StoreT, billing: BillingDeps): Promise<{ base: string; server: Server }> {
  const router = new Router(store, new RateLimiter({ default: { capacity: 10_000, per: 60 }, webhook: { capacity: 10_000, per: 60 } }));
  registerBillingRoutes({ router, store, deps }, billing);
  const server = createServer((req, res) => {
    void router.handle(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  return { base: `http://localhost:${(server.address() as AddressInfo).port}`, server };
}

async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

// ---------- unit: certificate chain, DER, entitlement ----------

describe('App Store certificate chain', () => {
  const at2027 = new Date('2027-01-15T12:00:00Z');

  it('accepts leaf → intermediate → pinned root with Apple marker extensions', () => {
    assert.equal(verifyAppleChain([leaf, intermediate, root], [root], at2027), leaf);
  });

  it('reads extension OIDs from DER', () => {
    assert.equal(decodeOid(Buffer.from('2a864886f70d', 'hex')), '1.2.840.113549');
    assert.ok(extensionOids(leaf.raw).includes('1.2.840.113635.100.6.11.1'));
    assert.ok(extensionOids(intermediate.raw).includes('1.2.840.113635.100.6.2.1'));
    assert.ok(!extensionOids(unmarkedLeaf.raw).includes('1.2.840.113635.100.6.11.1'));
    assert.throws(() => extensionOids(Buffer.from('3082ffff', 'hex')));
  });

  const reason = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      assert.ok(err instanceof JwsError, String(err));
      return err.reason;
    }
    assert.fail('expected a JwsError');
  };

  it('rejects a chain under a different root, and a pinned root spliced onto a rogue chain', () => {
    assert.equal(reason(() => verifyAppleChain([rogueLeaf, rogueIntermediate, rogueRoot], [root], at2027)), 'untrusted_root');
    assert.equal(reason(() => verifyAppleChain([rogueLeaf, rogueIntermediate, root], [root], at2027)), 'chain');
    assert.equal(reason(() => verifyAppleChain([leaf, rogueIntermediate, root], [root], at2027)), 'chain');
  });

  it('rejects wrong chain length, missing marker OIDs and certificates outside their validity', () => {
    assert.equal(reason(() => verifyAppleChain([leaf, intermediate], [root], at2027)), 'chain');
    assert.equal(reason(() => verifyAppleChain([unmarkedLeaf, intermediate, root], [root], at2027)), 'marker');
    // A CA certificate in the leaf slot fails the CA-flag check before anything else.
    assert.equal(reason(() => verifyAppleChain([intermediate, intermediate, root], [root], at2027)), 'chain');
    assert.equal(reason(() => verifyAppleChain([leaf, intermediate, root], [root], new Date('2060-01-01T00:00:00Z'))), 'certificate_validity');
    assert.equal(reason(() => verifyAppleChain([leaf, intermediate, root], [root], new Date('2020-01-01T00:00:00Z'))), 'certificate_validity');
  });

  it('loads a pinned root from PEM or DER', () => {
    assert.ok(parseCertificates(fixture('root.pem'))[0]?.raw.equals(root.raw));
    assert.ok(parseCertificates(root.raw)[0]?.raw.equals(root.raw));
  });
});

describe('entitlement model', () => {
  const base = { id: 's', userId: 'u', platform: 'app_store' as const, productId: 'plus', externalId: 'x', updatedAt: '' };
  const t = new Date('2027-01-15T12:00:00Z');
  const future = '2027-02-01T00:00:00.000Z';
  const past = '2027-01-01T00:00:00.000Z';

  it('derives Plus from active or in-grace records only, and fails closed on missing dates', () => {
    assert.equal(planFromRecords([], t), 'free');
    assert.equal(planFromRecords([{ ...base, status: 'active', expiresAt: future }], t), 'plus');
    assert.equal(planFromRecords([{ ...base, status: 'active', expiresAt: past }], t), 'free');
    assert.equal(planFromRecords([{ ...base, status: 'active' }], t), 'free');
    assert.equal(planFromRecords([{ ...base, status: 'grace_period', expiresAt: past, gracePeriodExpiresAt: future }], t), 'plus');
    assert.equal(planFromRecords([{ ...base, status: 'grace_period', expiresAt: past, gracePeriodExpiresAt: past }], t), 'free');
    for (const status of ['billing_retry', 'expired', 'revoked', 'refunded', 'paused', 'pending'] as const) {
      assert.equal(isEntitled({ status, expiresAt: future }, t), false, status);
    }
    assert.equal(planFromRecords([{ ...base, status: 'refunded', expiresAt: future }, { ...base, status: 'active', expiresAt: future }], t), 'plus');
  });
});

// ---------- App Store notifications ----------

describe('App Store Server Notifications V2', () => {
  const store = new Store();
  let base = '';
  let server: Server;
  before(async () => {
    ({ base, server } = await serve(store, { apple: { bundleId: BUNDLE, roots: [root], environments: ['Production', 'Sandbox'] } }));
  });
  after(() => server.close());
  beforeEach(() => {
    now = new Date('2027-01-15T12:00:00Z');
  });

  let signedAt = at(0);
  /** Each notification is signed a little later than the previous one, like Apple's would be. */
  function notify(type: string, tx: Record<string, unknown>, opts: { subtype?: string; renewal?: Record<string, unknown>; bundleId?: string; uuid?: string } = {}) {
    signedAt += 1000;
    const transaction = { transactionId: randomUUID(), bundleId: BUNDLE, environment: 'Production', type: 'Auto-Renewable Subscription', productId: 'plus_monthly', signedDate: signedAt, ...tx };
    return appleJws({
      notificationType: type,
      subtype: opts.subtype,
      notificationUUID: opts.uuid ?? randomUUID(),
      version: '2.0',
      signedDate: signedAt,
      data: {
        bundleId: opts.bundleId ?? BUNDLE,
        environment: 'Production',
        signedTransactionInfo: appleJws(transaction),
        signedRenewalInfo: opts.renewal ? appleJws({ originalTransactionId: tx.originalTransactionId, environment: 'Production', ...opts.renewal }) : undefined,
      },
    });
  }
  const post = (signedPayload: string) => call(base, 'POST', '/api/billing/apple/notifications', { signedPayload });

  async function subscribedUser() {
    const user = addUser(store);
    const status = await call(base, 'GET', '/api/billing/status', undefined, { Authorization: `Bearer ${user.token}` });
    assert.equal(status.status, 200);
    const token = status.json.billingAccountToken as string;
    assert.match(token, /^[0-9a-f-]{36}$/);
    const otid = `2000000${Math.floor(Math.random() * 1e9)}`;
    const r = await post(notify('SUBSCRIBED', { originalTransactionId: otid, appAccountToken: token, expiresDate: at(30 * DAY) }, { subtype: 'INITIAL_BUY', renewal: { autoRenewStatus: 1 } }));
    assert.equal(r.status, 200);
    assert.equal(r.json.result, 'processed');
    return { user, token, otid };
  }

  it('a verified SUBSCRIBED notification turns Plus on, links by appAccountToken and audits it', async () => {
    const { user, otid } = await subscribedUser();
    assert.equal(user.plan, 'plus');
    const record = store.data.billing.find((b) => b.externalId === otid);
    assert.equal(record?.userId, user.id);
    assert.equal(record?.status, 'active');
    assert.equal(record?.autoRenew, true);
    assert.ok(store.data.audit.some((a) => a.userId === user.id && a.action === 'billing.plan_changed' && a.actor.type === 'system'));

    const status = await call(base, 'GET', '/api/billing/status', undefined, { Authorization: `Bearer ${user.token}` });
    assert.equal(status.json.plan, 'plus');
    assert.equal(status.json.subscriptions[0].status, 'active');
    assert.equal(status.json.subscriptions[0].manageUrl, 'https://apps.apple.com/account/subscriptions');
  });

  it('ignores a duplicate notificationUUID', async () => {
    const user = addUser(store);
    const token = (await call(base, 'GET', '/api/billing/status', undefined, { Authorization: `Bearer ${user.token}` })).json.billingAccountToken;
    const payload = notify('SUBSCRIBED', { originalTransactionId: 'dup-1', appAccountToken: token, expiresDate: at(30 * DAY) });
    assert.equal((await post(payload)).json.result, 'processed');
    const audits = store.data.audit.length;
    const again = await post(payload);
    assert.equal(again.status, 200);
    assert.equal(again.json.result, 'duplicate');
    assert.equal(store.data.audit.length, audits);
  });

  it('EXPIRED, REFUND and REVOKE take Plus away', async () => {
    for (const [type, status] of [
      ['EXPIRED', 'expired'],
      ['REFUND', 'refunded'],
      ['REVOKE', 'revoked'],
    ] as const) {
      const { user, otid, token } = await subscribedUser();
      assert.equal(user.plan, 'plus');
      const r = await post(notify(type, { originalTransactionId: otid, appAccountToken: token, expiresDate: at(30 * DAY), revocationDate: type === 'EXPIRED' ? undefined : at(0) }));
      assert.equal(r.status, 200);
      assert.equal(user.plan, 'free', type);
      assert.equal(store.data.billing.find((b) => b.externalId === otid)?.status, status);
    }
  });

  it('a grace period keeps Plus past expiry until the grace deadline; billing retry does not', async () => {
    const { user, otid, token } = await subscribedUser();
    now = new Date(at(31 * DAY));
    const graceEnds = at(6 * DAY);
    await post(notify('DID_FAIL_TO_RENEW', { originalTransactionId: otid, appAccountToken: token, expiresDate: at(-DAY) }, { subtype: 'GRACE_PERIOD', renewal: { autoRenewStatus: 1, gracePeriodExpiresDate: graceEnds } }));
    assert.equal(user.plan, 'plus');
    const record = store.data.billing.find((b) => b.externalId === otid);
    assert.equal(record?.status, 'grace_period');
    assert.equal(record?.gracePeriodExpiresAt, new Date(graceEnds).toISOString());

    // Apple's GRACE_PERIOD_EXPIRED gets lost; the daily sweep notices the deadline passed.
    now = new Date(graceEnds + 1000);
    const swept = sweepExpiredSubscriptions(store, now);
    assert.ok(swept.downgraded.includes(user.id));
    assert.equal(user.plan, 'free');

    const other = await subscribedUser();
    await post(notify('DID_FAIL_TO_RENEW', { originalTransactionId: other.otid, appAccountToken: other.token, expiresDate: at(-DAY) }));
    assert.equal(other.user.plan, 'free');
    assert.equal(store.data.billing.find((b) => b.externalId === other.otid)?.status, 'billing_retry');
  });

  it('DID_CHANGE_RENEWAL_STATUS updates auto-renew without touching the plan', async () => {
    const { user, otid, token } = await subscribedUser();
    await post(notify('DID_CHANGE_RENEWAL_STATUS', { originalTransactionId: otid, appAccountToken: token, expiresDate: at(30 * DAY) }, { subtype: 'AUTO_RENEW_DISABLED', renewal: { autoRenewStatus: 0 } }));
    const record = store.data.billing.find((b) => b.externalId === otid);
    assert.equal(record?.autoRenew, false);
    assert.equal(record?.status, 'active');
    assert.equal(user.plan, 'plus');
  });

  it('a refresh keeps a billing problem until Apple shows a newer paid period', async () => {
    const { user, otid, token } = await subscribedUser();
    const firstExpiry = at(30 * DAY);
    now = new Date(at(31 * DAY));
    await post(notify('DID_FAIL_TO_RENEW', { originalTransactionId: otid, appAccountToken: token, expiresDate: firstExpiry }));
    assert.equal(user.plan, 'free');
    // Auto-renew toggled while the payment problem stands: still billing_retry.
    await post(notify('DID_CHANGE_RENEWAL_STATUS', { originalTransactionId: otid, appAccountToken: token, expiresDate: firstExpiry }, { subtype: 'AUTO_RENEW_ENABLED' }));
    assert.equal(store.data.billing.find((b) => b.externalId === otid)?.status, 'billing_retry');
    // The user fixed their card; the app verifies the renewed transaction before DID_RENEW arrives.
    signedAt += 1000;
    const renewed = appleJws({ transactionId: randomUUID(), originalTransactionId: otid, bundleId: BUNDLE, environment: 'Production', type: 'Auto-Renewable Subscription', productId: 'plus_monthly', signedDate: signedAt, expiresDate: at(30 * DAY), appAccountToken: token });
    const r = await call(base, 'POST', '/api/billing/apple/verify', { signedTransaction: renewed }, { Authorization: `Bearer ${user.token}` });
    assert.equal(r.status, 200);
    assert.equal(user.plan, 'plus');
  });

  it('a late, older notification cannot revive a refunded subscription', async () => {
    const { user, otid, token } = await subscribedUser();
    const lateRenewal = notify('DID_RENEW', { originalTransactionId: otid, appAccountToken: token, expiresDate: at(60 * DAY) });
    await post(notify('REFUND', { originalTransactionId: otid, appAccountToken: token, expiresDate: at(30 * DAY), revocationDate: at(0) }));
    assert.equal(user.plan, 'free');
    const r = await post(lateRenewal);
    assert.equal(r.json.result, 'stale');
    assert.equal(user.plan, 'free');
  });

  it('rejects forged, tampered and foreign payloads with 400 and changes nothing', async () => {
    const user = addUser(store);
    const token = (await call(base, 'GET', '/api/billing/status', undefined, { Authorization: `Bearer ${user.token}` })).json.billingAccountToken;
    const tx = { transactionId: '1', originalTransactionId: 'forged-1', bundleId: BUNDLE, environment: 'Production', type: 'Auto-Renewable Subscription', productId: 'plus_monthly', signedDate: at(0), appAccountToken: token, expiresDate: at(30 * DAY) };
    const notification = (signedTransactionInfo: string, bundleId = BUNDLE) => ({
      notificationType: 'SUBSCRIBED',
      notificationUUID: randomUUID(),
      signedDate: at(0),
      data: { bundleId, environment: 'Production', signedTransactionInfo },
    });
    const valid = appleJws(notification(appleJws(tx)));
    const [h, p, s] = valid.split('.');
    const tampered = `${h}.${b64json({ ...notification(appleJws(tx)), notificationType: 'SUBSCRIBED', notificationUUID: randomUUID() })}.${s}`;
    assert.ok(p);

    const cases: [string, string][] = [
      ['rogue chain', appleJws(notification(appleJws(tx)), { key: rogueKey, chain: x5c(rogueLeaf, rogueIntermediate, rogueRoot) })],
      ['pinned root spliced onto rogue chain', appleJws(notification(appleJws(tx)), { key: rogueKey, chain: x5c(rogueLeaf, rogueIntermediate, root) })],
      ['unmarked leaf', appleJws(notification(appleJws(tx)), { key: unmarkedKey, chain: x5c(unmarkedLeaf, intermediate, root) })],
      ['tampered payload', tampered],
      ['signed by a key that is not the leaf', appleJws(notification(appleJws(tx)), { key: rogueKey })],
      ['alg none', `${b64json({ alg: 'none', x5c: GOOD_CHAIN })}.${p}.`],
      ['alg HS256', appleJws(notification(appleJws(tx)), { alg: 'HS256' })],
      ['wrong bundle', appleJws(notification(appleJws(tx), 'com.someone.else'))],
      ['wrong bundle inside the transaction', appleJws(notification(appleJws({ ...tx, bundleId: 'com.someone.else' })))],
      ['forged nested transaction', appleJws(notification(appleJws(tx, { key: rogueKey, chain: x5c(rogueLeaf, rogueIntermediate, rogueRoot) })))],
      ['not a JWS', 'hello'],
    ];
    for (const [name, payload] of cases) {
      const r = await post(payload);
      assert.equal(r.status, 400, name);
      assert.equal(r.json.error, 'Invalid notification', name);
    }
    assert.equal(user.plan, 'free');
    assert.ok(!store.data.billing.some((b) => b.externalId === 'forged-1'));

    // Signed with a valid chain but presented after the pinned root was rotated out.
    const { base: otherBase, server: other } = await serve(new Store(), { apple: { bundleId: BUNDLE, roots: [rogueRoot], environments: ['Production'] } });
    const r = await call(otherBase, 'POST', '/api/billing/apple/notifications', { signedPayload: valid });
    other.close();
    assert.equal(r.status, 400);
  });

  it('acknowledges notifications it cannot link to an account', async () => {
    const r = await post(notify('SUBSCRIBED', { originalTransactionId: 'nobody-1', appAccountToken: randomUUID(), expiresDate: at(30 * DAY) }));
    assert.equal(r.status, 200);
    assert.equal(r.json.result, 'unlinked');
    assert.ok(!store.data.billing.some((b) => b.externalId === 'nobody-1'));
  });

  it('logs and ignores types it does not act on', async () => {
    const r = await post(
      appleJws({ notificationType: 'TEST', notificationUUID: randomUUID(), signedDate: at(0), data: { bundleId: BUNDLE, environment: 'Sandbox' } }),
    );
    assert.equal(r.status, 200);
    assert.equal(r.json.result, 'ignored');
  });

  it('POST /apple/verify links a purchase the app just made, only for the account that made it', async () => {
    const user = addUser(store);
    const auth = { Authorization: `Bearer ${user.token}` };
    const token = (await call(base, 'GET', '/api/billing/status', undefined, auth)).json.billingAccountToken as string;
    const tx = (appAccountToken: string, extra: Record<string, unknown> = {}) =>
      appleJws({ transactionId: randomUUID(), originalTransactionId: 'client-1', bundleId: BUNDLE, environment: 'Sandbox', type: 'Auto-Renewable Subscription', productId: 'plus_annual', signedDate: at(0), expiresDate: at(365 * DAY), appAccountToken, ...extra });

    const someoneElse = await call(base, 'POST', '/api/billing/apple/verify', { signedTransaction: tx(randomUUID()) }, auth);
    assert.equal(someoneElse.status, 403);
    assert.equal(user.plan, 'free');

    const forged = await call(base, 'POST', '/api/billing/apple/verify', { signedTransaction: appleJws({ originalTransactionId: 'client-1' }, { key: rogueKey }) }, auth);
    assert.equal(forged.status, 400);

    const ok = await call(base, 'POST', '/api/billing/apple/verify', { signedTransaction: tx(token.toUpperCase()) }, auth);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.plan, 'plus');
    assert.equal(user.plan, 'plus');

    // Unauthenticated callers get nothing.
    assert.equal((await call(base, 'POST', '/api/billing/apple/verify', { signedTransaction: tx(token) })).status, 401);
  });

  it('answers 503 while App Store billing is not configured', async () => {
    const { base: b, server: s } = await serve(new Store(), {});
    const r = await call(b, 'POST', '/api/billing/apple/notifications', { signedPayload: 'x.y.z' });
    s.close();
    assert.equal(r.status, 503);
  });
});

// ---------- Google Play RTDN ----------

describe('Google Play real-time developer notifications', () => {
  const googleKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const imposterKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const serviceAccountKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const KID = 'test-kid-1';
  const ACCESS_TOKEN = 'ya29.test-access-token';

  interface FakeSub {
    subscriptionState: string;
    acknowledgementState: string;
    expiryTime: string;
    obfuscatedExternalAccountId?: string;
    linkedPurchaseToken?: string;
    autoRenewEnabled?: boolean;
  }
  const subs = new Map<string, FakeSub>();
  const calls = { jwks: 0, token: 0, get: 0, ack: [] as string[] };
  let playDown = false;

  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
    if (url === GOOGLE_JWKS_URL) {
      calls.jwks++;
      return json({ keys: [{ ...googleKey.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }] }, 200, { 'Cache-Control': 'public, max-age=3600' });
    }
    if (url === 'https://oauth2.googleapis.com/token') {
      calls.token++;
      // The assertion must be a JWT signed with the service account key, for the Play scope.
      const assertion = new URLSearchParams(String(init?.body)).get('assertion') ?? '';
      const [h, p, s] = assertion.split('.');
      assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), serviceAccountKey.publicKey, Buffer.from(s ?? '', 'base64url')));
      assert.equal(JSON.parse(Buffer.from(p ?? '', 'base64url').toString()).scope, ANDROID_PUBLISHER_SCOPE);
      return json({ access_token: ACCESS_TOKEN, expires_in: 3600, token_type: 'Bearer' });
    }
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), `Bearer ${ACCESS_TOKEN}`);
    const m = /\/applications\/([^/]+)\/purchases\/(subscriptionsv2\/tokens\/([^/:]+)|subscriptions\/([^/]+)\/tokens\/([^/:]+):acknowledge)$/.exec(url);
    assert.ok(m, `unexpected URL ${url}`);
    assert.equal(decodeURIComponent(m[1] ?? ''), PACKAGE);
    if (playDown) return json({ error: { code: 503 } }, 503);
    if (m[3]) {
      calls.get++;
      const sub = subs.get(decodeURIComponent(m[3]));
      if (!sub) return json({ error: { code: 404 } }, 404);
      return json({
        kind: 'androidpublisher#subscriptionPurchaseV2',
        subscriptionState: sub.subscriptionState,
        acknowledgementState: sub.acknowledgementState,
        linkedPurchaseToken: sub.linkedPurchaseToken,
        externalAccountIdentifiers: sub.obfuscatedExternalAccountId ? { obfuscatedExternalAccountId: sub.obfuscatedExternalAccountId } : undefined,
        lineItems: [{ productId: 'plus_monthly', expiryTime: sub.expiryTime, autoRenewingPlan: { autoRenewEnabled: sub.autoRenewEnabled ?? true } }],
      });
    }
    assert.equal(init?.method, 'POST');
    const token = decodeURIComponent(m[5] ?? '');
    assert.equal(decodeURIComponent(m[4] ?? ''), 'plus_monthly');
    calls.ack.push(token);
    const sub = subs.get(token);
    if (sub) sub.acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
    return json({});
  }) as typeof fetch;

  function oidcToken(claims: Record<string, unknown> = {}, opts: { key?: KeyObject; kid?: string; alg?: string } = {}) {
    const iat = Math.floor(now.getTime() / 1000);
    const header = b64json({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? KID, typ: 'JWT' });
    const payload = b64json({ iss: 'https://accounts.google.com', aud: AUDIENCE, email: PUSH_SA, email_verified: true, sub: '1234', azp: '1234', iat, exp: iat + 3600, ...claims });
    const sig = sign('sha256', Buffer.from(`${header}.${payload}`), opts.key ?? googleKey.privateKey).toString('base64url');
    return `Bearer ${header}.${payload}.${sig}`;
  }

  const store = new Store();
  let base = '';
  let server: Server;
  before(async () => {
    const clock = () => now;
    const account = {
      client_email: 'play-api@trialguard-test.iam.gserviceaccount.com',
      private_key: serviceAccountKey.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      token_uri: 'https://oauth2.googleapis.com/token',
    };
    ({ base, server } = await serve(store, {
      google: {
        packageName: PACKAGE,
        push: { audience: AUDIENCE, serviceAccountEmail: PUSH_SA },
        jwks: googleJwks({ fetch: fakeFetch, clock }),
        play: playApi({ fetch: fakeFetch, tokens: serviceAccountTokens({ account, scope: ANDROID_PUBLISHER_SCOPE, fetch: fakeFetch, clock }) }),
      },
    }));
  });
  after(() => server.close());
  beforeEach(() => {
    now = new Date('2027-01-15T12:00:00Z');
    playDown = false;
  });

  let messages = 0;
  function push(notification: Record<string, unknown>, opts: { messageId?: string; auth?: string } = {}) {
    const messageId = opts.messageId ?? `msg-${++messages}`;
    const body = {
      message: { data: Buffer.from(JSON.stringify({ version: '1.0', packageName: PACKAGE, eventTimeMillis: String(now.getTime()), ...notification })).toString('base64'), messageId, publishTime: now.toISOString() },
      subscription: 'projects/trialguard-test/subscriptions/play-rtdn',
    };
    return call(base, 'POST', '/api/billing/google/rtdn', body, { Authorization: opts.auth ?? oidcToken() });
  }
  const subscriptionEvent = (purchaseToken: string, notificationType = 4) => ({ subscriptionNotification: { version: '1.0', notificationType, purchaseToken } });

  async function playUser() {
    const user = addUser(store);
    const token = (await call(base, 'GET', '/api/billing/status', undefined, { Authorization: `Bearer ${user.token}` })).json.billingAccountToken as string;
    const purchaseToken = `pt-${randomUUID()}`;
    subs.set(purchaseToken, {
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
      expiryTime: new Date(at(30 * DAY)).toISOString(),
      obfuscatedExternalAccountId: token,
    });
    return { user, purchaseToken };
  }

  it('rejects push requests without a valid Google OIDC token, before touching the Play API', async () => {
    const { user, purchaseToken } = await playUser();
    const before = calls.get;
    const iat = Math.floor(now.getTime() / 1000);
    const bad: [string, string | undefined][] = [
      ['missing', ''],
      ['wrong audience', oidcToken({ aud: 'https://evil.example/rtdn' })],
      ['expired', oidcToken({ iat: iat - 7200, exp: iat - 3600 })],
      ['issued in the future', oidcToken({ iat: iat + 600, exp: iat + 4200 })],
      ['bad signature', oidcToken({}, { key: imposterKey.privateKey })],
      ['unknown key id', oidcToken({}, { kid: 'nope' })],
      ['wrong service account', oidcToken({ email: 'someone@evil.iam.gserviceaccount.com' })],
      ['unverified email', oidcToken({ email_verified: false })],
      ['wrong issuer', oidcToken({ iss: 'https://evil.example' })],
      ['alg none', `Bearer ${b64json({ alg: 'none', kid: KID })}.${b64json({ aud: AUDIENCE })}.x`],
    ];
    for (const [name, auth] of bad) {
      const r = await push(subscriptionEvent(purchaseToken), { auth });
      assert.equal(r.status, 401, name);
    }
    assert.equal(calls.get, before);
    assert.equal(user.plan, 'free');
  });

  it('a verified RTDN fetches the real state, turns Plus on and acknowledges the purchase exactly once', async () => {
    const { user, purchaseToken } = await playUser();
    const r = await push(subscriptionEvent(purchaseToken, 4), { messageId: 'purchase-1' });
    assert.equal(r.status, 200);
    assert.equal(r.json.result, 'processed');
    assert.equal(user.plan, 'plus');
    assert.deepEqual(calls.ack.filter((t) => t === purchaseToken), [purchaseToken]);
    const record = store.data.billing.find((b) => b.externalId === purchaseToken);
    assert.equal(record?.platform, 'google_play');
    assert.equal(record?.status, 'active');

    // Pub/Sub redelivery: ignored without another Play API call.
    const gets = calls.get;
    const dup = await push(subscriptionEvent(purchaseToken, 4), { messageId: 'purchase-1' });
    assert.equal(dup.json.result, 'duplicate');
    assert.equal(calls.get, gets);

    // A later renewal is already acknowledged: no second acknowledge.
    const sub = subs.get(purchaseToken);
    assert.ok(sub);
    sub.expiryTime = new Date(at(60 * DAY)).toISOString();
    await push(subscriptionEvent(purchaseToken, 2));
    assert.equal(calls.ack.filter((t) => t === purchaseToken).length, 1);
    assert.equal(store.data.billing.find((b) => b.externalId === purchaseToken)?.expiresAt, sub.expiryTime);

    // JWKS and the access token were fetched once and cached.
    assert.equal(calls.jwks, 1);
    assert.equal(calls.token, 1);
  });

  it('cancelled keeps Plus until expiry; expiry, account hold and voided purchases take it away', async () => {
    const { user, purchaseToken } = await playUser();
    await push(subscriptionEvent(purchaseToken, 4));
    const sub = subs.get(purchaseToken);
    assert.ok(sub);

    sub.subscriptionState = 'SUBSCRIPTION_STATE_CANCELED';
    sub.autoRenewEnabled = false;
    await push(subscriptionEvent(purchaseToken, 3));
    assert.equal(user.plan, 'plus');
    assert.equal(store.data.billing.find((b) => b.externalId === purchaseToken)?.autoRenew, false);

    sub.subscriptionState = 'SUBSCRIPTION_STATE_EXPIRED';
    await push(subscriptionEvent(purchaseToken, 13));
    assert.equal(user.plan, 'free');

    const held = await playUser();
    await push(subscriptionEvent(held.purchaseToken, 4));
    const heldSub = subs.get(held.purchaseToken);
    assert.ok(heldSub);
    heldSub.subscriptionState = 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD';
    await push(subscriptionEvent(held.purchaseToken, 6));
    assert.equal(held.user.plan, 'plus', 'grace period keeps access');
    heldSub.subscriptionState = 'SUBSCRIPTION_STATE_ON_HOLD';
    heldSub.expiryTime = new Date(at(-DAY)).toISOString();
    await push(subscriptionEvent(held.purchaseToken, 5));
    assert.equal(held.user.plan, 'free', 'account hold removes access');

    const refunded = await playUser();
    await push(subscriptionEvent(refunded.purchaseToken, 4));
    assert.equal(refunded.user.plan, 'plus');
    const v = await push({ voidedPurchaseNotification: { purchaseToken: refunded.purchaseToken, orderId: 'GPA.1', productType: 1, refundType: 1 } });
    assert.equal(v.status, 200);
    assert.equal(refunded.user.plan, 'free');
    // Play may still report the refunded period as active (cancelled); it stays refunded.
    const refundedSub = subs.get(refunded.purchaseToken);
    assert.ok(refundedSub);
    refundedSub.subscriptionState = 'SUBSCRIPTION_STATE_CANCELED';
    await push(subscriptionEvent(refunded.purchaseToken, 3));
    assert.equal(refunded.user.plan, 'free');
    assert.equal(store.data.billing.find((b) => b.externalId === refunded.purchaseToken)?.status, 'refunded');
  });

  it('moves entitlement to the new token on upgrade and retires the linked one', async () => {
    const { user, purchaseToken } = await playUser();
    await push(subscriptionEvent(purchaseToken, 4));
    const newToken = `pt-${randomUUID()}`;
    subs.set(newToken, {
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
      expiryTime: new Date(at(365 * DAY)).toISOString(),
      linkedPurchaseToken: purchaseToken,
    });
    await push(subscriptionEvent(newToken, 4));
    assert.equal(user.plan, 'plus');
    assert.equal(store.data.billing.find((b) => b.externalId === purchaseToken)?.status, 'expired');
    assert.equal(store.data.billing.find((b) => b.externalId === newToken)?.userId, user.id);
    assert.ok(calls.ack.includes(newToken));
  });

  it('does not acknowledge a purchase it cannot link to an account', async () => {
    const purchaseToken = `pt-${randomUUID()}`;
    subs.set(purchaseToken, { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING', expiryTime: new Date(at(30 * DAY)).toISOString(), obfuscatedExternalAccountId: randomUUID() });
    const r = await push(subscriptionEvent(purchaseToken, 4));
    assert.equal(r.status, 200);
    assert.equal(r.json.result, 'unlinked');
    assert.ok(!calls.ack.includes(purchaseToken));
  });

  it('answers 502 when the Play API is down, so Pub/Sub retries the same message', async () => {
    const { user, purchaseToken } = await playUser();
    playDown = true;
    const failed = await push(subscriptionEvent(purchaseToken, 4), { messageId: 'retry-1' });
    assert.equal(failed.status, 502);
    assert.equal(user.plan, 'free');
    playDown = false;
    const retried = await push(subscriptionEvent(purchaseToken, 4), { messageId: 'retry-1' });
    assert.equal(retried.status, 200);
    assert.equal(retried.json.result, 'processed');
    assert.equal(user.plan, 'plus');
  });

  it('rejects another app’s notifications and ignores test notifications', async () => {
    const r = await push({ packageName: 'com.someone.else', testNotification: { version: '1.0' } });
    assert.equal(r.status, 400);
    const t = await push({ testNotification: { version: '1.0' } });
    assert.equal(t.status, 200);
    assert.equal(t.json.result, 'ignored');
  });

  it('JWKS cache honours max-age and refetches after it', async () => {
    let t = 0;
    let fetches = 0;
    const jwks = googleJwks({
      clock: () => new Date(t),
      fetch: (async () => {
        fetches++;
        return new Response(JSON.stringify({ keys: [{ ...googleKey.publicKey.export({ format: 'jwk' }), kid: KID }] }), { headers: { 'Cache-Control': 'max-age=120' } });
      }) as unknown as typeof fetch,
    });
    assert.ok(await jwks.key(KID));
    t += 60_000;
    assert.ok(await jwks.key(KID));
    assert.equal(fetches, 1);
    // Unknown kids may refetch, but only once a minute.
    assert.equal(await jwks.key('other'), undefined);
    assert.equal(await jwks.key('other'), undefined);
    assert.equal(fetches, 2);
    t += 121_000;
    await jwks.key(KID);
    assert.equal(fetches, 3);
    assert.equal(maxAgeMs('public, max-age=19850, must-revalidate'), 19_850_000);
    assert.equal(maxAgeMs(null), 3_600_000);
  });
});

// ---------- sweep and config ----------

describe('sweepExpiredSubscriptions', () => {
  it('downgrades users whose subscriptions lapsed without a notification, and leaves others alone', () => {
    const store = new Store();
    const t = new Date('2027-03-01T00:00:00Z');
    const lapsed = addUser(store, 'plus');
    const renewing = addUser(store, 'plus');
    const devPlus = addUser(store, 'plus');
    const record = (userId: string, expiresAt: string) => ({
      id: `sub_${userId}`,
      userId,
      platform: 'google_play' as const,
      productId: 'plus_monthly',
      externalId: `pt-${userId}`,
      status: 'active' as const,
      expiresAt,
      updatedAt: '2027-01-01T00:00:00.000Z',
    });
    store.data.billing.push(record(lapsed.id, '2027-02-27T00:00:00.000Z'), record(renewing.id, '2027-03-20T00:00:00.000Z'));
    const result = sweepExpiredSubscriptions(store, t);
    assert.deepEqual(result.downgraded, [lapsed.id]);
    assert.equal(result.checked, 2);
    assert.equal(lapsed.plan, 'free');
    assert.equal(renewing.plan, 'plus');
    assert.equal(devPlus.plan, 'plus', 'users without billing records are not touched');
    assert.ok(store.data.audit.some((a) => a.userId === lapsed.id && a.action === 'billing.plan_changed' && a.details?.reason === 'sweep'));
    // Idempotent.
    assert.deepEqual(sweepExpiredSubscriptions(store, t).downgraded, []);
  });
});

describe('billing config', () => {
  it('stays off when unset, loads the pinned root when set, and refuses half a configuration', () => {
    const clock = () => now;
    assert.deepEqual(billingFromEnv({ clock, env: {} }), {});
    const path = new URL('./fixtures/billing/root.pem', import.meta.url).pathname;
    const apple = billingFromEnv({ clock, env: { APPLE_BUNDLE_ID: BUNDLE, APPLE_ROOT_CA_PATH: path } }).apple;
    assert.ok(apple?.roots[0]?.raw.equals(root.raw));
    assert.deepEqual(apple?.environments, ['Production', 'Sandbox']);
    assert.throws(() => billingFromEnv({ clock, env: { APPLE_BUNDLE_ID: BUNDLE } }), /APPLE_ROOT_CA_PATH/);
    assert.throws(() => billingFromEnv({ clock, env: { GOOGLE_PLAY_PACKAGE_NAME: PACKAGE } }), /GOOGLE_PUBSUB_AUDIENCE/);
  });
});
