import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CATCH_UP_MIN_LEAD_HOURS,
  addDays,
  alertAllowed,
  alertsForEvents,
  chargeInstant,
  createManualItem,
  isEventAlert,
  localDate,
  localTime,
  normalizeAlertPrefs,
  quietWindowAt,
  scheduleAlerts,
  startOfLocalDay,
  zonedTimeToInstant,
  type Alert,
  type AlertPrefs,
  type ItemEvent,
  type TrackedItem,
} from '../src/index.ts';

const H = 3_600_000;
const CREATED = '2026-09-01T00:00:00Z';

/** Push-only prefs (one alert per lead time keeps assertions short), with overrides. */
function prefs(over: Partial<AlertPrefs> = {}): AlertPrefs {
  return normalizeAlertPrefs({ push: true, email: false, ...over });
}

function trial(id: string, ends: string): TrackedItem {
  return createManualItem({ name: id, amountCents: 999, cadence: 'monthly', date: ends, isTrial: true }, id, CREATED);
}

function renewal(id: string, date: string): TrackedItem {
  return createManualItem({ name: id, amountCents: 1500, cadence: 'monthly', date, isTrial: false }, id, CREATED);
}

/** [leadHours, sendAt] pairs, the shape most assertions care about. */
const timing = (alerts: Alert[]) => alerts.map((a) => [a.leadHours, a.sendAt]);

function leadMs(a: Alert): number {
  assert.ok(a.dueAt, `alert ${a.id} has no dueAt`);
  return Date.parse(a.dueAt) - Date.parse(a.sendAt);
}

function only<T>(list: readonly T[]): T {
  assert.equal(list.length, 1, `expected exactly one element, got ${list.length}`);
  const v = list[0];
  assert.ok(v !== undefined);
  return v;
}

describe('time zone math', () => {
  it('resolves a wall time that happens twice to its first occurrence (New York, fall back)', () => {
    assert.equal(zonedTimeToInstant('2026-11-01', '01:30', 'America/New_York').toISOString(), '2026-11-01T05:30:00.000Z');
  });

  it('resolves a skipped wall time to the moment the clocks jump', () => {
    assert.equal(zonedTimeToInstant('2027-03-14', '02:30', 'America/New_York').toISOString(), '2027-03-14T07:00:00.000Z');
    assert.equal(zonedTimeToInstant('2026-10-04', '02:30', 'Australia/Sydney').toISOString(), '2026-10-03T16:00:00.000Z');
  });

  it('finds the first instant of a local day, including half-hour zones and zones that skip midnight', () => {
    assert.equal(startOfLocalDay('2026-10-10', 'Asia/Kolkata').toISOString(), '2026-10-09T18:30:00.000Z');
    // Chile springs forward at midnight: Sep 6 starts at 01:00 local.
    const santiago = startOfLocalDay('2026-09-06', 'America/Santiago');
    assert.equal(santiago.toISOString(), '2026-09-06T04:00:00.000Z');
    assert.equal(localDate(santiago, 'America/Santiago'), '2026-09-06');
    assert.equal(localTime(santiago, 'America/Santiago'), '01:00');
    assert.equal(chargeInstant('2026-10-10').toISOString(), '2026-10-10T00:00:00.000Z', 'defaults to UTC');
  });

  it('reads local dates and times in the zone, not in UTC', () => {
    const t = new Date('2026-10-03T15:00:00Z');
    assert.equal(localDate(t, 'Asia/Tokyo'), '2026-10-04');
    assert.equal(localTime(t, 'Asia/Kolkata'), '20:30');
    assert.equal(localDate(t, 'America/Los_Angeles'), '2026-10-03');
  });

  it('places quiet windows deterministically on DST days', () => {
    const fallBack = { quietHours: { start: '01:30', end: '05:00' }, timeZone: 'America/New_York' };
    // 01:15 on the second pass through the repeated hour: the window began at the first 01:30 and is still running.
    assert.deepEqual(quietWindowAt(new Date('2026-11-01T06:15:00Z'), fallBack), {
      start: new Date('2026-11-01T05:30:00Z'),
      end: new Date('2026-11-01T10:00:00Z'),
    });
    const springForward = { quietHours: { start: '02:30', end: '06:00' }, timeZone: 'America/New_York' };
    // 02:30 never happens; the window starts when the clocks jump to 03:00 EDT.
    assert.equal(quietWindowAt(new Date('2027-03-14T07:15:00Z'), springForward)?.start.toISOString(), '2027-03-14T07:00:00.000Z');
    assert.equal(quietWindowAt(new Date('2027-03-14T06:59:00Z'), springForward), undefined);
  });

  it('treats window boundaries as not quiet, and an empty window as no window', () => {
    const p = prefs();
    assert.equal(quietWindowAt(new Date('2026-10-04T01:00:00Z'), p), undefined, '21:00 exactly');
    assert.equal(quietWindowAt(new Date('2026-10-04T12:00:00Z'), p), undefined, '08:00 exactly');
    assert.ok(quietWindowAt(new Date('2026-10-04T01:01:00Z'), p));
    assert.equal(quietWindowAt(new Date('2026-10-04T03:00:00Z'), prefs({ quietHours: { start: '22:00', end: '22:00' } })), undefined);
    assert.equal(quietWindowAt(new Date('2026-10-04T03:00:00Z'), prefs({ quietHours: null })), undefined);
  });
});

