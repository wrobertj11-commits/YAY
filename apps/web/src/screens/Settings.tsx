import { useState } from 'react';
import type { Nav } from '../App.tsx';
import { api, type Me } from '../api.ts';
import { timeAgo } from '../format.ts';

const STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');

interface Props {
  me: Me;
  nav: Nav;
  onChanged: () => Promise<unknown>;
  toast: (m: string) => void;
  onSignOut: () => void;
}

export function SettingsScreen({ me, nav, onChanged, toast, onSignOut }: Props) {
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function run(fn: () => Promise<unknown>, msg?: string) {
    setBusy(true);
    try {
      await fn();
      await onChanged();
      if (msg) toast(msg);
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(me.forwardingAddress);
      toast('Forwarding address copied');
    } catch {
      toast(me.forwardingAddress);
    }
  };

  return (
    <div className="settings">
      <header className="page-header">
        <h1>Account</h1>
        <p className="muted">{me.email}</p>
      </header>

      <section className={`card plan-card ${me.plan === 'plus' ? 'plus' : ''}`}>
        {me.plan === 'plus' ? (
          <>
            <h2>Trialguard Plus</h2>
            <p>Unlimited connections and trial alerts, price-hike alerts, post-cancel check and savings tracker.</p>
            <button className="btn btn-link" disabled={busy} onClick={() => run(() => api('PATCH', '/me', { plan: 'free' }), 'Switched to Free')}>
              Switch to Free
            </button>
          </>
        ) : (
          <>
            <h2>Go Plus for $3.99/mo</h2>
            <ul className="checks">
              <li>Alerts for every trial (Free covers 3)</li>
              <li>Price-hike warnings, old vs new</li>
              <li>Post-cancel check: we catch sneaky charges</li>
              <li>Savings tracker</li>
              <li>Unlimited banks and inboxes</li>
            </ul>
            <button className="btn btn-primary btn-block" disabled={busy} onClick={() => run(() => api('PATCH', '/me', { plan: 'plus' }), 'Welcome to Plus')}>
              Upgrade ($29.99/yr or $3.99/mo)
            </button>
            <p className="fine">Demo build: upgrading is free. The app store handles billing in the native app.</p>
          </>
        )}
      </section>

      <section>
        <h2 className="section-title">Connections</h2>
        <div className="card list-card">
          {me.connections.map((c) => (
            <div key={c.id} className="row static">
              <span className="connect-icon small" aria-hidden>
                {c.type === 'bank' ? '🏦' : '✉️'}
              </span>
              <div className="row-main">
                <div className="row-title">{c.label}</div>
                <div className={`row-sub ${c.status === 'error' ? 'error' : ''}`}>
                  {c.status === 'error' ? c.error : c.lastSyncedAt ? `Synced ${timeAgo(c.lastSyncedAt)}` : 'Not synced yet'}
                </div>
              </div>
              <button className="btn btn-link btn-small" disabled={busy} onClick={() => run(() => api('DELETE', `/connections/${c.id}`), 'Disconnected')}>
                Remove
              </button>
            </div>
          ))}
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

      <section>
        <h2 className="section-title">Forwarding address</h2>
        <div className="card">
          <p className="muted">Forward any signup or receipt email here and we'll track it. No inbox access needed.</p>
          <button className="copy-box" onClick={copy}>
            <code>{me.forwardingAddress}</code>
            <span>Copy</span>
          </button>
        </div>
      </section>

      <section>
        <h2 className="section-title">Preferences</h2>
        <div className="card form">
          <label className="field">
            <span>Your state (for cancellation rights)</span>
            <select value={me.state ?? ''} onChange={(e) => run(() => api('PATCH', '/me', { state: e.target.value }), 'Saved')}>
              <option value="">Not set</option>
              {STATES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <label className="toggle">
            <input type="checkbox" checked={me.alertPrefs.push} onChange={(e) => run(() => api('PATCH', '/me', { alertPrefs: { ...me.alertPrefs, push: e.target.checked } }))} />
            <span>Push notifications</span>
          </label>
          <label className="toggle">
            <input type="checkbox" checked={me.alertPrefs.email} onChange={(e) => run(() => api('PATCH', '/me', { alertPrefs: { ...me.alertPrefs, email: e.target.checked } }))} />
            <span>Email alerts</span>
          </label>
        </div>
      </section>

      <section>
        <h2 className="section-title">Privacy</h2>
        <div className="card">
          <p className="muted">
            Read-only access everywhere; we never move money. We read only receipt and signup emails, and keep just the extracted fields, never the email itself. We don't sell or share your data.
          </p>
          {confirmDelete ? (
            <div className="actions-row">
              <button className="btn btn-secondary" onClick={() => setConfirmDelete(false)}>
                Keep my account
              </button>
              <button
                className="btn btn-danger"
                disabled={busy}
                onClick={async () => {
                  await api('DELETE', '/me');
                  onSignOut();
                }}
              >
                Delete everything
              </button>
            </div>
          ) : (
            <button className="btn btn-link danger-text" onClick={() => setConfirmDelete(true)}>
              Delete my account and data
            </button>
          )}
        </div>
      </section>

      <button className="btn btn-secondary btn-block" onClick={onSignOut}>
        Sign out
      </button>
    </div>
  );
}
