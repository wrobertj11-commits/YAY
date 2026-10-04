import { PLAN_PRICES, searchMerchants, summarize, entitlements } from '@trialguard/core';
import { z } from 'zod';
import { todayFor, type RouteDeps } from './shared.ts';

export function register({ router, store, deps }: RouteDeps) {
  router.on('GET', '/api/alerts', {}, ({ user }) => {
    const now = deps.clock().toISOString();
    const channel = user.alertPrefs.push ? 'push' : 'email';
    const mine = store.data.alerts.filter((a) => a.userId === user.id && a.channel === channel);
    const strip = <T extends { userId?: string; claimedBy?: string; claimedAt?: string; lastError?: string }>(a: T) => {
      const { userId: _u, claimedBy: _c, claimedAt: _ca, lastError: _e, ...rest } = a;
      return rest;
    };
    return {
      inbox: mine.filter((a) => a.status === 'sent' && a.sentAt).sort((a, b) => (b.sentAt ?? '').localeCompare(a.sentAt ?? '')).map(strip),
      upcoming: mine.filter((a) => a.status === 'pending' && a.sendAt > now).sort((a, b) => a.sendAt.localeCompare(b.sendAt)).map(strip),
    };
  });

  router.on('POST', '/api/alerts/read', {}, ({ user }) => {
    const now = deps.clock().toISOString();
    for (const a of store.data.alerts) if (a.userId === user.id && a.sentAt && !a.readAt) a.readAt = now;
    store.save();
    return { ok: true };
  });

  router.on('GET', '/api/summary', {}, ({ user }) => {
    const s = summarize(store.itemsFor(user.id), todayFor(deps));
    const ent = entitlements(user.plan);
    return {
      ...s,
      // Free shows totals; the savings tracker is part of Plus.
      savedSoFarCents: ent.savingsTracker ? s.savedSoFarCents : null,
      verifiedSavedCents: ent.savingsTracker ? s.verifiedSavedCents : null,
      plusPrice: PLAN_PRICES.plus,
    };
  });

  router.on('GET', '/api/merchants', { auth: 'none', query: z.object({ q: z.string().max(64).optional() }) }, ({ query }) =>
    searchMerchants(query.q ?? '', 20).map(({ id, name, category }) => ({ id, name, category })),
  );
}
