import { z } from 'zod';
import { alertedTrialIds, daysBetween, entitlements, getMerchant, isValidTimeZone, toISODate, yearlyEquivalent, type Cadence, type TrackedItem } from '@trialguard/core';
import { config } from '../config.ts';
import { assert, type Router } from '../http.ts';
import type { PipelineDeps } from '../pipeline.ts';
import type { Connection, Store, User } from '../store.ts';

/** What every route module receives. */
export interface RouteDeps {
  router: Router;
  store: Store;
  deps: PipelineDeps;
}

// ---------- shared validators ----------

export const CADENCES = ['weekly', 'monthly', 'quarterly', 'annual'] as const satisfies readonly Cadence[];
export const zCadence = z.enum(CADENCES);
export const zIsoDate = z.iso.date();
export const zState = z.string().regex(/^[A-Za-z]{2}$/, 'must be a two-letter state code').transform((s) => s.toUpperCase());
export const zTimeZone = z.string().max(64).refine(isValidTimeZone, 'must be an IANA time zone like America/Chicago');
export const zCents = z.number().int().min(0).max(10_000_000);
/** Free text that will be shown back to the user: trimmed, length-capped, no control characters. */
export const zText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => s.replace(/(?![\t\n\r])\p{Cc}/gu, '').trim());

// ---------- shapes returned to clients ----------

export function publicConnection(c: Connection) {
  return { id: c.id, type: c.type, provider: c.provider, label: c.label, status: c.status, error: c.error, lastSyncedAt: c.lastSyncedAt };
}

export function publicUser(store: Store, u: User) {
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
    devMode: config.devLogin,
    connections: store.data.connections.filter((c) => c.userId === u.id).map(publicConnection),
  };
}

export function publicItem(item: TrackedItem, today: string, alerted: Set<string>) {
  const merchant = getMerchant(item.merchantId);
  const date = item.status === 'trial' ? item.trialEndsAt : item.nextChargeDate;
  const { userId: _userId, ...rest } = item as TrackedItem & { userId?: string };
  return {
    ...rest,
    category: merchant?.category ?? 'Other',
    cancelDifficulty: merchant?.difficulty,
    daysUntilCharge: date ? daysBetween(today, date) : undefined,
    yearlyCents: yearlyEquivalent(item.amountCents, item.cadence),
    alertsOn: item.status !== 'trial' || alerted.has(item.id),
    needsReview: !item.confirmedByUser && item.confidence < 0.6,
  };
}

export function publicItems(store: Store, user: User, today: string) {
  const items = store.itemsFor(user.id);
  const alerted = alertedTrialIds(items, user.plan);
  return items.map((i) => publicItem(i, today, alerted));
}

export function todayFor(deps: PipelineDeps): string {
  return toISODate(deps.clock());
}

export function userItem(store: Store, user: User, id: string) {
  const item = store.data.items.find((i) => i.id === id && i.userId === user.id);
  assert(item, 'Item not found', 404);
  return item;
}
