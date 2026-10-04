import { z } from 'zod';
import { config } from '../config.ts';
import { decrypt } from '../crypto.ts';
import { assert, HttpError } from '../http.ts';
import { inc } from '../metrics.ts';
import { syncUser } from '../pipeline.ts';
import { KeyUnavailableError, PlaidWebhookVerifier, plaidKeySource, type VerifyResult } from '../plaid/verify.ts';
import { handlePlaidWebhook, webhookLabels, zPlaidWebhook } from '../plaid/webhooks.ts';
import { PLAID_DISCONNECTED_MESSAGE, PlaidApiError, PlaidBank } from '../providers/bank.ts';
import type { Connection, Store, User } from '../store.ts';
import { publicConnection, type RouteDeps } from './shared.ts';

export interface PlaidRouteOptions {
  /** Plaid client. Undefined when Plaid isn't configured: update-mode link tokens answer 501. */
  plaid?: Pick<PlaidBank, 'createUpdateLinkToken' | 'getWebhookVerificationKey'>;
  /** Checks the Plaid-Verification JWT. */
  verifier?: Pick<PlaidWebhookVerifier, 'verify'>;
  /**
   * Whether webhooks must be signed. Always true in production. False only in dev without Plaid
   * credentials, where there is no key to verify against, so the flow can still be demoed with curl.
   */
  requireSignature: boolean;
  /** Plaid expects webhooks to be acknowledged promptly, so an inline pull is cut off after this long. */
  inlineTimeoutMs: number;
}

/** Statuses the user fixes by re-linking through Plaid Link in update mode. */
const NEEDS_RELINK: ReadonlySet<Connection['status']> = new Set(['reauth_required', 'pending_expiration']);

/** These endpoints act on the URL alone; an empty strict schema still rejects stray fields. */
const zNoBody = z.strictObject({});

function ownedBank(store: Store, user: User, id: string): Connection {
  const conn = store.data.connections.find((c) => c.id === id && c.userId === user.id);
  // Another user's connection is "not found" rather than "forbidden", so ids reveal nothing.
  assert(conn, 'Connection not found', 404);
  assert(conn.type === 'bank', 'Only bank connections are reconnected this way', 400);
  return conn;
}

/** Plaid webhooks (SYNC_UPDATES_AVAILABLE, Item errors) and update-mode re-linking. Tests pass `overrides`. */
export function register({ router, store, deps }: RouteDeps, overrides: Partial<PlaidRouteOptions> = {}): void {
  const plaid = 'plaid' in overrides ? overrides.plaid : PlaidBank.configured() ? new PlaidBank() : undefined;
  const opts: PlaidRouteOptions = {
    plaid,
    verifier: overrides.verifier ?? (plaid ? new PlaidWebhookVerifier({ fetchKey: plaidKeySource(plaid), clock: deps.clock }) : undefined),
    requireSignature: overrides.requireSignature ?? (config.production || PlaidBank.configured()),
    inlineTimeoutMs: overrides.inlineTimeoutMs ?? 8_000,
  };

  router.on('POST', '/api/webhooks/plaid', { auth: 'none', limit: 'webhook', body: zPlaidWebhook, maxBody: 64_000 }, async ({ req, body, rawBody, log }) => {
    const labels = webhookLabels(body);
    const reject = (status: number, message: string, result: string, fields: Record<string, unknown>) => {
      inc('plaid_webhooks_total', { ...labels, result });
      log.warn('plaid webhook rejected', { ...labels, ...fields });
      return new HttpError(status, message);
    };

    if (opts.requireSignature) {
      if (!opts.verifier) throw reject(401, 'Invalid webhook signature', 'unverified', { reason: 'plaid_not_configured' });
      const header = req.headers['plaid-verification'];
      let verdict: VerifyResult;
      try {
        verdict = await opts.verifier.verify(typeof header === 'string' ? header : undefined, rawBody);
      } catch (err) {
        if (!(err instanceof KeyUnavailableError)) throw err;
        // Not the sender's fault: a non-2xx lets the delivery be retried once Plaid answers again.
        throw reject(503, 'Webhook could not be verified right now', 'key_unavailable', { err });
      }
      if (!verdict.ok) throw reject(401, 'Invalid webhook signature', 'unverified', { reason: verdict.reason });
      // The same signed delivery seen twice inside the iat window is a replay.
      if (!store.markWebhookProcessed('plaid', `jwt_${verdict.tokenId}`, deps.clock().toISOString())) {
        inc('plaid_webhooks_total', { ...labels, result: 'duplicate' });
        return { ok: true };
      }
    } else {
      log.warn('accepting an unsigned Plaid webhook (dev only: Plaid is not configured)', labels);
    }

    // Processing failures are recorded and reported inside; Plaid still gets its 200.
    const result = await handlePlaidWebhook(store, body, deps, { timeoutMs: opts.inlineTimeoutMs, allowSandboxIds: !opts.requireSignature, log });
    inc('plaid_webhooks_total', { ...labels, result });
    log.info('plaid webhook', { ...labels, result });
    return { ok: true };
  });

  // Update mode, step 1: the app opens Plaid Link with this token and the user signs in to their bank again.
  router.on('POST', '/api/connections/:id/link-token', { body: zNoBody }, async ({ user, params, log }) => {
    const conn = ownedBank(store, user, params.id);
    assert(NEEDS_RELINK.has(conn.status), "This connection doesn't need reconnecting", 409);
    assert(opts.plaid, 'Plaid is not configured on this server; reconnecting happens in the Trialguard app', 501);
    assert(conn.provider === 'plaid' && conn.sealedToken, "This connection can't be reconnected. Remove it and connect it again.", 409);
    try {
      return { linkToken: await opts.plaid.createUpdateLinkToken(user.id, decrypt(conn.sealedToken)) };
    } catch (err) {
      if (!(err instanceof PlaidApiError)) throw err;
      log.warn('plaid update-mode link token failed', { connectionId: conn.id, status: err.status, errorCode: err.errorCode });
      throw new HttpError(502, 'Plaid could not start reconnecting. Try again in a moment.');
    }
  });

  // Update mode, step 2: Link succeeded. The access token and item_id are unchanged, so just resume syncing.
  router.on('POST', '/api/connections/:id/relinked', { body: zNoBody, limit: 'sync' }, async ({ user, params }) => {
    const conn = ownedBank(store, user, params.id);
    assert(conn.provider !== 'plaid' || conn.sealedToken, PLAID_DISCONNECTED_MESSAGE, 409);
    conn.status = 'active';
    conn.error = undefined;
    const summary = await syncUser(store, user, deps);
    return { connection: publicConnection(conn), summary };
  });
}
