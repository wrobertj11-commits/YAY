import { buildCancelPlan, conciergeFeeCents, yearlyEquivalent } from '@trialguard/core';
import { z } from 'zod';
import { newId } from '../crypto.ts';
import { assert } from '../http.ts';
import type { ConciergeRequest } from '../store.ts';
import { userItem, type RouteDeps } from './shared.ts';

/** F10: done-for-you cancellation requests. */
export function register({ router, store, deps }: RouteDeps) {
  router.on('POST', '/api/items/:id/concierge', { body: z.strictObject({}) }, ({ user, params }) => {
    const item = userItem(store, user, params.id);
    const plan = buildCancelPlan(item, user.state);
    assert(plan.conciergeAvailable, 'Done-for-you cancellation is not available for this service yet');
    const now = deps.clock().toISOString();
    const request: ConciergeRequest = {
      id: newId('cnc'),
      userId: user.id,
      itemId: item.id,
      feeCents: conciergeFeeCents(yearlyEquivalent(item.amountCents, item.cadence)),
      status: 'queued',
      createdAt: now,
    };
    store.data.concierge.push(request);
    item.cancelStartedAt = now;
    store.save();
    return { concierge: request };
  });
}
