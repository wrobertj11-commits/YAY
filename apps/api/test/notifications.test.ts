import assert from 'node:assert/strict';
import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createH2Server, type Http2Server } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

process.env.TRIALGUARD_DISABLE_LLM = '1';
process.env.TRIALGUARD_JOBS = '0';

const { normalizeAlertPrefs } = await import('@trialguard/core');
const { createApp } = await import('../src/app.ts');
const { signPayload } = await import('../src/crypto.ts');
const { defaultDeps } = await import('../src/pipeline.ts');
const { Store } = await import('../src/store.ts');
const { counterValue, renderPrometheus } = await import('../src/metrics.ts');
const { createScheduler, registerDailyJob } = await import('../src/jobs.ts');
const { dispatchDueAlerts } = await import('../src/notify.ts');
const d = await import('../src/delivery/index.ts');

type StoreT = InstanceType<typeof Store>;
type Alert = StoreT['data']['alerts'][number];
type Item = StoreT['data']['items'][number];
type Device = StoreT['data']['devices'][number];
type User = StoreT['data']['users'][number];

const T0 = new Date('2026-10-03T15:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;
const scratch = mkdtempSync(path.join(tmpdir(), 'trialguard-notify-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function makeUser(id = 'usr_a'): User {
  return { id, email: `${id}@example.com`, token: `tok_${id}`, plan: 'plus', forwardToken: `f${id}`, alertPrefs: normalizeAlertPrefs({}), createdAt: T0.toISOString() };
}

function makeItem(id: string, status: Item['status'], date = '2026-10-05', userId = 'usr_a'): Item {
  return {
    id,
    userId,
    matchKey: id,
    name: 'Headspace',
    kind: status === 'trial' ? 'trial' : 'subscription',
    status,
    amountCents: 6999,
    cadence: 'annual',
    trialEndsAt: status === 'trial' ? date : undefined,
    nextChargeDate: date,
    rail: 'card',
    sources: ['manual'],
    confidence: 1,
    confirmedByUser: true,
    transactionIds: [],
    emailIds: [],
    priceHistory: [],
    createdAt: T0.toISOString(),
    updatedAt: T0.toISOString(),
  };
}

function makeAlert(id: string, overrides: Partial<Alert> = {}): Alert {
  return {
    id,
    itemId: 'itm_a',
    userId: 'usr_a',
    type: 'trial_converting',
    channel: 'push',
    leadHours: 48,
    sendAt: T0.toISOString(),
    dueAt: '2026-10-05T12:00:00.000Z',
    title: 'Headspace trial ends in 2 days',
    body: 'Your free trial converts on Oct 5 and $69.99/yr will be charged.',
    status: 'pending',
    attempts: 0,
    ...overrides,
  };
}

function fixture(file?: string) {
  const store = new Store(file);
  store.data.users.push(makeUser());
  store.data.items.push(makeItem('itm_a', 'trial'));
  return store;
}

const noJitter = { random: () => 0.5 };

/** Records what was sent; optionally fails or waits. */
function recorder(behaviour: (alert: Alert, n: number) => Promise<void> | void = () => {}) {
  const sent: string[] = [];
  let n = 0;
  return {
    sent,
    notifier: {
      async send(_user: User, alert: Alert) {
        await behaviour(alert, ++n);
        sent.push(alert.id);
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------

describe('outbox: send-once delivery', () => {
  it('claims with a lease and flushes the claim to disk before calling the provider', async () => {
    const file = path.join(scratch, 'claim.json');
    const store = fixture(file);
    store.data.alerts.push(makeAlert('a1'));
    let seenOnDisk: Alert | undefined;
    let seenInMemory: Alert | undefined;
    const { notifier } = recorder((alert) => {
      seenInMemory = { ...alert };
      seenOnDisk = (JSON.parse(readFileSync(file, 'utf8')) as StoreT['data']).alerts.find((a) => a.id === 'a1');
    });
    const report = await d.dispatchOutbox(store, notifier, { clock: () => T0, instanceId: 'inst-1' });
    assert.equal(report.sent, 1);
    assert.equal(seenInMemory?.status, 'sending');
    assert.equal(seenOnDisk?.status, 'sending', 'claim is durable before the send');
    assert.equal(seenOnDisk?.claimedBy, 'inst-1');
    assert.equal(seenOnDisk?.claimedAt, T0.toISOString());
    assert.equal(seenOnDisk?.attempts, 1);
    const onDisk = (JSON.parse(readFileSync(file, 'utf8')) as StoreT['data']).alerts[0];
    assert.equal(onDisk?.status, 'sent');
    assert.equal(onDisk?.sentAt, T0.toISOString());
  });

  it('never sends alerts that are not due, and never sends one twice', async () => {
    const store = fixture();
    store.data.alerts.push(makeAlert('due'), makeAlert('later', { sendAt: at(5 * MIN).toISOString() }));
    const { sent, notifier } = recorder();
    await d.dispatchOutbox(store, notifier, { clock: () => T0 });
    await d.dispatchOutbox(store, notifier, { clock: () => T0 });
    assert.deepEqual(sent, ['due']);
    await d.dispatchOutbox(store, notifier, { clock: () => at(5 * MIN) });
    assert.deepEqual(sent, ['due', 'later']);
  });

  it('skips (with a reason) alerts whose user, item or relevance is gone', async () => {
    const store = fixture();
    store.data.users.push({ ...makeUser('usr_b'), alertPrefs: normalizeAlertPrefs({ types: { renewal: false } as never }) });
    store.data.items.push(makeItem('itm_active', 'active'), makeItem('itm_cancelled', 'cancel_pending'), makeItem('itm_b', 'active', '2026-10-05', 'usr_b'));
    store.data.alerts.push(
      makeAlert('ghost-user', { userId: 'usr_gone' }),
      makeAlert('ghost-item', { itemId: 'itm_gone' }),
      makeAlert('converted', { itemId: 'itm_active' }),
      makeAlert('cancelled', { itemId: 'itm_cancelled', type: 'renewal' }),
      makeAlert('too-late', { dueAt: at(-MIN).toISOString() }),
      makeAlert('type-off', { userId: 'usr_b', itemId: 'itm_b', type: 'renewal' }),
      makeAlert('ok'),
    );
    const { sent, notifier } = recorder();
    const report = await d.dispatchOutbox(store, notifier, { clock: () => T0 });
    assert.deepEqual(sent, ['ok']);
    assert.equal(report.skipped, 6);
    const reason = (id: string) => store.data.alerts.find((a) => a.id === id)?.skipReason;
    assert.equal(reason('ghost-user'), 'user_gone');
    assert.equal(reason('ghost-item'), 'item_gone');
    assert.equal(reason('converted'), 'item_not_live');
    assert.equal(reason('cancelled'), 'item_not_live');
    assert.equal(reason('too-late'), 'past_due');
    assert.equal(reason('type-off'), 'type_off');
    assert.ok(store.data.alerts.filter((a) => a.id !== 'ok').every((a) => a.status === 'skipped'));
  });

  it('re-queues a crashed claim once its lease expires, and leaves live claims alone', async () => {
    const store = fixture();
    store.data.alerts.push(
      makeAlert('crashed', { status: 'sending', claimedBy: 'dead-instance', claimedAt: at(-10 * MIN).toISOString(), attempts: 1 }),
      makeAlert('in-flight', { status: 'sending', claimedBy: 'other-instance', claimedAt: at(-MIN).toISOString(), attempts: 1 }),
      makeAlert('exhausted', { status: 'sending', claimedBy: 'dead-instance', claimedAt: at(-10 * MIN).toISOString(), attempts: 8 }),
    );
    const { sent, notifier } = recorder();
    const report = await d.dispatchOutbox(store, notifier, { clock: () => T0, leaseMs: 5 * MIN, maxAttempts: 8 });
    assert.equal(report.recovered, 2);
    assert.deepEqual(sent, ['crashed'], 'at-least-once: the crashed send goes out again');
    const byId = (id: string) => store.data.alerts.find((a) => a.id === id);
    assert.equal(byId('crashed')?.status, 'sent');
    assert.equal(byId('crashed')?.attempts, 2);
    assert.equal(byId('in-flight')?.status, 'sending', 'a live lease is not stolen');
    assert.equal(byId('exhausted')?.status, 'failed');
  });

  it('retries with exponential backoff, honours Retry-After, then gives up', async () => {
    const store = fixture();
    store.data.alerts.push(makeAlert('flaky'));
    const { notifier } = recorder(() => {
      throw new Error('ECONNRESET');
    });
    const opts = { ...noJitter, baseBackoffMs: MIN, maxAttempts: 3, instanceId: 'i1' };
    const alert = () => store.data.alerts[0];

    let r = await d.dispatchOutbox(store, notifier, { ...opts, clock: () => T0 });
    assert.equal(r.retried, 1);
    assert.equal(alert()?.status, 'pending');
    assert.equal(alert()?.attempts, 1);
    assert.equal(alert()?.nextAttemptAt, at(MIN).toISOString(), '1st retry after the base delay');
    assert.equal(alert()?.claimedBy, undefined);
    assert.match(alert()?.lastError ?? '', /ECONNRESET/);

    r = await d.dispatchOutbox(store, notifier, { ...opts, clock: () => at(30_000) });
    assert.equal(r.retried + r.failed + r.sent, 0, 'not attempted before nextAttemptAt');

    await d.dispatchOutbox(store, notifier, { ...opts, clock: () => at(MIN) });
    assert.equal(alert()?.attempts, 2);
    assert.equal(alert()?.nextAttemptAt, at(MIN + 2 * MIN).toISOString(), 'delay doubles');

    r = await d.dispatchOutbox(store, notifier, { ...opts, clock: () => at(3 * MIN) });
    assert.equal(r.failed, 1);
    assert.equal(alert()?.status, 'failed');
    assert.equal(alert()?.attempts, 3);

    // A provider's Retry-After wins over a shorter backoff; a permanent error fails at once.
    const s2 = fixture();
    s2.data.alerts.push(makeAlert('throttled'), makeAlert('rejected', { sendAt: at(-MIN).toISOString() }));
    await d.dispatchOutbox(
      s2,
      {
        async send(_u, a) {
          if (a.id === 'rejected') throw new d.DeliveryError('Postmark HTTP 422 error 406', { retryable: false });
          throw new d.DeliveryError('429', { retryable: true, retryAfterMs: 30 * MIN });
        },
      },
      { ...opts, clock: () => T0 },
    );
    assert.equal(s2.data.alerts.find((a) => a.id === 'throttled')?.nextAttemptAt, at(30 * MIN).toISOString());
    assert.equal(s2.data.alerts.find((a) => a.id === 'rejected')?.status, 'failed');
    assert.equal(s2.data.alerts.find((a) => a.id === 'rejected')?.attempts, 1);
  });

  it('backoff is capped and jittered within ±20%', () => {
    const o = { baseBackoffMs: MIN, maxBackoffMs: 60 * MIN };
    assert.equal(d.backoffMs(1, { ...o, random: () => 0.5 }), MIN);
    assert.equal(d.backoffMs(4, { ...o, random: () => 0.5 }), 8 * MIN);
    assert.equal(d.backoffMs(20, { ...o, random: () => 0.5 }), 60 * MIN);
    assert.equal(d.backoffMs(1, { ...o, random: () => 0 }), 0.8 * MIN);
    assert.equal(d.backoffMs(1, { ...o, random: () => 1 }), 1.2 * MIN);
  });

  it('two dispatchers racing on one store never double-send', async () => {
    const store = fixture();
    for (let i = 0; i < 40; i++) store.data.alerts.push(makeAlert(`race-${i}`, { sendAt: at(-i * 1000).toISOString() }));
    const deliveries: string[] = [];
    const slow = (who: string) => ({
      async send(_u: User, a: Alert) {
        assert.equal(a.claimedBy, who, 'only the claimer sends');
        await new Promise((r) => setTimeout(r, Math.random() * 3));
        deliveries.push(a.id);
      },
    });
    const [a, b] = await Promise.all([
      d.dispatchOutbox(store, slow('A'), { clock: () => T0, instanceId: 'A' }),
      d.dispatchOutbox(store, slow('B'), { clock: () => T0, instanceId: 'B' }),
    ]);
    assert.equal(deliveries.length, 40);
    assert.equal(new Set(deliveries).size, 40, 'no alert delivered twice');
    assert.equal(a.sent + b.sent, 40);
    assert.ok(a.sent > 0 && b.sent > 0, 'both dispatchers did work');
  });

  it('does not double-send when the scheduler replaces pending rows mid-run', async () => {
    const store = fixture();
    store.data.alerts.push(makeAlert('r1'), makeAlert('r2', { sendAt: at(-1000).toISOString() }));
    const deliveries: string[] = [];
    let replaced = false;
    const notifier = {
      async send(_u: User, a: Alert) {
        if (!replaced) {
          // What recompute() does: keep claimed rows, rebuild pending ones as fresh objects.
          replaced = true;
          store.data.alerts = store.data.alerts.map((x) => (x.status === 'pending' ? { ...x } : x));
        }
        deliveries.push(a.id);
      },
    };
    await d.dispatchOutbox(store, notifier, { clock: () => T0 });
    await d.dispatchOutbox(store, notifier, { clock: () => T0 });
    assert.deepEqual(deliveries.sort(), ['r1', 'r2']);
    assert.ok(store.data.alerts.every((a) => a.status === 'sent'));
  });

  it('keeps the legacy dispatchDueAlerts contract and publishes metrics', async () => {
    const store = fixture();
    store.data.alerts.push(makeAlert('m1'), makeAlert('m2', { channel: 'email' }), makeAlert('m3', { sendAt: at(MIN).toISOString() }));
    const before = counterValue('alerts_delivered_total', { channel: 'push', result: 'sent' });
    const sent = await dispatchDueAlerts(store, { send: async () => {} }, T0);
    assert.equal(sent, 2);
    assert.equal(counterValue('alerts_delivered_total', { channel: 'push', result: 'sent' }), before + 1);
    store.data.alerts.push(makeAlert('m4', { nextAttemptAt: at(MIN).toISOString(), attempts: 1, sendAt: at(-MIN).toISOString() }));
    d.updateBacklogGauge(store, T0);
    const text = renderPrometheus();
    assert.match(text, /alerts_outbox_backlog\{state="retry_wait"\} 1/);
    assert.match(text, /alerts_outbox_backlog\{state="due"\} 0/);
  });
});

// ---------------------------------------------------------------------------------------------

describe('job lock (leader election)', () => {
  it('lets one instance hold the lock and another take it over once stale', () => {
    const file = path.join(scratch, 'jobs-a.lock');
    let now = T0;
    const clock = () => now;
    const a = new d.JobLock({ file, instanceId: 'A', staleMs: 90_000, clock });
    const b = new d.JobLock({ file, instanceId: 'B', staleMs: 90_000, clock });

    assert.equal(a.tryAcquire(), true);
    assert.equal(b.tryAcquire(), false);
    assert.equal(a.holder()?.instanceId, 'A');

    now = at(60_000);
    assert.equal(a.heartbeat(), true);
    now = at(120_000);
    assert.equal(b.tryAcquire(), false, 'heartbeat 60s ago is still fresh');

    now = at(60_000 + 91_000);
    assert.equal(b.tryAcquire(), true, 'stale lock taken over');
    assert.equal(b.holder()?.instanceId, 'B');
    assert.equal(a.heartbeat(), false, 'old leader notices and steps down');
    assert.equal(a.isLeader(), false);
    assert.equal(a.tryAcquire(), false);

    a.release();
    assert.equal(b.holder()?.instanceId, 'B', "release never deletes someone else's lock");
    b.release();
    assert.equal(b.holder(), undefined);
    assert.equal(a.tryAcquire(), true, 'a released lock is free immediately');
    a.release();
  });

  it('judges unreadable lock files by age, and serializes takeovers', () => {
    const file = path.join(scratch, 'jobs-b.lock');
    const now = new Date();
    const clock = () => now;
    const c = new d.JobLock({ file, instanceId: 'C', staleMs: 90_000, clock });

    writeFileSync(file, ''); // a creator died between open() and write()
    assert.equal(c.tryAcquire(), false, 'fresh unreadable file is respected');
    const old = new Date(now.getTime() - 120_000);
    utimesSync(file, old, old);
    assert.equal(c.tryAcquire(), true);
    c.release();

    // Another taker is mid-takeover: wait. A takeover guard left by a crashed taker expires.
    writeFileSync(file, JSON.stringify({ instanceId: 'X', pid: 1, acquiredAt: old.toISOString(), heartbeatAt: old.toISOString() }));
    writeFileSync(`${file}.takeover`, 'Y');
    assert.equal(c.tryAcquire(), false);
    utimesSync(`${file}.takeover`, old, old);
    assert.equal(c.tryAcquire(), false, 'stale guard is cleared first');
    assert.equal(c.tryAcquire(), true);
    c.release();
  });

  it('runs dispatch and the daily jobs on the leader only, once a day', async () => {
    const lockFile = path.join(scratch, 'jobs-c.lock');
    const store = fixture();
    store.data.alerts.push(makeAlert('j1'));
    let now = T0;
    const deps = { ...defaultDeps, llm: undefined, notifier: undefined, clock: () => now };
    const daily: string[] = [];
    registerDailyJob('registered-sweep', (_s, when) => void daily.push(`registered@${when.toISOString()}`));
    const sweep = (_s: StoreT, when: Date) => void daily.push(`option@${when.toISOString()}`);
    const r1 = recorder();
    const r2 = recorder();
    const one = createScheduler(store, r1.notifier, deps, { instanceId: 'one', lockFile, daily: [sweep] });
    const two = createScheduler(store, r2.notifier, deps, { instanceId: 'two', lockFile, daily: [sweep] });

    assert.equal((await one.tick()).leader, true);
    assert.equal((await two.tick()).leader, false);
    assert.deepEqual(r1.sent, ['j1']);
    assert.deepEqual(r2.sent, []);
    assert.deepEqual(daily, [], 'first start begins the 24h clock instead of re-syncing everyone at boot');

    now = at(24 * 3_600_000);
    assert.equal(one.heartbeat(), true);
    const t = await one.tick();
    assert.deepEqual(t.daily, ['daily-recheck', 'registered-sweep', 'sweep']);
    assert.deepEqual(daily, [`registered@${now.toISOString()}`, `option@${now.toISOString()}`]);
    assert.equal((await one.tick()).daily, undefined, 'not again the same day');

    // Leader dies (no heartbeat); the follower takes over after the stale window.
    now = at(24 * 3_600_000 + 91_000);
    store.data.alerts.push(makeAlert('j2', { sendAt: now.toISOString() }));
    assert.equal((await two.tick()).leader, true);
    assert.deepEqual(r2.sent, ['j2']);
    assert.equal(one.heartbeat(), false);
    two.stop();
    one.stop();
  });
});

// ---------------------------------------------------------------------------------------------

function ecKey() {
  return generateKeyPairSync('ec', { namedCurve: 'P-256' });
}

function decodeJwt(jwt: string, publicKey: KeyObject, alg: 'ES256' | 'RS256') {
  const [h, p, s] = jwt.split('.');
  assert.ok(h && p && s, 'three JWT segments');
  const ok = verify('sha256', Buffer.from(`${h}.${p}`), alg === 'ES256' ? { key: publicKey, dsaEncoding: 'ieee-p1363' } : publicKey, Buffer.from(s, 'base64url'));
  assert.ok(ok, 'JWT signature verifies with the public key');
  return { header: JSON.parse(Buffer.from(h, 'base64url').toString()), claims: JSON.parse(Buffer.from(p, 'base64url').toString()) };
}

const pushMsg = d.pushMessage(makeAlert('itm_a:trial:2026-10-05:48:push'));

describe('APNs provider', () => {
  const keys = ecKey();
  const cfg = { keyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), keyId: 'KEY123', teamId: 'TEAM456', bundleId: 'app.trialguard', production: false };

  function fakeTransport(reply: (n: number) => { status: number; body?: string; headers?: Record<string, string> }) {
    const calls: { origin: string; method: string; path: string; headers: Record<string, string>; body: string }[] = [];
    return {
      calls,
      transport: {
        async request(req: { origin: string; method: string; path: string; headers: Record<string, string>; body: string; timeoutMs: number }) {
          calls.push(req);
          const r = reply(calls.length);
          return { status: r.status, headers: r.headers ?? {}, body: r.body ?? '' };
        },
        close() {},
      },
    };
  }

  it('sends an alert push with token auth and the alert id as collapse id', async () => {
    let now = T0;
    const fake = fakeTransport(() => ({ status: 200 }));
    const apns = new d.ApnsProvider(cfg, { transport: fake.transport, clock: () => now });
    assert.deepEqual(await apns.send('a1b2c3d4e5f6', pushMsg), { ok: true });
    const call = fake.calls[0];
    assert.ok(call);
    assert.equal(call.origin, 'https://api.sandbox.push.apple.com');
    assert.equal(call.method, 'POST');
    assert.equal(call.path, '/3/device/a1b2c3d4e5f6');
    assert.equal(call.headers['apns-topic'], 'app.trialguard');
    assert.equal(call.headers['apns-push-type'], 'alert');
    assert.equal(call.headers['apns-collapse-id'], 'itm_a:trial:2026-10-05:48:push');
    assert.equal(call.headers['apns-expiration'], String(Date.parse('2026-10-05T12:00:00Z') / 1000));
    const payload = JSON.parse(call.body);
    assert.equal(payload.aps.alert.title, 'Headspace trial ends in 2 days');
    assert.equal(payload.itemId, 'itm_a');

    const auth = call.headers.authorization ?? '';
    assert.match(auth, /^bearer /);
    const { header, claims } = decodeJwt(auth.slice(7), keys.publicKey, 'ES256');
    assert.deepEqual(header, { alg: 'ES256', kid: 'KEY123' });
    assert.deepEqual(claims, { iss: 'TEAM456', iat: T0.getTime() / 1000 });

    // The provider token is reused (Apple throttles refreshes) and renewed before it turns an hour old.
    now = at(30 * MIN);
    await apns.send('a1b2c3d4e5f6', pushMsg);
    assert.equal(fake.calls[1]?.headers.authorization, auth);
    now = at(55 * MIN);
    await apns.send('a1b2c3d4e5f6', pushMsg);
    assert.notEqual(fake.calls[2]?.headers.authorization, auth);
  });

  it('maps APNs errors: dead tokens, stale provider tokens, throttling, config problems', async () => {
    const replies: Record<number, { status: number; body?: string; headers?: Record<string, string> }> = {
      1: { status: 410, body: '{"reason":"Unregistered","timestamp":1700000000000}' },
      2: { status: 400, body: '{"reason":"BadDeviceToken"}' },
      3: { status: 403, body: '{"reason":"ExpiredProviderToken"}' },
      4: { status: 429, body: '{"reason":"TooManyRequests"}', headers: { 'retry-after': '120' } },
      5: { status: 400, body: '{"reason":"BadTopic"}' },
      6: { status: 503, body: '{"reason":"ServiceUnavailable"}' },
    };
    const fake = fakeTransport((n) => replies[n] ?? { status: 200 });
    const apns = new d.ApnsProvider({ ...cfg, production: true }, { transport: fake.transport, clock: () => T0 });
    const outcomes = [];
    for (let i = 0; i < 6; i++) outcomes.push(await apns.send('aaaa1111', pushMsg));
    assert.deepEqual(outcomes[0], { ok: false, invalidToken: true, retryable: false, reason: 'Unregistered' });
    assert.deepEqual(outcomes[1], { ok: false, invalidToken: true, retryable: false, reason: 'BadDeviceToken' });
    assert.deepEqual(outcomes[2], { ok: false, invalidToken: false, retryable: true, reason: 'ExpiredProviderToken' });
    assert.deepEqual(outcomes[3], { ok: false, invalidToken: false, retryable: true, reason: 'TooManyRequests', retryAfterMs: 120_000 });
    assert.deepEqual(outcomes[4], { ok: false, invalidToken: false, retryable: false, reason: 'BadTopic' });
    assert.equal(outcomes[5]?.ok === false && outcomes[5].retryable, true);
    assert.equal(fake.calls[0]?.origin, 'https://api.push.apple.com');
    assert.notEqual(fake.calls[3]?.headers.authorization, fake.calls[2]?.headers.authorization, 'fresh JWT after ExpiredProviderToken');
  });

  it('refuses a key that is not an EC .p8 key', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    assert.throws(() => new d.ApnsProvider({ ...cfg, keyPem: rsa }, { transport: fakeTransport(() => ({ status: 200 })).transport }), /EC/);
  });

  describe('HTTP/2 transport (local h2c server, no network)', () => {
    let server: Http2Server;
    let origin: string;
    const seen: Record<string, string | string[] | undefined>[] = [];
    before(async () => {
      server = createH2Server();
      server.on('stream', (stream, headers) => {
        seen.push({ ...headers });
        let body = '';
        stream.on('data', (c: Buffer) => (body += c.toString()));
        stream.on('end', () => {
          const bad = headers[':path'] === '/3/device/dead';
          stream.respond({ ':status': bad ? 410 : 200, 'apns-id': 'abc', 'content-type': 'application/json' });
          stream.end(bad ? '{"reason":"Unregistered"}' : body.length ? '' : '{}');
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    after(() => server.close());

    it('sends headers and body over one pooled session', async () => {
      const t = d.http2Transport();
      try {
        const ok = await t.request({ origin, method: 'POST', path: '/3/device/live', headers: { 'apns-topic': 'app.trialguard', 'apns-collapse-id': 'x1' }, body: '{"aps":{}}', timeoutMs: 2000 });
        assert.equal(ok.status, 200);
        assert.equal(ok.headers['apns-id'], 'abc');
        const gone = await t.request({ origin, method: 'POST', path: '/3/device/dead', headers: {}, body: '{}', timeoutMs: 2000 });
        assert.equal(gone.status, 410);
        assert.equal(JSON.parse(gone.body).reason, 'Unregistered');
        assert.equal(seen[0]?.['apns-topic'], 'app.trialguard');
        assert.equal(seen[0]?.['apns-collapse-id'], 'x1');
        assert.equal(seen[0]?.[':method'], 'POST');
      } finally {
        t.close();
      }
    });
  });
});

describe('FCM provider', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = d.parseServiceAccount(
    JSON.stringify({
      type: 'service_account',
      project_id: 'trialguard-prod',
      private_key_id: 'kid-1',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      client_email: 'push@trialguard-prod.iam.gserviceaccount.com',
      token_uri: 'https://evil.example/token',
    }),
  );

  function fakeFetch(fcmReply: (n: number) => { status: number; body: unknown; headers?: Record<string, string> }) {
    const calls: { url: string; init: RequestInit }[] = [];
    let tokens = 0;
    let sends = 0;
    const fetchImpl = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url === 'https://oauth2.googleapis.com/token') {
        tokens++;
        return new Response(JSON.stringify({ access_token: `ya29.token-${tokens}`, expires_in: 3599, token_type: 'Bearer' }), { status: 200 });
      }
      const r = fcmReply(++sends);
      return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers });
    };
    return { calls, fetchImpl, tokenRequests: () => tokens };
  }

  it('gets an OAuth2 token with a signed JWT-bearer assertion and caches it until expiry', async () => {
    let now = T0;
    const f = fakeFetch(() => ({ status: 200, body: { name: 'projects/trialguard-prod/messages/1' } }));
    const fcm = new d.FcmProvider(sa, { fetch: f.fetchImpl, clock: () => now });
    assert.deepEqual(await fcm.send('fcm-token-1', pushMsg), { ok: true });
    await fcm.send('fcm-token-1', pushMsg);
    assert.equal(f.tokenRequests(), 1, 'token cached between sends');

    const tokenCall = f.calls[0];
    assert.ok(tokenCall);
    assert.equal(tokenCall.url, 'https://oauth2.googleapis.com/token', 'token endpoint pinned, file token_uri ignored');
    const form = new URLSearchParams(String(tokenCall.init.body));
    assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    const { header, claims } = decodeJwt(form.get('assertion') ?? '', publicKey, 'RS256');
    assert.deepEqual(header, { alg: 'RS256', typ: 'JWT', kid: 'kid-1' });
    assert.equal(claims.iss, 'push@trialguard-prod.iam.gserviceaccount.com');
    assert.equal(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
    assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
    assert.equal(claims.exp - claims.iat, 3600);

    const send = f.calls[1];
    assert.ok(send);
    assert.equal(send.url, 'https://fcm.googleapis.com/v1/projects/trialguard-prod/messages:send');
    assert.equal((send.init.headers as Record<string, string>).Authorization, 'Bearer ya29.token-1');
    const { message } = JSON.parse(String(send.init.body));
    assert.equal(message.token, 'fcm-token-1');
    assert.equal(message.notification.title, 'Headspace trial ends in 2 days');
    assert.equal(message.android.notification.tag, 'itm_a:trial:2026-10-05:48:push');
    assert.match(message.webpush.headers.Topic, /^[\w-]{1,32}$/);
    assert.equal(message.data.alertId, 'itm_a:trial:2026-10-05:48:push');

    now = at(60 * MIN);
    await fcm.send('fcm-token-1', pushMsg);
    assert.equal(f.tokenRequests(), 2, 'refreshed after expiry');
  });

  it('maps FCM errors: UNREGISTERED / 404 disable, 401 refreshes the token, 5xx retries', async () => {
    const fcmError = (status: number, code: string, errorCode?: string) => ({
      status,
      body: { error: { code: status, status: code, details: errorCode ? [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }] : [] } },
    });
    const replies: Record<number, ReturnType<typeof fcmError>> = {
      1: fcmError(404, 'NOT_FOUND', 'UNREGISTERED'),
      2: fcmError(401, 'UNAUTHENTICATED'),
      3: fcmError(503, 'UNAVAILABLE'),
      4: fcmError(400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT'),
    };
    const f = fakeFetch((n) => replies[n] ?? { status: 200, body: {} });
    const fcm = new d.FcmProvider(sa, { fetch: f.fetchImpl, clock: () => T0 });
    assert.deepEqual(await fcm.send('t', pushMsg), { ok: false, invalidToken: true, retryable: false, reason: 'UNREGISTERED' });
    assert.deepEqual(await fcm.send('t', pushMsg), { ok: false, invalidToken: false, retryable: true, reason: 'UNAUTHENTICATED' });
    const unavailable = await fcm.send('t', pushMsg);
    assert.equal(unavailable.ok === false && unavailable.retryable, true);
    assert.equal(f.tokenRequests(), 2, 'a 401 drops the cached access token');
    assert.deepEqual(await fcm.send('t', pushMsg), { ok: false, invalidToken: false, retryable: false, reason: 'INVALID_ARGUMENT' });
  });
});

describe('Postmark sender and alert email', () => {
  const email = d.renderAlertEmail('pat@example.com', makeAlert('e1', { channel: 'email', title: 'Max <b>trial</b>\r\nBcc: x@evil.test', body: 'Cancel & save' }), {
    from: 'Trialguard <alerts@trialguard.app>',
    publicUrl: 'https://trialguard.app',
    unsubscribeUrl: 'https://trialguard.app/api/unsubscribe?token=abc.def',
    postalAddress: '100 Main St, Brooklyn, NY 11201',
  });

  it('renders text + HTML with an unsubscribe link, RFC 8058 headers and the postal address', () => {
    assert.equal(email.subject, 'Max <b>trial</b> Bcc: x@evil.test', 'no line breaks reach the Subject header');
    assert.match(email.text, /Unsubscribe from alert emails: https:\/\/trialguard\.app\/api\/unsubscribe\?token=abc\.def/);
    assert.match(email.text, /100 Main St, Brooklyn, NY 11201/);
    assert.match(email.html, /Max &#60;b&#62;trial&#60;\/b&#62;/, 'HTML is escaped');
    assert.match(email.html, /Cancel &#38; save/);
    assert.match(email.html, /href="https:\/\/trialguard\.app\/api\/unsubscribe\?token=abc\.def"/);
    assert.match(email.html, /100 Main St/);
    assert.deepEqual(email.headers, {
      'List-Unsubscribe': '<https://trialguard.app/api/unsubscribe?token=abc.def>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('posts to the Postmark API with the server token and maps errors', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const replies = [
      new Response(JSON.stringify({ To: 'pat@example.com', MessageID: 'pm-1', ErrorCode: 0, Message: 'OK' }), { status: 200 }),
      new Response(JSON.stringify({ ErrorCode: 406, Message: "You tried to send to recipient(s) that have been marked as inactive. Found inactive addresses: pat@example.com." }), { status: 422 }),
      new Response(JSON.stringify({ ErrorCode: 400, Message: 'Sender signature not defined' }), { status: 422 }),
      new Response('oops', { status: 500 }),
    ];
    const pm = new d.PostmarkSender({
      serverToken: 'server-token-1',
      fetch: async (url, init) => {
        calls.push({ url, init });
        const r = replies.shift();
        assert.ok(r);
        return r;
      },
    });
    assert.deepEqual(await pm.send(email), { messageId: 'pm-1' });
    const call = calls[0];
    assert.ok(call);
    assert.equal(call.url, 'https://api.postmarkapp.com/email');
    assert.equal((call.init.headers as Record<string, string>)['X-Postmark-Server-Token'], 'server-token-1');
    const body = JSON.parse(String(call.init.body));
    assert.equal(body.From, 'Trialguard <alerts@trialguard.app>');
    assert.equal(body.To, 'pat@example.com');
    assert.equal(body.MessageStream, 'outbound');
    assert.equal(body.TrackLinks, 'None');
    assert.ok(body.TextBody && body.HtmlBody);
    assert.deepEqual(body.Headers, [
      { Name: 'List-Unsubscribe', Value: '<https://trialguard.app/api/unsubscribe?token=abc.def>' },
      { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
    ]);

    const inactive = await pm.send(email).catch((e: unknown) => e);
    assert.ok(inactive instanceof d.DeliveryError);
    assert.equal(inactive.retryable, false, 'inactive recipient is permanent');
    assert.doesNotMatch(inactive.message, /pat@example\.com/, 'addresses are scrubbed from errors');
    const account = await pm.send(email).catch((e: unknown) => e);
    assert.ok(account instanceof d.DeliveryError && account.retryable, 'account-level 422 is retried');
    const down = await pm.send(email).catch((e: unknown) => e);
    assert.ok(down instanceof d.DeliveryError && down.retryable);
  });
});

describe('delivery notifier', () => {
  const ok = { ok: true } as const;
  function fakePush(name: 'apns' | 'fcm', outcome: (token: string) => Awaited<ReturnType<InstanceType<typeof d.ApnsProvider>['send']>>) {
    const sent: { token: string; collapseId: string }[] = [];
    return {
      sent,
      provider: {
        name,
        async send(token: string, msg: { collapseId: string }) {
          sent.push({ token, collapseId: msg.collapseId });
          return outcome(token);
        },
      },
    };
  }
  const device = (id: string, platform: Device['platform'], pushToken: string, userId = 'usr_a'): Device => ({
    id,
    userId,
    platform,
    pushToken,
    createdAt: T0.toISOString(),
    lastSeenAt: T0.toISOString(),
  });
  const channels = { publicUrl: 'https://trialguard.app', production: false, clock: () => T0 };

  it('routes iOS to APNs and Android/web to FCM, disabling dead tokens', async () => {
    const store = fixture();
    store.data.devices.push(device('dev_ios', 'ios', 'ios-token'), device('dev_android', 'android', 'dead-token'), device('dev_web', 'web', 'web-token'), device('dev_other', 'ios', 'x', 'usr_b'));
    const apns = fakePush('apns', () => ok);
    const fcm = fakePush('fcm', (t) => (t === 'dead-token' ? { ok: false, invalidToken: true, retryable: false, reason: 'UNREGISTERED' } : ok));
    const notifier = d.createDeliveryNotifier(store, { ...channels, apns: apns.provider, fcm: fcm.provider });
    const result = await notifier.send(store.data.users[0] as User, makeAlert('itm_a:trial:2026-10-05:48:push'));
    assert.deepEqual(result, { status: 'sent', via: 'push' });
    assert.deepEqual(apns.sent, [{ token: 'ios-token', collapseId: 'itm_a:trial:2026-10-05:48:push' }]);
    assert.deepEqual(fcm.sent.map((s) => s.token).sort(), ['dead-token', 'web-token']);
    assert.ok(store.data.devices.find((x) => x.id === 'dev_android')?.disabledAt, 'dead token disabled');
    assert.equal(store.data.devices.find((x) => x.id === 'dev_web')?.disabledAt, undefined);
  });

  it('falls back to the in-app inbox, and retries only transient failures', async () => {
    const store = fixture();
    const user = store.data.users[0] as User;
    const none = d.createDeliveryNotifier(store, channels);
    assert.deepEqual(await none.send(user, makeAlert('p1')), { status: 'sent', via: 'inbox' }, 'no provider: inbox, as before');

    store.data.devices.push(device('dev_1', 'ios', 't1'), device('dev_2', 'ios', 't2'));
    const flaky = fakePush('apns', () => ({ ok: false, invalidToken: false, retryable: true, reason: 'ServiceUnavailable', retryAfterMs: 5000 }));
    const err = await d
      .createDeliveryNotifier(store, { ...channels, apns: flaky.provider })
      .send(user, makeAlert('p2'))
      .catch((e: unknown) => e);
    assert.ok(err instanceof d.DeliveryError && err.retryable && err.retryAfterMs === 5000);

    const throwing = { name: 'apns' as const, send: async () => Promise.reject(new Error('socket hang up')) };
    const err2 = await d.createDeliveryNotifier(store, { ...channels, apns: throwing }).send(user, makeAlert('p3')).catch((e: unknown) => e);
    assert.ok(err2 instanceof d.DeliveryError && err2.retryable, 'transport errors are retried');

    const rejecting = fakePush('apns', () => ({ ok: false, invalidToken: false, retryable: false, reason: 'BadTopic' }));
    const r = await d.createDeliveryNotifier(store, { ...channels, apns: rejecting.provider }).send(user, makeAlert('p4'));
    assert.equal(r && r.status === 'sent' && r.via, 'inbox');
  });

  it('emails with a working one-click unsubscribe link, and never pretends in production', async () => {
    const store = fixture();
    const user = store.data.users[0] as User;
    const mail: Parameters<InstanceType<typeof d.PostmarkSender>['send']>[0][] = [];
    const sender = { name: 'fake', send: async (m: (typeof mail)[number]) => (mail.push(m), {}) };
    const notifier = d.createDeliveryNotifier(store, { ...channels, email: sender, emailFrom: 'Trialguard <alerts@trialguard.app>', postalAddress: '1 Main St' });
    assert.deepEqual(await notifier.send(user, makeAlert('m1', { channel: 'email' })), { status: 'sent', via: 'email' });
    const sent = mail[0];
    assert.ok(sent);
    assert.equal(sent.to, 'usr_a@example.com');
    const link = /<(.+)>/.exec(sent.headers['List-Unsubscribe'] ?? '')?.[1] ?? '';
    assert.match(link, /^https:\/\/trialguard\.app\/api\/unsubscribe\?token=/);
    assert.equal(d.verifyUnsubscribeToken(new URL(link).searchParams.get('token') ?? ''), 'usr_a');

    assert.deepEqual(await d.createDeliveryNotifier(store, channels).send(user, makeAlert('m2', { channel: 'email' })), { status: 'sent', via: 'log' }, 'dev: console');
    assert.deepEqual(await d.createDeliveryNotifier(store, { ...channels, production: true }).send(user, makeAlert('m3', { channel: 'email' })), {
      status: 'skipped',
      reason: 'email_not_configured',
    });
  });
});

describe('delivery config from env', () => {
  const pem = ecKey().privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  it('fails fast on half-configured channels and missing CAN-SPAM address', () => {
    assert.throws(() => d.readDeliverySettings({ APNS_KEY_ID: 'K' }), /APNs is partly configured; missing APNS_KEY_PATH or APNS_KEY, APNS_TEAM_ID, APNS_BUNDLE_ID/);
    assert.throws(() => d.readDeliverySettings({ POSTMARK_SERVER_TOKEN: 't' }), /EMAIL_FROM/);
    const prodEmail = { NODE_ENV: 'production', POSTMARK_SERVER_TOKEN: 't', EMAIL_FROM: 'a@b.co', PUBLIC_URL: 'https://trialguard.app' };
    assert.throws(() => d.readDeliverySettings(prodEmail), /COMPANY_POSTAL_ADDRESS/);
    assert.throws(() => d.readDeliverySettings({ ...prodEmail, COMPANY_POSTAL_ADDRESS: '1 Main St', PUBLIC_URL: 'http://trialguard.app' }), /PUBLIC_URL must be https/);
    assert.doesNotThrow(() => d.readDeliverySettings({ ...prodEmail, COMPANY_POSTAL_ADDRESS: '1 Main St' }));
    assert.deepEqual(d.readDeliverySettings({}), { emailFrom: undefined, postalAddress: undefined });
  });

  it('reads the APNs key from a path or inline, and picks the gateway by environment', () => {
    const keyFile = path.join(scratch, 'AuthKey_K.p8');
    writeFileSync(keyFile, pem);
    const base = { APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T', APNS_BUNDLE_ID: 'app.trialguard' };
    assert.equal(d.readDeliverySettings({ ...base, APNS_KEY_PATH: keyFile }).apns?.production, false);
    assert.equal(d.readDeliverySettings({ ...base, APNS_KEY_PATH: keyFile, NODE_ENV: 'production' }).apns?.production, true, 'production defaults to the production gateway');
    assert.equal(d.readDeliverySettings({ ...base, APNS_KEY: pem.replace(/\n/g, '\\n'), APNS_PRODUCTION: '0', NODE_ENV: 'production' }).apns?.production, false);
    const delivery = d.createDeliveryFromEnv(new Store(), { ...base, APNS_KEY_PATH: keyFile });
    assert.deepEqual(delivery.channels, { push: ['apns'], email: 'console' });
    delivery.close();
  });
});

// ---------------------------------------------------------------------------------------------

describe('devices, notification settings and unsubscribe (HTTP)', () => {
  let now = T0;
  const deps = { ...defaultDeps, llm: undefined, notifier: undefined, clock: () => now };
  const store = new Store();
  let server: Server;
  let base: string;
  let alice = '';
  let bob = '';

  async function call(method: string, p: string, body?: unknown, token = alice, headers: Record<string, string> = {}) {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text, headers: res.headers };
  }

  before(async () => {
    server = createServer(createApp(store, deps));
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
    alice = (await call('POST', '/api/auth/signup', { email: 'alice@example.com' }, '')).json.token;
    bob = (await call('POST', '/api/auth/signup', { email: 'bob@example.com' }, '')).json.token;
  });
  after(() => server.close());

  it('registers devices with an upsert by token', async () => {
    const first = await call('POST', '/api/devices', { platform: 'ios', pushToken: 'a'.repeat(64), appVersion: '1.0.0' });
    assert.equal(first.status, 200);
    assert.equal(first.json.pushToken, undefined, 'tokens are never echoed back');
    now = at(MIN);
    const again = await call('POST', '/api/devices', { platform: 'ios', pushToken: 'a'.repeat(64), appVersion: '1.1.0' });
    assert.equal(again.json.id, first.json.id, 'same token, same device');
    assert.equal(again.json.appVersion, '1.1.0');
    assert.equal(store.data.devices.length, 1);

    // The same phone signs in to another account: the token moves (with a new id).
    const moved = await call('POST', '/api/devices', { platform: 'ios', pushToken: 'a'.repeat(64) }, bob);
    assert.notEqual(moved.json.id, first.json.id);
    assert.equal(store.data.devices.length, 1);
    assert.deepEqual((await call('GET', '/api/devices')).json, []);
    assert.equal((await call('DELETE', `/api/devices/${moved.json.id}`)).status, 404, "can't delete another account's device");
    assert.equal((await call('DELETE', `/api/devices/${moved.json.id}`, undefined, bob)).json.deleted, true);
    assert.equal(store.data.devices.length, 0);
  });

  it('validates device registrations and caps devices per user', async () => {
    assert.equal((await call('POST', '/api/devices', { platform: 'blackberry', pushToken: 'abcdefgh1234' })).status, 400);
    assert.equal((await call('POST', '/api/devices', { platform: 'ios', pushToken: '../../admin?x=1' })).status, 400);
    assert.equal((await call('POST', '/api/devices', { platform: 'ios', pushToken: 'abcdefgh1234', extra: true })).status, 400);
    for (let i = 0; i < 12; i++) {
      now = at(10 * MIN + i * MIN);
      assert.equal((await call('POST', '/api/devices', { platform: 'android', pushToken: `fcm:token-${i}-xxxxxxxx` })).status, 200);
    }
    const mine = (await call('GET', '/api/devices')).json as { id: string; lastSeenAt: string }[];
    assert.equal(mine.length, 10);
    const tokens = store.data.devices.filter((x) => mine.some((m) => m.id === x.id)).map((x) => x.pushToken);
    assert.ok(!tokens.includes('fcm:token-0-xxxxxxxx') && !tokens.includes('fcm:token-1-xxxxxxxx'), 'least recently seen evicted');
    assert.ok(tokens.includes('fcm:token-11-xxxxxxxx'));
  });

  it('reads and updates notification settings, rebuilding the outbox', async () => {
    now = T0;
    await call('POST', '/api/items', { name: 'Headspace', amountCents: 6999, cadence: 'annual', date: '2026-10-08', isTrial: true });
    const aliceId = (await call('GET', '/api/me')).json.id as string;
    const pendingEmail = () => store.data.alerts.filter((a) => a.userId === aliceId && a.status === 'pending' && a.channel === 'email').length;
    assert.ok(pendingEmail() > 0);

    const got = await call('GET', '/api/me/notifications');
    assert.equal(got.status, 200);
    assert.equal(got.json.prefs.email, true);
    assert.equal(got.json.emailUnsubscribedAt, null);
    assert.equal(got.json.devices.length, 10);

    const put = await call('PUT', '/api/me/notifications', { email: false, types: { renewal: false }, quietHours: { start: '22:30', end: '07:00' }, timeZone: 'America/Los_Angeles' });
    assert.equal(put.status, 200);
    assert.deepEqual(put.json.prefs.quietHours, { start: '22:30', end: '07:00' });
    assert.equal(put.json.prefs.timeZone, 'America/Los_Angeles');
    assert.equal(put.json.prefs.types.renewal, false);
    assert.equal(put.json.prefs.types.trial_converting, true, 'types merge per type');
    assert.equal(put.json.prefs.push, true, 'fields not sent are kept');
    assert.equal(pendingEmail(), 0, 'outbox reflects the change');

    assert.equal((await call('PUT', '/api/me/notifications', { quietHours: null })).json.prefs.quietHours, null);
  });

  it('rejects invalid notification settings', async () => {
    const bad = [
      { quietHours: { start: '25:00', end: '07:00' } },
      { quietHours: { start: '7:00', end: '08:00' } },
      { quietHours: { start: '08:00', end: '08:00' } },
      { quietHours: { start: '08:00' } },
      { timeZone: 'Mars/Olympus_Mons' },
      { types: { birthday: true } },
      { push: 'yes' },
      { pushes: true },
    ];
    for (const body of bad) {
      const r = await call('PUT', '/api/me/notifications', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.ok(Array.isArray(r.json.details));
    }
    assert.equal((await call('PUT', '/api/me/notifications', { email: true }, '')).status, 401);
  });

  it('GET unsubscribe only confirms; POST (RFC 8058 one-click) unsubscribes', async () => {
    const bobUser = store.data.users.find((u) => u.email === 'bob@example.com');
    assert.ok(bobUser);
    const token = d.unsubscribeToken(bobUser.id);

    const page = await call('GET', `/api/unsubscribe?token=${token}`, undefined, '');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.match(page.text, /<form method="post" action="\/api\/unsubscribe\?token=/);
    assert.equal(bobUser.emailUnsubscribedAt, undefined, 'a GET (link scanner) changes nothing');
    assert.equal(bobUser.alertPrefs.email, true);

    now = at(2 * MIN);
    const one = await call('POST', `/api/unsubscribe?token=${token}`, 'List-Unsubscribe=One-Click', '', { 'Content-Type': 'application/x-www-form-urlencoded' });
    assert.equal(one.status, 200);
    assert.equal(bobUser.emailUnsubscribedAt, at(2 * MIN).toISOString());
    assert.equal(bobUser.alertPrefs.email, false);
    assert.ok(store.data.audit.some((a) => a.userId === bobUser.id && a.action === 'email.unsubscribed'));

    now = at(3 * MIN);
    await call('POST', `/api/unsubscribe?token=${token}`, 'List-Unsubscribe=One-Click', '', { 'Content-Type': 'application/x-www-form-urlencoded' });
    assert.equal(bobUser.emailUnsubscribedAt, at(2 * MIN).toISOString(), 'idempotent: keeps the first timestamp');

    // Re-enabling email (e.g. through the legacy PATCH alias) without re-subscribing still sends no email.
    store.data.items.push(makeItem('itm_bob', 'trial', '2026-10-05', bobUser.id));
    bobUser.alertPrefs.email = true;
    store.data.alerts.push(makeAlert('bob-email', { userId: bobUser.id, itemId: 'itm_bob', channel: 'email' }));
    const { sent, notifier } = recorder();
    await d.dispatchOutbox(store, notifier, { clock: () => now });
    assert.ok(!sent.includes('bob-email'));
    assert.equal(store.data.alerts.find((a) => a.id === 'bob-email')?.skipReason, 'unsubscribed');

    // Turning email on in settings is an explicit re-subscribe.
    const resub = await call('PUT', '/api/me/notifications', { email: true }, bob);
    assert.equal(resub.json.emailUnsubscribedAt, null);
    assert.ok(store.data.audit.some((a) => a.userId === bobUser.id && a.action === 'email.resubscribed'));
  });

  it('rejects bad, tampered and wrong-purpose unsubscribe tokens', async () => {
    const bobUser = store.data.users.find((u) => u.email === 'bob@example.com');
    assert.ok(bobUser);
    const good = d.unsubscribeToken(bobUser.id);
    const [payload] = good.split('.');
    const forged = `${Buffer.from(`unsub:email:v1:${'usr_someone_else'}`).toString('base64url')}.${good.split('.')[1]}`;
    const tokens = ['', 'garbage', `${good}x`, `${payload}.AAAA`, forged, signPayload(`login:${bobUser.id}`)];
    const before = bobUser.emailUnsubscribedAt;
    for (const t of tokens) {
      assert.equal((await call('GET', `/api/unsubscribe?token=${encodeURIComponent(t)}`, undefined, '')).status, 400, `GET ${t}`);
      assert.equal((await call('POST', `/api/unsubscribe?token=${encodeURIComponent(t)}`, 'List-Unsubscribe=One-Click', '')).status, 400, `POST ${t}`);
    }
    assert.equal((await call('POST', '/api/unsubscribe', 'List-Unsubscribe=One-Click', '')).status, 400, 'missing token');
    assert.equal(bobUser.emailUnsubscribedAt, before);
  });
});
