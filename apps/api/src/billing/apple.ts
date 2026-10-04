import type { X509Certificate } from 'node:crypto';
import { z } from 'zod';
import type { Logger } from '../log.ts';
import { inc } from '../metrics.ts';
import type { PipelineDeps } from '../pipeline.ts';
import type { BillingSubscription, Store, User } from '../store.ts';
import { verifyAppleJws } from './appleJws.ts';
import {
  applyEntitlements,
  billingAccountToken,
  findSubscription,
  upsertSubscription,
  userByBillingToken,
  userById,
  type SubscriptionStatus,
} from './entitlement.ts';
import { BillingRejection } from './errors.ts';

/**
 * App Store Server Notifications V2, and the signed transactions the app sends right after a purchase.
 * Both are JWS signed by Apple and verified the same way before any field is read.
 */

export interface AppleBillingConfig {
  bundleId: string;
  /** Pinned trust anchors: Apple Root CA - G3 (tests pin a throwaway root). */
  roots: readonly X509Certificate[];
  /**
   * App Store environments accepted. Production keeps "Sandbox" too: App Review and TestFlight buy in the
   * sandbox, and their purchases must unlock Plus or review fails.
   */
  environments: readonly string[];
}

type Clock = Pick<PipelineDeps, 'clock'>;

const AUTO_RENEWABLE = 'Auto-Renewable Subscription';
/** Apple dates are milliseconds since the epoch. */
const zMillis = z.number().int().nonnegative();

const zNotification = z.looseObject({
  notificationType: z.string().max(64),
  subtype: z.string().max(64).optional(),
  notificationUUID: z.string().min(1).max(128),
  signedDate: zMillis.optional(),
  data: z
    .looseObject({
      bundleId: z.string(),
      environment: z.string(),
      signedTransactionInfo: z.string().optional(),
      signedRenewalInfo: z.string().optional(),
    })
    .optional(),
  // Summary notifications (e.g. RENEWAL_EXTENSION / SUMMARY) carry `summary` instead of `data`.
  summary: z.looseObject({ bundleId: z.string(), environment: z.string() }).optional(),
});

const zTransaction = z.looseObject({
  transactionId: z.string(),
  originalTransactionId: z.string().min(1).max(64),
  bundleId: z.string(),
  productId: z.string().min(1).max(200),
  environment: z.string(),
  type: z.string(),
  signedDate: zMillis,
  expiresDate: zMillis.optional(),
  revocationDate: zMillis.optional(),
  appAccountToken: z.string().optional(),
});
type Transaction = z.infer<typeof zTransaction>;

const zRenewal = z.looseObject({
  originalTransactionId: z.string(),
  autoRenewStatus: z.number().int().optional(),
  gracePeriodExpiresDate: zMillis.optional(),
});
type Renewal = z.infer<typeof zRenewal>;

export type AppleOutcome =
  | { result: 'processed'; recordId: string; status: SubscriptionStatus }
  | { result: 'duplicate' | 'ignored' | 'unlinked' | 'stale' };

/** What a notification type means for the subscription. */
type Action = { kind: 'set'; status: SubscriptionStatus } | { kind: 'refresh' } | { kind: 'ignore' };

/**
 * Maps notificationType / subtype. "refresh" types don't change the status by themselves, but carry the
 * current signed transaction and renewal info, so dates and auto-renew are brought up to date.
 */
