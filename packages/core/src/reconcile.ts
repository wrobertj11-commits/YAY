import { addDays, advanceByCadence, cadenceDays, daysBetween, nextOnOrAfter } from './dates.ts';
import { getMerchant } from './merchants.ts';
import { normalizeMerchant } from './normalize.ts';
import type {
  Cadence,
  EmailSignal,
  ISODate,
  ISODateTime,
  NormalizedMerchant,
  RecurringCharge,
  Source,
  TrackedItem,
  Transaction,
} from './types.ts';

/** Bank feeds lag; a trial charge can post a few days either side of the conversion date. */
const CONVERSION_WINDOW_DAYS = 3;
/** How long after an expected charge date we wait before calling a cancellation verified. */
const VERIFY_GRACE_DAYS = 5;
/** Ignore a charge-history price change older than this; it is old news. */
const PRICE_CHANGE_RECENCY_DAYS = 60;

export type ItemEventType = 'new_item' | 'trial_converted' | 'price_increase' | 'charge_after_cancel' | 'cancel_verified';

export interface ItemEvent {
  type: ItemEventType;
  itemId: string;
  transactionId?: string;
}

export interface ReconcileInput {
  items: TrackedItem[];
  transactions: Transaction[];
  recurring: RecurringCharge[];
  signals: (EmailSignal & { source?: Source })[];
  today: ISODate;
  now: ISODateTime;
  newId: () => string;
}

export interface ReconcileResult {
  items: TrackedItem[];
  events: ItemEvent[];
}

const CANCELLED: TrackedItem['status'][] = ['cancel_pending', 'cancel_verified', 'charged_after_cancel'];

export function isCancelled(item: TrackedItem): boolean {
  return CANCELLED.includes(item.status);
}

export function isLive(item: TrackedItem): boolean {
  return item.status === 'active' || item.status === 'trial';
}

function signalKey(s: EmailSignal): string {
  return s.merchantId ?? `name:${s.serviceName.toLowerCase()}`;
}

/**
 * Emails that change a cancelled item's state (a cancellation silences renewal alerts and starts the post-cancel
 * check; a new trial signup re-opens a cancelled item) only count for a catalog merchant when sent from one of that
 * merchant's domains: anyone can email "Your Netflix membership has been cancelled" or "Your Netflix trial has
 * started". An email the user pasted in the app is their own statement, so it is trusted. Merchants outside the
 * catalog have no known domains to check against.
 */
export function isTrustedSignal(s: EmailSignal & { source?: Source }, item: TrackedItem): boolean {
  const source = s.source ?? 'email';
  // Anyone who learns a forwarding address can mail it a fake "you've been cancelled" with any From line.
  if (source === 'inbound') return false;
  if (source === 'forwarded') return true;
  const merchant = getMerchant(item.merchantId ?? s.merchantId);
  if (!merchant) return true;
  const domain = s.senderDomain;
  return Boolean(domain && merchant.emailDomains.some((d) => domain === d || domain.endsWith(`.${d}`)));
}

/** Kept for existing callers: the cancellation case of isTrustedSignal. */
export const isTrustedCancellation = isTrustedSignal;

function addUnique<T>(list: T[], ...values: T[]): T[] {
  for (const v of values) if (!list.includes(v)) list.push(v);
  return list;
}

function txnMatchesItem(n: NormalizedMerchant, amountCents: number, item: TrackedItem): boolean {
  if (item.merchantId && n.merchantId === item.merchantId) {
    // App-store items are split by price; anything else from the same catalog merchant matches.
    const store = item.merchantId === 'apple-app-store' || item.merchantId === 'google-play';
    return !store || item.amountCents === amountCents;
  }
  return n.key === item.matchKey || n.name.toLowerCase() === item.name.toLowerCase();
}

