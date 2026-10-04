import { chargeInstant } from './dates.ts';
import { formatCents } from './money.ts';
import { entitlements } from './plans.ts';
import { DEFAULT_ALERT_PREFS, normalizeAlertPrefs, quietWindowAt, type AlertPrefs } from './prefs.ts';
import type { ItemEvent } from './reconcile.ts';
import type { Alert, AlertChannel, AlertType, Cadence, Plan, TrackedItem } from './types.ts';

export const ALERT_LEAD_HOURS = [48, 24] as const;

/**
 * A late catch-up found during quiet hours waits for the window to end only if that still leaves this much
 * warning before the charge; with less, a message at night beats a message after the trial has converted.
 */
export const CATCH_UP_MIN_LEAD_HOURS = 12;

/** Alerts built once, when detection sees the event. Unlike scheduled alerts they cannot be rebuilt later. */
export const EVENT_ALERT_TYPES: readonly AlertType[] = ['price_increase', 'charge_after_cancel', 'cancel_verified'];

const HOUR_MS = 3_600_000;
const CADENCE_SUFFIX: Record<Cadence, string> = { weekly: '/wk', monthly: '/mo', quarterly: '/qtr', annual: '/yr' };

export function isEventAlert(alert: Pick<Alert, 'type'>): boolean {
  return EVENT_ALERT_TYPES.includes(alert.type);
}

function price(item: TrackedItem): string {
  return item.amountCents ? `${formatCents(item.amountCents)}${CADENCE_SUFFIX[item.cadence]}` : 'the full price';
}

