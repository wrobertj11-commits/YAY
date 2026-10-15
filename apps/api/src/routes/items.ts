import { z } from 'zod';
import { buildCancelPlan, createManualItem, alertedTrialIds } from '@trialguard/core';
import { newId } from '../crypto.ts';
import { assert } from '../http.ts';
import { recompute } from '../pipeline.ts';
import { publicItem, publicItems, todayFor, userItem, zCadence, zCents, zIsoDate, zText, type RouteDeps } from './shared.ts';

const zCreate = z.strictObject({
  name: zText(80).pipe(z.string().min(1, 'name is required')),
  merchantId: z.string().max(64).optional(),
  amountCents: zCents,
  cadence: zCadence,
  date: zIsoDate,
  isTrial: z.boolean().default(false),
  paymentMethod: zText(40).optional(),
});

const zPatch = z.strictObject({
  confirm: z.literal(true).optional(),
  dismiss: z.literal(true).optional(),
  restore: z.literal(true).optional(),
  name: zText(80).pipe(z.string().min(1)).optional(),
  amountCents: zCents.optional(),
  cadence: zCadence.optional(),
  nextChargeDate: zIsoDate.optional(),
});

export function register({ router, store, deps }: RouteDeps) {
  router.on('GET', '/api/items', {}, ({ user }) => publicItems(store, user, todayFor(deps), deps.clock()));

  router.on('GET', '/api/items/:id', {}, ({ user, params }) => {
    const item = userItem(store, user, params.id);
    const alerted = alertedTrialIds(store.itemsFor(user.id), user.plan, deps.clock(), user.alertPrefs.timeZone);
    const transactions = store.data.transactions
      .filter((t) => t.userId === user.id && (item.transactionIds.includes(t.id) || item.postCancelChargeIds?.includes(t.id)))
      .map(({ id, date, amountCents, description, paymentMethod }) => ({ id, date, amountCents, description, paymentMethod }))
      .sort((a, b) => b.date.localeCompare(a.date));
    return { ...publicItem(item, todayFor(deps), alerted), transactions, cancelPlan: buildCancelPlan(item, user.state) };
  });

  router.on('POST', '/api/items', { body: zCreate, limit: 'ingest' }, ({ user, body }) => {
    const item = createManualItem({ ...body }, newId('itm'), deps.clock().toISOString());
    store.data.items.push({ ...item, userId: user.id });
    recompute(store, user, deps);
    return store.data.items.find((i) => i.id === item.id);
  });

  router.on('PATCH', '/api/items/:id', { body: zPatch }, ({ user, params, body }) => {
    const item = userItem(store, user, params.id);
    // "Is this right?" confirm step.
    if (body.confirm) item.confirmedByUser = true;
    if (body.dismiss) item.status = 'dismissed';
    if (body.restore && item.status === 'dismissed') item.status = item.trialEndsAt ? 'trial' : 'active';
    if (body.name) item.name = body.name;
    if (body.amountCents !== undefined) item.amountCents = body.amountCents;
    if (body.cadence) item.cadence = body.cadence;
    if (body.nextChargeDate) {
      if (item.status === 'trial') item.trialEndsAt = body.nextChargeDate;
      item.nextChargeDate = body.nextChargeDate;
    }
    if (body.name || body.amountCents !== undefined || body.cadence || body.nextChargeDate) item.confirmedByUser = true;
    item.updatedAt = deps.clock().toISOString();
    recompute(store, user, deps);
    return item;
  });

  router.on('DELETE', '/api/items/:id', {}, ({ user, params }) => {
    const item = userItem(store, user, params.id);
    assert(item.sources.length === 1 && item.sources[0] === 'manual', 'Only manually added items can be deleted; dismiss detected ones instead');
    store.data.items = store.data.items.filter((i) => i !== item);
    recompute(store, user, deps);
    return { deleted: true };
  });
}
