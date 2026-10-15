import { useState } from 'react';
import { api, ApiError, type Connection } from '../../api.ts';
import { timeAgo } from '../../format.ts';
import type { SectionProps } from './types.ts';

/** States the user fixes by signing in to their bank again (Plaid Link in update mode). */
const RECONNECT_COPY = {
  reauth_required: {
    badge: 'Reconnect',
    title: (label: string) => `${label} needs you to sign in again`,
    body: "Your bank asked you to confirm your login. Until you do, we can't see new charges, so alerts for this account may be late or missing.",
  },
  pending_expiration: {
    badge: 'Expires soon',
    title: (label: string) => `Access to ${label} expires soon`,
    body: 'Banks only let apps read your account for a limited time. Reconnect to renew it so charges keep coming in.',
  },
};

function reconnectCopy(c: Connection) {
  return c.status === 'reauth_required' || c.status === 'pending_expiration' ? RECONNECT_COPY[c.status] : undefined;
}

function statusLine(c: Connection): string {
  if (c.status === 'error') return c.error ?? 'Sync failed';
  if (reconnectCopy(c)) return 'Needs reconnecting';
  return c.lastSyncedAt ? `Synced ${timeAgo(c.lastSyncedAt)}` : 'Not synced yet';
}

export function ConnectionsSection({ me, nav, busy, run }: SectionProps) {
  // Connections whose reconnect has to be finished in the mobile app.
  const [inApp, setInApp] = useState<ReadonlySet<string>>(new Set());

  // Update mode runs inside Plaid Link, whose SDK lives in the native app, so the web can only hand off.
  // The server answers 501 when Plaid isn't configured (the demo); either way the next step is in the app.
  const reconnect = (c: Connection) =>
    run(async () => {
      try {
        await api<{ linkToken: string }>('POST', `/connections/${c.id}/link-token`);
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 501)) throw err;
      }
      setInApp((prev) => new Set(prev).add(c.id));
    });

  return (
    <section>
      <h2 className="section-title">Connections</h2>
      {me.connections.map((c) => {
        const copy = reconnectCopy(c);
        if (!copy) return null;
        return (
          <div key={c.id} className="alert-banner warn" role="status">
            <strong>{copy.title(c.label)}</strong>
            <span>{copy.body}</span>
            {inApp.has(c.id) && <span>Reconnecting opens your bank's secure sign-in, which runs in the Trialguard app. Open the app on your phone and tap Reconnect there.</span>}
            <div className="banner-actions">
              {c.type === 'bank' ? (
                <button className="btn btn-small btn-primary" disabled={busy} onClick={() => reconnect(c)}>
                  Reconnect
                </button>
              ) : (
                <span>Remove this inbox below and connect it again.</span>
              )}
              {inApp.has(c.id) && me.devMode && (
                <button className="btn btn-small btn-secondary" disabled={busy} onClick={() => run(() => api('POST', `/connections/${c.id}/relinked`), 'Reconnected')}>
                  Mark reconnected (demo)
                </button>
              )}
            </div>
          </div>
        );
      })}
      <div className="card list-card">
        {me.connections.map((c) => {
          const badge = reconnectCopy(c)?.badge;
          return (
            <div key={c.id} className="row static">
              <span className="connect-icon small" aria-hidden>
                {c.type === 'bank' ? '🏦' : '✉️'}
              </span>
              <div className="row-main">
                <div className="row-title">
                  {c.label}
                  {badge && <span className="badge badge-warn">{badge}</span>}
                </div>
                <div className={`row-sub ${c.status === 'error' ? 'error' : ''}`}>{statusLine(c)}</div>
              </div>
              <button className="btn btn-link btn-small" disabled={busy} onClick={() => run(() => api('DELETE', `/connections/${c.id}`), 'Disconnected')}>
                Remove
              </button>
            </div>
          );
        })}
        <button className="row" onClick={nav.connect}>
          <span className="connect-icon small" aria-hidden>
            ＋
          </span>
          <div className="row-main">
            <div className="row-title">Add a bank or inbox</div>
          </div>
        </button>
      </div>
      <button className="btn btn-secondary btn-block" disabled={busy} onClick={() => run(() => api('POST', '/sync'), 'Everything is up to date')}>
        {busy ? 'Syncing…' : 'Sync now'}
      </button>
    </section>
  );
}
