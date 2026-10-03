import type { OutboxAlert, Store, User } from './store.ts';

/**
 * Delivery channels. The MVP logs and keeps every alert in the in-app inbox; production wires
 * push to APNs/FCM and email to a transactional provider behind this same interface.
 */
export interface Notifier {
  send(user: User, alert: OutboxAlert): Promise<void>;
}

export const consoleNotifier: Notifier = {
  async send(user, alert) {
    console.log(`[notify:${alert.channel}] → ${user.email}: ${alert.title} — ${alert.body}`);
  },
};

/** Sends every alert whose time has come. Runs every minute. */
export async function dispatchDueAlerts(store: Store, notifier: Notifier, now: Date): Promise<number> {
  let sent = 0;
  for (const alert of store.data.alerts) {
    if (alert.sentAt || alert.sendAt > now.toISOString()) continue;
    const user = store.data.users.find((u) => u.id === alert.userId);
    if (!user) continue;
    await notifier.send(user, alert);
    alert.sentAt = now.toISOString();
    sent++;
  }
  if (sent) store.save();
  return sent;
}
