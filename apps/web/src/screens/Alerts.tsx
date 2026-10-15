import { useEffect } from 'react';
import type { AppData, Nav } from '../App.tsx';
import { api, type Alert, type Item } from '../api.ts';
import { timeAgo } from '../format.ts';
import { Empty } from '../ui.tsx';

const ICON: Record<string, string> = {
  trial_converting: '⏰',
  renewal: '🔁',
  price_increase: '📈',
  charge_after_cancel: '⚠️',
  cancel_verified: '✅',
};

export function AlertsScreen({ alerts, items, nav, onRead }: { alerts: AppData['alerts']; items: Item[]; nav: Nav; onRead: () => Promise<unknown> }) {
  const unread = alerts.inbox.some((a) => !a.readAt);
  useEffect(() => {
    if (!unread) return;
    const t = setTimeout(() => {
      api('POST', '/alerts/read').then(onRead).catch(() => {});
    }, 1500);
    return () => clearTimeout(t);
  }, [unread, onRead]);

  const exists = new Set(items.map((i) => i.id));
  const row = (a: Alert, upcoming = false) => (
    <button key={a.id} className={`alert-row ${!a.readAt && !upcoming ? 'unread' : ''}`} onClick={() => exists.has(a.itemId) && nav.item(a.itemId)}>
      <span className="alert-icon" aria-hidden>
        {ICON[a.type] ?? '•'}
      </span>
      <span className="alert-text">
        <strong>{a.title}</strong>
        <span>{a.body}</span>
        <small className="muted">
          {upcoming
            ? `Scheduled ${new Date(a.sendAt).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
            : timeAgo(a.sentAt!)}
        </small>
      </span>
    </button>
  );

  return (
    <div>
      <header className="page-header">
        <h1>Alerts</h1>
        <p className="muted">We warn you 48 and 24 hours before every trial converts or renewal charges.</p>
      </header>
      {alerts.inbox.length === 0 && alerts.upcoming.length === 0 ? (
        <Empty icon="🔔" title="No alerts yet">
          <p className="muted">When a trial is about to convert, you'll hear from us here.</p>
        </Empty>
      ) : (
        <>
          {alerts.inbox.length > 0 && <div className="card list-card">{alerts.inbox.map((a) => row(a))}</div>}
          {alerts.upcoming.length > 0 && (
            <section>
              <h2 className="section-title">Coming up</h2>
              <div className="card list-card">{alerts.upcoming.slice(0, 12).map((a) => row(a, true))}</div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