/** "Oct 10". Item dates are calendar dates already in the user's zone, so they are printed as-is, not shifted. */
function shortDate(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * "in 37 hours" / "in 2 days": real time left from the send moment to the local-midnight due instant,
 * rounded down so the copy never promises more time than the user has.
 */
function timeLeft(sendAt: Date, due: Date): string {
  const hours = Math.floor((due.getTime() - sendAt.getTime()) / HOUR_MS);
  if (hours < 1) return 'within the hour';
  if (hours < 48) return `in ${hours} hour${hours === 1 ? '' : 's'}`;
  return `in ${Math.floor(hours / 24)} days`;
}

function channels(prefs: AlertPrefs): AlertChannel[] {
  return (['push', 'email'] as const).filter((c) => prefs[c]);
}

/** A lead-time alert that lands in quiet hours goes out when the window starts: earlier, so the lead still holds. */
function beforeQuietHours(sendAt: Date, prefs: AlertPrefs): Date {
  return quietWindowAt(sendAt, prefs)?.start ?? sendAt;
}

/** Informational alerts lose nothing by waiting, so during quiet hours they are held until the window ends. */
function afterQuietHours(sendAt: Date, prefs: AlertPrefs): Date {
  return quietWindowAt(sendAt, prefs)?.end ?? sendAt;
}

/**
 * When a missed lead-time alert goes out: now, unless it is quiet hours and the window ends with at least
 * CATCH_UP_MIN_LEAD_HOURS to spare before the charge.
 */
function catchUpAt(now: Date, due: Date, prefs: AlertPrefs): Date {
  const quiet = quietWindowAt(now, prefs);
  if (quiet && due.getTime() - quiet.end.getTime() >= CATCH_UP_MIN_LEAD_HOURS * HOUR_MS) return quiet.end;
  return now;
}

/** Trials that get alerts under the plan: the soonest-ending ones, up to the plan's cap. */
export function alertedTrialIds(items: TrackedItem[], plan: Plan): Set<string> {
  const cap = entitlements(plan).maxTrialAlerts;
  const trials = items
    .flatMap((i) => (i.status === 'trial' && i.trialEndsAt ? [{ id: i.id, endsAt: i.trialEndsAt }] : []))
    .sort((a, b) => a.endsAt.localeCompare(b.endsAt));
  return new Set(trials.slice(0, cap).map((t) => t.id));
}

/**
 * F4: alerts 48h and 24h before a trial converts or a renewal charges, in the user's time zone.
 *
 * - Due is local midnight on the charge date (prefs.timeZone): a trial can convert at any hour that day.
 * - Each alert goes out `lead` hours of real elapsed time before due, so DST changes cannot shorten the warning,
 *   and the "48h before" promise holds for every alert that is not a catch-up.
 * - An alert that lands in quiet hours moves earlier, to the moment the window starts.
 * - If a send moment has already passed (the item was found late), one catch-up alert goes out now, or when
 *   quiet hours end if that is still CATCH_UP_MIN_LEAD_HOURS before due. It keeps the earliest missed lead's id,
 *   so re-running never adds a second catch-up for the same item and date.
 * - A type switched off in prefs gets no alerts; channels come from prefs.push / prefs.email.
 */
export function scheduleAlerts(items: TrackedItem[], plan: Plan, now: Date, prefs: AlertPrefs = DEFAULT_ALERT_PREFS): Alert[] {
  // Prefs come from storage and clients; a malformed zone or window must not take scheduling down for everyone.
  const p = normalizeAlertPrefs(prefs);
  const sendOn = channels(p);
  const alerts: Alert[] = [];
  const trialIds = alertedTrialIds(items, plan);

  for (const item of items) {
    const isTrial = item.status === 'trial';
    if (isTrial && !trialIds.has(item.id)) continue;
    if (!isTrial && item.status !== 'active') continue;
    const type: AlertType = isTrial ? 'trial_converting' : 'renewal';
    if (p.types[type] === false) continue;
    const date = isTrial ? item.trialEndsAt : item.nextChargeDate;
    if (!date) continue;
    // Low-confidence guesses the user has not confirmed only get trial alerts.
    if (!isTrial && item.confidence < 0.5 && !item.confirmedByUser) continue;

    const due = chargeInstant(date, p.timeZone);
    if (due <= now) continue;
    const pm = item.paymentMethod ? ` to ${item.paymentMethod}` : '';

    let firedLate = false;
    for (const lead of ALERT_LEAD_HOURS) {
      let sendAt = beforeQuietHours(new Date(due.getTime() - lead * HOUR_MS), p);
      let catchUp = false;
      if (sendAt < now) {
        // Only one catch-up alert, and only for the earliest missed lead time.
        if (firedLate) continue;
        firedLate = true;
        catchUp = true;
        sendAt = catchUpAt(now, due, p);
      }
      const when = timeLeft(sendAt, due);
      for (const channel of sendOn) {
        alerts.push({
          id: `${item.id}:${isTrial ? 'trial' : 'renewal'}:${date}:${lead}:${channel}`,
          itemId: item.id,
          type,
          channel,
          leadHours: lead,
          ...(catchUp ? { catchUp: true } : {}),
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

type EventAlert = Omit<Alert, 'channel' | 'sendAt' | 'id'> & { key: string };

/** The alert for one detection event, keyed by the facts it reports so the same event always maps to the same id. */
function eventAlert(ev: ItemEvent, item: TrackedItem, plan: Plan): EventAlert | undefined {
  const ent = entitlements(plan);
  if (ev.type === 'price_increase' && ent.priceHikeAlerts && item.priceChange) {
    const { oldCents, newCents, effectiveDate } = item.priceChange;
    return {
      key: `${oldCents}-${newCents}-${effectiveDate ?? 'na'}`,
      itemId: item.id,
      type: 'price_increase',
      title: `${item.name} is raising its price`,
      body: `${formatCents(oldCents)} → ${formatCents(newCents)}${CADENCE_SUFFIX[item.cadence]}${effectiveDate ? ` from ${shortDate(effectiveDate)}` : ''}. That's ${formatCents((newCents - oldCents) * (item.cadence === 'annual' ? 1 : 12))} more a year.`,
    };
  }
  if (ev.type === 'charge_after_cancel' && ent.postCancelCheck) {
    const charge = ev.transactionId ?? item.postCancelChargeIds?.[0];
    return {
      key: charge ?? 'na',
      itemId: item.id,
      type: 'charge_after_cancel',
      title: `${item.name} charged you after you cancelled`,
      body: `We found a new charge from ${item.name} after ${item.cancelledAt ? `your cancellation on ${shortDate(item.cancelledAt)}` : 'you cancelled'}. Tap to dispute it or request a refund.`,
    };
  }
  if (ev.type === 'cancel_verified') {
    return {
      key: item.cancelVerifiedAt ?? 'na',
      itemId: item.id,
      type: 'cancel_verified',
      title: `${item.name} cancellation confirmed`,
      body: `No charge appeared when ${item.name} would have renewed. It's officially done.`,
    };
  }
  return undefined;
}

/**
 * Alerts for things detection just found (price hikes, charges after cancel, verified cancels). They go out now,
 * or when quiet hours end: they are informational, and nothing charges sooner because of the wait.
 * Ids are built from the event's facts (prices and date, the charge, the verification date), so re-running
 * detection never queues the same news twice.
 */
export function alertsForEvents(events: ItemEvent[], items: TrackedItem[], plan: Plan, now: Date, prefs: AlertPrefs = DEFAULT_ALERT_PREFS): Alert[] {
  const p = normalizeAlertPrefs(prefs);
  const byId = new Map(items.map((i) => [i.id, i]));
  const sendAt = afterQuietHours(now, p).toISOString();
  const alerts: Alert[] = [];
  const seen = new Set<string>();
  for (const ev of events) {
    const item = byId.get(ev.itemId);
    if (!item) continue;
    const built = eventAlert(ev, item, plan);
    if (!built || p.types[built.type] === false) continue;
    const { key, ...alert } = built;
    for (const channel of channels(p)) {
      const id = `${item.id}:${alert.type}:${key}:${channel}`;
      // One reconcile pass can report the same fact more than once; it is still one piece of news.
      if (seen.has(id)) continue;
      seen.add(id);
      alerts.push({ ...alert, id, channel, sendAt });
    }
  }
  return alerts;
}
