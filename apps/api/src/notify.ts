import { log } from './log.ts';
import { inc } from './metrics.ts';
import type { OutboxAlert, Store, User } from './store.ts';

/**
 * Delivery channels. The MVP logs and keeps every alert in the in-app inbox; production wires
 * push to APNs/FCM and email to a transactional provider behind this same interface.
 */
export interface Notifier {
  send(user: User, alert: OutboxAlert): Promise<void>;
}

export const consoleNotifier: Notifier = {
  async send(_user, alert) {
    log.info('alert delivered (console)', { alertId: alert.id, channel: alert.channel, type: alert.type });
  },
};

/** Sends every alert whose time has come. */
export async function dispatchDueAlerts(store: Store, notifier: Notifier, now: Date): Promise<number> {
  let sent = 0;
  for (const alert of store.data.alerts) {
    if (alert.status !== 'pending' || alert.sendAt > now.toISOString()) continue;
    const user = store.data.users.find((u) => u.id === alert.userId);
    if (!user) continue;
    alert.status = 'sending';
    alert.attempts++;
    try {
      await notifier.send(user, alert);
      alert.status = 'sent';
      alert.sentAt = now.toISOString();
      sent++;
      inc('alerts_delivered_total', { channel: alert.channel, result: 'sent' });
    } catch (err) {
      alert.status = 'failed';
      alert.lastError = (err as Error).message;
      inc('alerts_delivered_total', { channel: alert.channel, result: 'failed' });
    }
  }
  if (sent) store.save();
  return sent;
}