describe('scheduleAlerts in the user time zone', () => {
  const early = new Date('2026-09-20T12:00:00Z');

  it('New York across DST end (2026-11-01): leads are real elapsed hours, not wall-clock days', () => {
    const p = prefs({ quietHours: null });
    const alerts = scheduleAlerts([trial('t', '2026-11-02')], 'plus', early, p);
    // Due is midnight EST (05:00Z). With the 25-hour day in between, 48h earlier is 01:00 EDT, not midnight.
    assert.deepEqual(timing(alerts), [
      [48, '2026-10-31T05:00:00.000Z'],
      [24, '2026-11-01T05:00:00.000Z'],
    ]);
    for (const a of alerts) assert.equal(leadMs(a), (a.leadHours ?? 0) * H);
    assert.equal(localTime(new Date(at0(alerts).sendAt), 'America/New_York'), '01:00');
  });

  it('New York across DST end with quiet hours: both alerts move back to 21:00 the evening before', () => {
    const alerts = scheduleAlerts([trial('t', '2026-11-02')], 'plus', early, prefs());
    assert.deepEqual(timing(alerts), [
      [48, '2026-10-31T01:00:00.000Z'], // Oct 30, 21:00 EDT
      [24, '2026-11-01T01:00:00.000Z'], // Oct 31, 21:00 EDT
    ]);
  });

  it('New York across DST start (2027-03-14)', () => {
    const now = new Date('2027-03-01T12:00:00Z');
    const plain = scheduleAlerts([trial('t', '2027-03-15')], 'plus', now, prefs({ quietHours: null }));
    // Due is midnight EDT (04:00Z); with the 23-hour day in between, the marks fall at 23:00 EST.
    assert.deepEqual(timing(plain), [
      [48, '2027-03-13T04:00:00.000Z'],
      [24, '2027-03-14T04:00:00.000Z'],
    ]);
    const quiet = scheduleAlerts([trial('t', '2027-03-15')], 'plus', now, prefs());
    assert.deepEqual(timing(quiet), [
      [48, '2027-03-13T02:00:00.000Z'], // Mar 12, 21:00 EST
      [24, '2027-03-14T02:00:00.000Z'], // Mar 13, 21:00 EST
    ]);
  });

  it('Australia/Sydney (+10 → +11 on 2026-10-04)', () => {
    const tz = 'Australia/Sydney';
    const plain = scheduleAlerts([trial('t', '2026-10-05')], 'plus', early, prefs({ timeZone: tz, quietHours: null }));
    assert.equal(at0(plain).dueAt, '2026-10-04T13:00:00.000Z', 'midnight AEDT');
    assert.deepEqual(timing(plain), [
      [48, '2026-10-02T13:00:00.000Z'], // 23:00 AEST
      [24, '2026-10-03T13:00:00.000Z'],
    ]);
    const quiet = scheduleAlerts([trial('t', '2026-10-05')], 'plus', early, prefs({ timeZone: tz, quietHours: { start: '22:00', end: '07:00' } }));
    assert.deepEqual(timing(quiet), [
      [48, '2026-10-02T12:00:00.000Z'], // 22:00 AEST
      [24, '2026-10-03T12:00:00.000Z'],
    ]);
  });

  it('Australia/Sydney across DST end (2027-04-04)', () => {
    const alerts = scheduleAlerts([trial('t', '2027-04-05')], 'plus', new Date('2027-03-20T00:00:00Z'), prefs({ timeZone: 'Australia/Sydney', quietHours: null }));
    assert.equal(at0(alerts).dueAt, '2027-04-04T14:00:00.000Z', 'midnight AEST');
    assert.deepEqual(timing(alerts), [
      [48, '2027-04-02T14:00:00.000Z'], // 01:00 AEDT
      [24, '2027-04-03T14:00:00.000Z'],
    ]);
  });

  it('Asia/Kolkata (+05:30, no DST) with a half-hour quiet window that wraps midnight', () => {
    const p = prefs({ timeZone: 'Asia/Kolkata', quietHours: { start: '22:30', end: '06:30' } });
    const alerts = scheduleAlerts([trial('t', '2026-10-10')], 'plus', early, p);
    assert.equal(at0(alerts).dueAt, '2026-10-09T18:30:00.000Z');
    assert.deepEqual(timing(alerts), [
      [48, '2026-10-07T17:00:00.000Z'], // Oct 7, 22:30 IST
      [24, '2026-10-08T17:00:00.000Z'],
    ]);
  });

  it('leaves alerts alone when quiet hours are off or the mark sits on a window boundary', () => {
    const exact = [
      [48, '2026-10-08T04:00:00.000Z'],
      [24, '2026-10-09T04:00:00.000Z'],
    ];
    assert.deepEqual(timing(scheduleAlerts([trial('t', '2026-10-10')], 'plus', early, prefs({ quietHours: null }))), exact);
    // Midnight is the start of a 00:00-06:00 window and the end of a 22:00-00:00 one: neither counts as quiet.
    assert.deepEqual(timing(scheduleAlerts([trial('t', '2026-10-10')], 'plus', early, prefs({ quietHours: { start: '00:00', end: '06:00' } }))), exact);
    assert.deepEqual(timing(scheduleAlerts([trial('t', '2026-10-10')], 'plus', early, prefs({ quietHours: { start: '22:00', end: '00:00' } }))), exact);
  });

  it('defers a late catch-up found during quiet hours to the window end when that leaves 12+ hours', () => {
    const now = new Date('2026-10-04T03:00:00Z'); // Oct 3, 23:00 EDT
    const a = only(scheduleAlerts([trial('t', '2026-10-05')], 'plus', now, prefs()));
    assert.equal(a.catchUp, true);
    assert.equal(a.leadHours, 48);
    assert.equal(a.sendAt, '2026-10-04T12:00:00.000Z', '08:00 EDT, 16h before due');
    assert.ok(leadMs(a) >= CATCH_UP_MIN_LEAD_HOURS * H);
    assert.equal(a.title, 't trial ends in 16 hours');
  });

  it('sends a late catch-up during quiet hours now when waiting would leave under 12 hours', () => {
    const now = new Date('2026-10-04T03:00:00Z'); // Oct 3, 23:00 EDT
    // The window ends at 13:00 EDT, 11h before the Oct 5 midnight due.
    const late = only(scheduleAlerts([trial('t', '2026-10-05')], 'plus', now, prefs({ quietHours: { start: '21:00', end: '13:00' } })));
    assert.equal(late.sendAt, now.toISOString());
    assert.equal(late.catchUp, true);
    // The window ends after the trial converts (midnight tonight).
    const tonight = only(scheduleAlerts([trial('t', '2026-10-04')], 'plus', now, prefs()));
    assert.equal(tonight.sendAt, now.toISOString());
    assert.equal(tonight.title, 't trial ends in 1 hour');
  });

  it('keeps one catch-up per item and date across re-runs', () => {
    const first = scheduleAlerts([trial('t', '2026-10-05')], 'plus', new Date('2026-10-03T15:00:00Z'), prefs());
    const later = scheduleAlerts([trial('t', '2026-10-05')], 'plus', new Date('2026-10-04T16:00:00Z'), prefs());
    const catchUpIds = new Set([...first, ...later].filter((a) => a.catchUp).map((a) => a.id));
    assert.deepEqual([...catchUpIds], ['t:trial:2026-10-05:48:push']);
    assert.equal(only(later).id, 't:trial:2026-10-05:48:push', 'the passed 24h mark is not a second catch-up');
  });

  it('writes copy relative to the user’s local due date', () => {
    // 01:00 on Oct 4 in Tokyo; the trial ends Oct 5 local, so it can convert in 23 hours.
    const now = new Date('2026-10-03T16:00:00Z');
    const a = only(scheduleAlerts([trial('Calm', '2026-10-05')], 'plus', now, prefs({ timeZone: 'Asia/Tokyo', quietHours: null })));
    assert.equal(a.title, 'Calm trial ends in 23 hours');
    assert.match(a.body, /converts on Oct 5 /);
    const ahead = scheduleAlerts([trial('Calm', '2026-10-10')], 'plus', early, prefs({ timeZone: 'Asia/Tokyo' }));
    assert.equal(at0(ahead).title, 'Calm trial ends in 2 days');
    // 23:30 in Tokyo the night before: under an hour left is never rounded up to "1 hour".
    const lastMinute = only(scheduleAlerts([trial('Calm', '2026-10-05')], 'plus', new Date('2026-10-04T14:30:00Z'), prefs({ timeZone: 'Asia/Tokyo' })));
    assert.equal(lastMinute.title, 'Calm trial ends within the hour');
    assert.equal(lastMinute.sendAt, '2026-10-04T14:30:00.000Z');
  });

  it('honours per-type switches but still alerts the other type', () => {
    const items = [trial('t', '2026-10-10'), renewal('r', '2026-10-12')];
    const noTrials = scheduleAlerts(items, 'plus', early, prefs({ types: { ...prefs().types, trial_converting: false } }));
    assert.deepEqual([...new Set(noTrials.map((a) => a.itemId))], ['r']);
    const noRenewals = scheduleAlerts(items, 'plus', early, prefs({ types: { ...prefs().types, renewal: false } }));
    assert.deepEqual([...new Set(noRenewals.map((a) => a.type))], ['trial_converting']);
    const both = scheduleAlerts(items, 'plus', early, normalizeAlertPrefs({ push: true, email: true }));
    assert.deepEqual([...new Set(both.map((a) => a.channel))].sort(), ['email', 'push']);
  });

  it('still caps Free trial alerts at the 3 soonest trials in any zone', () => {
    const items = ['2026-10-20', '2026-10-06', '2026-10-30', '2026-10-12'].map((d, i) => trial(`t${i}`, d));
    const ids = new Set(scheduleAlerts(items, 'free', early, prefs({ timeZone: 'Australia/Sydney' })).map((a) => a.itemId));
    assert.deepEqual([...ids].sort(), ['t0', 't1', 't3']);
  });

  it('falls back to defaults for malformed prefs instead of throwing', () => {
    const bad = { ...prefs(), timeZone: 'Not/AZone', quietHours: { start: '9pm', end: '8am' } } as AlertPrefs;
    assert.deepEqual(timing(scheduleAlerts([trial('t', '2026-10-10')], 'plus', early, bad)), timing(scheduleAlerts([trial('t', '2026-10-10')], 'plus', early, prefs())));
  });

  it('every 48h alert goes out at least 48 hours before due, and none lands inside quiet hours', () => {
    const zones = ['America/New_York', 'America/Los_Angeles', 'Europe/London', 'Australia/Sydney', 'Asia/Kolkata', 'America/Santiago', 'Pacific/Chatham'];
    const windows = [null, { start: '21:00', end: '08:00' }, { start: '23:30', end: '06:15' }, { start: '00:30', end: '02:45' }, { start: '01:00', end: '01:30' }];
    const now = new Date('2026-08-15T00:00:00Z');
    let checked = 0;
    for (const timeZone of zones) {
      for (const quietHours of windows) {
        const p = prefs({ timeZone, quietHours });
        const items: TrackedItem[] = [];
        // Every other day through both northern and southern DST changes.
        for (let d = '2026-09-01'; d < '2027-04-30'; d = addDays(d, 2)) items.push(trial(`t${d}`, d));
        for (const a of scheduleAlerts(items, 'plus', now, p)) {
          assert.ok(!a.catchUp);
          assert.ok(leadMs(a) >= (a.leadHours ?? Infinity) * H, `${timeZone} ${JSON.stringify(quietHours)} ${a.id}: ${a.sendAt} → ${a.dueAt}`);
          assert.equal(quietWindowAt(new Date(a.sendAt), p), undefined, `${timeZone} ${a.id} is inside quiet hours`);
          assert.equal(a.dueAt, chargeInstant(a.id.split(':')[2] ?? '', timeZone).toISOString());
          checked++;
        }
      }
    }
    assert.ok(checked > 5000, `checked ${checked}`);
  });
});

