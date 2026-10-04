import { z } from 'zod';
import { handleAppleNotification, verifyAppleTransaction } from '../billing/apple.ts';
import { billingFromEnv, type BillingDeps } from '../billing/config.ts';
import { billingStatus } from '../billing/entitlement.ts';
import { BillingRejection } from '../billing/errors.ts';
import { createRtdnHandler, InFlightError, PlayApiError, zPubSubPush } from '../billing/google.ts';
import { HttpError } from '../http.ts';
import type { Logger } from '../log.ts';
import { describe, inc } from '../metrics.ts';
import type { RouteDeps } from './shared.ts';

describe('billing_notifications_total', 'Store billing messages handled, by platform, type and result');
describe('billing_rejected_total', 'Billing messages refused (bad signature, wrong app, bad push token), by reason');
describe('billing_plan_changes_total', 'Plan changes derived from billing records, by new plan and reason');
describe('billing_stale_events_total', 'Store events older than the state already applied, skipped');
describe('billing_upstream_errors_total', 'Failed Play Developer API calls, by status');
describe('billing_play_acknowledged_total', 'Play subscription purchases acknowledged');

// Store bodies may grow new fields; only the ones we read are pinned down.
const zAppleNotificationBody = z.looseObject({ signedPayload: z.string().min(1).max(200_000) });
const zAppleVerifyBody = z.strictObject({ signedTransaction: z.string().min(1).max(64_000) });

/**
 * Maps billing failures to HTTP. Rejections (forged, foreign, malformed) are 4xx with a generic message;
 * the reason goes to logs and metrics. A Play API failure is a 502 and a duplicate still in flight a 409,
 * so Pub/Sub redelivers later. Anything else surfaces as a 500 (reported), which the stores also retry.
 */
function toHttpError(err: unknown, platform: 'app_store' | 'google_play', publicMessage: string, log: Logger): unknown {
  if (err instanceof BillingRejection) {
    inc('billing_rejected_total', { platform, reason: err.reason });
    log.warn('billing message rejected', { platform, reason: err.reason, detail: err.message });
    // 403 is the app's own user presenting someone else's purchase: tell them plainly.
    return new HttpError(err.status, err.status === 403 ? err.message : err.status === 401 ? 'Unauthorized' : publicMessage);
  }
  if (err instanceof InFlightError) return new HttpError(409, 'This message is already being processed');
  if (err instanceof PlayApiError) {
    inc('billing_upstream_errors_total', { platform, status: String(err.status) });
    log.warn('play developer api call failed', { status: err.status });
    return new HttpError(502, 'Store API unavailable, retry later');
  }
  return err;
}

/** App Store Server Notifications v2 and Google Play real-time developer notifications. */
export function register(routeDeps: RouteDeps): void {
  registerBillingRoutes(routeDeps, billingFromEnv({ clock: routeDeps.deps.clock }));
}

/** Tests call this directly with pinned test roots and a fake fetch. */
export function registerBillingRoutes({ router, store, deps }: RouteDeps, billing: BillingDeps): void {
  router.on('GET', '/api/billing/status', {}, ({ user }) => billingStatus(store, user, deps.clock()));

  router.on(
    'POST',
    '/api/billing/apple/notifications',
    { auth: 'none', limit: 'webhook', body: zAppleNotificationBody, maxBody: 256_000 },
    ({ body, log }) => {
      if (!billing.apple) throw new HttpError(503, 'App Store billing is not configured');
      try {
        const outcome = handleAppleNotification(store, body.signedPayload, billing.apple, deps, log);
        log.info('app store notification', { result: outcome.result });
        return { ok: true, result: outcome.result };
      } catch (err) {
        throw toHttpError(err, 'app_store', 'Invalid notification', log);
      }
    },
  );

  router.on('POST', '/api/billing/apple/verify', { body: zAppleVerifyBody }, ({ user, body, log }) => {
    if (!billing.apple) throw new HttpError(503, 'App Store billing is not configured');
    try {
      const outcome = verifyAppleTransaction(store, user, body.signedTransaction, billing.apple, deps, log);
      return { result: outcome.result, ...billingStatus(store, user, deps.clock()) };
    } catch (err) {
      throw toHttpError(err, 'app_store', 'Invalid transaction', log);
    }
  });

  const rtdn = billing.google ? createRtdnHandler(store, billing.google, deps) : undefined;
  router.on(
    'POST',
    '/api/billing/google/rtdn',
    { auth: 'none', limit: 'webhook', body: zPubSubPush, maxBody: 128_000 },
    async ({ req, body, log }) => {
      if (!rtdn) throw new HttpError(503, 'Google Play billing is not configured');
      try {
        const outcome = await rtdn(req.headers.authorization, body, log);
        log.info('play notification', { result: outcome.result });
        return { ok: true, result: outcome.result };
      } catch (err) {
        throw toHttpError(err, 'google_play', 'Invalid notification', log);
      }
    },
  );
}
