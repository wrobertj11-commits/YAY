import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import type { AlertType } from '@trialguard/core';
import { log, scrub } from '../log.ts';
import { describe, inc, setGauge } from '../metrics.ts';
import type { OutboxAlert, Store, User } from '../store.ts';
import { DeliveryError, type Notifier, type SendResult } from './types.ts';

/**
 * Send-once delivery from the outbox (`store.data.alerts`).
 *
 * The alert id is deterministic (item, type, date, lead time, channel), so it is the idempotency key:
 * the scheduler never re-queues an id that has left `pending` (see `recompute` in pipeline.ts).
 *
 * Lifecycle: pending → sending (claimed: `claimedBy` + `claimedAt`, flushed to disk BEFORE any provider
 * call) → sent | skipped | failed, or back to pending with `nextAttemptAt` (exponential backoff).
 * A `sending` row whose lease expired belongs to an instance that died mid-send. It may or may not have
 * reached the provider, so it goes back to pending: delivery is at-least-once. Push carries a collapse id
 * derived from the alert id, so a re-send replaces the notification on the device instead of duplicating it.
 *
 * With Postgres the claim becomes one statement, committed before any provider call:
 *   UPDATE alerts SET status = 'sending', claimed_by = $1, claimed_at = now(), attempts = attempts + 1
 *   WHERE id IN (SELECT id FROM alerts
 *                WHERE status = 'pending' AND send_at <= now()
 *                  AND (next_attempt_at IS NULL OR next_attempt_at <= now())
 *                ORDER BY send_at LIMIT 50
 *                FOR UPDATE SKIP LOCKED)
 *   RETURNING *;
 * plus a primary key / unique index on alerts.id, so the scheduler's upsert can never create a second
 * row for the same alert and any number of instances can dispatch without double-sending.
 */

export interface DispatchOptions {
  clock: () => Date;
  /** Written to `claimedBy`; must differ between processes. */
  instanceId: string;
  /** A claim older than this is presumed dead. Must exceed the slowest possible send (all devices × timeout). */
  leaseMs: number;
  /** Attempts (including the first) before an alert is marked failed. */
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  /** Bounds one run so a huge backlog can't starve the rest of the tick. */
  maxPerRun: number;
  /** Jitter source (tests pin it). */
  random: () => number;
}

export const DISPATCH_DEFAULTS = {
  leaseMs: 5 * 60_000,
  maxAttempts: 8,
  baseBackoffMs: 60_000,
  maxBackoffMs: 6 * 3_600_000,
  maxPerRun: 500,
  random: Math.random,
} satisfies Partial<DispatchOptions>;