export function blankItem(partial: Partial<TrackedItem> & Pick<TrackedItem, 'id' | 'name' | 'matchKey'>, now: ISODateTime): TrackedItem {
  return {
    kind: 'subscription',
    status: 'active',
    amountCents: 0,
    cadence: 'monthly',
    rail: 'card',
    sources: [],
    confidence: 0.5,
    confirmedByUser: false,
    transactionIds: [],
    emailIds: [],
    priceHistory: [],
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

export interface ManualItemInput {
  name: string;
  merchantId?: string;
  amountCents: number;
  cadence: Cadence;
  /** For a trial: the conversion date. For a subscription: the next charge date. */
  date: ISODate;
  isTrial: boolean;
  paymentMethod?: string;
}

/** F6: a trial or subscription the user entered by hand. */
export function createManualItem(input: ManualItemInput, id: string, now: ISODateTime): TrackedItem {
  const merchant = getMerchant(input.merchantId);
  return blankItem(
    {
      id,
      name: merchant?.name ?? input.name,
      merchantId: merchant?.id,
      matchKey: merchant?.id ?? `name:${input.name.toLowerCase()}`,
      kind: input.isTrial ? 'trial' : 'subscription',
      status: input.isTrial ? 'trial' : 'active',
      amountCents: input.amountCents,
      cadence: input.cadence,
      trialEndsAt: input.isTrial ? input.date : undefined,
      nextChargeDate: input.date,
      paymentMethod: input.paymentMethod,
      sources: ['manual'],
      confidence: 1,
      confirmedByUser: true,
    },
    now,
  );
}

/**
 * Detection pipeline step 4–5: merge bank charges, email signals and existing items so each
 * subscription is one item that tracks its whole life (trial -> paid -> cancelled -> verified).
 * Pure and idempotent: running it daily with the same data yields the same items and no events.
 */
export function reconcile(input: ReconcileInput): ReconcileResult {
  const { today, now, newId } = input;
  const items = input.items.map((i) => structuredClone(i));
  const events: ItemEvent[] = [];
  const touch = (item: TrackedItem) => (item.updatedAt = now);

  const findByKey = (key: string, name?: string) =>
    items.find((i) => i.matchKey === key || (i.merchantId && i.merchantId === key)) ??
    (name ? items.find((i) => i.name.toLowerCase() === name.toLowerCase()) : undefined);

  // ---- 1. Email signals (oldest first so later emails win) ----
  const signals = [...input.signals].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  for (const s of signals) {
    if (items.some((i) => i.emailIds.includes(s.emailId))) continue;
    const source: Source = s.source ?? 'email';
    let item = findByKey(signalKey(s), s.serviceName);
    if (item?.status === 'dismissed') continue;

    switch (s.kind) {
      case 'trial_signup': {
        // A real re-subscription comes from the merchant (or the user). A charged-after-cancel item is never
        // re-opened automatically: its cancellation proof and the disputed charge are the user's evidence.
        const restarting =
          item &&
          isCancelled(item) &&
          item.status !== 'charged_after_cancel' &&
          (!item.cancelledAt || s.receivedAt > item.cancelledAt) &&
          isTrustedSignal(s, item);
        if (!item || restarting) {
          if (!item) {
            item = blankItem({ id: newId(), name: s.serviceName, merchantId: s.merchantId, matchKey: signalKey(s) }, now);
            items.push(item);
            events.push({ type: 'new_item', itemId: item.id });
          }
          Object.assign(item, {
            kind: 'trial',
            status: 'trial',
            trialEndsAt: s.chargeDate,
            nextChargeDate: s.chargeDate,
            amountCents: s.priceCents ?? 0,
            cadence: s.cadence ?? 'monthly',
            confidence: s.confidence,
            cancelledAt: undefined,
            cancelStartedAt: undefined,
            cancelVerifiedAt: undefined,
            cancelProof: undefined,
            postCancelChargeIds: undefined,
          });
        } else if (item.status === 'trial') {
          item.trialEndsAt ??= s.chargeDate;
          item.nextChargeDate ??= s.chargeDate;
          if (!item.amountCents && s.priceCents) item.amountCents = s.priceCents;
        }
        break;
      }
      case 'receipt': {
        if (!item) {
          item = blankItem({ id: newId(), name: s.serviceName, merchantId: s.merchantId, matchKey: signalKey(s) }, now);
          item.amountCents = s.priceCents ?? 0;
          item.cadence = s.cadence ?? 'monthly';
          item.nextChargeDate = s.chargeDate ?? advanceByCadence(s.receivedAt, item.cadence);
          item.confidence = s.confidence;
          items.push(item);
          events.push({ type: 'new_item', itemId: item.id });
        } else if (isLive(item)) {
          if (s.priceCents && !item.transactionIds.length) item.amountCents = s.priceCents;
          if (s.cadence && !item.transactionIds.length) item.cadence = s.cadence;
          if (s.chargeDate && (!item.nextChargeDate || s.chargeDate > item.nextChargeDate)) item.nextChargeDate = s.chargeDate;
        }
        break;
      }
      case 'price_increase': {
        if (!item) {
          item = blankItem({ id: newId(), name: s.serviceName, merchantId: s.merchantId, matchKey: signalKey(s) }, now);
          item.amountCents = s.oldPriceCents ?? 0;
          item.cadence = s.cadence ?? 'monthly';
          item.confidence = s.confidence;
          items.push(item);
          events.push({ type: 'new_item', itemId: item.id });
        }
        const oldCents = s.oldPriceCents ?? item.amountCents;
        if (s.priceCents && oldCents && s.priceCents > oldCents && isLive(item)) {
          item.priceChange = { oldCents, newCents: s.priceCents, effectiveDate: s.effectiveDate, detectedFrom: 'email' };
          events.push({ type: 'price_increase', itemId: item.id });
        }
        break;
      }
      case 'cancellation_confirmation': {
        if (!item) continue; // nothing we track; ignore
        if (!isTrustedCancellation(s, item)) continue; // not from the merchant: leave the item (and its alerts) alone
        if (isLive(item) || item.status === 'cancel_pending') {
          item.status = 'cancel_pending';
          item.cancelledAt ??= s.receivedAt;
          item.cancelProof = `Cancellation confirmation email received ${s.receivedAt}`;
        }
        break;
      }
    }

    addUnique(item.sources, source);
    item.emailIds.push(s.emailId);
    item.merchantId ??= s.merchantId;
    touch(item);
  }

  // ---- 2. Recurring bank charges ----
  for (const rc of input.recurring) {
    // Catalog merchants match by key only: generic names like "App Store subscription" are shared.
    let item = findByKey(rc.key, rc.merchantId ? undefined : rc.name);
    if (item?.status === 'dismissed' || (item && isCancelled(item))) continue; // post-cancel check below

    if (!item) {
      item = blankItem({ id: newId(), name: rc.name, merchantId: rc.merchantId, matchKey: rc.key }, now);
      items.push(item);
      events.push({ type: 'new_item', itemId: item.id });
    }

    if (item.status === 'trial') {
      const convertedOn = item.trialEndsAt ? addDays(item.trialEndsAt, -CONVERSION_WINDOW_DAYS) : undefined;
      if (convertedOn && rc.lastChargeDate < convertedOn) {
        // Charges from before this trial belong to an earlier stint; leave the trial alone.
        continue;
      }
      item.kind = 'subscription';
      item.status = 'active';
      item.trialEndsAt = undefined;
      events.push({ type: 'trial_converted', itemId: item.id });
    }

    const prevPrice = item.priceHistory[item.priceHistory.length - 1]?.amountCents;
    item.amountCents = rc.amountCents;
    item.cadence = rc.cadence;
    item.nextChargeDate = rc.nextChargeDate;
    item.paymentMethod = rc.paymentMethod;
    item.rail = rc.rail;
    item.confidence = Math.max(item.confidence, rc.confidence);
    item.priceHistory = rc.priceHistory;
    addUnique(item.transactionIds, ...rc.transactionIds);
    addUnique(item.sources, 'bank');

    const hist = rc.priceHistory;
    const before = hist[hist.length - 2];
    const after = hist[hist.length - 1];
    if (before && after) {
      const isNew = prevPrice === undefined || prevPrice !== after.amountCents;
      const recent = daysBetween(after.date, today) <= PRICE_CHANGE_RECENCY_DAYS;
      if (after.amountCents > before.amountCents && recent && (item.priceChange?.newCents !== after.amountCents)) {
        item.priceChange = { oldCents: before.amountCents, newCents: after.amountCents, effectiveDate: after.date, detectedFrom: 'charges' };
        if (isNew) events.push({ type: 'price_increase', itemId: item.id });
      }
    }
    touch(item);
  }

  // ---- 3. Single-charge trial conversion and post-cancel check (raw transactions) ----
  const debits = input.transactions
    .filter((t) => t.amountCents > 0)
    .map((t) => ({ t, n: normalizeMerchant(t.description) }))
    .sort((a, b) => a.t.date.localeCompare(b.t.date));

  for (const item of items) {
    if (item.status === 'trial' && item.trialEndsAt) {
      const from = addDays(item.trialEndsAt, -CONVERSION_WINDOW_DAYS);
      const hit = debits.find(({ t, n }) => t.date >= from && txnMatchesItem(n, t.amountCents, { ...item, amountCents: t.amountCents }));
      if (hit) {
        item.kind = 'subscription';
        item.status = 'active';
        item.amountCents = hit.t.amountCents;
        item.paymentMethod = hit.t.paymentMethod;
        item.nextChargeDate = nextOnOrAfter(advanceByCadence(hit.t.date, item.cadence), item.cadence, today);
        item.trialEndsAt = undefined;
        addUnique(item.transactionIds, hit.t.id);
        addUnique(item.sources, 'bank');
        events.push({ type: 'trial_converted', itemId: item.id, transactionId: hit.t.id });
        touch(item);
      }
    }

    if ((item.status === 'cancel_pending' || item.status === 'cancel_verified') && item.cancelledAt) {
      const after = debits.filter(
        ({ t, n }) => t.date > item.cancelledAt! && !item.transactionIds.includes(t.id) && txnMatchesItem(n, t.amountCents, { ...item, amountCents: t.amountCents }),
      );
      if (after.length) {
        item.status = 'charged_after_cancel';
        item.postCancelChargeIds = after.map(({ t }) => t.id);
        events.push({ type: 'charge_after_cancel', itemId: item.id, transactionId: after[0]?.t.id });
        touch(item);
        continue;
      }
    }

    if (item.status === 'cancel_pending' && item.cancelledAt) {
      const expected = item.nextChargeDate ?? addDays(item.cancelledAt, cadenceDays(item.cadence));
      if (daysBetween(expected, today) > VERIFY_GRACE_DAYS) {
        item.status = 'cancel_verified';
        item.cancelVerifiedAt = today;
        events.push({ type: 'cancel_verified', itemId: item.id });
        touch(item);
      }
    }
  }

  // ---- 4. Roll schedules forward for items without fresh bank data ----
  for (const item of items) {
    if (item.status === 'trial' && item.trialEndsAt && daysBetween(item.trialEndsAt, today) > CONVERSION_WINDOW_DAYS) {
      // No cancellation and no bank proof either way: assume it converted, at lower confidence.
      item.kind = 'subscription';
      item.status = 'active';
      item.nextChargeDate = nextOnOrAfter(advanceByCadence(item.trialEndsAt, item.cadence), item.cadence, today);
      item.trialEndsAt = undefined;
      item.confidence = Math.min(item.confidence, 0.5);
      events.push({ type: 'trial_converted', itemId: item.id });
      touch(item);
    } else if (item.status === 'active' && item.nextChargeDate && item.nextChargeDate < today) {
      item.nextChargeDate = nextOnOrAfter(item.nextChargeDate, item.cadence, today);
      touch(item);
    }
  }

  return { items, events };
}

/** User tapped "I cancelled it" (or the concierge finished). Verification happens on later statements. */
export function markCancelled(item: TrackedItem, today: ISODate, now: ISODateTime, proof?: string): TrackedItem {
  return {
    ...item,
    status: 'cancel_pending',
    cancelledAt: today,
    cancelProof: proof ?? item.cancelProof,
    // A trial cancelled before conversion is expected never to charge.
    nextChargeDate: item.trialEndsAt ?? item.nextChargeDate,
    updatedAt: now,
  };
}
