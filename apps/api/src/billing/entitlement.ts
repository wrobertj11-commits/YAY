import { randomUUID } from 'node:crypto';
import type { Plan } from '@trialguard/core';
import { newId } from '../crypto.ts';
import { log } from '../log.ts';
import { inc } from '../metrics.ts';
import { recompute, type PipelineDeps } from '../pipeline.ts';
import type { BillingSubscription, Store, User } from '../store.ts';

/**
 * Entitlement model. Billing records (store.data.billing) hold what Apple / Google last told us, verified;
 * user.plan is only ever derived from them. Nothing the client says changes a record, so nothing the
 * client says changes a plan.
 */

export type SubscriptionStatus = BillingSubscription['status'];
export type BillingPlatform = BillingSubscription['platform'];
type Clock = Pick<PipelineDeps, 'clock'>;

const SYSTEM = { type: 'system', id: 'billing' } as const;

/** Where users manage (cancel, fix payment for) a store subscription. Trialguard can't do it for them. */
export const MANAGE_URLS: Record<BillingPlatform, string> = {
  app_store: 'https://apps.apple.com/account/subscriptions',
  google_play: 'https://play.google.com/store/account/subscriptions',
};

function isBefore(now: Date, iso: string | undefined): boolean {
  if (iso === undefined) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && now.getTime() < t;
}

/** Does this record entitle its user to Plus at `now`? A missing or unparseable date fails closed. */
export function isEntitled(r: Pick<BillingSubscription, 'status' | 'expiresAt' | 'gracePeriodExpiresAt'>, now: Date): boolean {
  switch (r.status) {
    case 'active':
      return isBefore(now, r.expiresAt);
    case 'grace_period':
      // The store keeps access on through its grace period even though the paid period has ended.
      return isBefore(now, r.gracePeriodExpiresAt ?? r.expiresAt);
    case 'billing_retry':
    case 'expired':
    case 'revoked':
    case 'refunded':
    case 'paused':
    case 'pending':
      return false;
  }
}

/** The plan a user's billing records entitle them to at `now`. Pure. */
export function planFromRecords(records: readonly BillingSubscription[], now: Date): Plan {
  return records.some((r) => isEntitled(r, now)) ? 'plus' : 'free';
}

/**
 * Status as of `now`. Records keep the store's last word; an "active" one whose paid period has passed
 * with no newer word (a lost notification) reads as expired.
 */
export function effectiveStatus(r: BillingSubscription, now: Date): SubscriptionStatus {
  return (r.status === 'active' || r.status === 'grace_period') && !isEntitled(r, now) ? 'expired' : r.status;
}

// ---------- account linking ----------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The UUID the app hands to StoreKit (appAccountToken) and Play Billing (obfuscatedExternalAccountId).
 * Stores echo it back inside their signed data, which is how a purchase finds its Trialguard account.
 */
export function billingAccountToken(store: Store, user: User): string {
  if (!user.billingAccountToken) {
    user.billingAccountToken = randomUUID();
    store.save();
  }
  return user.billingAccountToken;
}

/** StoreKit may echo the UUID in either case, so matching ignores case. */
export function userByBillingToken(store: Store, token: string | undefined): User | undefined {
  if (!token || !UUID_RE.test(token)) return undefined;
  const t = token.toLowerCase();
  return store.data.users.find((u) => u.billingAccountToken === t);
}

export function userById(store: Store, id: string | undefined): User | undefined {
  return id === undefined ? undefined : store.data.users.find((u) => u.id === id);
}

// ---------- records ----------

export function findSubscription(store: Store, platform: BillingPlatform, externalId: string): BillingSubscription | undefined {
  return store.data.billing.find((b) => b.platform === platform && b.externalId === externalId);
}

export interface SubscriptionUpdate {
  platform: BillingPlatform;
  externalId: string;
  userId: string;
  productId: string;
  status: SubscriptionStatus;
  /** Omitted: keep the current value. */
  expiresAt?: string;
  gracePeriodExpiresAt?: string;
  /** Omitted: keep the current value. */
  autoRenew?: boolean;
  environment?: string;
  /**
   * Store-side time of the event. An update older than the newest one already applied is dropped, so a
   * delayed or replayed message can't revive a refunded or expired subscription. Omit it for facts that
   * hold regardless of order (a voided purchase, state fetched fresh from the store API).
   */
  eventAt?: string;
}

export interface UpsertResult {
  record: BillingSubscription;
  applied: boolean;
  /** Set when the subscription moved to a different account; that account's plan must be re-derived too. */
  previousUserId?: string;
}

