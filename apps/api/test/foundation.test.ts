import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

process.env.TRIALGUARD_DISABLE_LLM = '1';
process.env.TRIALGUARD_JOBS = '0';

const { createApp, createRouter } = await import('../src/app.ts');
const { defaultDeps } = await import('../src/pipeline.ts');
const { Store } = await import('../src/store.ts');
const { RateLimiter } = await import('../src/ratelimit.ts');
const { StaticKeyring, seal, unseal, needsRotation } = await import('../src/keyring.ts');
const { redact, scrub } = await import('../src/log.ts');
const { renderPrometheus, inc } = await import('../src/metrics.ts');
const { assertNodeVersion } = await import('../src/config.ts');
const { clientIp } = await import('../src/http.ts');

const deps = { ...defaultDeps, llm: undefined, notifier: undefined, clock: () => new Date('2026-10-03T15:00:00Z') };

/** POST/PATCH/PUT routes that legitimately take no body. Anything else must declare a schema. */
const BODILESS = new Set(['POST /api/sync', 'POST /api/alerts/read', 'POST /api/connections/plaid/link-token']);

describe('router', () => {
  it('every mutating route validates its body against a schema', () => {
    const router = createRouter(new Store(), deps);
    const unvalidated = router
      .list()
      .filter((r) => ['POST', 'PATCH', 'PUT'].includes(r.method) && !r.validated && !r.raw && !BODILESS.has(`${r.method} ${r.path}`));
    assert.deepEqual(unvalidated, []);
  });

  let server: Server;
  let base: string;
  before(async () => {
    // Tight auth bucket so the limiter test is quick.
    const limiter = new RateLimiter({ auth: { capacity: 3, per: 60 }, default: { capacity: 1000, per: 60 } });
    server = createServer(createApp(new Store(), deps, limiter));
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

  it('rejects invalid bodies with a 400 that names each problem', async () => {
    const res = await post('/api/auth/signup', { email: 'not-an-email', state: 'California', extra: 1 });
    assert.equal(res.status, 400);
    const json = (await res.json()) as { details: string[] };
    assert.ok(json.details.some((d) => d.startsWith('email')));
    assert.ok(json.details.some((d) => d.startsWith('state')));
    assert.ok(json.details.some((d) => /extra|unrecognized/i.test(d)));
  });

  it('rejects malformed JSON and oversized bodies', async () => {
    assert.equal((await post('/api/auth/login', '{nope')).status, 400);
    assert.equal((await post('/api/auth/signup', 'x'.repeat(1_100_000))).status, 413);
  });

  it('rate limits the auth endpoints with Retry-After', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await post('/api/auth/login', { email: `x${i}@example.com` })).status);
    assert.ok(statuses.includes(429), `got ${statuses.join(',')}`);
    const limited = await post('/api/auth/login', { email: 'y@example.com' });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  });

  it('serves liveness, readiness and metrics', async () => {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
    const metrics = await (await fetch(`${base}/metrics`)).text();
    assert.match(metrics, /http_requests_total/);
  });

  it('returns 405 for a known path with the wrong method', async () => {
    const res = await fetch(`${base}/api/me`, { method: 'PUT' });
    assert.equal(res.status, 405);
  });
});

describe('rate limiter', () => {
  it('refills over time', () => {
    let t = 0;
    const rl = new RateLimiter({ x: { capacity: 2, per: 10 } }, () => t);
    assert.equal(rl.take('x', 'k'), 0);
    assert.equal(rl.take('x', 'k'), 0);
    assert.ok(rl.take('x', 'k') > 0);
    t += 5_000;
    assert.equal(rl.take('x', 'k'), 0);
    assert.equal(rl.take('x', 'other'), 0, 'keys are independent');
  });
});

describe('keyring', () => {
  const hex = () => randomBytes(32).toString('hex');
  const oldKey = hex();
  const newKey = hex();

  it('round-trips and records the key id', () => {
    const ring = new StaticKeyring({ a: oldKey }, 'a');
    const sealed = seal(ring, 'access-sandbox-123');
    assert.match(sealed, /^v2\.a\./);
    assert.equal(unseal(ring, sealed), 'access-sandbox-123');
  });

  it('decrypts old ciphertexts after rotation and flags them for re-encryption', () => {
    const before = new StaticKeyring({ a: oldKey }, 'a');
    const sealed = seal(before, 'secret');
    const rotated = new StaticKeyring({ b: newKey, a: oldKey }, 'b');
    assert.equal(unseal(rotated, sealed), 'secret');
    assert.ok(needsRotation(rotated, sealed));
    assert.ok(!needsRotation(rotated, seal(rotated, 'secret')));
  });

  it('refuses tampered ciphertexts and unknown key ids', () => {
    const ring = new StaticKeyring({ a: oldKey }, 'a');
    const sealed = seal(ring, 'secret');
    const parts = sealed.split('.');
    parts[4] = Buffer.from('tampered').toString('base64url');
    assert.throws(() => unseal(ring, parts.join('.')));
    assert.throws(() => unseal(ring, sealed.replace('v2.a.', 'v2.zz.')));
    // The key id is bound into the AAD, so relabelling a ciphertext fails too.
    const two = new StaticKeyring({ a: oldKey, b: oldKey }, 'a');
    assert.throws(() => unseal(two, sealed.replace('v2.a.', 'v2.b.')));
  });

  it('rejects malformed keys', () => {
    assert.throws(() => new StaticKeyring({ a: 'short' }, 'a'));
    assert.throws(() => new StaticKeyring({ a: oldKey }, 'missing'));
  });
});

describe('logging and metrics', () => {
  it('redacts personal data', () => {
    const out = redact({ email: 'a@b.com', note: 'card 4111111111111111', nested: { token: 'abc', ok: 'contact me at x@y.io' } }) as Record<string, any>;
    assert.equal(out.email, '[redacted]');
    assert.equal(out.note, '[redacted]');
    assert.equal(out.nested.token, '[redacted]');
    assert.equal(out.nested.ok, 'contact me at [email]');
    assert.equal(scrub('Authorization: Bearer abc.def-123 acct 123456789012'), 'Authorization: Bearer [token] acct [digits]');
  });

  it('renders Prometheus text', () => {
    inc('test_counter_total', { result: 'ok' });
    assert.match(renderPrometheus(), /test_counter_total\{result="ok"\} 1/);
  });
});

describe('runtime guard', () => {
  it('requires Node 22.18+', () => {
    assert.throws(() => assertNodeVersion('22.11.0'));
    assert.throws(() => assertNodeVersion('20.18.0'));
    assert.doesNotThrow(() => assertNodeVersion('22.18.0'));
    assert.doesNotThrow(() => assertNodeVersion('24.1.0'));
  });
});

describe('client ip behind proxies', () => {
  const req = (xff: string | undefined) => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: '10.0.0.5' } }) as never;

  it('ignores the client-controlled left-most entries', () => {
    assert.equal(clientIp(req('6.6.6.6, 198.51.100.66'), 1), '198.51.100.66');
    assert.equal(clientIp(req('6.6.6.6, 198.51.100.66, 10.1.1.1'), 2), '198.51.100.66');
  });

  it('uses the socket address when no proxy is trusted or the header is short', () => {
    assert.equal(clientIp(req('6.6.6.6'), 0), '10.0.0.5');
    assert.equal(clientIp(req(undefined), 1), '10.0.0.5');
    assert.equal(clientIp(req('198.51.100.66'), 2), '10.0.0.5');
  });
});
