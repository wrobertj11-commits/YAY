import { chargeInstant } from './dates.ts';
import { formatCents } from './money.ts';
import { entitlements } from './plans.ts';
import { DEFAULT_ALERT_PREFS, type AlertPrefs } from './prefs.ts';
import type { ItemEvent } from './reconcile.ts';
import type { Alert, AlertChannel, Cadence, Plan, TrackedItem } from './types.ts';

export const ALERT_LEAD_HOURS = [48, 24] as const;


const HOUR_MS = 3_600_000;
const CADENCE_SUFFIX: Record<Cadence, string> = { weekly: '/wk', monthly: '/mo', quarterly: '/qtr', annual: '/yr' };

function price(item: TrackedItem): string {
  return item.amountCents ? `${formatCents(item.amountCents)}${CADENCE_SUFFIX[item.cadence]}` : 'the full price';
}

function shortDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function channels(prefs: AlertPrefs): AlertChannel[] {
  return (['push', 'email'] as const).filter((c) => prefs[c]);
}

/** Trials that get alerts under the plan: the soonest-ending ones, up to the plan's cap. */
export function alertedTrialIds(items: TrackedItem[], plan: Plan): Set<string> {
  const cap = entitlements(plan).maxTrialAlerts;
  const trials = items
    .filter((i) => i.status === 'trial' && i.trialEndsAt)
    .sort((a, b) => a.trialEndsAt!.localeCompare(b.trialEndsAt!));
  return new Set(trials.slice(0, cap).map((i) => i.id));
}

/**
 * F4: alerts at 48h and 24h before a trial converts or a renewal charges.
 * If the 48h mark is already past (a trial found late), the alert goes out immediately,
 * as long as the charge itself is still in the future.
 */
export function scheduleAlerts(items: TrackedItem[], plan: Plan, now: Date, prefs: AlertPrefs = DEFAULT_ALERT_PREFS): Alert[] {
  const alerts: Alert[] = [];
  const trialIds = alertedTrialIds(items, plan);

  for (const item of items) {
    const isTrial = item.status === 'trial';
    if (isTrial && !trialIds.has(item.id)) continue;
    if (!isTrial && item.status !== 'active') continue;
    const date = isTrial ? item.trialEndsAt : item.nextChargeDate;
    if (!date) continue;
    // Low-confidence guesses the user has not confirmed only get trial alerts.
    if (!isTrial && item.confidence < 0.5 && !item.confirmedByUser) continue;

    const due = chargeInstant(date);
    if (due <= now) continue;
    const pm = item.paymentMethod ? ` to ${item.paymentMethod}` : '';

    let firedLate = false;
    for (const lead of ALERT_LEAD_HOURS) {
      let sendAt = new Date(due.getTime() - lead * HOUR_MS);
      if (sendAt < now) {
        // Only one catch-up alert, and only for the earliest missed lead time.
        if (firedLate) continue;
        firedLate = true;
        sendAt = now;
      }
      const hours = Math.max(1, Math.round((due.getTime() - sendAt.getTime()) / HOUR_MS));
      const when = hours >= 36 ? `in ${Math.round(hours / 24)} days` : `in ${hours} hours`;
      for (const channel of channels(prefs)) {
        alerts.push({
          id: `${item.id}:${isTrial ? 'trial' : 'renewal'}:${date}:${lead}:${channel}`,
          itemId: item.id,
          type: isTrial ? 'trial_converting' : 'renewal',
          channel,
          leadHours: lead,
          sendAt: sendAt.toISOString(),
          dueAt: due.toISOString(),
          title: isTrial ? `${item.name} trial ends ${when}` : `${item.name} renews ${when}`,
          body: isTrial
            ? `Your free trial converts on ${shortDate(date)} and ${price(item)} will be charged${pm}. Cancel now if you don't want it.`
            : `${price(item)} will be charged${pm} on ${shortDate(date)}. Still using it?`,
        });
      }
    }
  }
  return alerts.sort((a, b) => a.sendAt.localeCompare(b.sendAt));
}

/** Immediate alerts for things detection just found (price hikes, charges after cancel, verified cancels). */
export function alertsForEvents(events: ItemEvent[], items: TrackedItem[], plan: Plan, now: Date, prefs: AlertPrefs = DEFAULT_ALERT_PREFS): Alert[] {
  const ent = entitlements(plan);
  const byId = new Map(items.map((i) => [i.id, i]));
  const alerts: Alert[] = [];
  for (const ev of events) {
    const item = byId.get(ev.itemId);
    if (!item) continue;
    let alert: Omit<Alert, 'id' | 'channel'> | undefined;
    if (ev.type === 'price_increase' && ent.priceHikeAlerts && item.priceChange) {
      const { oldCents, newCents, effectiveDate } = item.priceChange;
      alert = {
        itemId: item.id,
        type: 'price_increase',
        sendAt: now.toISOString(),
        title: `${item.name} is raising its price`,
        body: `${formatCents(oldCents)} → ${formatCents(newCents)}${CADENCE_SUFFIX[item.cadence]}${effectiveDate ? ` from ${shortDate(effectiveDate)}` : ''}. That's ${formatCents((newCents - oldCents) * (item.cadence === 'annual' ? 1 : 12))} more a year.`,
      };
    } else if (ev.type === 'charge_after_cancel' && ent.postCancelCheck) {
      alert = {
        itemId: item.id,
        type: 'charge_after_cancel',
        sendAt: now.toISOString(),
        title: `${item.name} charged you after you cancelled`,
        body: `We found a new charge from ${item.name} after your cancellation on ${shortDate(item.cancelledAt!)}. Tap to dispute it or request a refund.`,
      };
    } else if (ev.type === 'cancel_verified') {
      alert = {
        itemId: item.id,
        type: 'cancel_verified',
        sendAt: now.toISOString(),
        title: `${item.name} cancellation confirmed`,
        body: `No charge appeared when ${item.name} would have renewed. It's officially done.`,
      };
    }
    if (!alert) continue;
    for (const channel of channels(prefs)) {
      alerts.push({ ...alert, channel, id: `${item.id}:${ev.type}:${ev.transactionId ?? alert.body.length}:${channel}` });
    }
  }
  return alerts;
}
