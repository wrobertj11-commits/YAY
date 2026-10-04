/**
 * Plaid webhooks: what each one means for a bank connection.
 *
 * Getting Plaid production access (also in docs/LAUNCH.md)
 * ---------------------------------------------------------
 * 1. In the Plaid Dashboard, request Production access for the Transactions product. Plaid asks for
 *    a company profile and use case, and has you complete its security questionnaire. Approval is
 *    a review with its own queue, so start it early.
 * 2. Fill in the application display information (name, logo, website). Link shows it to users when
 *    they connect a bank.
 * 3. OAuth banks: several large US institutions connect through OAuth and need extra registration
 *    on top of Production approval, tracked per institution in the Dashboard. The native app also
 *    needs its redirect configured: an allowed redirect URI (iOS universal link) in the Dashboard,
 *    passed as `redirect_uri` on /link/token/create, and the Android package name passed as
 *    `android_package_name`. Neither is sent yet (see createLinkToken in providers/bank.ts).
 * 4. Production uses its own secret (Sandbox secrets don't work there) and its own Items: nothing
 *    linked in Sandbox carries over. Set PLAID_ENV=production, PLAID_CLIENT_ID, PLAID_SECRET.
 * 5. Set PLAID_WEBHOOK_URL to the public HTTPS URL of POST /api/webhooks/plaid. It is attached to each
 *    Item when its link token is created, so Items linked before it was set don't send webhooks
 *    (Plaid's /item/webhook/update can change it per Item). The API must be able to reach
 *    https://production.plaid.com to fetch webhook verification keys; production rejects unsigned
 *    webhooks.
 * 6. When a user removes a bank, call PlaidBank.removeItem. Plaid recommends it when a user
 *    disconnects, and for a subscription-billed product like Transactions it is what ends billing
 *    for that Item. DELETE /api/connections/:id does this (best effort).
 *
 * Handling
 * --------
 * TRANSACTIONS / SYNC_UPDATES_AVAILABLE pulls that connection right away and recomputes the user,
 * so a trial that is about to convert gets its alert now rather than after the daily re-check.
 * ITEM codes move the connection between statuses; the user fixes reauth_required and
 * pending_expiration by re-linking in update mode (routes/plaid.ts). Anything else is ignored.
 */
import { z } from 'zod';
import type { Logger } from '../log.ts';
import { reportError } from '../log.ts';
import { describe, inc } from '../metrics.ts';
import { pullConnection, recompute, type PipelineDeps } from '../pipeline.ts';
import { LOGIN_REQUIRED_MESSAGE, PLAID_DISCONNECTED_MESSAGE, recordPullFailure } from '../providers/bank.ts';
import type { Connection, Store, User } from '../store.ts';

describe('plaid_webhooks_total', 'Plaid webhooks by type, code and result');

/** The fields we act on. Plaid adds others per webhook (environment, consent_expiration_time, ...); they pass through. */
export const zPlaidWebhook = z.looseObject({
  webhook_type: z.string().min(1).max(64),
  webhook_code: z.string().min(1).max(64),
  item_id: z.string().max(256).nullish(),
  error: z.looseObject({ error_code: z.string().max(128).nullish() }).nullish(),
});

export type PlaidWebhook = z.infer<typeof zPlaidWebhook>;

export type WebhookResult = 'processed' | 'ignored' | 'unknown_item' | 'failed' | 'timeout';

export { LOGIN_REQUIRED_MESSAGE };
export const EXPIRING_MESSAGE = 'Access to this bank expires soon. Reconnect to keep tracking charges.';

/** What an ITEM webhook does to a connection. */
export type ItemAction = { kind: 'status'; status: Connection['status']; error?: string } | { kind: 'revoke' };

export function itemAction(code: string, errorCode: string | null | undefined): ItemAction | undefined {
  switch (code) {
    case 'ERROR':
      // Other Item errors surface on the next pull; only this one needs the user.
      return errorCode === 'ITEM_LOGIN_REQUIRED' ? { kind: 'status', status: 'reauth_required', error: LOGIN_REQUIRED_MESSAGE } : undefined;
    case 'PENDING_EXPIRATION':
    case 'PENDING_DISCONNECT':
      return { kind: 'status', status: 'pending_expiration', error: EXPIRING_MESSAGE };
    case 'LOGIN_REPAIRED':
      return { kind: 'status', status: 'active' };
    case 'USER_PERMISSION_REVOKED':
    case 'USER_ACCOUNT_REVOKED':
      return { kind: 'revoke' };
    default:
      return undefined;
  }
}

const LABEL_TYPES = new Set(['TRANSACTIONS', 'ITEM']);
const LABEL_CODES = new Set(['SYNC_UPDATES_AVAILABLE', 'ERROR', 'PENDING_EXPIRATION', 'PENDING_DISCONNECT', 'LOGIN_REPAIRED', 'USER_PERMISSION_REVOKED', 'USER_ACCOUNT_REVOKED']);

/** Metric labels from an untrusted body: anything outside the known set becomes "other" so cardinality stays bounded. */
export function webhookLabels(hook: Pick<PlaidWebhook, 'webhook_type' | 'webhook_code'>): { type: string; code: string } {
  return {
    type: LABEL_TYPES.has(hook.webhook_type) ? hook.webhook_type : 'other',
    code: LABEL_CODES.has(hook.webhook_code) ? hook.webhook_code : 'other',
  };
}

