import { buildCancelPlan, conciergeFeeCents, getMerchant, markCancelled, toISODate, yearlyEquivalent, type TrackedItem } from '@trialguard/core';
import { newId } from '../crypto.ts';
import { assert, HttpError } from '../http.ts';
import { describe, inc } from '../metrics.ts';
import { recompute, type PipelineDeps } from '../pipeline.ts';
import type { AuditEntry, ConciergeRequest, Store, User } from '../store.ts';
import { AUTHORIZATION_TEXT_VERSION, authorizationDigest, authorizationText } from './authorization.ts';

describe('concierge_events_total', 'Done-for-you cancellation lifecycle events (requested, withdrawn, claimed, done, failed)');

export type ConciergeStatus = ConciergeRequest['status'];
type Actor = AuditEntry['actor'];
type Clock = Pick<PipelineDeps, 'clock'>;

/** Open requests: staff may work them and the user may withdraw them. The rest are final. */
const OPEN: readonly ConciergeStatus[] = ['queued', 'in_progress'];

export function isOpen(r: ConciergeRequest): boolean {
  return OPEN.includes(r.status);
}

/**
 * Every valid move and who makes it. Staff move work forward (queued -> in_progress -> done | failed);
 * only the user can withdraw (any open -> cancelled). Nothing leaves done, failed or cancelled, so a
 * withdrawn request can't be picked back up by staff, and a finished one can't be re-opened.
 */
const TRANSITIONS: Record<ConciergeStatus, Partial<Record<ConciergeStatus, 'staff' | 'user'>>> = {
  queued: { in_progress: 'staff', cancelled: 'user' },
  in_progress: { done: 'staff', failed: 'staff', cancelled: 'user' },
  done: {},
  failed: {},
  cancelled: {},
};

export function canTransition(from: ConciergeStatus, to: ConciergeStatus, by: 'staff' | 'user'): boolean {
  return TRANSITIONS[from][to] === by;
}

/** Items a cancellation still makes sense for (the same set the in-app "I've cancelled it" accepts). */
const CANCELLABLE: readonly TrackedItem['status'][] = ['active', 'trial', 'charged_after_cancel'];

const staff = (id: string): Actor => ({ type: 'staff', id });

/** Append-only trail entry. Details stay non-sensitive: ids, statuses, versions, flags. Never names, notes or proof. */
function record(store: Store, request: ConciergeRequest, actor: Actor, action: string, at: string, details?: Record<string, unknown>): void {
  store.audit({ at, actor, action, userId: request.userId, subject: { type: 'concierge_request', id: request.id }, details });
}

function find(store: Store, id: string): ConciergeRequest {
  const request = store.data.concierge.find((r) => r.id === id);
  assert(request, 'Request not found', 404);
  return request;
}

function itemOf(store: Store, r: ConciergeRequest) {
  return store.data.items.find((i) => i.id === r.itemId && i.userId === r.userId);
}

// ---------- user actions ----------

export interface Signature {
  textVersion: string;
  signedName: string;
  ip: string;
  userAgent?: string;
}

/**
 * Queues a done-for-you cancellation, signed by the user. The signature is checked against the current
 * text version (a stale client must re-show the text), and only one open request per item is allowed.
 * Written through immediately: it is the evidence that staff may act.
 */
