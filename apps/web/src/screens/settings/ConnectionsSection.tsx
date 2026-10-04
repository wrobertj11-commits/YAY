import { api } from '../../api.ts';
import { timeAgo } from '../../format.ts';
import type { SectionProps } from './types.ts';

export function ConnectionsSection({ me, nav, busy, run }: SectionProps) {
  return (
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
  );
}
