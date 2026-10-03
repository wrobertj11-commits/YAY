import { existsSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import {
  alertedTrialIds,
  buildCancelPlan,
  conciergeFeeCents,
  createManualItem,
  daysBetween,
  entitlements,
  getMerchant,
  markCancelled,
  PLAN_PRICES,
  searchMerchants,
  summarize,
  READABLE_SUBJECT_TERMS,
  toISODate,
  yearlyEquivalent,
  type Cadence,
  type TrackedItem,
} from '@trialguard/core';
import { config } from './config.ts';
import { encrypt, newId, newToken } from './crypto.ts';
import { PlaidBank } from './providers/bank.ts';
import { ingestEmail, recompute, syncUser, type PipelineDeps } from './pipeline.ts';
import type { Connection, ConnectionType, Store, User } from './store.ts';

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Handler = (ctx: { req: IncomingMessage; body: any; params: Record<string, string>; user: User; query: URLSearchParams }) => unknown;
interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  auth: boolean;
  handler: Handler;
}

const CADENCES: Cadence[] = ['weekly', 'monthly', 'quarterly', 'annual'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function assert(cond: unknown, message: string, status = 400): asserts cond {
  if (!cond) throw new HttpError(status, message);
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new HttpError(413, 'Body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function publicUser(store: Store, u: User) {
  return {
    id: u.id,
    email: u.email,
    plan: u.plan,
    state: u.state,
    alertPrefs: u.alertPrefs,
    forwardingAddress: `u-${u.forwardToken}@${config.inboundDomain}`,
    entitlements: entitlements(u.plan),
    lastSyncAt: u.lastSyncAt,
    createdAt: u.createdAt,
    connections: store.data.connections.filter((c) => c.userId === u.id).map(publicConnection),
  };
}

function publicConnection(c: Connection) {
  return { id: c.id, type: c.type, provider: c.provider, label: c.label, status: c.status, error: c.error, lastSyncedAt: c.lastSyncedAt };
}

function publicItem(item: TrackedItem, today: string, alerted: Set<string>) {
  const merchant = getMerchant(item.merchantId);
  const date = item.status === 'trial' ? item.trialEndsAt : item.nextChargeDate;
  return {
    ...item,
    userId: undefined,
    category: merchant?.category ?? 'Other',
    cancelDifficulty: merchant?.difficulty,
    daysUntilCharge: date ? daysBetween(today, date) : undefined,
    yearlyCents: yearlyEquivalent(item.amountCents, item.cadence),
    alertsOn: item.status !== 'trial' || alerted.has(item.id),
    needsReview: !item.confirmedByUser && item.confidence < 0.6,
  };
}

export function createApp(store: Store, deps: PipelineDeps) {
  const routes: Route[] = [];
  const on = (method: string, p: string, handler: Handler, auth = true) => {
    const keys: string[] = [];
    const pattern = new RegExp(`^${p.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
    routes.push({ method, pattern, keys, auth, handler });
  };
  const today = () => toISODate(deps.clock());
  const userItem = (user: User, id: string) => {
    const item = store.data.items.find((i) => i.id === id && i.userId === user.id);
    assert(item, 'Item not found', 404);
    return item;
  };

  // ---------- auth & account ----------
  on('POST', '/api/auth/signup', ({ body }) => {
    const email = String(body.email ?? '').trim().toLowerCase();
    assert(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email), 'A valid email is required');
    assert(!store.data.users.some((u) => u.email === email), 'An account with that email already exists', 409);
    const user: User = {
      id: newId('usr'),
      email,
      token: newToken(),
      plan: 'free',
      state: typeof body.state === 'string' ? body.state.toUpperCase().slice(0, 2) : undefined,
      forwardToken: newToken().slice(0, 10).toLowerCase(),
      alertPrefs: { push: true, email: true },
      createdAt: deps.clock().toISOString(),
    };
    store.data.users.push(user);
    store.save();
    return { token: user.token, user: publicUser(store, user) };
  }, false);

  on('POST', '/api/auth/login', ({ body }) => {
    // Production sends a magic link; the dev build signs straight in so the demo is usable.
    assert(config.devLogin, 'Check your email for a sign-in link', 202);
    const user = store.data.users.find((u) => u.email === String(body.email ?? '').trim().toLowerCase());
    assert(user, 'No account with that email', 404);
    return { token: user.token, user: publicUser(store, user) };
  }, false);

  on('GET', '/api/me', ({ user }) => publicUser(store, user));

  on('PATCH', '/api/me', ({ user, body }) => {
    if (typeof body.state === 'string') user.state = body.state.toUpperCase().slice(0, 2) || undefined;
    if (body.alertPrefs) user.alertPrefs = { push: Boolean(body.alertPrefs.push), email: Boolean(body.alertPrefs.email) };
    if (body.plan === 'free' || body.plan === 'plus') user.plan = body.plan; // billing (StoreKit / Play Billing) stubbed in the MVP
    recompute(store, user, deps);
    return publicUser(store, user);
  });

  on('DELETE', '/api/me', ({ user }) => {
    store.deleteUser(user.id);
    return { deleted: true };
  });

  // ---------- connections ----------
  on('GET', '/api/connections/email-filter', () => ({
    description: 'We only read emails whose subject looks like a receipt, signup, renewal, price change or cancellation. Bodies are processed and discarded; only the extracted fields are kept.',
    subjectTerms: READABLE_SUBJECT_TERMS,
    senders: 'Plus receipts from billing / no-reply addresses of known subscription services.',
  }));

  on('POST', '/api/connections/plaid/link-token', async ({ user }) => {
    assert(PlaidBank.configured(), 'Plaid is not configured on this server; use sandbox mode', 501);
    return { linkToken: await new PlaidBank().createLinkToken(user.id) };
  });

  on('POST', '/api/connections', async ({ user, body }) => {
    const type = body.type as ConnectionType;
    assert(['bank', 'gmail', 'outlook'].includes(type), 'type must be bank, gmail or outlook');
    const ent = entitlements(user.plan);
    const mine = store.data.connections.filter((c) => c.userId === user.id);
    if (type === 'bank') assert(mine.filter((c) => c.type === 'bank').length < ent.maxBankConnections, 'Free includes 1 bank connection. Upgrade to Plus for unlimited.', 402);
    else assert(mine.filter((c) => c.type !== 'bank').length < ent.maxInboxes, 'Free includes 1 inbox. Upgrade to Plus for unlimited.', 402);

    const sandbox = body.mode !== 'live';
    let sealedToken: string | undefined;
    let provider: Connection['provider'] = 'sandbox';
    if (!sandbox) {
      if (type === 'bank') {
        assert(PlaidBank.configured(), 'Plaid is not configured on this server', 501);
        assert(typeof body.publicToken === 'string', 'publicToken from Plaid Link is required');
        sealedToken = encrypt(await new PlaidBank().exchangePublicToken(body.publicToken));
        provider = 'plaid';
      } else {
        // The mobile client runs the OAuth consent flow (read-only scope) and hands us the token.
        assert(typeof body.accessToken === 'string', 'accessToken from the OAuth flow is required');
        sealedToken = encrypt(body.accessToken);
        provider = type;
      }
    }
    const conn: Connection = {
      id: newId('con'),
      userId: user.id,
      type,
      provider,
      label: String(body.label ?? (type === 'bank' ? (sandbox ? 'Demo Bank (sandbox)' : 'Bank account') : `${type === 'gmail' ? 'Gmail' : 'Outlook'}${sandbox ? ' (sandbox)' : ''}`)),
      sealedToken,
      status: 'active',
      createdAt: deps.clock().toISOString(),
    };
    store.data.connections.push(conn);
    const summary = await syncUser(store, user, deps);
    return { connection: publicConnection(conn), summary };
  });

  on('DELETE', '/api/connections/:id', ({ user, params }) => {
    const conn = store.data.connections.find((c) => c.id === params.id && c.userId === user.id);
    assert(conn, 'Connection not found', 404);
    store.data.connections = store.data.connections.filter((c) => c !== conn);
    // Disconnecting removes the raw data that came through it.
    store.data.transactions = store.data.transactions.filter((t) => t.connectionId !== conn.id);
    store.save();
    return { deleted: true };
  });

  on('POST', '/api/sync', ({ user }) => syncUser(store, user, deps));

  // ---------- items ----------
  on('GET', '/api/items', ({ user }) => {
    const items = store.itemsFor(user.id);
    const alerted = alertedTrialIds(items, user.plan);
    return items.map((i) => publicItem(i, today(), alerted));
  });

  on('GET', '/api/items/:id', ({ user, params }) => {
    const item = userItem(user, params.id);
    const alerted = alertedTrialIds(store.itemsFor(user.id), user.plan);
    const transactions = store.data.transactions
      .filter((t) => t.userId === user.id && (item.transactionIds.includes(t.id) || item.postCancelChargeIds?.includes(t.id)))
      .map(({ id, date, amountCents, description, paymentMethod }) => ({ id, date, amountCents, description, paymentMethod }))
      .sort((a, b) => b.date.localeCompare(a.date));
    return { ...publicItem(item, today(), alerted), transactions, cancelPlan: buildCancelPlan(item, user.state) };
  });

  on('POST', '/api/items', ({ user, body }) => {
    assert(typeof body.name === 'string' && body.name.trim(), 'name is required');
    assert(Number.isInteger(body.amountCents) && body.amountCents >= 0, 'amountCents must be a non-negative integer');
    assert(CADENCES.includes(body.cadence), 'cadence must be weekly, monthly, quarterly or annual');
    assert(typeof body.date === 'string' && ISO.test(body.date), 'date must be YYYY-MM-DD');
    const item = createManualItem(
      { name: body.name.trim(), merchantId: body.merchantId, amountCents: body.amountCents, cadence: body.cadence, date: body.date, isTrial: Boolean(body.isTrial), paymentMethod: body.paymentMethod },
      newId('itm'),
      deps.clock().toISOString(),
    );
    store.data.items.push({ ...item, userId: user.id });
    recompute(store, user, deps);
    return store.data.items.find((i) => i.id === item.id);
  });

  on('PATCH', '/api/items/:id', ({ user, params, body }) => {
    const item = userItem(user, params.id);
    // "Is this right?" confirm step.
    if (body.confirm === true) item.confirmedByUser = true;
    if (body.dismiss === true) item.status = 'dismissed';
    if (body.restore === true && item.status === 'dismissed') item.status = item.trialEndsAt ? 'trial' : 'active';
    if (typeof body.name === 'string' && body.name.trim()) item.name = body.name.trim();
    if (Number.isInteger(body.amountCents) && body.amountCents >= 0) item.amountCents = body.amountCents;
    if (CADENCES.includes(body.cadence)) item.cadence = body.cadence;
    if (typeof body.nextChargeDate === 'string' && ISO.test(body.nextChargeDate)) {
      if (item.status === 'trial') item.trialEndsAt = body.nextChargeDate;
      item.nextChargeDate = body.nextChargeDate;
    }
    if (Object.keys(body).some((k) => k !== 'dismiss' && k !== 'restore')) item.confirmedByUser = true;
    item.updatedAt = deps.clock().toISOString();
    recompute(store, user, deps);
    return item;
  });

  on('DELETE', '/api/items/:id', ({ user, params }) => {
    const item = userItem(user, params.id);
    assert(item.sources.length === 1 && item.sources[0] === 'manual', 'Only manually added items can be deleted; dismiss detected ones instead');
    store.data.items = store.data.items.filter((i) => i !== item);
    recompute(store, user, deps);
    return { deleted: true };
  });

  // ---------- cancel hub ----------
  on('GET', '/api/items/:id/cancel', ({ user, params }) => buildCancelPlan(userItem(user, params.id), user.state));

  on('POST', '/api/items/:id/cancel', ({ user, params, body }) => {
    const item = userItem(user, params.id);
    const now = deps.clock().toISOString();
    if (body.action === 'started') {
      item.cancelStartedAt = now;
    } else if (body.action === 'completed') {
      assert(item.status === 'active' || item.status === 'trial' || item.status === 'charged_after_cancel', 'Item is already cancelled');
      Object.assign(item, markCancelled(item, today(), now, typeof body.proof === 'string' ? body.proof : 'Marked cancelled in app'));
    } else if (body.action === 'undo') {
      assert(item.status === 'cancel_pending', 'Only a pending cancellation can be undone');
      Object.assign(item, { status: item.trialEndsAt ? 'trial' : 'active', cancelledAt: undefined, cancelProof: undefined });
    } else if (body.action === 'concierge') {
      const plan = buildCancelPlan(item, user.state);
      assert(plan.conciergeAvailable, 'Done-for-you cancellation is not available for this service yet');
      const request = {
        id: newId('cnc'),
        userId: user.id,
        itemId: item.id,
        feeCents: conciergeFeeCents(yearlyEquivalent(item.amountCents, item.cadence)),
        status: 'queued' as const,
        createdAt: now,
      };
      store.data.concierge.push(request);
      item.cancelStartedAt = now;
      store.save();
      return { concierge: request };
    } else {
      throw new HttpError(400, 'action must be started, completed, undo or concierge');
    }
    item.updatedAt = now;
    recompute(store, user, deps);
    return item;
  });

  on('POST', '/api/merchants/:id/report-broken', ({ user, params, body }) => {
    assert(getMerchant(params.id), 'Unknown merchant', 404);
    store.data.brokenLinks.push({ merchantId: params.id, userId: user.id, note: typeof body.note === 'string' ? body.note.slice(0, 500) : undefined, createdAt: deps.clock().toISOString() });
    store.save();
    return { thanks: true };
  });

  on('GET', '/api/merchants', ({ query }) => searchMerchants(query.get('q') ?? '', 20).map(({ id, name, category }) => ({ id, name, category })));

  // ---------- forwarded email (F6) ----------
  on('POST', '/api/forward', async ({ user, body }) => {
    assert(typeof body.text === 'string' && body.text.trim(), 'Paste the email text');
    const subject = typeof body.subject === 'string' ? body.subject : body.text.split('\n')[0].slice(0, 200);
    const signal = await ingestEmail(
      store,
      user,
      { id: newId('fwd'), from: typeof body.from === 'string' ? body.from : '', subject, date: deps.clock().toISOString(), body: body.text },
      'forwarded',
      deps,
    );
    assert(signal, "We couldn't find a subscription or trial in that email. Try adding it by hand.", 422);
    recompute(store, user, deps);
    const item = store.itemsFor(user.id).find((i) => i.emailIds.includes(signal.emailId));
    return { signal: { ...signal, userId: undefined }, item };
  });

  /** Webhook from the inbound-mail provider for u-<token>@<inboundDomain>. */
  on('POST', '/api/inbound', async ({ req, body }) => {
    assert(!config.inboundSecret || req.headers['x-inbound-secret'] === config.inboundSecret, 'Forbidden', 403);
    const token = String(body.to ?? '').match(/^u-([a-z0-9_-]+)@/i)?.[1]?.toLowerCase();
    const user = store.data.users.find((u) => u.forwardToken === token);
    assert(user, 'Unknown forwarding address', 404);
    const signal = await ingestEmail(
      store,
      user,
      { id: String(body.messageId ?? newId('fwd')), from: String(body.originalFrom ?? body.from ?? ''), subject: String(body.subject ?? ''), date: deps.clock().toISOString(), body: String(body.text ?? '') },
      'forwarded',
      deps,
    );
    if (signal) recompute(store, user, deps);
    return { accepted: Boolean(signal) };
  }, false);

  // ---------- alerts & summary ----------
  on('GET', '/api/alerts', ({ user }) => {
    const now = deps.clock().toISOString();
    const mine = store.data.alerts.filter((a) => a.userId === user.id && a.channel === (user.alertPrefs.push ? 'push' : 'email'));
    return {
      inbox: mine.filter((a) => a.sentAt).sort((a, b) => b.sentAt!.localeCompare(a.sentAt!)),
      upcoming: mine.filter((a) => !a.sentAt && a.sendAt > now).sort((a, b) => a.sendAt.localeCompare(b.sendAt)),
    };
  });

  on('POST', '/api/alerts/read', ({ user }) => {
    const now = deps.clock().toISOString();
    for (const a of store.data.alerts) if (a.userId === user.id && a.sentAt && !a.readAt) a.readAt = now;
    store.save();
    return { ok: true };
  });

  on('GET', '/api/summary', ({ user }) => {
    const s = summarize(store.itemsFor(user.id), today());
    const ent = entitlements(user.plan);
    return {
      ...s,
      // Free shows totals; the savings tracker is part of Plus.
      savedSoFarCents: ent.savingsTracker ? s.savedSoFarCents : null,
      verifiedSavedCents: ent.savingsTracker ? s.verifiedSavedCents : null,
      plusPrice: PLAN_PRICES.plus,
    };
  });

  on('GET', '/api/health', () => ({ ok: true, llm: config.llmEnabled, plaid: PlaidBank.configured() }), false);

  // ---------- dispatcher ----------
  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
    };

    if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);

    const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
    if (!route) return send(404, { error: 'Not found' });
    try {
      let user: User | undefined;
      if (route.auth) {
        const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
        user = token ? store.userByToken(token) : undefined;
        assert(user, 'Sign in required', 401);
      }
      const m = route.pattern.exec(url.pathname)!;
      const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
      const result = await route.handler({ req, body, params, user: user!, query: url.searchParams });
      send(200, result);
    } catch (err) {
      if (err instanceof HttpError) return send(err.status, { error: err.message });
      console.error(err);
      send(500, { error: 'Something went wrong' });
    }
  };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

function serveStatic(pathname: string, res: ServerResponse) {
  const root = config.webDist;
  let file = path.join(root, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(root, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Web app not built. Run `npm run build -w @trialguard/web` or use `npm run dev`.');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}