export function createRequest(store: Store, user: User, item: TrackedItem, signature: Signature, deps: Clock): ConciergeRequest {
  assert(buildCancelPlan(item, user.state).conciergeAvailable, 'Done-for-you cancellation is not available for this service yet');
  assert(CANCELLABLE.includes(item.status), 'This subscription is already cancelled', 409);
  assert(signature.textVersion === AUTHORIZATION_TEXT_VERSION, 'The authorization text has changed. Review it and sign again.', 409);
  assert(
    !store.data.concierge.some((r) => r.userId === user.id && r.itemId === item.id && isOpen(r)),
    'A done-for-you cancellation is already open for this subscription',
    409,
  );

  const at = deps.clock().toISOString();
  const merchantName = getMerchant(item.merchantId)?.name ?? item.name;
  const request: ConciergeRequest = {
    id: newId('cnc'),
    userId: user.id,
    itemId: item.id,
    merchantId: item.merchantId,
    feeCents: conciergeFeeCents(yearlyEquivalent(item.amountCents, item.cadence)),
    status: 'queued',
    authorization: {
      textVersion: AUTHORIZATION_TEXT_VERSION,
      textSha256: authorizationDigest(authorizationText(merchantName)),
      merchantName,
      signedName: signature.signedName,
      signedAt: at,
      ip: signature.ip,
      userAgent: signature.userAgent,
    },
    createdAt: at,
    updatedAt: at,
  };
  store.data.concierge.push(request);
  item.cancelStartedAt = at;
  record(store, request, { type: 'user', id: user.id }, 'concierge.requested', at, {
    itemId: item.id,
    merchantId: item.merchantId,
    feeCents: request.feeCents,
    textVersion: AUTHORIZATION_TEXT_VERSION,
    textSha256: request.authorization?.textSha256,
  });
  inc('concierge_events_total', { event: 'requested' });
  store.flush();
  return request;
}

/** The user withdraws an open request. This revokes the authorization; staff can no longer act on it. */
export function withdrawRequest(store: Store, user: User, id: string, deps: Clock): ConciergeRequest {
  const request = store.data.concierge.find((r) => r.id === id && r.userId === user.id);
  assert(request, 'Request not found', 404);
  assert(canTransition(request.status, 'cancelled', 'user'), `This request is ${request.status.replace('_', ' ')} and can't be withdrawn`, 409);

  const at = deps.clock().toISOString();
  const from = request.status;
  request.status = 'cancelled';
  request.closedAt = at;
  request.updatedAt = at;
  if (request.authorization) request.authorization.revokedAt = at;
  record(store, request, { type: 'user', id: user.id }, 'concierge.withdrawn', at, { from, to: 'cancelled', authorizationRevoked: Boolean(request.authorization) });
  inc('concierge_events_total', { event: 'withdrawn' });
  store.flush();
  return request;
}

/**
 * The user cancelled the subscription themselves while a request was still open: close it so staff don't
 * act on a finished job, and revoke the authorization exactly as a withdrawal would.
 */
export function closeForSelfCancel(store: Store, user: User, itemId: string, deps: Clock): number {
  const open = store.data.concierge.filter((r) => r.userId === user.id && r.itemId === itemId && isOpen(r));
  const at = deps.clock().toISOString();
  for (const request of open) {
    const from = request.status;
    request.status = 'cancelled';
    request.closedAt = at;
    request.updatedAt = at;
    request.note = 'You cancelled this yourself, so we closed the request.';
    if (request.authorization) request.authorization.revokedAt = at;
    record(store, request, { type: 'user', id: user.id }, 'concierge.closed_self_cancelled', at, { from, to: 'cancelled', authorizationRevoked: Boolean(request.authorization) });
    inc('concierge_events_total', { event: 'closed_self_cancelled' });
  }
  if (open.length) store.flush();
  return open.length;
}

// ---------- staff actions ----------

/** Staff opened the full request (customer name and, for the assignee, email). Recorded every time. */
export function viewRequest(store: Store, staffId: string, id: string, deps: Clock): ConciergeRequest {
  const request = find(store, id);
  record(store, request, staff(staffId), 'concierge.viewed', deps.clock().toISOString(), { status: request.status });
  return request;
}

/**
 * queued -> in_progress, assigned to the caller. A request someone else holds is refused (no silent
 * take-over), and so is one without a live written authorization: requests queued before authorization
 * existed must be re-requested by the user.
 */
