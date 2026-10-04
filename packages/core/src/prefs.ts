import type { AlertType } from './types.ts';

/** "HH:MM", 24-hour, in the user's own time zone. */
export type LocalTime = string;

export interface QuietHours {
  start: LocalTime;
  end: LocalTime;
}

/** Notification settings. Alert timing is computed in `timeZone`, never in server or UTC time. */
export interface AlertPrefs {
  push: boolean;
  email: boolean;
  /** Per-alert-type switches. */
  types: Record<AlertType, boolean>;
  /** Window when nothing is sent. Alerts move earlier, never later, so lead times still hold. */
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