export function appleAction(type: string, subtype: string | undefined): Action {
  switch (type) {
    case 'SUBSCRIBED':
    case 'DID_RENEW':
    case 'REFUND_REVERSED': // Apple reversed a refund it had granted: access must be reinstated.
      return { kind: 'set', status: 'active' };
    case 'DID_FAIL_TO_RENEW':
      return { kind: 'set', status: subtype === 'GRACE_PERIOD' ? 'grace_period' : 'billing_retry' };
    case 'GRACE_PERIOD_EXPIRED':
    case 'EXPIRED':
      return { kind: 'set', status: 'expired' };
    case 'REFUND':
      return { kind: 'set', status: 'refunded' };
    case 'REVOKE':
      return { kind: 'set', status: 'revoked' };
    case 'DID_CHANGE_RENEWAL_STATUS':
    case 'RENEWAL_EXTENDED':
      return { kind: 'refresh' };
    default:
      return { kind: 'ignore' };
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Status a transaction implies on its own. */
function statusFromTransaction(tx: Transaction, now: Date): SubscriptionStatus {
  if (tx.revocationDate !== undefined) return 'revoked';
  return tx.expiresDate !== undefined && tx.expiresDate > now.getTime() ? 'active' : 'expired';
}

/**
 * Status for a "refresh" (a notification that doesn't set one, or the app's verify call). Event-driven
 * states (grace, billing retry, refund, ...) stand until their own notification, unless the signed
 * transaction shows a later paid period than the one they were about: then the user has paid again.
 */
function refreshedStatus(existing: BillingSubscription | undefined, tx: Transaction, now: Date): SubscriptionStatus {
  const fromTx = statusFromTransaction(tx, now);
  if (!existing || existing.status === 'active' || existing.status === 'expired') return fromTx;
  const newerPeriod = tx.expiresDate !== undefined && (!existing.expiresAt || iso(tx.expiresDate) > existing.expiresAt);
  return fromTx === 'active' && newerPeriod ? 'active' : existing.status;
}

function decodeSigned<T>(jws: string, schema: z.ZodType<T>, apple: AppleBillingConfig, now: Date, what: string): T {
  const parsed = schema.safeParse(verifyAppleJws(jws, apple.roots, now));
  if (!parsed.success) throw new BillingRejection('payload', `${what} has an unexpected shape`);
  return parsed.data;
}

function checkApp(apple: AppleBillingConfig, bundleId: string, environment: string): void {
  if (bundleId !== apple.bundleId) throw new BillingRejection('bundle', 'bundleId does not match this app');
  if (!apple.environments.includes(environment)) throw new BillingRejection('environment', 'environment is not accepted');
}

interface TransactionInput {
  tx: Transaction;
  renewal?: Renewal;
  action: Action;
  subtype?: string;
  eventAt: string;
  /** Verify endpoint: the signed-in user the transaction has already been matched to. */
  linkTo?: User;
}

function applyTransaction(store: Store, input: TransactionInput, deps: Clock, log: Logger): AppleOutcome {
  const { tx, renewal, action, subtype } = input;
  const now = deps.clock();
  const existing = findSubscription(store, 'app_store', tx.originalTransactionId);
  // The token inside Apple's signed transaction is the freshest evidence of whose purchase this is.
  const user = input.linkTo ?? userByBillingToken(store, tx.appAccountToken) ?? userById(store, existing?.userId);
  if (!user) {
    log.warn('app store subscription has no matching account', { recordId: existing?.id });
    return { result: 'unlinked' };
  }

  const status = action.kind === 'set' ? action.status : refreshedStatus(existing, tx, now);
  let autoRenew = renewal?.autoRenewStatus === undefined ? undefined : renewal.autoRenewStatus === 1;
  if (subtype === 'AUTO_RENEW_ENABLED') autoRenew = true;
  if (subtype === 'AUTO_RENEW_DISABLED') autoRenew = false;

  const { record, applied, previousUserId } = upsertSubscription(
    store,
    {
      platform: 'app_store',
      externalId: tx.originalTransactionId,
      userId: user.id,
      productId: tx.productId,
      status,
      expiresAt: tx.expiresDate === undefined ? undefined : iso(tx.expiresDate),
      gracePeriodExpiresAt: renewal?.gracePeriodExpiresDate === undefined ? undefined : iso(renewal.gracePeriodExpiresDate),
      autoRenew,
      environment: tx.environment,
      eventAt: input.eventAt,
    },
    now,
  );
  if (!applied) {
    log.info('app store event older than current state, skipped', { recordId: record.id });
    return { result: 'stale' };
  }
  applyEntitlements(store, [user.id, previousUserId], deps, 'app_store');
  return { result: 'processed', recordId: record.id, status: record.status };
}

/**
 * Handles one App Store Server Notification V2 body. Throws BillingRejection for anything forged or not
 * ours. Idempotent on notificationUUID: Apple retries until it gets a 200.
 */
export function handleAppleNotification(store: Store, signedPayload: string, apple: AppleBillingConfig, deps: Clock, log: Logger): AppleOutcome {
  const now = deps.clock();
  const n = decodeSigned(signedPayload, zNotification, apple, now, 'notification');
  const app = n.data ?? n.summary;
  if (!app) throw new BillingRejection('payload', 'notification carries no app data');
  checkApp(apple, app.bundleId, app.environment);
  if (store.data.webhookEvents.some((e) => e.provider === 'app_store' && e.id === n.notificationUUID)) return { result: 'duplicate' };

  const outcome = applyNotification(store, n, app.environment, apple, deps, log);
  // Everything above is synchronous, so check-then-mark can't interleave with another request.
  store.markWebhookProcessed('app_store', n.notificationUUID, now.toISOString());
  inc('billing_notifications_total', { platform: 'app_store', type: n.notificationType, result: outcome.result });
  return outcome;
}

function applyNotification(
  store: Store,
  n: z.infer<typeof zNotification>,
  environment: string,
  apple: AppleBillingConfig,
  deps: Clock,
  log: Logger,
): AppleOutcome {
  const now = deps.clock();
  const action = appleAction(n.notificationType, n.subtype);
  const signedTx = n.data?.signedTransactionInfo;
  if (action.kind === 'ignore' || !signedTx) {
    log.info('app store notification ignored', { type: n.notificationType, subtype: n.subtype });
    return { result: 'ignored' };
  }
  const tx = decodeSigned(signedTx, zTransaction, apple, now, 'transaction');
  checkApp(apple, tx.bundleId, tx.environment);
  if (tx.environment !== environment) throw new BillingRejection('environment', 'transaction environment differs from the notification');
  const signedRenewal = n.data?.signedRenewalInfo;
  const renewal = signedRenewal ? decodeSigned(signedRenewal, zRenewal, apple, now, 'renewal info') : undefined;
  if (renewal && renewal.originalTransactionId !== tx.originalTransactionId) throw new BillingRejection('payload', 'renewal info is for another subscription');
  if (tx.type !== AUTO_RENEWABLE) {
    log.info('app store notification for a non-subscription product ignored', { type: n.notificationType });
    return { result: 'ignored' };
  }
  return applyTransaction(store, { tx, renewal, action, subtype: n.subtype, eventAt: iso(n.signedDate ?? tx.signedDate) }, deps, log);
}

/**
 * POST /api/billing/apple/verify: the app sends StoreKit's signed transaction right after a purchase so
 * Plus turns on before the server notification lands. Same verification as notifications, and the
 * transaction must carry this user's appAccountToken, so one person's receipt can't unlock another's account.
 */
export function verifyAppleTransaction(store: Store, user: User, signedTransaction: string, apple: AppleBillingConfig, deps: Clock, log: Logger): AppleOutcome {
  const now = deps.clock();
  const tx = decodeSigned(signedTransaction, zTransaction, apple, now, 'transaction');
  checkApp(apple, tx.bundleId, tx.environment);
  if (tx.type !== AUTO_RENEWABLE) throw new BillingRejection('payload', 'not an auto-renewable subscription');
  if (tx.appAccountToken?.toLowerCase() !== billingAccountToken(store, user)) {
    throw new BillingRejection('account', 'This purchase belongs to a different Trialguard account', 403);
  }
  // Ordered by the transaction's signedDate, so replaying an old (pre-refund) transaction is a no-op.
  const outcome = applyTransaction(store, { tx, action: { kind: 'refresh' }, eventAt: iso(tx.signedDate), linkTo: user }, deps, log);
  inc('billing_notifications_total', { platform: 'app_store', type: 'CLIENT_VERIFY', result: outcome.result });
  return outcome;
}
