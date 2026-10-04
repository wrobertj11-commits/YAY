import { log, scrub } from '../log.ts';
import { describe, inc } from '../metrics.ts';
import type { Device, OutboxAlert, Store, User } from '../store.ts';
import { renderAlertEmail } from './alert-email.ts';
import { collapseKey } from './jwt.ts';
import { unsubscribeUrl } from './unsubscribe.ts';
import { DeliveryError, type EmailSender, type Notifier, type PushMessage, type PushOutcome, type PushProvider, type SendResult } from './types.ts';

export interface DeliveryChannels {
  /** iOS devices. */
  apns?: PushProvider;
  /** Android devices, and web devices registered with an FCM token. */
  fcm?: PushProvider;
  email?: EmailSender;
  emailFrom?: string;
  postalAddress?: string;
  publicUrl: string;
  /** In production an alert email with no configured sender is skipped, never reported as sent. */
  production: boolean;
  clock: () => Date;
}

describe('push_sends_total', 'Push requests per device, by provider and result');

export function pushMessage(alert: OutboxAlert): PushMessage {
  return {
    title: alert.title,
    body: alert.body,
    collapseId: collapseKey(alert.id),
    expiresAt: alert.dueAt,
    data: { alertId: alert.id, itemId: alert.itemId, alertType: alert.type },
  };
}

/**
 * Routes an outbox alert to its channel. Push fans out to the user's enabled devices; the in-app
 * inbox (GET /api/alerts) is the floor, so a push alert with no provider, no devices or only dead
 * tokens is still delivered there. Email goes through the transactional sender.
 */
export function createDeliveryNotifier(store: Store, ch: DeliveryChannels): Notifier {
  const providerFor = (d: Device): PushProvider | undefined => (d.platform === 'ios' ? ch.apns : ch.fcm);

  async function sendPush(user: User, alert: OutboxAlert): Promise<SendResult> {
    const devices = store.data.devices.filter((d) => d.userId === user.id && !d.disabledAt);
    const targets = devices.flatMap((d) => {
      const provider = providerFor(d);
      return provider ? [{ device: d, provider }] : [];
    });
    if (!targets.length) {
      log.info('alert delivered (in-app inbox)', { alertId: alert.id, type: alert.type, devices: devices.length });
      return { status: 'sent', via: 'inbox' };
    }

    const msg = pushMessage(alert);
    let delivered = 0;
    let transient: DeliveryError | undefined;
    const rejected: string[] = [];
    for (const { device, provider } of targets) {
      let outcome: PushOutcome;
      try {
        outcome = await provider.send(device.pushToken, msg);
      } catch (err) {
        // Network errors, timeouts, OAuth hiccups: worth another try.
        outcome = { ok: false, invalidToken: false, retryable: true, reason: scrub((err as Error).message ?? 'error').slice(0, 120) };
      }
      inc('push_sends_total', { provider: provider.name, result: outcome.ok ? 'ok' : outcome.invalidToken ? 'invalid_token' : outcome.retryable ? 'retry' : 'rejected' });
      if (outcome.ok) {
        delivered++;
      } else if (outcome.invalidToken) {
        device.disabledAt = ch.clock().toISOString();
        log.info('push token rejected; device disabled', { deviceId: device.id, provider: provider.name, reason: outcome.reason });
        store.save();
      } else if (outcome.retryable) {
        const wait = Math.max(transient?.retryAfterMs ?? 0, outcome.retryAfterMs ?? 0);
        transient = new DeliveryError(`${provider.name}: ${outcome.reason}`, { retryable: true, retryAfterMs: wait || undefined });
      } else {
        rejected.push(`${provider.name}: ${outcome.reason}`);
      }
    }
    // One device is enough: the alert reached the user. Devices that missed it still have the inbox.
    if (delivered) return { status: 'sent', via: 'push' };
    if (transient) throw transient;
    return { status: 'sent', via: 'inbox', note: rejected.length ? `push rejected (${rejected.join(', ')})` : 'every device token was invalid' };
  }

  async function sendEmail(user: User, alert: OutboxAlert): Promise<SendResult> {
    if (!ch.email || !ch.emailFrom) {
      if (ch.production) return { status: 'skipped', reason: 'email_not_configured' };
      log.info('alert delivered (console)', { alertId: alert.id, channel: alert.channel, type: alert.type });
      return { status: 'sent', via: 'log' };
    }
    const email = renderAlertEmail(user.email, alert, {
      from: ch.emailFrom,
      publicUrl: ch.publicUrl,
      unsubscribeUrl: unsubscribeUrl(ch.publicUrl, user.id),
      postalAddress: ch.postalAddress,
    });
    await ch.email.send(email);
    return { status: 'sent', via: 'email' };
  }

  return {
    send: (user, alert) => (alert.channel === 'push' ? sendPush(user, alert) : sendEmail(user, alert)),
  };
}
