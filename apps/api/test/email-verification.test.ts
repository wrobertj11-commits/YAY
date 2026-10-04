import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';

process.env.TRIALGUARD_DISABLE_LLM = '1';
process.env.TRIALGUARD_JOBS = '0';

const { normalizeAlertPrefs } = await import('@trialguard/core');
const { createApp } = await import('../src/app.ts');
const { config } = await import('../src/config.ts');
const { defaultDeps } = await import('../src/pipeline.ts');
const { Store } = await import('../src/store.ts');
const { LIMITS, RateLimiter } = await import('../src/ratelimit.ts');
const { setLogSink } = await import('../src/log.ts');
const d = await import('../src/delivery/index.ts');
const { setVerificationMailer, verificationMailer } = await import('../src/auth/mailer.ts');
const v = await import('../src/auth/verification.ts');
const { renderVerificationEmail } = await import('../src/auth/verification-email.ts');

type StoreT = InstanceType<typeof Store>;
type User = StoreT['data']['users'][number];
type Alert = StoreT['data']['alerts'][number];
type Item = StoreT['data']['items'][number];
type OutgoingEmail = Parameters<InstanceType<typeof d.PostmarkSender>['send']>[0];

const T0 = new Date('2026-10-04T15:00:00Z');
const MIN = 60_000;
let now = T0;
/** The clock only moves forward: rate-limit buckets would go negative if it went back. */
const tick = (ms: number) => (now = new Date(now.getTime() + ms));
const deps = { ...defaultDeps, llm: undefined, notifier: undefined, clock: () => now };
const store = new Store();
// Real per-address code bucket, on the test clock; a roomy auth bucket so many signups from one IP are fine.
const limiter = new RateLimiter({ ...LIMITS, auth: { capacity: 10_000, per: 60 } }, () => now.getTime());

/** Every log line written while this file runs (nothing is printed). */
const logs: string[] = [];
setLogSink((line) => void logs.push(line), 'debug');

/** A transactional sender double: records what would have gone to Postmark, or fails on demand. */
function fakeSender() {
  const sent: OutgoingEmail[] = [];
  let failNext = false;
  return {
    sent,
    failOnce: () => void (failNext = true),
    mailer: {
      sender: {
        name: 'fake',
        async send(msg: OutgoingEmail) {
          if (failNext) {
            failNext = false;
            throw new d.DeliveryError('Postmark HTTP 500', { retryable: true });
          }
          sent.push(msg);
          return { messageId: `pm-${sent.length}` };
        },
      },
      from: 'Trialguard <alerts@trialguard.app>',
      postalAddress: '100 Main St, Brooklyn, NY 11201',
    },
  };
}

/** The 6-digit code on its own line of the plain-text part. */
function codeIn(msg: OutgoingEmail | undefined): string {
  const code = msg?.text.match(/^(\d{6})$/m)?.[1];
  assert.ok(code, 'the email carries a 6-digit code');
  return code;
}

const wrong = (code: string) => (code === '000000' ? '111111' : '000000');

let server: Server;
let base: string;

async function call(method: string, p: string, body?: unknown, token = '') {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: (text ? JSON.parse(text) : undefined) as any };
}

async function signup(email: string): Promise<{ token: string; id: string; user: any }> {
  const r = await call('POST', '/api/auth/signup', { email, timeZone: 'America/New_York' });
  assert.equal(r.status, 200, r.text);
  return { token: r.json.token, id: r.json.user.id, user: r.json.user };
}

/** Sends a code through the dev path (no sender configured) and returns it. */
async function devCode(token: string): Promise<string> {
  setVerificationMailer(null);
  const r = await call('POST', '/api/auth/email/send-code', {}, token);
  assert.equal(r.status, 200, r.text);
  return r.json.devCode;
}

const userById = (id: string): User | undefined => store.data.users.find((u) => u.id === id);

