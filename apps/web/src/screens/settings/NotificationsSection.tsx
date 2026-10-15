import { useEffect, useMemo, useState } from 'react';
import { api, type AlertPrefs, type AlertType } from '../../api.ts';
import { shortDate } from '../../format.ts';
import type { SectionProps } from './types.ts';
import { VerifyEmailCard } from './VerifyEmailCard.tsx';

/** GET/PUT /api/me/notifications. */
interface NotificationSettings {
  prefs: AlertPrefs;
  emailUnsubscribedAt: string | null;
  devices: { id: string; platform: 'ios' | 'android' | 'web'; appVersion?: string; lastSeenAt: string; enabled: boolean }[];
}

type Patch = Partial<Omit<AlertPrefs, 'types'>> & { types?: Partial<Record<AlertType, boolean>> };

const TYPES: { type: AlertType; label: string; hint: string; plus?: 'priceHikeAlerts' | 'postCancelCheck' }[] = [
  { type: 'trial_converting', label: 'A free trial is about to end', hint: '2 days and 1 day before it turns into a paid plan' },
  { type: 'renewal', label: 'A subscription is about to renew', hint: 'Before you’re charged again' },
  { type: 'price_increase', label: 'A price goes up', hint: 'Old price vs new, as soon as we spot it', plus: 'priceHikeAlerts' },
  { type: 'charge_after_cancel', label: 'Charged after you cancelled', hint: 'So you can dispute it or ask for a refund', plus: 'postCancelCheck' },
  { type: 'cancel_verified', label: 'A cancellation is confirmed', hint: 'When the renewal date passes with no charge' },
];

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function deviceTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** Every IANA zone the browser knows, with the saved and device zones first. */
function timeZoneOptions(...first: (string | undefined)[]): string[] {
  let all: string[] = [];
  try {
    all = Intl.supportedValuesOf('timeZone');
  } catch {
    // Older browsers: offer just the zones we already know about.
  }
  return [...new Set([...first.filter((z): z is string => Boolean(z)), ...all])];
}

const zoneLabel = (tz: string) => tz.replace(/_/g, ' ');

export function NotificationsSection({ me, busy, run, toast }: SectionProps) {
  const prefs = me.alertPrefs;
  const [info, setInfo] = useState<NotificationSettings | null>(null);
  // Unsaved edits to the quiet-hours inputs; otherwise the inputs show what's saved (which may change from another device).
  const [draft, setDraft] = useState<{ start: string; end: string } | null>(null);
  const quiet = draft ?? prefs.quietHours ?? { start: '21:00', end: '08:00' };
  const setQuiet = setDraft;
  const device = useMemo(() => deviceTimeZone(), []);
  const zones = useMemo(() => timeZoneOptions(device, prefs.timeZone), [device, prefs.timeZone]);

  useEffect(() => {
    api<NotificationSettings>('GET', '/me/notifications')
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  const savedStart = prefs.quietHours?.start;
  const savedEnd = prefs.quietHours?.end;

  const save = (patch: Patch, msg = 'Saved') =>
    run(async () => {
      setInfo(await api<NotificationSettings>('PUT', '/me/notifications', patch));
    }, msg);

  /** Time inputs save when the user leaves them, not on every keystroke. */
  const commitQuiet = () => {
    if (!HHMM.test(quiet.start) || !HHMM.test(quiet.end)) return;
    if (quiet.start === quiet.end) return toast('Quiet hours need different start and end times');
    if (quiet.start === savedStart && quiet.end === savedEnd) return setDraft(null);
    void save({ quietHours: quiet }, 'Quiet hours saved').then(() => setDraft(null));
  };

  const activeDevices = info?.devices.filter((d) => d.enabled).length ?? 0;

  return (
    <section>
      <h2 className="section-title">Notifications</h2>

      {!me.emailVerified && <VerifyEmailCard me={me} busy={busy} run={run} toast={toast} />}

      <div className="card form">
        <label className="toggle">
          <input type="checkbox" checked={prefs.push} disabled={busy} onChange={(e) => save({ push: e.target.checked })} />
          <span className="stack-sm">
            <span>Push notifications</span>
            {prefs.push && info && (
              <small className="muted">
                {activeDevices
                  ? `Sending to ${activeDevices} ${activeDevices === 1 ? 'device' : 'devices'}`
                  : 'No phone set up yet. Alerts appear in your in-app inbox; install the app to get them on your lock screen.'}
              </small>
            )}
          </span>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={prefs.email} disabled={busy} onChange={(e) => save({ email: e.target.checked })} />
          <span className="stack-sm">
            <span>Email alerts</span>
            {prefs.email && !me.emailVerified && <small className="muted">On hold until you verify your email address.</small>}
            {!prefs.email && info?.emailUnsubscribedAt && (
              <small className="muted">You unsubscribed on {shortDate(info.emailUnsubscribedAt)}. Turning this on subscribes you again.</small>
            )}
          </span>
        </label>
        {!prefs.push && !prefs.email && (
          <div className="alert-banner warn">
            <strong>All alerts are off.</strong>
            <span>Turn on push or email so we can warn you before a trial or renewal charges you.</span>
          </div>
        )}
      </div>

      <div className="card form">
        <p className="muted">Alert me when…</p>
        {TYPES.map((t) => (
          <label className="toggle" key={t.type}>
            <input type="checkbox" checked={prefs.types[t.type]} disabled={busy} onChange={(e) => save({ types: { [t.type]: e.target.checked } })} />
            <span className="stack-sm">
              <span>
                {t.label} {t.plus && !me.entitlements[t.plus] && <span className="badge badge-info">Plus</span>}
              </span>
              <small className="muted">{t.hint}</small>
            </span>
          </label>
        ))}
      </div>

      <div className="card form">
        <label className="toggle">
          <input
            type="checkbox"
            checked={prefs.quietHours !== null}
            disabled={busy}
            onChange={(e) => save({ quietHours: e.target.checked ? quiet : null }, e.target.checked ? 'Quiet hours on' : 'Quiet hours off')}
          />
          <span className="stack-sm">
            <span>Quiet hours</span>
            <small className="muted">Nothing is sent in this window. Alerts that would land in it go out earlier, never later.</small>
          </span>
        </label>
        {prefs.quietHours && (
          <div className="field-row">
            <label className="field">
              <span>From</span>
              <input type="time" value={quiet.start} disabled={busy} onChange={(e) => setQuiet({ ...quiet, start: e.target.value })} onBlur={commitQuiet} />
            </label>
            <label className="field">
              <span>Until</span>
              <input type="time" value={quiet.end} disabled={busy} onChange={(e) => setQuiet({ ...quiet, end: e.target.value })} onBlur={commitQuiet} />
            </label>
          </div>
        )}

        <label className="field">
          <span>Time zone for alert times and quiet hours</span>
          <select value={prefs.timeZone} disabled={busy} onChange={(e) => save({ timeZone: e.target.value }, 'Time zone saved')}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {zoneLabel(z)}
                {z === device ? ' (this device)' : ''}
              </option>
            ))}
          </select>
        </label>
        {device && device !== prefs.timeZone && (
          <div className="alert-banner info">
            <span>
              This device is set to <strong>{zoneLabel(device)}</strong>, but alerts are timed for {zoneLabel(prefs.timeZone)}.
            </span>
            <div className="banner-actions">
              <button className="btn btn-small btn-primary" disabled={busy} onClick={() => save({ timeZone: device }, 'Time zone saved')}>
                Use this device’s time zone
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