export function claimRequest(store: Store, staffId: string, id: string, deps: Clock): ConciergeRequest {
  const request = find(store, id);
  if (request.status === 'in_progress') {
    throw new HttpError(409, request.assignedTo === staffId ? 'You have already claimed this request' : `Already claimed by ${request.assignedTo ?? 'another staff member'}`);
  }
  assert(canTransition(request.status, 'in_progress', 'staff'), `Can't claim a request that is ${request.status}`, 409);
  assert(request.authorization && !request.authorization.revokedAt, 'No written authorization on file. The user must request again.', 409);

  const at = deps.clock().toISOString();
  // The user may have cancelled it themselves meanwhile (in the app or by the merchant's own email). Close the
  // request rather than send staff to contact the merchant about a finished job.
  const item = store.data.items.find((i) => i.id === request.itemId && i.userId === request.userId);
  if (!item || !CANCELLABLE.includes(item.status)) {
    const from = request.status;
    request.status = 'cancelled';
    request.closedAt = at;
    request.updatedAt = at;
    request.note = 'This subscription was already cancelled, so we closed the request.';
    request.authorization.revokedAt = at;
    record(store, request, { type: 'system', id: 'concierge' }, 'concierge.closed_already_cancelled', at, { from, to: 'cancelled', itemStatus: item?.status ?? 'missing' });
    inc('concierge_events_total', { event: 'closed_already_cancelled' });
    store.flush();
    throw new HttpError(409, 'This subscription is already cancelled; the request has been closed');
  }
  request.status = 'in_progress';
  request.assignedTo = staffId;
  request.claimedAt = at;
  request.updatedAt = at;
  record(store, request, staff(staffId), 'concierge.claimed', at, { from: 'queued', to: 'in_progress' });
  inc('concierge_events_total', { event: 'claimed' });
  store.save();
  return request;
}

export type StatusChange = { status: 'in_progress' } | { status: 'done'; proof: string; note?: string } | { status: 'failed'; note: string; proof?: string };

/**
 * Staff move a request forward. 'in_progress' is a claim. 'done' and 'failed' close it and only the
 * assignee may make them. 'done' marks the item cancelled with the staff's proof, exactly as if the user
 * had tapped "I've cancelled it", so the usual statement check verifies it later.
 */
export function changeStatus(store: Store, staffId: string, id: string, change: StatusChange, deps: Clock): ConciergeRequest {
  if (change.status === 'in_progress') return claimRequest(store, staffId, id, deps);
  const request = find(store, id);
  assert(canTransition(request.status, change.status, 'staff'), `Can't move a ${request.status} request to ${change.status}`, 409);
  assert(request.assignedTo === staffId, `Claimed by ${request.assignedTo ?? 'another staff member'}; only they can close it`, 409);

  const at = deps.clock().toISOString();
  const from = request.status;
  request.status = change.status;
  request.closedAt = at;
  request.updatedAt = at;
  if (change.note) request.note = change.note;
  if (change.proof) request.proof = change.proof;
  const itemCancelled = change.status === 'done' && markItemCancelled(store, request, change.proof, deps);
  record(store, request, staff(staffId), 'concierge.status_changed', at, {
    from,
    to: change.status,
    hasProof: Boolean(change.proof),
    hasNote: Boolean(change.note),
    itemCancelled,
  });
  inc('concierge_events_total', { event: change.status });
  store.save();
  return request;
}

/**
 * Applies a finished concierge cancellation to the item and re-runs reconciliation. An item the user has
 * since cancelled, dismissed or deleted is left alone (the request still records the proof).
 */
function markItemCancelled(store: Store, request: ConciergeRequest, proof: string, deps: Clock): boolean {
  const user = store.data.users.find((u) => u.id === request.userId);
  const item = itemOf(store, request);
  if (!user || !item || !CANCELLABLE.includes(item.status)) return false;
  const now = deps.clock();
  Object.assign(item, markCancelled(item, toISODate(now), now.toISOString(), `Cancelled by Trialguard concierge: ${proof}`));
  recompute(store, user, deps);
  return true;
}

