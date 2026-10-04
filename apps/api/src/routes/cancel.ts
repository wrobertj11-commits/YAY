import { z } from 'zod';
import { buildCancelPlan, getMerchant, markCancelled } from '@trialguard/core';
import { assert } from '../http.ts';
import { recompute } from '../pipeline.ts';
import { todayFor, userItem, zText, type RouteDeps } from './shared.ts';

const zCancelAction = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('started') }),
  z.strictObject({ action: z.literal('completed'), proof: zText(200).optional() }),
  z.strictObject({ action: z.literal('undo') }),
]);

export function register({ router, store, deps }: RouteDeps) {
  router.on('GET', '/api/items/:id/cancel', {}, ({ user, params }) => buildCancelPlan(userItem(store, user, params.id), user.state));

  router.on('POST', '/api/items/:id/cancel', { body: zCancelAction }, ({ user, params, body }) => {
    const item = userItem(store, user, params.id);
    const now = deps.clock().toISOString();
    if (body.action === 'started') {
      item.cancelStartedAt = now;
    } else if (body.action === 'completed') {
      assert(item.status === 'active' || item.status === 'trial' || item.status === 'charged_after_cancel', 'Item is already cancelled');
      Object.assign(item, markCancelled(item, todayFor(deps), now, body.proof || 'Marked cancelled in app'));
    } else {
      assert(item.status === 'cancel_pending', 'Only a pending cancellation can be undone');
      Object.assign(item, { status: item.trialEndsAt ? 'trial' : 'active', cancelledAt: undefined, cancelProof: undefined });
    }
    item.updatedAt = now;
    recompute(store, user, deps);
    return item;
  });

  router.on('POST', '/api/merchants/:id/report-broken', { body: z.strictObject({ note: zText(500).optional() }) }, ({ user, params, body }) => {
    assert(getMerchant(params.id), 'Unknown merchant', 404);
    store.data.brokenLinks.push({ merchantId: params.id, userId: user.id, note: body.note, createdAt: deps.clock().toISOString() });
    store.save();
    return { thanks: true };
  });
}