export function upsertSubscription(store: Store, u: SubscriptionUpdate, now: Date): UpsertResult {
  const at = now.toISOString();
  const existing = findSubscription(store, u.platform, u.externalId);
  if (existing && u.eventAt && existing.lastEventAt && u.eventAt < existing.lastEventAt) {
    inc('billing_stale_events_total', { platform: u.platform });
    return { record: existing, applied: false };
  }

  const record: BillingSubscription = existing ?? {
    id: newId('sub'),
    userId: u.userId,
    platform: u.platform,
    productId: u.productId,
    externalId: u.externalId,
    status: u.status,
    createdAt: at,
    updatedAt: at,
  };
  if (!existing) store.data.billing.push(record);
  const before = existing ? { status: existing.status, userId: existing.userId } : undefined;

  record.userId = u.userId;
  record.productId = u.productId;
  record.status = u.status;
  record.expiresAt = u.expiresAt ?? record.expiresAt;
  record.gracePeriodExpiresAt = u.status === 'grace_period' ? (u.gracePeriodExpiresAt ?? record.gracePeriodExpiresAt) : undefined;
  record.autoRenew = u.autoRenew ?? record.autoRenew;
  record.environment = u.environment ?? record.environment;
  if (u.eventAt && (!record.lastEventAt || u.eventAt > record.lastEventAt)) record.lastEventAt = u.eventAt;
  record.updatedAt = at;

  if (!before || before.status !== record.status || before.userId !== record.userId) {
    store.audit({
      actor: SYSTEM,
      userId: record.userId,
      action: before ? 'billing.subscription_updated' : 'billing.subscription_created',
      subject: { type: 'billing_subscription', id: record.id },
      details: { platform: record.platform, productId: record.productId, from: before?.status, to: record.status, moved: before ? before.userId !== record.userId : undefined },
      at,
    });
  }
  store.save();
  const moved = before && before.userId !== record.userId ? before.userId : undefined;
  return { record, applied: true, previousUserId: moved };
}

// ---------- plan ----------

/**
 * Re-derives user.plan from the user's records. A change is audited, and alerts are recomputed because the
 * plan sets the trial-alert cap and the Plus-only alert types. Returns true when the plan changed.
 */
export function applyEntitlement(store: Store, user: User, deps: Clock, reason: 'app_store' | 'google_play' | 'sweep'): boolean {
  const now = deps.clock();
  const to = planFromRecords(
    store.data.billing.filter((b) => b.userId === user.id),
    now,
  );
  const from = user.plan;
  if (to === from) return false;
  user.plan = to;
  store.audit({ actor: SYSTEM, userId: user.id, action: 'billing.plan_changed', details: { from, to, reason }, at: now.toISOString() });
  inc('billing_plan_changes_total', { to, reason });
  log.info('plan changed', { userId: user.id, from, to, reason });
  recompute(store, user, deps);
  return true;
}

/** Re-derives the plan of every affected account (deleted accounts are skipped). */
export function applyEntitlements(store: Store, userIds: Iterable<string | undefined>, deps: Clock, reason: 'app_store' | 'google_play'): void {
  for (const id of new Set(userIds)) {
    const user = userById(store, id);
    if (user) applyEntitlement(store, user, deps, reason);
  }
}

/**
 * Daily backstop for lost notifications: re-derives the plan of every user with billing records, so a
 * subscription whose paid period (or grace period) ran out with no newer word from the store stops
 * granting Plus. Records are left as the store last described them; a late notification still applies.
 * Users without records (e.g. the dev-mode plan switch) are untouched.
 */
export function sweepExpiredSubscriptions(store: Store, now: Date): { checked: number; downgraded: string[] } {
  const deps = { clock: () => now };
  const withRecords = new Set(store.data.billing.map((b) => b.userId));
  const downgraded: string[] = [];
  let checked = 0;
  for (const user of store.data.users) {
    if (!withRecords.has(user.id)) continue;
    checked++;
    const before = user.plan;
    if (applyEntitlement(store, user, deps, 'sweep') && before === 'plus') downgraded.push(user.id);
  }
  if (downgraded.length) log.info('billing sweep downgraded users', { count: downgraded.length });
  return { checked, downgraded };
}

// ---------- client view ----------

export function billingStatus(store: Store, user: User, now: Date) {
  const subscriptions = store.data.billing
    .filter((b) => b.userId === user.id)
    .map((r) => ({
      id: r.id,
      platform: r.platform,
      productId: r.productId,
      status: effectiveStatus(r, now),
      entitled: isEntitled(r, now),
      expiresAt: r.expiresAt,
      gracePeriodExpiresAt: r.status === 'grace_period' ? r.gracePeriodExpiresAt : undefined,
      autoRenew: r.autoRenew,
      manageUrl: MANAGE_URLS[r.platform],
      updatedAt: r.updatedAt,
    }))
    // Entitling subscriptions first, then the most recently updated.
    .sort((a, b) => Number(b.entitled) - Number(a.entitled) || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 10);
  return { plan: user.plan, billingAccountToken: billingAccountToken(store, user), subscriptions };
}