// ---------- views ----------

/** What a user sees about their own request. No staff identity, IP or user agent. */
export function userView(store: Store, r: ConciergeRequest) {
  const a = r.authorization;
  return {
    id: r.id,
    itemId: r.itemId,
    itemName: itemOf(store, r)?.name,
    merchantName: a?.merchantName,
    status: r.status,
    feeCents: r.feeCents,
    note: r.note,
    proof: r.proof,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    closedAt: r.closedAt,
    authorization: a ? { textVersion: a.textVersion, signedName: a.signedName, signedAt: a.signedAt, revokedAt: a.revokedAt } : null,
  };
}

/**
 * One row of the ops queue: enough to triage and pick work (merchant, item name, amount, whether a valid
 * authorization is on file). No customer name or email (those come with the audited detail view), and
 * never transactions, tokens, IP or user agent.
 */
export function queueRow(store: Store, r: ConciergeRequest) {
  const item = itemOf(store, r);
  const merchant = getMerchant(r.merchantId ?? item?.merchantId);
  const a = r.authorization;
  return {
    id: r.id,
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    closedAt: r.closedAt,
    assignedTo: r.assignedTo,
    claimedAt: r.claimedAt,
    feeCents: r.feeCents,
    merchant: merchant ? { id: merchant.id, name: merchant.name, cancelUrl: merchant.cancelUrl, difficulty: merchant.difficulty } : null,
    item: item ? { name: item.name, amountCents: item.amountCents, cadence: item.cadence } : null,
    authorization: a ? { textVersion: a.textVersion, signedAt: a.signedAt, revoked: Boolean(a.revokedAt) } : null,
  };
}

/**
 * The full working view of one request (claim, status change and the audited detail endpoint). Adds what
 * doing the job needs: the merchant's steps, the item's billing facts, and the authorization as signed.
 * The customer's email (to identify their account with the merchant) is included only for the assignee
 * while the request is in progress. IP and user agent stay in the record as evidence and are not shown.
 */
export function workView(store: Store, r: ConciergeRequest, staffId: string) {
  const item = itemOf(store, r);
  const merchant = getMerchant(r.merchantId ?? item?.merchantId);
  const a = r.authorization;
  const working = r.status === 'in_progress' && r.assignedTo === staffId;
  return {
    ...queueRow(store, r),
    userId: r.userId,
    merchant: merchant
      ? { id: merchant.id, name: merchant.name, cancelUrl: merchant.cancelUrl, difficulty: merchant.difficulty, phone: merchant.phone, steps: merchant.cancelSteps }
      : null,
    item: item
      ? {
          id: item.id,
          name: item.name,
          status: item.status,
          amountCents: item.amountCents,
          cadence: item.cadence,
          rail: item.rail,
          paymentMethod: item.paymentMethod,
          nextChargeDate: item.nextChargeDate,
          trialEndsAt: item.trialEndsAt,
        }
      : null,
    authorization: a
      ? { textVersion: a.textVersion, textSha256: a.textSha256, merchantName: a.merchantName, signedName: a.signedName, signedAt: a.signedAt, revokedAt: a.revokedAt }
      : null,
    contactEmail: working ? store.data.users.find((u) => u.id === r.userId)?.email : undefined,
    note: r.note,
    proof: r.proof,
  };
}

/** Ops queue order: open work oldest first (first in, first out); closed requests newest first. */
export function queue(store: Store, status: ConciergeStatus, limit: number): ConciergeRequest[] {
  const rows = store.data.concierge.filter((r) => r.status === status);
  const sorted = OPEN.includes(status)
    ? rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    : rows.reverse().sort((a, b) => (b.closedAt ?? b.updatedAt ?? b.createdAt).localeCompare(a.closedAt ?? a.updatedAt ?? a.createdAt));
  return sorted.slice(0, limit);
}
