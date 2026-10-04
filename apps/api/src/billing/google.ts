import { z } from 'zod';
import type { Logger } from '../log.ts';
import { inc } from '../metrics.ts';
import type { PipelineDeps } from '../pipeline.ts';
import type { BillingSubscription, Store } from '../store.ts';
import {
  applyEntitlements,
  findSubscription,
  isEntitled,
  upsertSubscription,
  userByBillingToken,
  userById,
  type SubscriptionStatus,
  type SubscriptionUpdate,
} from './entitlement.ts';
import { BillingRejection } from './errors.ts';
import { verifyPushToken, type AccessTokenSource, type JwksSource, type PushAuthPolicy } from './googleAuth.ts';

/**
 * Google Play Real-time Developer Notifications, delivered by Pub/Sub push. A notification only says
 * "something changed for this purchase token"; the state itself is always fetched from the Play Developer
 * API (purchases.subscriptionsv2.get), so a forged or stale message can't grant anything.
 */

type Fetch = typeof fetch;
type Clock = Pick<PipelineDeps, 'clock'>;

const PLAY_API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const PRODUCT_TYPE_SUBSCRIPTION = 1;

// ---------- Play Developer API adapter ----------

const zLineItem = z.looseObject({
  productId: z.string(),
  expiryTime: z.string().optional(),
  autoRenewingPlan: z.looseObject({ autoRenewEnabled: z.boolean().optional() }).optional(),
});

const zSubscriptionV2 = z.looseObject({
  subscriptionState: z.string(),
  acknowledgementState: z.string().optional(),
  linkedPurchaseToken: z.string().optional(),
  testPurchase: z.looseObject({}).optional(),
  externalAccountIdentifiers: z.looseObject({ obfuscatedExternalAccountId: z.string().optional() }).optional(),
  lineItems: z.array(zLineItem).optional(),
});
export type PlaySubscription = z.infer<typeof zSubscriptionV2>;

export class PlayApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'PlayApiError';
    this.status = status;
  }
}

export interface PlayApi {
  getSubscription(packageName: string, purchaseToken: string): Promise<PlaySubscription>;
  /** purchases.subscriptions.acknowledge. Play refunds and revokes purchases left unacknowledged for 3 days. */
  acknowledge(packageName: string, productId: string, purchaseToken: string): Promise<void>;
}

export function playApi(opts: { fetch: Fetch; tokens: AccessTokenSource }): PlayApi {
  const enc = encodeURIComponent;
  async function call(url: string, init: RequestInit = {}): Promise<Response> {
    const res = await opts.fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${await opts.tokens.token()}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) opts.tokens.invalidate();
    // The URL holds the purchase token, so it stays out of the error message (and the logs).
    if (!res.ok) throw new PlayApiError(res.status, `Play Developer API returned ${res.status}`);
    return res;
  }
  return {
    async getSubscription(packageName, purchaseToken) {
      const res = await call(`${PLAY_API}/${enc(packageName)}/purchases/subscriptionsv2/tokens/${enc(purchaseToken)}`);
      const parsed = zSubscriptionV2.safeParse(await res.json());
      if (!parsed.success) throw new PlayApiError(502, 'Play Developer API returned an unexpected subscription shape');
      return parsed.data;
    },
    async acknowledge(packageName, productId, purchaseToken) {
      await call(`${PLAY_API}/${enc(packageName)}/purchases/subscriptions/${enc(productId)}/tokens/${enc(purchaseToken)}:acknowledge`, {
        method: 'POST',
        body: '{}',
      });
    },
  };
}

// ---------- state mapping ----------

/** Play subscriptionState → our status. Unknown (future) states return undefined: don't guess. */
export function playStatus(state: string): SubscriptionStatus | undefined {
  switch (state) {
    case 'SUBSCRIPTION_STATE_ACTIVE':
    case 'SUBSCRIPTION_STATE_CANCELED': // auto-renew is off; the user keeps access until expiryTime
      return 'active';
    case 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD':
      return 'grace_period';
    case 'SUBSCRIPTION_STATE_ON_HOLD':
      return 'billing_retry';
    case 'SUBSCRIPTION_STATE_PAUSED':
      return 'paused';
    case 'SUBSCRIPTION_STATE_PENDING':
      return 'pending';
    case 'SUBSCRIPTION_STATE_EXPIRED':
    case 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED':
      return 'expired';
    default:
      return undefined;
  }
}

function toIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/** The line item that runs longest: it decides when access ends. */
function latestLineItem(sub: PlaySubscription) {
  let best: { productId: string; expiresAt?: string; autoRenew?: boolean } | undefined;
  for (const li of sub.lineItems ?? []) {
    const expiresAt = toIso(li.expiryTime);
    if (!best || (expiresAt && (!best.expiresAt || expiresAt > best.expiresAt))) {
      best = { productId: li.productId, expiresAt, autoRenew: li.autoRenewingPlan?.autoRenewEnabled };
    }
  }
  return best;
}

// ---------- RTDN ----------

export interface GoogleBillingConfig {
  packageName: string;
  push: PushAuthPolicy;
  jwks: JwksSource;
  play: PlayApi;
}

/** Pub/Sub push envelope. */
export const zPubSubPush = z.looseObject({
  message: z.looseObject({
    data: z.string().max(64_000),
    messageId: z.string().min(1).max(128),
  }),
  subscription: z.string().max(512).optional(),
});
export type PubSubPush = z.infer<typeof zPubSubPush>;

const zToken = z.string().min(1).max(2048);
const zDeveloperNotification = z.looseObject({
  packageName: z.string(),
  eventTimeMillis: z.union([z.string(), z.number()]).optional(),
  subscriptionNotification: z
    .looseObject({ notificationType: z.number().int(), purchaseToken: zToken, subscriptionId: z.string().optional() })
    .optional(),
  voidedPurchaseNotification: z.looseObject({ purchaseToken: zToken, productType: z.number().int().optional() }).optional(),
  testNotification: z.looseObject({}).optional(),
});
type DeveloperNotification = z.infer<typeof zDeveloperNotification>;

export type GoogleOutcome =
  | { result: 'processed'; recordId: string; status: SubscriptionStatus; acknowledged: boolean }
  | { result: 'duplicate' | 'ignored' | 'unlinked' };

/** Another delivery of the same message is still being processed; the caller should answer non-2xx so Pub/Sub retries. */
export class InFlightError extends Error {}

function decodeNotification(data: string): DeveloperNotification {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
  } catch {
    throw new BillingRejection('payload', 'message.data is not base64 JSON');
  }
  const parsed = zDeveloperNotification.safeParse(json);
  if (!parsed.success) throw new BillingRejection('payload', 'unexpected developer notification shape');
  return parsed.data;
}

/**
 * A Play purchase's fresh state as an update to its record. A voided purchase stays refunded until Play
 * reports a later paid period: Play may go on describing the refunded period as active (cancelled).
 */
function recordUpdate(
  existing: BillingSubscription | undefined,
  purchaseToken: string,
  sub: PlaySubscription,
  status: SubscriptionStatus,
  userId: string,
  notifiedProductId?: string,
): SubscriptionUpdate {
  const line = latestLineItem(sub);
  const productId = line?.productId ?? notifiedProductId ?? existing?.productId;
  if (!productId) throw new PlayApiError(502, 'Play subscription has no product');
  const refundedPeriod = existing?.status === 'refunded' && !(line?.expiresAt && existing.expiresAt && line.expiresAt > existing.expiresAt);
  return {
    platform: 'google_play',
    externalId: purchaseToken,
    userId,
    productId,
    status: refundedPeriod ? 'refunded' : status,
    expiresAt: line?.expiresAt,
    // Play extends expiryTime through the grace period, so it is also the grace deadline.
    gracePeriodExpiresAt: status === 'grace_period' ? line?.expiresAt : undefined,
    autoRenew: line?.autoRenew,
    environment: sub.testPurchase ? 'test' : 'production',
  };
}

