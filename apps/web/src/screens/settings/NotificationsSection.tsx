import { api } from '../../api.ts';
import type { SectionProps } from './types.ts';

export function NotificationsSection({ me, run }: SectionProps) {
  return (
    <section>
      <h2 className="section-title">Notifications</h2>
      <div className="card form">
        <label className="toggle">
          <input type="checkbox" checked={me.alertPrefs.push} onChange={(e) => run(() => api('PATCH', '/me', { alertPrefs: { push: e.target.checked } }))} />
          <span>Push notifications</span>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={me.alertPrefs.email} onChange={(e) => run(() => api('PATCH', '/me', { alertPrefs: { email: e.target.checked } }))} />
          <span>Email alerts</span>
        </label>
      </div>
    </section>
  );
}
