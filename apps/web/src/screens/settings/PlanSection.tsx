import { useEffect, useState } from 'react';
import { api } from '../../api.ts';
import type { SectionProps } from './types.ts';

/** GET /api/billing/status (see apps/api/src/billing/entitlement.ts). */
interface BillingSubscription {
  id: string;
  platform: 'app_store' | 'google_play';
  productId: string;
  status: 'active' | 'grace_period' | 'billing_retry' | 'expired' | 'revoked' | 'refunded' | 'paused' | 'pending';
  entitled: boolean;
  expiresAt?: string;
  gracePeriodExpiresAt?: string;
  autoRenew?: boolean;
  /** The store's own subscription management page: only the store can cancel or fix payment. */
  manageUrl: string;
}

interface BillingStatus {
  plan: 'free' | 'plus';
  subscriptions: BillingSubscription[];
}

const STORE = {
  app_store: { name: 'The App Store', short: 'App Store' },
  google_play: { name: 'Google Play', short: 'Google Play' },
} as const;

/** Expiry instants come from the store; show them as the user's local date, with the year (plans can be annual). */
function day(iso?: string): string {
  return iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'the end of the period';
}

function describe(s: BillingSubscription): { badge: string; tone: string; text: string } {
  const store = STORE[s.platform].name;
  switch (s.status) {
    case 'active':
      return s.autoRenew === false
        ? { badge: 'Ends soon', tone: 'badge-warn', text: `Auto-renew is off. Plus stays on until ${day(s.expiresAt)}.` }
        : { badge: 'Active', tone: 'badge-ok', text: `Renews on ${day(s.expiresAt)}.` };
    case 'grace_period':
      return { badge: 'In grace period', tone: 'badge-warn', text: `${store} couldn't charge your payment method. Plus stays on until ${day(s.gracePeriodExpiresAt ?? s.expiresAt)} while it retries.` };
    case 'billing_retry':
      return { badge: 'Billing issue', tone: 'badge-danger', text: `${store} couldn't charge your payment method, so Plus is off. Update it to turn Plus back on.` };
    case 'pending':
      return { badge: 'Payment pending', tone: 'badge-info', text: `Plus turns on once ${store} confirms your payment.` };
    case 'paused':
      return { badge: 'Paused', tone: 'badge-info', text: 'Your subscription is paused. Resume it to turn Plus back on.' };
    case 'expired':
      return { badge: 'Expired', tone: '', text: `Plus ended on ${day(s.expiresAt)}.` };
    case 'refunded':
      return { badge: 'Refunded', tone: '', text: 'This purchase was refunded.' };
    case 'revoked':
      return { badge: 'Revoked', tone: '', text: 'This purchase is no longer active.' };
  }
}

/** States a Free user can act on in the store to get Plus back. */
const ACTIONABLE = new Set<BillingSubscription['status']>(['billing_retry', 'pending', 'paused']);

function SubscriptionStatus({ sub }: { sub: BillingSubscription }) {
  const d = describe(sub);
  return (
    <div className="stack-sm">
      <p>
        <span className={`badge ${d.tone}`}>{d.badge}</span>
      </p>
      <p className="fine">{d.text}</p>
      <a className="btn btn-link" href={sub.manageUrl} target="_blank" rel="noreferrer">
        Manage in {STORE[sub.platform].short}
      </a>
    </div>
  );
}

export function PlanSection({ me, busy, run }: SectionProps) {
  const [billing, setBilling] = useState<BillingStatus | null>(null);

  // Re-read when the plan changes (a store notification or the dev switch moved it).
  useEffect(() => {
    let live = true;
    api<BillingStatus>('GET', '/billing/status')
      .then((b) => {
        if (live) setBilling(b);
      })
      .catch(() => {
        if (live) setBilling(null);
      });
    return () => {
      live = false;
    };
  }, [me.plan]);

  // The server lists entitling subscriptions first, then the most recent.
  const sub = billing?.subscriptions[0];
  const showStatus = sub && (me.plan === 'plus' || ACTIONABLE.has(sub.status));

  return (
    <section className={`card plan-card ${me.plan === 'plus' ? 'plus' : ''}`}>
      {me.plan === 'plus' ? (
        <>
          <h2>Trialguard Plus</h2>
          <p>Unlimited connections and trial alerts, price-hike alerts, post-cancel check and savings tracker.</p>
          {showStatus && <SubscriptionStatus sub={sub} />}
          {me.devMode && (
            <button className="btn btn-link" disabled={busy} onClick={() => run(() => api('PATCH', '/me', { plan: 'free' }), 'Switched to Free')}>
              Switch to Free
            </button>
          )}
        </>
      ) : (
        <>
          <h2>Go Plus for $3.99/mo</h2>
          {showStatus && <SubscriptionStatus sub={sub} />}
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