describe('alertsForEvents', () => {
  const now = new Date('2026-10-03T15:00:00Z'); // 11:00 EDT
  const night = new Date('2026-10-04T03:00:00Z'); // 23:00 EDT

  const hiked: TrackedItem = {
    ...renewal('n', '2026-10-15'),
    priceChange: { oldCents: 1549, newCents: 1799, effectiveDate: '2026-10-15', detectedFrom: 'email' },
  };
  const charged: TrackedItem = { ...renewal('c', '2026-10-20'), status: 'charged_after_cancel', cancelledAt: '2026-09-25', postCancelChargeIds: ['txn_9'] };
  const verified: TrackedItem = { ...renewal('v', '2026-10-01'), status: 'cancel_verified', cancelledAt: '2026-09-20', cancelVerifiedAt: '2026-10-02' };
  const items = [hiked, charged, verified];
  const events: ItemEvent[] = [
    { type: 'price_increase', itemId: 'n' },
    { type: 'charge_after_cancel', itemId: 'c', transactionId: 'txn_9' },
    { type: 'cancel_verified', itemId: 'v' },
    { type: 'new_item', itemId: 'n' },
  ];

  it('builds ids from the event facts, identical across runs', () => {
    const p = normalizeAlertPrefs({});
    const first = alertsForEvents(events, items, 'plus', now, p);
    const second = alertsForEvents(events, items, 'plus', new Date('2026-10-05T15:00:00Z'), p);
    assert.deepEqual(
      first.map((a) => a.id),
      second.map((a) => a.id),
    );
    assert.deepEqual(first.map((a) => a.id).sort(), [
      'c:charge_after_cancel:txn_9:email',
      'c:charge_after_cancel:txn_9:push',
      'n:price_increase:1549-1799-2026-10-15:email',
      'n:price_increase:1549-1799-2026-10-15:push',
      'v:cancel_verified:2026-10-02:email',
      'v:cancel_verified:2026-10-02:push',
    ]);
    assert.ok(first.every(isEventAlert));
  });

  it('gives a different price change a different id, and reports the same news once per run', () => {
    const again = alertsForEvents([...events, { type: 'price_increase', itemId: 'n' }], items, 'plus', now, prefs());
    assert.equal(again.filter((a) => a.type === 'price_increase').length, 1);
    const newer: TrackedItem = { ...hiked, priceChange: { oldCents: 1799, newCents: 1999, detectedFrom: 'charges' } };
    const a = only(alertsForEvents([{ type: 'price_increase', itemId: 'n' }], [newer], 'plus', now, prefs()));
    assert.equal(a.id, 'n:price_increase:1799-1999-na:push');
  });

  it('keys a post-cancel charge by its transaction, falling back to the item’s recorded charge', () => {
    const a = only(alertsForEvents([{ type: 'charge_after_cancel', itemId: 'c' }], items, 'plus', now, prefs()));
    assert.equal(a.id, 'c:charge_after_cancel:txn_9:push');
    assert.match(a.body, /cancellation on Sep 25/);
  });

  it('sends now outside quiet hours and holds until the window ends inside them', () => {
    assert.ok(alertsForEvents(events, items, 'plus', now, prefs()).every((a) => a.sendAt === now.toISOString()));
    const held = alertsForEvents(events, items, 'plus', night, prefs());
    assert.equal(held.length, 3);
    assert.ok(held.every((a) => a.sendAt === '2026-10-04T12:00:00.000Z'), '08:00 EDT');
  });

  it('honours per-type switches and plan gates', () => {
    const p = prefs({ types: { ...prefs().types, price_increase: false, cancel_verified: false } });
    assert.deepEqual(
      alertsForEvents(events, items, 'plus', now, p).map((a) => a.type),
      ['charge_after_cancel'],
    );
    // Free has neither price-hike alerts nor the post-cancel check, only verified cancels.
    assert.deepEqual(
      alertsForEvents(events, items, 'free', now, prefs()).map((a) => a.type),
      ['cancel_verified'],
    );
  });

  it('lets send-time checks re-apply prefs that changed after scheduling', () => {
    const p = prefs({ types: { ...prefs().types, renewal: false } });
    assert.equal(alertAllowed({ type: 'renewal', channel: 'push' }, p), false);
    assert.equal(alertAllowed({ type: 'price_increase', channel: 'push' }, p), true);
    assert.equal(alertAllowed({ type: 'price_increase', channel: 'email' }, p), false);
    assert.equal(isEventAlert({ type: 'trial_converting' }), false);
  });
});

function at0(alerts: Alert[]): Alert {
  const a = alerts[0];
  assert.ok(a, 'expected at least one alert');
  return a;
}
