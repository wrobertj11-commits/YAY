import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

process.env.ADMIN_TOKEN = 'real-admin-token-0123456789abcdef';
process.env.TRIALGUARD_DISABLE_LLM = '1';
process.env.TRIALGUARD_JOBS = '0';

const { createApp } = await import('../src/app.ts');
const { defaultDeps } = await import('../src/pipeline.ts');
const { RateLimiter } = await import('../src/ratelimit.ts');
const { Store } = await import('../src/store.ts');

let server: Server;
let base: string;
before(async () => {
  const limiter = new RateLimiter({ auth: { capacity: 3, per: 60 }, default: { capacity: 1000, per: 60 } });
  server = createServer(createApp(new Store(), { ...defaultDeps, llm: undefined, notifier: undefined }, limiter));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

describe('admin token', () => {
  it('rate limits wrong tokens so the shared admin token cannot be brute-forced', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`${base}/api/admin/concierge?status=queued`, { headers: { Authorization: `Bearer guess-${i}`, 'X-Staff-Id': 'sam' } });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses.slice(0, 3), [401, 401, 401]);
    assert.ok(statuses.slice(3).every((s) => s === 429), statuses.join(','));
  });
});