/**
 * Builds the RTDN handler. It keeps the set of message ids in flight, because processing awaits the Play
 * API and Pub/Sub may redeliver meanwhile; a message is marked processed only after it fully succeeds.
 */
export function createRtdnHandler(store: Store, google: GoogleBillingConfig, deps: Clock) {
  const inFlight = new Set<string>();
  /** Tail of the work queued per purchase token (see oneAtATime). An entry goes once its queue drains. */
  const queues = new Map<string, Promise<void>>();

  return async function handleRtdn(authorization: string | undefined, body: PubSubPush, log: Logger): Promise<GoogleOutcome> {
    const now = deps.clock();
    // Authenticate before looking at anything in the body.
    await verifyPushToken(authorization, google.push, google.jwks, now);
    const messageId = body.message.messageId;
    if (store.data.webhookEvents.some((e) => e.provider === 'google_play' && e.id === messageId)) return { result: 'duplicate' };
    if (inFlight.has(messageId)) throw new InFlightError('message is already being processed');

    const n = decodeNotification(body.message.data);
    if (n.packageName !== google.packageName) throw new BillingRejection('package', 'packageName does not match this app');

    inFlight.add(messageId);
    try {
      const outcome = await apply(n, log);
      store.markWebhookProcessed('google_play', messageId, deps.clock().toISOString());
      inc('billing_notifications_total', { platform: 'google_play', type: notificationKind(n), result: outcome.result });
      return outcome;
    } finally {
      inFlight.delete(messageId);
    }
  };

  async function apply(n: DeveloperNotification, log: Logger): Promise<GoogleOutcome> {
    if (n.voidedPurchaseNotification) return voided(n.voidedPurchaseNotification, log);
    const s = n.subscriptionNotification;
    if (s) return oneAtATime(s.purchaseToken, () => subscriptionChanged(s.purchaseToken, s.subscriptionId, log));
    log.info('play notification ignored', { kind: notificationKind(n) });
    return { result: 'ignored' };
  }

  /**
   * Runs `task` once every earlier task for the same purchase token has settled. Each notification reads
   * Play, then writes; two for one purchase (renewed, then cancelled) run side by side could finish in the
   * wrong order and leave the older read in the record. One at a time, each read is at least as new.
   */
  function oneAtATime<T>(purchaseToken: string, task: () => Promise<T>): Promise<T> {
    const run = (queues.get(purchaseToken) ?? Promise.resolve()).then(task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    queues.set(purchaseToken, tail);
    void tail.then(() => {
      if (queues.get(purchaseToken) === tail) queues.delete(purchaseToken);
    });
    return run;
  }

  /** A refund, chargeback or revocation. Final for the period it covered, whatever the order of arrival. */
  function voided(v: NonNullable<DeveloperNotification['voidedPurchaseNotification']>, log: Logger): GoogleOutcome {
    if (v.productType !== undefined && v.productType !== PRODUCT_TYPE_SUBSCRIPTION) return { result: 'ignored' };
    const record = findSubscription(store, 'google_play', v.purchaseToken);
    if (!record) {
      log.warn('voided play purchase for an unknown subscription');
      return { result: 'unlinked' };
    }
    const { record: updated } = upsertSubscription(store, { ...record, status: 'refunded', eventAt: undefined }, deps.clock());
    applyEntitlements(store, [updated.userId], deps, 'google_play');
    return { result: 'processed', recordId: updated.id, status: updated.status, acknowledged: false };
  }

  /**
   * The current state of the purchase an abandoned upgrade or resubscribe links to. When a pending purchase
   * is cancelled, the one it would have replaced carries on, and Play's guidance is to read it again through
   * linkedPurchaseToken: that restores a record retired too early and picks up anything that changed while
   * the new purchase was pending. Undefined when there is no record of ours to restore.
   */
  async function abandonedReplacement(sub: PlaySubscription, log: Logger): Promise<PlaySubscription | undefined> {
    const token = sub.linkedPurchaseToken;
    if (sub.subscriptionState !== 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED' || !token) return undefined;
    if (!findSubscription(store, 'google_play', token)) return undefined;
    try {
      return await google.play.getSubscription(google.packageName, token);
    } catch (err) {
      // Play stops answering for a purchase a while after it ends (410 Gone). There is nothing to restore
      // then, and retrying would only hold this notification up forever.
      if (err instanceof PlayApiError && (err.status === 404 || err.status === 410)) {
        log.info('linked play purchase is gone, nothing to restore', { status: err.status });
        return undefined;
      }
      throw err;
    }
  }

  async function subscriptionChanged(purchaseToken: string, notifiedProductId: string | undefined, log: Logger): Promise<GoogleOutcome> {
    const sub = await google.play.getSubscription(google.packageName, purchaseToken);
    const status = playStatus(sub.subscriptionState);
    if (!status) {
      log.warn('unknown play subscription state', { state: sub.subscriptionState });
      return { result: 'ignored' };
    }
    const linkedSub = await abandonedReplacement(sub, log);
    // Synchronous from here to the writes, so the records read below are current when written.
    const now = deps.clock();
    const existing = findSubscription(store, 'google_play', purchaseToken);
    const linked = sub.linkedPurchaseToken ? findSubscription(store, 'google_play', sub.linkedPurchaseToken) : undefined;
    // obfuscatedExternalAccountId is what the app set at purchase; an upgrade or resubscribe can also be
    // traced through linkedPurchaseToken to the account that owned the old purchase.
    const user =
      userByBillingToken(store, sub.externalAccountIdentifiers?.obfuscatedExternalAccountId) ?? userById(store, existing?.userId) ?? userById(store, linked?.userId);
    if (!user) {
      // Not acknowledged on purpose: nothing was granted, so Play's automatic refund is the right outcome.
      log.warn('play subscription has no matching account', { state: sub.subscriptionState });
      return { result: 'unlinked' };
    }

    const { record, previousUserId } = upsertSubscription(store, recordUpdate(existing, purchaseToken, sub, status, user.id, notifiedProductId), now);
    const affected = [user.id, previousUserId];
    if (linked && linked.id !== record.id) {
      if (linkedSub) {
        restoreLinked(linked, linkedSub, now, log);
        affected.push(linked.userId);
      } else if (isEntitled(record, now) && linked.status !== 'expired') {
        // The old purchase of an upgrade, downgrade or resubscribe is replaced by this one, but only once
        // this one grants access itself: while a payment is pending (e.g. cash at a store), the old
        // purchase is still what the user has paid for.
        upsertSubscription(store, { ...linked, status: 'expired', eventAt: undefined }, now);
        affected.push(linked.userId);
      }
    }
    applyEntitlements(store, affected, deps, 'google_play');

    let acknowledged = false;
    if (sub.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING' && isEntitled(record, now)) {
      // A failure throws, so the message isn't marked processed and Pub/Sub's retry acknowledges again.
      await google.play.acknowledge(google.packageName, record.productId, purchaseToken);
      acknowledged = true;
      inc('billing_play_acknowledged_total');
    }
    return { result: 'processed', recordId: record.id, status: record.status, acknowledged };
  }

  /** Writes Play's fresh word on the purchase an abandoned upgrade linked to. It stays with its own account. */
  function restoreLinked(linked: BillingSubscription, sub: PlaySubscription, now: Date, log: Logger): void {
    const status = playStatus(sub.subscriptionState);
    if (!status) {
      log.warn('unknown play subscription state', { state: sub.subscriptionState });
      return;
    }
    const { record } = upsertSubscription(store, recordUpdate(linked, linked.externalId, sub, status, linked.userId), now);
    log.info('pending play purchase abandoned, linked purchase re-read', { recordId: record.id, status: record.status });
  }
}

function notificationKind(n: DeveloperNotification): string {
  if (n.subscriptionNotification) return `subscription_${n.subscriptionNotification.notificationType}`;
  if (n.voidedPurchaseNotification) return 'voided';
  if (n.testNotification) return 'test';
  return 'other';
}