/**
 * The connection a webhook is about, by Plaid item_id. `allowSandboxIds` is set only for unsigned
 * dev webhooks: sandbox connections have no item_id, so the demo addresses them by connection id.
 */
export function findWebhookConnection(store: Store, itemId: string, allowSandboxIds: boolean): Connection | undefined {
  return store.data.connections.find(
    (c) => c.type === 'bank' && ((c.provider === 'plaid' && c.externalId === itemId) || (allowSandboxIds && c.provider === 'sandbox' && c.id === itemId)),
  );
}

export interface HandleOptions {
  /** Longest we spend pulling inline before acknowledging anyway. The pull keeps running and records its own outcome. */
  timeoutMs: number;
  allowSandboxIds: boolean;
  log: Logger;
}

export async function handlePlaidWebhook(store: Store, hook: PlaidWebhook, deps: PipelineDeps, opts: HandleOptions): Promise<WebhookResult> {
  if (!hook.item_id) return 'ignored';
  const conn = findWebhookConnection(store, hook.item_id, opts.allowSandboxIds);
  const user = conn && store.data.users.find((u) => u.id === conn.userId);
  // Webhooks keep coming for a short while after a user removes a bank or deletes their account.
  if (!conn || !user) return 'unknown_item';

  if (hook.webhook_type === 'TRANSACTIONS') {
    // Legacy codes (INITIAL_UPDATE, DEFAULT_UPDATE, ...) belong to /transactions/get, which we don't use.
    if (hook.webhook_code !== 'SYNC_UPDATES_AVAILABLE') return 'ignored';
    // Same rule as syncUser: a connection waiting for the user would only fail again.
    if (conn.status === 'reauth_required' || (conn.provider === 'plaid' && !conn.sealedToken)) return 'ignored';
    return pullWithin(store, user, conn, deps, opts);
  }

  if (hook.webhook_type !== 'ITEM') return 'ignored';
  const action = itemAction(hook.webhook_code, hook.error?.error_code);
  if (!action || !applyItemAction(store, user, conn, action, hook.webhook_code, deps)) return 'ignored';
  store.save();
  opts.log.info('plaid item status', { connectionId: conn.id, code: hook.webhook_code, status: conn.status });
  return 'processed';
}

/** Returns false when the action doesn't apply to the connection's current state. */
function applyItemAction(store: Store, user: User, conn: Connection, action: ItemAction, code: string, deps: PipelineDeps): boolean {
  if (action.kind === 'revoke') {
    // Consent is gone: the token is useless and must not be kept. Re-connecting creates a new Item.
    conn.sealedToken = undefined;
    conn.cursor = undefined;
    conn.status = 'error';
    conn.error = PLAID_DISCONNECTED_MESSAGE;
    store.audit({
      at: deps.clock().toISOString(),
      actor: { type: 'system', id: 'plaid' },
      action: 'connection.revoked',
      userId: user.id,
      subject: { type: 'connection', id: conn.id },
      details: { code },
    });
    return true;
  }
  // A revoked connection has no token left: neither update mode nor a repaired login can bring it back.
  if (conn.provider === 'plaid' && !conn.sealedToken) return false;
  // Already needs a sign-in; that stronger state stays (update mode fixes both).
  if (action.status === 'pending_expiration' && conn.status === 'reauth_required') return false;
  // A repaired login doesn't renew expiring consent; only re-linking does.
  if (action.status === 'active' && (conn.status === 'active' || conn.status === 'pending_expiration')) return false;
  conn.status = action.status;
  conn.error = action.error;
  return true;
}

/**
 * Pulls one connection and recomputes the user, bounded by `timeoutMs`. Failures are recorded on the
 * connection like a normal sync failure, logged and reported, but never thrown: the webhook is still
 * acknowledged, and the daily re-check retries.
 */
async function pullWithin(store: Store, user: User, conn: Connection, deps: PipelineDeps, opts: HandleOptions): Promise<WebhookResult> {
  // Never rejects, so it can outlive the timeout without becoming an unhandled rejection.
  const work = (async (): Promise<WebhookResult> => {
    try {
      await pullConnection(store, user, conn, deps);
    } catch (err) {
      recordWebhookPullFailure(store, conn, err, opts.log);
      return 'failed';
    }
    try {
      recompute(store, user, deps);
      return 'processed';
    } catch (err) {
      // Not the connection's fault; the pulled data is kept and the daily re-check recomputes.
      reportError(err, { source: 'plaid-webhook', step: 'recompute', userId: user.id });
      return 'failed';
    }
  })();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<WebhookResult>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), opts.timeoutMs);
  });
  try {
    const result = await Promise.race([work, timeout]);
    if (result === 'timeout') opts.log.warn('plaid webhook pull still running; acknowledged anyway', { connectionId: conn.id, timeoutMs: opts.timeoutMs });
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function recordWebhookPullFailure(store: Store, conn: Connection, err: unknown, log: Logger): void {
  // The ITEM / ERROR webhook may arrive later (or not at all); a login-required pull already told us.
  if (!recordPullFailure(conn, err).loginRequired) {
    inc('sync_connection_errors_total', { provider: conn.provider });
    reportError(err, { source: 'plaid-webhook', connectionId: conn.id });
  }
  log.warn('plaid webhook pull failed', { connectionId: conn.id, err });
  store.save();
}