before(async () => {
  server = createServer(createApp(store, deps, limiter));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());
afterEach(() => {
  setVerificationMailer(null);
  config.devLogin = true;
});

describe('signup and unverified addresses', () => {
  it('new accounts start unverified, and an unverified account does not reserve its address', async () => {
    const squatter = await signup('victim@example.com');
    assert.equal(squatter.user.emailVerified, false);
    const owner = await signup('victim@example.com');
    assert.notEqual(owner.id, squatter.id, 'the real owner can still sign up');
    assert.equal(owner.user.emailVerified, false);
    assert.equal(store.data.users.filter((u) => u.email === 'victim@example.com').length, 2);
  });

  it('holds back email alerts (but not push) until the address is verified', async () => {
    const attacker = await signup('target@example.com');
    // The attack: a manual "trial" named with phishing text, ending tomorrow so its alerts are due now.
    const phish = 'Your bank account is locked - call 555 0100';
    assert.equal((await call('POST', '/api/items', { name: phish, amountCents: 999, cadence: 'monthly', date: '2026-10-05', isTrial: true }, attacker.token)).status, 200);
    const alertsOf = (userId: string) => store.data.alerts.filter((a) => a.userId === userId);
    assert.ok(alertsOf(attacker.id).some((a) => a.channel === 'email') && alertsOf(attacker.id).some((a) => a.channel === 'push'), 'both channels are scheduled');

    const mail = fakeSender();
    const notifier = d.createDeliveryNotifier(store, {
      email: mail.mailer.sender,
      emailFrom: mail.mailer.from,
      postalAddress: mail.mailer.postalAddress,
      publicUrl: 'https://trialguard.app',
      production: true,
      clock: () => now,
    });
    await d.dispatchOutbox(store, notifier, { clock: () => now });

    assert.equal(mail.sent.length, 0, 'nothing is emailed to an address nobody has verified');
    const email = alertsOf(attacker.id).filter((a) => a.channel === 'email' && a.status !== 'pending');
    assert.ok(email.length > 0 && email.every((a) => a.status === 'skipped' && a.skipReason === 'email_unverified'));
    const push = alertsOf(attacker.id).filter((a) => a.channel === 'push' && a.status !== 'pending');
    assert.ok(push.length > 0 && push.every((a) => a.status === 'sent'), 'push / in-app inbox still delivered');

    // The real owner signs up and verifies: the impostor is gone, and the owner's email alerts go out.
    const owner = await signup('target@example.com');
    const code = await devCode(owner.token);
    assert.equal((await call('POST', '/api/auth/email/verify', { code }, owner.token)).status, 200);
    assert.equal(alertsOf(attacker.id).length, 0);
    assert.equal((await call('POST', '/api/items', { name: 'Headspace', amountCents: 6999, cadence: 'annual', date: '2026-10-05', isTrial: true }, owner.token)).status, 200);
    await d.dispatchOutbox(store, notifier, { clock: () => now });
    assert.ok(mail.sent.length > 0, 'email alerts are sent after verification');
    assert.ok(mail.sent.every((m) => m.to === 'target@example.com' && /Headspace/.test(m.subject) && !m.text.includes(phish)));
    assert.ok(alertsOf(owner.id).some((a) => a.channel === 'email' && a.status === 'sent'));
  });

  it('existing accounts load unverified (they are asked to verify)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'trialguard-verify-'));
    try {
      const file = path.join(dir, 'db.json');
      const legacy: User = { id: 'usr_old', email: 'old@example.com', token: 'tok_old', plan: 'free', forwardToken: 'old', alertPrefs: normalizeAlertPrefs({}), createdAt: T0.toISOString() };
      const item: Item = {
        id: 'itm_old',
        userId: 'usr_old',
        matchKey: 'itm_old',
        name: 'Headspace',
        kind: 'trial',
        status: 'trial',
        amountCents: 6999,
        cadence: 'annual',
        trialEndsAt: '2026-10-08',
        nextChargeDate: '2026-10-08',
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
      writeFileSync(file, JSON.stringify({ users: [legacy], items: [item] }));
      const loaded = new Store(file);
      const user = loaded.data.users[0];
      assert.ok(user);
      assert.equal(user.emailVerifiedAt, undefined);
      const alert: Alert = { id: 'old', itemId: 'itm_old', userId: 'usr_old', type: 'trial_converting', channel: 'email', leadHours: 48, sendAt: T0.toISOString(), title: 't', body: 'b', status: 'pending', attempts: 0 };
      assert.equal(d.skipReasonFor(loaded, user, alert, T0.toISOString()), 'email_unverified');
      assert.equal(d.skipReasonFor(loaded, user, { ...alert, channel: 'push' }, T0.toISOString()), undefined, 'push is unaffected');
      // An unsubscribe still reads as an unsubscribe.
      assert.equal(d.skipReasonFor(loaded, { ...user, emailUnsubscribedAt: T0.toISOString() }, alert, T0.toISOString()), 'unsubscribed');
      assert.equal(d.skipReasonFor(loaded, { ...user, emailVerifiedAt: T0.toISOString() }, alert, T0.toISOString()), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('POST /api/auth/email/send-code and /verify', () => {
  it('verifies with the emailed code, deletes the squatting duplicate (audited) and then reserves the address', async () => {
    const squatter = await signup('jo@example.com');
    await call('POST', '/api/items', { name: 'Phishing text', amountCents: 100, cadence: 'monthly', date: '2026-10-20', isTrial: true }, squatter.token);
    const owner = await signup('jo@example.com');

    const mail = fakeSender();
    setVerificationMailer(mail.mailer);
    const sent = await call('POST', '/api/auth/email/send-code', {}, owner.token);
    assert.equal(sent.status, 200);
    assert.equal(sent.json.sent, true);
    assert.equal(sent.json.devCode, undefined, 'with a sender, the code only goes by email');
    assert.equal(sent.json.expiresAt, new Date(now.getTime() + 30 * MIN).toISOString());
    assert.equal(mail.sent.length, 1);
    const msg = mail.sent[0]!;
    assert.equal(msg.to, 'jo@example.com');
    assert.equal(msg.from, 'Trialguard <alerts@trialguard.app>');
    assert.equal(msg.tag, 'email_verification');
    assert.match(msg.text, /100 Main St, Brooklyn, NY 11201/, 'CAN-SPAM postal address in the footer');
    assert.match(msg.html, /100 Main St/);
    assert.doesNotMatch(msg.text + msg.html, /Phishing/, 'nothing a user typed');

    tick(5 * MIN);
    const ok = await call('POST', '/api/auth/email/verify', { code: codeIn(msg) }, owner.token);
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.user.emailVerified, true);
    assert.equal(userById(owner.id)?.emailVerifiedAt, now.toISOString());
    assert.equal(userById(owner.id)?.emailVerification, undefined, 'a used code is gone');

    assert.equal(userById(squatter.id), undefined, 'the unverified duplicate is deleted');
    assert.equal(store.data.items.filter((i) => i.userId === squatter.id).length, 0);
    assert.equal((await call('GET', '/api/me', undefined, squatter.token)).status, 401);
    const deletion = store.data.audit.filter((a) => a.userId === squatter.id);
    assert.deepEqual(
      deletion.map((a) => ({ action: a.action, actor: a.actor, details: a.details })),
      [{ action: 'account.deleted', actor: { type: 'system', id: 'email-verification' }, details: { reason: 'email_verified_by_another_account' } }],
    );
    const verified = store.data.audit.find((a) => a.userId === owner.id && a.action === 'email.verified');
    assert.deepEqual(verified?.details, { duplicateAccountsRemoved: 1 });

    // Only now is the address taken.
    assert.equal((await call('POST', '/api/auth/signup', { email: 'jo@example.com' })).status, 409);
    assert.equal((await call('POST', '/api/auth/signup', { email: 'JO@Example.com' })).status, 409);
    assert.equal((await call('POST', '/api/auth/email/send-code', {}, owner.token)).status, 409, 'already verified');
    assert.equal((await call('POST', '/api/auth/email/verify', { code: '123456' }, owner.token)).status, 200, 'verify is idempotent');
  });

  it('limits wrong guesses to 5 per code, after which even the right code fails', async () => {
    const u = await signup('guess@example.com');
    const code = await devCode(u.token);
    for (let left = 4; left >= 1; left--) {
      const r = await call('POST', '/api/auth/email/verify', { code: wrong(code) }, u.token);
      assert.equal(r.status, 400);
      assert.match(r.json.error, new RegExp(`${left} tr(y|ies) left`));
    }
    assert.equal((await call('POST', '/api/auth/email/verify', { code: wrong(code) }, u.token)).status, 429, 'fifth wrong guess locks the code');
    const locked = await call('POST', '/api/auth/email/verify', { code }, u.token);
    assert.equal(locked.status, 429);
    assert.match(locked.json.error, /Send a new code/);
    assert.equal(userById(u.id)?.emailVerifiedAt, undefined);

    // Malformed input is rejected by the schema and costs nothing.
    assert.equal((await call('POST', '/api/auth/email/verify', { code: '12345' }, u.token)).status, 400);
    assert.equal((await call('POST', '/api/auth/email/verify', { code: 'abcdef' }, u.token)).status, 400);
    assert.equal((await call('POST', '/api/auth/email/verify', {}, u.token)).status, 400);

    const fresh = await devCode(u.token);
    const ok = await call('POST', '/api/auth/email/verify', { code: `${fresh.slice(0, 3)} ${fresh.slice(3)}` }, u.token);
    assert.equal(ok.status, 200, 'a new code works (spaces are fine)');
  });

  it('only the latest code counts', async () => {
    const u = await signup('latest@example.com');
    const first = await devCode(u.token);
    const second = await devCode(u.token);
    if (first !== second) assert.equal((await call('POST', '/api/auth/email/verify', { code: first }, u.token)).status, 400);
    assert.equal((await call('POST', '/api/auth/email/verify', { code: second }, u.token)).status, 200);
  });

  it('rejects an expired code', async () => {
    const u = await signup('late@example.com');
    const code = await devCode(u.token);
    tick(30 * MIN - 1);
    assert.equal(userById(u.id)?.emailVerification?.attempts, 0);
    assert.equal((await call('POST', '/api/auth/email/verify', { code: wrong(code) }, u.token)).status, 400, 'still live a moment before');
    tick(1);
    const r = await call('POST', '/api/auth/email/verify', { code }, u.token);
    assert.equal(r.status, 410);
    assert.match(r.json.error, /expired/);
    assert.equal(userById(u.id)?.emailVerifiedAt, undefined);
    assert.equal(userById(u.id)?.emailVerification, undefined, 'the expired code is cleared');
    assert.equal((await call('POST', '/api/auth/email/verify', { code }, u.token)).status, 400, 'no code waiting');
  });

  it('rate limits codes per address (5 an hour), shared by every account claiming it', async () => {
    const a = await signup('flood@example.com');
    const b = await signup('flood@example.com');
    setVerificationMailer(null);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await call('POST', '/api/auth/email/send-code', {}, i % 2 ? b.token : a.token)).status);
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
    const limited = await call('POST', '/api/auth/email/send-code', {}, b.token);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal(LIMITS.emailCode.capacity, 5);

    const other = await signup('someone-else@example.com');
    assert.equal((await call('POST', '/api/auth/email/send-code', {}, other.token)).status, 200, 'other addresses are unaffected');

    tick(60 * MIN);
    assert.equal((await call('POST', '/api/auth/email/send-code', {}, a.token)).status, 200, 'refills over the hour');
  });

  it('in production without an email sender, answers 503 and issues no code', async () => {
    const u = await signup('prod@example.com');
    config.devLogin = false;
    setVerificationMailer(null);
    const r = await call('POST', '/api/auth/email/send-code', {}, u.token);
    assert.equal(r.status, 503);
    assert.equal(r.json.devCode, undefined);
    assert.equal(userById(u.id)?.emailVerification, undefined);
  });

  it('a failed send answers 502 and keeps the code that was already sent', async () => {
    const u = await signup('flaky@example.com');
    const mail = fakeSender();
    setVerificationMailer(mail.mailer);
    assert.equal((await call('POST', '/api/auth/email/send-code', {}, u.token)).status, 200);
    const code = codeIn(mail.sent[0]);
    mail.failOnce();
    assert.equal((await call('POST', '/api/auth/email/send-code', {}, u.token)).status, 502);
    assert.equal((await call('POST', '/api/auth/email/verify', { code }, u.token)).status, 200, 'the code in the inbox still works');
  });

  it('never logs a code, and returns it only from a dev build with no sender', async () => {
    const u = await signup('quiet@example.com');
    const mail = fakeSender();
    setVerificationMailer(mail.mailer);
    config.devLogin = false;
    logs.length = 0;
    const sent = await call('POST', '/api/auth/email/send-code', {}, u.token);
    assert.equal(sent.status, 200);
    const code = codeIn(mail.sent[0]);
    assert.ok(!sent.text.includes(code), 'not in the production response');
    assert.equal(sent.json.devCode, undefined);

    // Stored only as a keyed hash.
    const pending = userById(u.id)?.emailVerification;
    assert.ok(pending);
    assert.match(pending.codeHash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(pending).includes(code));
    assert.notEqual(pending.codeHash, v.hashCode({ id: 'usr_other', email: 'quiet@example.com' }, code), 'bound to the account');

    // Not in the data export either.
    const exp = await call('GET', '/api/me/export', undefined, u.token);
    assert.equal(exp.status, 200);
    assert.ok(!exp.text.includes(pending.codeHash) && !exp.text.includes('emailVerification"'));
    assert.equal(exp.json.profile.emailVerifiedAt, undefined);

    await call('POST', '/api/auth/email/verify', { code: wrong(code) }, u.token);
    await call('POST', '/api/auth/email/verify', { code }, u.token);
    assert.equal(userById(u.id)?.emailVerifiedAt, now.toISOString());
    assert.ok(logs.length > 0, 'requests were logged');
    assert.ok(!logs.some((l) => l.includes(code)), 'no log line contains the code');
    assert.equal((await call('GET', '/api/me/export', undefined, u.token)).json.profile.emailVerifiedAt, now.toISOString(), 'verification time is exported');

    // Dev build: a configured sender still means email only; the code comes back only when there is no sender.
    config.devLogin = true;
    const dev = await signup('dev@example.com');
    setVerificationMailer(mail.mailer);
    assert.equal((await call('POST', '/api/auth/email/send-code', {}, dev.token)).json.devCode, undefined);
    logs.length = 0;
    const devReply = await devCode(dev.token);
    assert.match(devReply, /^\d{6}$/);
    assert.ok(!logs.some((l) => l.includes(devReply)));
  });

  it('requires sign-in', async () => {
    assert.equal((await call('POST', '/api/auth/email/send-code', {})).status, 401);
    assert.equal((await call('POST', '/api/auth/email/verify', { code: '123456' })).status, 401);
  });
});

describe('dev login with duplicate addresses', () => {
  it('prefers the verified account', async () => {
    const owner = await signup('both@example.com');
    const code = await devCode(owner.token);
    assert.equal((await call('POST', '/api/auth/email/verify', { code }, owner.token)).status, 200);
    // An unverified duplicate that predates the verification (e.g. written by another instance).
    store.data.users.unshift({ id: 'usr_dup', email: 'both@example.com', token: 'tok_dup', plan: 'free', forwardToken: 'dup', alertPrefs: normalizeAlertPrefs({}), createdAt: T0.toISOString() });
    const r = await call('POST', '/api/auth/login', { email: 'both@example.com' });
    assert.equal(r.status, 200);
    assert.equal(r.json.user.id, owner.id);
    assert.equal(r.json.token, owner.token);
  });
});

describe('verification codes (unit)', () => {
  it('are 6 digits, hashed per account and address, and compared after the attempt check', () => {
    for (let i = 0; i < 50; i++) assert.match(v.newCode(), /^\d{6}$/);
    const user: User = { id: 'usr_u', email: 'u@example.com', token: 't', plan: 'free', forwardToken: 'f', alertPrefs: normalizeAlertPrefs({}), createdAt: T0.toISOString() };
    const { code, verification } = v.issueCode(user, T0);
    assert.equal(verification.attempts, 0);
    assert.notEqual(v.hashCode(user, code), v.hashCode({ ...user, email: 'other@example.com' }, code), 'bound to the address');
    assert.deepEqual(v.checkCode(user, wrong(code), T0), { ok: false, reason: 'wrong', attemptsLeft: 4 });
    assert.deepEqual(v.checkCode(user, code, T0), { ok: true });
    assert.deepEqual(v.checkCode(user, code, T0), { ok: false, reason: 'none' }, 'single use');
  });

  it('use the alert-email Postmark settings, and only when email is fully configured', () => {
    setVerificationMailer(undefined);
    assert.equal(verificationMailer({}), null, 'no POSTMARK_SERVER_TOKEN: no sender');
    setVerificationMailer(undefined);
    assert.throws(() => verificationMailer({ POSTMARK_SERVER_TOKEN: 'pm-token' }), /EMAIL_FROM is required/);
    setVerificationMailer(undefined);
    const m = verificationMailer({ POSTMARK_SERVER_TOKEN: 'pm-token', EMAIL_FROM: 'Trialguard <alerts@trialguard.app>', COMPANY_POSTAL_ADDRESS: '1 Main St', APNS_KEY_PATH: '/nonexistent.p8' });
    assert.ok(m);
    assert.equal(m.sender.name, 'postmark');
    assert.equal(m.from, 'Trialguard <alerts@trialguard.app>');
    assert.equal(m.postalAddress, '1 Main St');
    setVerificationMailer(undefined);
    assert.throws(() => verificationMailer({ NODE_ENV: 'production', PUBLIC_URL: 'https://trialguard.app', POSTMARK_SERVER_TOKEN: 'pm-token', EMAIL_FROM: 'a@trialguard.app' }), /COMPANY_POSTAL_ADDRESS/);
  });

  it('render an email with the code and no unsubscribe headers', () => {
    const msg = renderVerificationEmail('a@example.com', '012345', { from: 'Trialguard <alerts@trialguard.app>', publicUrl: 'https://trialguard.app', minutes: 30 });
    assert.equal(msg.to, 'a@example.com');
    assert.match(msg.text, /^012345$/m);
    assert.match(msg.html, />012345</);
    assert.match(msg.text, /expires in 30 minutes/);
    assert.match(msg.text, /ignore this email/);
    assert.deepEqual(msg.headers, {});
  });
});
