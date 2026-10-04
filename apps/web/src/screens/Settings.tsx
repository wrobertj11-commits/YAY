import { useState } from 'react';
import type { Nav } from '../App.tsx';
import { api, type Me } from '../api.ts';
import { ConnectionsSection } from './settings/ConnectionsSection.tsx';
import { NotificationsSection } from './settings/NotificationsSection.tsx';
import { PlanSection } from './settings/PlanSection.tsx';
import { PrivacySection } from './settings/PrivacySection.tsx';
import type { SectionProps } from './settings/types.ts';

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

  const section: SectionProps = { me, nav, busy, run, toast, onSignOut };

  return (
    <div className="settings">
      <header className="page-header">
        <h1>Account</h1>
        <p className="muted">{me.email}</p>
      </header>

      <PlanSection {...section} />
      <ConnectionsSection {...section} />

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
        <h2 className="section-title">Your state</h2>
        <div className="card form">
          <label className="field">
            <span>Used to show your cancellation rights</span>
            <select value={me.state ?? ''} onChange={(e) => run(() => api('PATCH', '/me', { state: e.target.value }), 'Saved')}>
              <option value="">Not set</option>
              {STATES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <NotificationsSection {...section} />
      <PrivacySection {...section} />

      <button className="btn btn-secondary btn-block" onClick={onSignOut}>
        Sign out
      </button>
    </div>
  );
}
