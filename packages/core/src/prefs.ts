import { addDays } from './dates.ts';
import { localDate, zonedTimeToInstant } from './tz.ts';
import type { AlertChannel, AlertType } from './types.ts';

/** "HH:MM", 24-hour, in the user's own time zone. */
export type LocalTime = string;

/** A nightly window; `end` before `start` wraps past midnight ("21:00" → "08:00"). Equal times mean no window. */
export interface QuietHours {
  start: LocalTime;
  end: LocalTime;
}

/** Notification settings. Alert timing is computed in `timeZone`, never in server or UTC time. */
export interface AlertPrefs {
  push: boolean;
  email: boolean;
  /** Per-alert-type switches. A type switched off is not sent on any channel. */
  types: Record<AlertType, boolean>;
  /**
   * Window when nothing is sent. Lead-time alerts move earlier, never later, so lead times still hold;
   * informational alerts (and late catch-ups with time to spare) wait for the window to end.
   */
  quietHours: QuietHours | null;
  /** IANA zone, e.g. "America/New_York". */
  timeZone: string;
}

export const ALERT_TYPES: AlertType[] = ['trial_converting', 'renewal', 'price_increase', 'charge_after_cancel', 'cancel_verified'];

export const DEFAULT_TIME_ZONE = 'America/New_York';

export const DEFAULT_ALERT_PREFS: AlertPrefs = {
  push: true,
  email: true,
  types: { trial_converting: true, renewal: true, price_increase: true, charge_after_cancel: true, cancel_verified: true },
  quietHours: { start: '21:00', end: '08:00' },
  timeZone: DEFAULT_TIME_ZONE,
};

export const LOCAL_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Whether prefs allow an alert of this type on this channel (used again at send time: prefs can change after scheduling). */
export function alertAllowed(alert: { type: AlertType; channel: AlertChannel }, prefs: AlertPrefs): boolean {
  return prefs.types[alert.type] !== false && prefs[alert.channel];
}

export interface QuietWindow {
  start: Date;
  end: Date;
}

/**
 * The quiet-hours window `instant` falls strictly inside, as real instants, or undefined when it is not quiet.
 * The boundaries are not quiet, so an alert moved to a window's start, or held until its end, goes out there.
 * Window edges on DST days resolve like every local time here (see zonedTimeToInstant): a skipped edge
 * starts when the clocks jump and a repeated one at its first occurrence.
 */
export function quietWindowAt(instant: Date, prefs: Pick<AlertPrefs, 'quietHours' | 'timeZone'>): QuietWindow | undefined {
  const q = prefs.quietHours;
  if (!q || q.start === q.end) return undefined;
  const wraps = q.end < q.start;
  const t = instant.getTime();
  const today = localDate(instant, prefs.timeZone);
  // Windows are shorter than a day, so only the ones starting yesterday or today can contain `instant`.
  for (const startDay of [addDays(today, -1), today]) {
    const start = zonedTimeToInstant(startDay, q.start, prefs.timeZone);
    const end = zonedTimeToInstant(wraps ? addDays(startDay, 1) : startDay, q.end, prefs.timeZone);
    if (start.getTime() < t && t < end.getTime()) return { start, end };
  }
  return undefined;
}

/** Fills in defaults for prefs saved by older versions (or partial client input). */
export function normalizeAlertPrefs(input: Partial<AlertPrefs> | undefined): AlertPrefs {
  const p = input ?? {};
  const quiet = p.quietHours;
  return {
    push: p.push ?? DEFAULT_ALERT_PREFS.push,
    email: p.email ?? DEFAULT_ALERT_PREFS.email,
    types: { ...DEFAULT_ALERT_PREFS.types, ...(p.types ?? {}) },
    quietHours:
      quiet === null
        ? null
        : quiet && LOCAL_TIME_RE.test(quiet.start) && LOCAL_TIME_RE.test(quiet.end)
          ? { start: quiet.start, end: quiet.end }
          : DEFAULT_ALERT_PREFS.quietHours,
    timeZone: p.timeZone && isValidTimeZone(p.timeZone) ? p.timeZone : DEFAULT_ALERT_PREFS.timeZone,
  };
}