/** Identifies this process in claims and in the job lock. Hostname + pid help ops; the random part makes it unique. */
export const INSTANCE_ID = `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;

export interface DispatchReport {
  sent: number;
  skipped: number;
  retried: number;
  failed: number;
  /** Expired leases returned to pending (or failed) at the start of the run. */
  recovered: number;
}

describe('alerts_skipped_total', 'Alerts deliberately not sent, by reason');
describe('alerts_outbox_backlog', 'Outbox rows waiting: due now, waiting for a retry, or claimed and sending');
describe('alerts_lease_recovered_total', 'Alerts whose sender died mid-send and were re-queued');

/** Exponential backoff with ±20% jitter, so retries after a provider outage don't arrive in lockstep. */
export function backoffMs(attempts: number, opts: Pick<DispatchOptions, 'baseBackoffMs' | 'maxBackoffMs' | 'random'>): number {
  const exp = opts.baseBackoffMs * 2 ** Math.max(0, attempts - 1);
  const jitter = 1 + (opts.random() * 2 - 1) * 0.2;
  return Math.round(Math.min(opts.maxBackoffMs, exp * jitter));
}

const SCHEDULED_TYPES: ReadonlySet<AlertType> = new Set(['trial_converting', 'renewal']);

/**
 * Why an alert must not go out now, or undefined to send it. Checked at send time, not just at
 * scheduling time, because the user, the item and the settings can all change in between.
 */
export function skipReasonFor(store: Store, user: User | undefined, alert: OutboxAlert, nowIso: string): string | undefined {
  if (!user) return 'user_gone';
  const prefs = user.alertPrefs;
  if (!prefs[alert.channel]) return 'channel_off';
  if (prefs.types[alert.type] === false) return 'type_off';
  if (alert.channel === 'email' && user.emailUnsubscribedAt) return 'unsubscribed';
  // Anyone can sign up with any address; only mail the address once its owner has entered a code sent to it.
  if (alert.channel === 'email' && !user.emailVerifiedAt) return 'email_unverified';
  const item = store.data.items.find((i) => i.id === alert.itemId && i.userId === user.id);
  if (!item) return 'item_gone';
  if (alert.type === 'trial_converting' && item.status !== 'trial') return 'item_not_live';
  if (alert.type === 'renewal' && item.status !== 'active') return 'item_not_live';
  // "Your trial ends in 48 hours" is wrong (and useless) once the charge has happened, e.g. after an outage.
  if (SCHEDULED_TYPES.has(alert.type) && alert.dueAt && alert.dueAt <= nowIso) return 'past_due';
  return undefined;
}

function isDue(a: OutboxAlert, nowIso: string): boolean {
  return a.status === 'pending' && a.sendAt <= nowIso && (!a.nextAttemptAt || a.nextAttemptAt <= nowIso);
}

/**
 * The earliest due alert, read from the live array. It is re-read on every iteration because the
 * scheduler may replace pending rows with fresh objects while we await a provider, and another
 * dispatcher may have claimed a row in the meantime. Finding and claiming happen in the same
 * synchronous step, so two dispatchers in one process can never claim the same row.
 */
function nextDue(store: Store, nowIso: string, done: Set<string>): OutboxAlert | undefined {
  let next: OutboxAlert | undefined;
  for (const a of store.data.alerts) {
    if (isDue(a, nowIso) && !done.has(a.id) && (!next || a.sendAt < next.sendAt)) next = a;
  }
  return next;
}

/** Returns crashed claims to pending. Runs at the start of every dispatch. */
export function recoverExpiredLeases(store: Store, now: Date, opts: Pick<DispatchOptions, 'leaseMs' | 'maxAttempts'>): number {
  let recovered = 0;
  for (const a of store.data.alerts) {
    if (a.status !== 'sending') continue;
    const claimedAt = a.claimedAt ? Date.parse(a.claimedAt) : Number.NaN;
    if (Number.isFinite(claimedAt) && now.getTime() - claimedAt < opts.leaseMs) continue;
    a.lastError = 'lease expired: the sender stopped before recording a result';
    a.claimedBy = undefined;
    a.claimedAt = undefined;
    a.nextAttemptAt = undefined;
    if (a.attempts >= opts.maxAttempts) {
      a.status = 'failed';
      inc('alerts_delivered_total', { channel: a.channel, result: 'failed' });
    } else {
      a.status = 'pending';
    }
    recovered++;
  }
  if (recovered) {
    inc('alerts_lease_recovered_total', {}, recovered);
    log.warn('re-queued alerts with expired leases', { count: recovered });
    store.flush();
  }
  return recovered;
}

function markSkipped(alert: OutboxAlert, reason: string): void {
  alert.status = 'skipped';
  alert.skipReason = reason;
  alert.nextAttemptAt = undefined;
  inc('alerts_delivered_total', { channel: alert.channel, result: 'skipped' });
  inc('alerts_skipped_total', { reason });
}

function recordResult(alert: OutboxAlert, result: SendResult, now: Date): 'sent' | 'skipped' {
  alert.nextAttemptAt = undefined;
  if (result && result.status === 'skipped') {
    markSkipped(alert, result.reason);
    return 'skipped';
  }
  alert.status = 'sent';
  alert.sentAt = now.toISOString();
  // A push that only reached the in-app inbox keeps a note of why (e.g. every device rejected it).
  alert.lastError = result?.note ? scrub(result.note).slice(0, 300) : undefined;
  inc('alerts_delivered_total', { channel: alert.channel, result: result?.via === 'inbox' ? 'inbox' : 'sent' });
  return 'sent';
}

function recordFailure(alert: OutboxAlert, err: unknown, claimStamp: string, opts: DispatchOptions): 'retried' | 'failed' | 'lost' {
  // Fencing: if our lease expired and someone else re-claimed the row, their outcome wins.
  if (alert.status !== 'sending' || alert.claimedBy !== opts.instanceId || alert.claimedAt !== claimStamp) {
    log.warn('alert lease lost before the failure was recorded', { alertId: alert.id });
    return 'lost';
  }
  const retryable = err instanceof DeliveryError ? err.retryable : true;
  const retryAfter = err instanceof DeliveryError ? (err.retryAfterMs ?? 0) : 0;
  alert.lastError = scrub(err instanceof Error ? err.message : String(err)).slice(0, 300);
  alert.claimedBy = undefined;
  alert.claimedAt = undefined;
  if (!retryable || alert.attempts >= opts.maxAttempts) {
    alert.status = 'failed';
    alert.nextAttemptAt = undefined;
    inc('alerts_delivered_total', { channel: alert.channel, result: 'failed' });
    log.warn('alert delivery failed', { alertId: alert.id, channel: alert.channel, attempts: alert.attempts, retryable, error: alert.lastError });
    return 'failed';
  }
  const wait = Math.max(backoffMs(alert.attempts, opts), retryAfter);
  alert.status = 'pending';
  alert.nextAttemptAt = new Date(opts.clock().getTime() + wait).toISOString();
  inc('alerts_delivered_total', { channel: alert.channel, result: 'retry' });
  log.info('alert delivery will retry', { alertId: alert.id, channel: alert.channel, attempts: alert.attempts, waitMs: wait });
  return 'retried';
}

/** Sends every alert whose time has come, at most once per alert id (barring a crash mid-send). */
export async function dispatchOutbox(store: Store, notifier: Notifier, options: Partial<DispatchOptions> & Pick<DispatchOptions, 'clock'>): Promise<DispatchReport> {
  const opts: DispatchOptions = { ...DISPATCH_DEFAULTS, instanceId: INSTANCE_ID, ...options };
  const report: DispatchReport = { sent: 0, skipped: 0, retried: 0, failed: 0, recovered: recoverExpiredLeases(store, opts.clock(), opts) };
  const done = new Set<string>();

  while (done.size < opts.maxPerRun) {
    const nowIso = opts.clock().toISOString();
    const alert = nextDue(store, nowIso, done);
    if (!alert) break;
    done.add(alert.id);

    const user = store.data.users.find((u) => u.id === alert.userId);
    const reason = skipReasonFor(store, user, alert, nowIso);
    if (reason || !user) {
      markSkipped(alert, reason ?? 'user_gone');
      report.skipped++;
      store.save();
      continue;
    }

    // Claim, and make the claim durable before anything leaves the building.
    alert.status = 'sending';
    alert.claimedBy = opts.instanceId;
    alert.claimedAt = nowIso;
    alert.attempts++;
    store.flush();

    try {
      const result = await notifier.send(user, alert);
      report[recordResult(alert, result, opts.clock())]++;
    } catch (err) {
      const outcome = recordFailure(alert, err, nowIso, opts);
      if (outcome !== 'lost') report[outcome]++;
    }
    store.flush();
  }

  updateBacklogGauge(store, opts.clock());
  return report;
}

/** Gauge of what is waiting, so a stuck dispatcher or a provider outage shows up on a dashboard. */
export function updateBacklogGauge(store: Store, now: Date): void {
  const nowIso = now.toISOString();
  let due = 0;
  let retryWait = 0;
  let sending = 0;
  for (const a of store.data.alerts) {
    if (a.status === 'sending') sending++;
    else if (a.status === 'pending' && a.sendAt <= nowIso) {
      if (a.nextAttemptAt && a.nextAttemptAt > nowIso) retryWait++;
      else due++;
    }
  }
  setGauge('alerts_outbox_backlog', due, { state: 'due' });
  setGauge('alerts_outbox_backlog', retryWait, { state: 'retry_wait' });
  setGauge('alerts_outbox_backlog', sending, { state: 'sending' });
}
