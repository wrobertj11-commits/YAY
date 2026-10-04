import { api } from '../../api.ts';
import type { SectionProps } from './types.ts';

export function PlanSection({ me, busy, run }: SectionProps) {
  return (
    <section className={`card plan-card ${me.plan === 'plus' ? 'plus' : ''}`}>
      {me.plan === 'plus' ? (
        <>
          <h2>Trialguard Plus</h2>
          <p>Unlimited connections and trial alerts, price-hike alerts, post-cancel check and savings tracker.</p>
          {me.devMode && (
            <button className="btn btn-link" disabled={busy} onClick={() => run(() => api('PATCH', '/me', { plan: 'free' }), 'Switched to Free')}>
              Switch to Free
            </button>
          )}
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
          {me.devMode ? (
            <>
              <button className="btn btn-primary btn-block" disabled={busy} onClick={() => run(() => api('PATCH', '/me', { plan: 'plus' }), 'Welcome to Plus')}>
                Upgrade ($29.99/yr or $3.99/mo)
              </button>
              <p className="fine">Demo build: upgrading is free. The app store handles billing in the native app.</p>
            </>
          ) : (
            <p className="fine">Upgrade from the Trialguard app on your phone.</p>
          )}
        </>
      )}
    </section>
  );
}
