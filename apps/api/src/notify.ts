import { dispatchOutbox, type DispatchOptions } from './delivery/outbox.ts';
import type { Notifier } from './delivery/types.ts';
import { log } from './log.ts';
import type { Store } from './store.ts';

/**
 * Delivery channels. A Notifier sends one outbox alert; the outbox (delivery/outbox.ts) decides when,
 * claims the alert so it goes out once, and handles retries. `consoleNotifier` only logs (dev, tests);
 * production builds one from env with createDeliveryFromEnv (APNs/FCM push, Postmark email).
 */
export { DeliveryError, type Notifier, type SendResult } from './delivery/types.ts';

export const consoleNotifier: Notifier = {
  async send(_user, alert) {
    log.info('alert delivered (console)', { alertId: alert.id, channel: alert.channel, type: alert.type });
  },
};

/**
 * Sends every alert whose time has come, claiming each one first so it goes out once even with a
 * concurrent dispatcher. Returns how many were delivered. `now` is the dispatch time (tests pin it).
 */
export async function dispatchDueAlerts(store: Store, notifier: Notifier, now: Date, opts: Partial<Omit<DispatchOptions, 'clock'>> = {}): Promise<number> {
  const report = await dispatchOutbox(store, notifier, { ...opts, clock: () => now });
  return report.sent;
}
