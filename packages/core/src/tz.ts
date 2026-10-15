import type { ISODate } from './types.ts';

/**
 * Wall-clock time in a user's IANA time zone, built on Intl alone (no Temporal, no bundled tz data).
 * Intl only converts instant → wall clock, so the reverse is solved by trying the zone's offsets just
 * before and just after the requested wall time and keeping the ones that round-trip.
 */

const SECOND_MS = 1_000;
const DAY_MS = 86_400_000;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * Formatter construction is the slow part of Intl, so one is kept per zone. Intl accepts any casing of a
 * zone name, so the cache is bounded rather than trusting the number of distinct spellings to stay small.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();
const MAX_CACHED_ZONES = 256;

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    if (formatters.size >= MAX_CACHED_ZONES) formatters.clear();
    formatters.set(timeZone, f);
  }
  return f;
}

function wallClock(instantMs: number, timeZone: string): WallClock {
  const w: WallClock = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const part of formatter(timeZone).formatToParts(instantMs)) {
    const n = Number(part.value);
    switch (part.type) {
      case 'year':
        w.year = n;
        break;
      case 'month':
        w.month = n;
        break;
      case 'day':
        w.day = n;
        break;
      case 'hour':
        w.hour = n;
        break;
      case 'minute':
        w.minute = n;
        break;
      case 'second':
        w.second = n;
        break;
      default:
        // literal separators and other parts carry no wall-clock value
        break;
    }
  }
  return w;
}

/** Date.UTC, minus its habit of reading years 0-99 as 1900-1999. */
function utcMs(year: number, month: number, day: number, hour: number, minute: number, second: number): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(hour, minute, second, 0);
  return d.getTime();
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** Offset of `timeZone` from UTC at `instant`, in ms (New York in summer: -4h). */
export function zoneOffsetMs(instant: Date | number, timeZone: string): number {
  const t = typeof instant === 'number' ? instant : instant.getTime();
  const w = wallClock(t, timeZone);
  // Intl drops milliseconds, so compare against the instant floored to the whole second.
  return utcMs(w.year, w.month, w.day, w.hour, w.minute, w.second) - Math.floor(t / SECOND_MS) * SECOND_MS;
}

/** The calendar date `instant` falls on in `timeZone`, e.g. "2026-10-04". */
export function localDate(instant: Date, timeZone: string): ISODate {
  const w = wallClock(instant.getTime(), timeZone);
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
}

/** The wall-clock "HH:MM" of `instant` in `timeZone`. */
export function localTime(instant: Date, timeZone: string): string {
  const w = wallClock(instant.getTime(), timeZone);
  return `${pad(w.hour)}:${pad(w.minute)}`;
}

/**
 * The first instant at which the clock in `timeZone` reads `time` ("HH:MM") or later on `date`.
 *
 * That one rule settles both DST oddities deterministically:
 * - a time that happens twice (clocks fall back) resolves to its first occurrence;
 * - a time that never happens (clocks spring forward over it) resolves to the moment the clocks jump,
 *   e.g. 02:30 on a 02:00 → 03:00 night is 03:00 in the new offset.
 * For midnight this is always the first instant of the local day, even in zones that skip midnight.
 */
export function zonedTimeToInstant(date: ISODate, time: string, timeZone: string): Date {
  const d = DATE_RE.exec(date);
  const t = TIME_RE.exec(time);
  if (!d || !t) throw new RangeError(`Invalid local date/time: ${date} ${time}`);
  const wall = utcMs(Number(d[1]), Number(d[2]), Number(d[3]), Number(t[1]), Number(t[2]), 0);

  // A wall time sits within a day of at most one transition, so these two offsets are the only candidates.
  const before = zoneOffsetMs(wall - DAY_MS, timeZone);
  const after = zoneOffsetMs(wall + DAY_MS, timeZone);
  // Same offset on both sides: no transition nearby, the common case. Only wall times near a DST change go on.
  if (before === after) return new Date(wall - before);
  const valid = [before, after].map((offset) => wall - offset).filter((instant) => wall - instant === zoneOffsetMs(instant, timeZone));
  if (valid.length) return new Date(Math.min(...valid));

  // Skipped wall time: binary-search the jump, to the second. At `wall - after` the old offset still applies
  // (the clock reads earlier than `time`); at `wall - before` the new one already does (it reads later).
  let lo = wall - after;
  let hi = wall - before;
  if (hi <= lo) return new Date(hi);
  while (hi - lo > SECOND_MS) {
    const mid = Math.floor((lo + hi) / 2 / SECOND_MS) * SECOND_MS;
    if (zoneOffsetMs(mid, timeZone) === after) hi = mid;
    else lo = mid;
  }
  return new Date(hi);
}

/** The first instant of the calendar day `date` in `timeZone`. */
export function startOfLocalDay(date: ISODate, timeZone: string): Date {
  return zonedTimeToInstant(date, '00:00', timeZone);
}
