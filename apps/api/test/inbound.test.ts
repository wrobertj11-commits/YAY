import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createManualItem, normalizeAlertPrefs } from '@trialguard/core';

process.env.TRIALGUARD_DISABLE_LLM = '1';
process.env.TRIALGUARD_JOBS = '0';

const { createApp } = await import('../src/app.ts');
const { defaultDeps } = await import('../src/pipeline.ts');
const { Store } = await import('../src/store.ts');

const NOW = '2026-10-04T15:00:00Z';
const deps = { ...defaultDeps, llm: undefined, notifier: undefined, clock: () => new Date(NOW) };
const store = new Store();
let server: Server;
let base: string;

function addUser(id: string, email: string) {
  store.data.users.push({ id, email, token: `tok-${id}`, plan: 'free', forwardToken: `fwd${id}`, createdAt: NOW, alertPrefs: normalizeAlertPrefs({}) });
  const item = createManualItem({ name: 'Spotify', merchantId: 'spotify', amountCents: 1199, cadence: 'monthly', date: '2026-10-20', isTrial: false }, `spotify-${id}`, NOW);
  store.data.items.push({ ...item, userId: id });
}

const inbound = (to: string, from: string, n: number) =>
  fetch(`${base}/api/inbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to,
      from,
      originalFrom: 'Spotify <no-reply@spotify.com>',
      subject: 'Your Premium subscription has been cancelled',
      text: 'Sorry to see you go.',
      messageId: `m-${to}-${n}`,
    }),
  });

before(async () => {
  addUser('a', 'alex@example.com');
  addUser('b', 'blair@example.com');
  addUser('c', 'casey@example.com');
  server = createServer(createApp(store, deps));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const status = (id: string) => store.data.items.find((i) => i.id === `spotify-${id}`)?.status;

describe('forwarding address', () => {
  it('ignores a "you cancelled" email a stranger sends to the forwarding address', async () => {
    const res = await inbound('u-fwda@in.trialguard.app', 'Mallory <mallory@evil.example>', 1);
    assert.equal(res.status, 200);
    assert.equal(status('a'), 'active', 'claimed sender is not trusted when the forwarder is not the user');
    const signal = store.data.signals.find((s) => s.userId === 'a');
    assert.equal(signal?.source, 'inbound');
  });

  it("trusts the same email when the user forwards it from their own address", async () => {
    const res = await inbound('u-fwdb@in.trialguard.app', 'Blair <Blair@Example.com>', 1);
    assert.equal(res.status, 200);
    assert.equal(status('b'), 'cancel_pending');
  });

  it('rate limits per forwarding address, not per provider IP', async () => {
    let limited = 0;
    for (let i = 0; i < 65; i++) if ((await inbound('u-fwdc@in.trialguard.app', 'casey@example.com', 100 + i)).status === 429) limited++;
    assert.ok(limited > 0, 'one address eventually hits its own limit');
    // Every request so far came from the same IP, yet another user's mail still goes through.
    const other = await inbound('u-fwda@in.trialguard.app', 'alex@example.com', 999);
    assert.equal(other.status, 200);
  });
});
