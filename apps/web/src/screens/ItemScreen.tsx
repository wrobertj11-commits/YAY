import { useCallback, useEffect, useState } from 'react';
import type { Nav } from '../App.tsx';
import { api, type Cadence, type ItemDetail, type Me } from '../api.ts';
import { CADENCE_LABEL, money, price, RAIL_LABEL, relativeDays, shortDate, SOURCE_LABEL } from '../format.ts';
import { Avatar, Spinner, StatusBadge } from '../ui.tsx';

interface Props {
  id: string;
  startInCancel: boolean;
  me: Me;
  nav: Nav;
  onChanged: () => Promise<unknown>;
  toast: (msg: string) => void;
}

export function ItemScreen({ id, startInCancel, me, nav, onChanged, toast }: Props) {
  const [item, setItem] = useState<ItemDetail | null>(null);
  const [cancelMode, setCancelMode] = useState(startInCancel);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api<ItemDetail>('GET', `/items/${id}`).then(setItem), [id]);
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);

  async function act(fn: () => Promise<unknown>, message?: string) {
    setError(null);
    try {
      await fn();
      await Promise.all([load(), onChanged()]);
      if (message) toast(message);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!item) {
    return (
      <div className="center-screen">
        {error ? <p className="error">{error}</p> : <Spinner />}
      </div>
    );
  }

  if (cancelMode) {
    return (
      <CancelFlow
        item={item}
        me={me}
        onBack={() => setCancelMode(false)}
        onDone={async (proof) => {
          await act(() => api('POST', `/items/${id}/cancel`, { action: 'completed', proof }), `Nice. We'll watch your next statement for ${item.name}.`);
          setCancelMode(false);
        }}
        onConcierge={() =>
          act(async () => {
            const r = await api<{ concierge: { feeCents: number } }>('POST', `/items/${id}/cancel`, { action: 'concierge' });
            toast(`Concierge requested. Fee: ${money(r.concierge.feeCents)}.`);
          })
        }
        onStarted={() => api('POST', `/items/${id}/cancel`, { action: 'started' }).catch(() => {})}
        onReportBroken={() => item.merchantId && act(() => api('POST', `/merchants/${item.merchantId}/report-broken`, {}), 'Thanks, we will fix that guide.')}
        error={error}
      />
    );
  }

  const live = item.status === 'active' || item.status === 'trial';
  const pc = item.priceChange;

  return (
    <div className="detail">
      <button className="back" onClick={nav.back}>
        ‹ Back
      </button>

      <header className="detail-header">
        <Avatar name={item.name} size={64} />
        <h1>{item.name}</h1>
        <div className="detail-price">{price(item)}</div>
        <StatusBadge item={item} />
      </header>

      {item.status === 'charged_after_cancel' && (
        <div className="alert-banner danger">
          <strong>Charged after you cancelled on {shortDate(item.cancelledAt)}.</strong>
          <span>
            Contact {item.name} with your cancellation proof and ask for a refund. If they refuse, dispute the charge with your card issuer
            {item.cancelProof ? ` (proof: ${item.cancelProof})` : ''}.
          </span>
        </div>
      )}
      {item.status === 'cancel_pending' && (
        <div className="alert-banner info">
          <strong>Cancelled {shortDate(item.cancelledAt)}. Verifying.</strong>
          <span>
            It's done once {item.nextChargeDate ? shortDate(item.nextChargeDate) : 'the next billing date'} passes with no charge. We'll let you know.
          </span>
        </div>
      )}
      {item.status === 'cancel_verified' && (
        <div className="alert-banner ok">
          <strong>Cancellation verified {shortDate(item.cancelVerifiedAt)}.</strong>
          <span>No charge appeared when it would have renewed. You're saving {money(item.yearlyCents, { whole: true })} a year.</span>
        </div>
      )}
      {item.needsReview && live && (
        <div className="alert-banner warn">
          <strong>Is this right?</strong>
          <span>We're not fully sure about this one.</span>
          <div className="banner-actions">
            <button className="btn btn-small btn-primary" onClick={() => act(() => api('PATCH', `/items/${id}`, { confirm: true }), 'Thanks for confirming.')}>
              Yes, it's a subscription
            </button>
            <button className="btn btn-small btn-secondary" onClick={() => act(() => api('PATCH', `/items/${id}`, { dismiss: true }), 'Hidden.')}>
              No
            </button>
            <button className="btn btn-small btn-link" onClick={() => setEditing(true)}>
              Edit
            </button>
          </div>
        </div>
      )}

      <div className="card facts">
        {item.status === 'trial' ? (
          <Fact label="Trial converts" value={`${shortDate(item.trialEndsAt)} (${relativeDays(item.daysUntilCharge)})`} strong />
        ) : live ? (
          <Fact label="Next charge" value={`${shortDate(item.nextChargeDate)} (${relativeDays(item.daysUntilCharge)})`} strong />
        ) : null}
        <Fact label="Costs" value={`${money(item.yearlyCents)} a year`} />
        <Fact label="Billing" value={CADENCE_LABEL[item.cadence]} />
        {item.paymentMethod && <Fact label="Paid with" value={`${item.paymentMethod} ${RAIL_LABEL[item.rail]}`} />}
        {!item.paymentMethod && item.rail !== 'card' && <Fact label="Paid" value={RAIL_LABEL[item.rail]} />}
        <Fact label="Found in" value={item.sources.map((s) => SOURCE_LABEL[s] ?? s).join(' + ')} />
        {live && <Fact label="Alerts" value={item.alertsOn ? '48h and 24h before' : 'Off (Free covers 3 trials)'} />}
      </div>

      {pc && pc.newCents > pc.oldCents && live && (
        <div className="card price-change">
          <div className="muted">Price increase{pc.effectiveDate ? ` from ${shortDate(pc.effectiveDate)}` : ''}</div>
          <div className="price-compare">
            <span className="old">{money(pc.oldCents)}</span>
            <span aria-hidden>→</span>
            <span className="new">{money(pc.newCents)}</span>
          </div>
          <div className="muted">+{money((pc.newCents - pc.oldCents) * (item.cadence === 'annual' ? 1 : 12))} a year</div>
        </div>
      )}

      {live && (
        <div className="actions">
          <button className="btn btn-danger btn-block btn-lg" onClick={() => setCancelMode(true)}>
            Cancel {item.status === 'trial' ? 'trial' : 'subscription'}
          </button>
          {!item.needsReview && (
            <div className="actions-row">
              <button className="btn btn-secondary" onClick={() => setEditing(true)}>
                Edit details
              </button>
              <button className="btn btn-secondary" onClick={() => act(() => api('PATCH', `/items/${id}`, { dismiss: true }), 'Hidden from your list.')}>
                Not a subscription
              </button>
            </div>
          )}
        </div>
      )}
      {item.status === 'cancel_pending' && (
        <button className="btn btn-link btn-block" onClick={() => act(() => api('POST', `/items/${id}/cancel`, { action: 'undo' }), 'Marked active again.')}>
          I didn't actually cancel
        </button>
      )}
      {item.status === 'charged_after_cancel' && (
        <button className="btn btn-secondary btn-block" onClick={() => setCancelMode(true)}>
          Open cancel guide again
        </button>
      )}
      {item.status === 'dismissed' && (
        <button className="btn btn-secondary btn-block" onClick={() => act(() => api('PATCH', `/items/${id}`, { restore: true }), 'Restored.')}>
          Show in my list again
        </button>
      )}

      {editing && <EditForm item={item} onCancel={() => setEditing(false)} onSave={(patch) => act(() => api('PATCH', `/items/${id}`, patch), 'Saved.').then(() => setEditing(false))} />}

      {item.transactions.length > 0 && (
        <section>
          <h2 className="section-title">Charge history</h2>
          <div className="card list-card">
            {item.transactions.map((t) => (
              <div key={t.id} className={`row static ${item.postCancelChargeIds?.includes(t.id) ? 'flagged' : ''}`}>
                <div className="row-main">
                  <div className="row-title">{shortDate(t.date)}</div>
                  <div className="row-sub mono">{t.description}</div>
                </div>
                <div className="row-end">{money(t.amountCents)}</div>
              </div>
            ))}
          </div>
        </section>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function Fact({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="fact">
      <span className="muted">{label}</span>
      {strong ? <strong>{value}</strong> : <span>{value}</span>}
    </div>
  );
}

function EditForm({ item, onSave, onCancel }: { item: ItemDetail; onSave: (p: Record<string, unknown>) => void; onCancel: () => void }) {
  const [name, setName] = useState(item.name);
  const [amount, setAmount] = useState((item.amountCents / 100).toFixed(2));
  const [cadence, setCadence] = useState<Cadence>(item.cadence);
  const [date, setDate] = useState((item.status === 'trial' ? item.trialEndsAt : item.nextChargeDate) ?? '');
  return (
    <form
      className="card form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ name, amountCents: Math.round(parseFloat(amount || '0') * 100), cadence, nextChargeDate: date || undefined });
      }}
    >
      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="field-row">
        <label className="field">
          <span>Price ($)</span>
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="field">
          <span>Billing</span>
          <select value={cadence} onChange={(e) => setCadence(e.target.value as Cadence)}>
            {Object.entries(CADENCE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span>{item.status === 'trial' ? 'Trial ends' : 'Next charge'}</span>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <div className="actions-row">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-primary">Save</button>
      </div>
    </form>
  );
}

interface CancelFlowProps {
  item: ItemDetail;
  me: Me;
  onBack: () => void;
  onDone: (proof?: string) => void;
  onConcierge: () => void;
  onStarted: () => void;
  onReportBroken: () => void;
  error: string | null;
}

function CancelFlow({ item, me, onBack, onDone, onConcierge, onStarted, onReportBroken, error }: CancelFlowProps) {
  const plan = item.cancelPlan;
  const [checked, setChecked] = useState<boolean[]>(() => plan.steps.map(() => false));
  const [proof, setProof] = useState('');
  const allDone = checked.every(Boolean);

  return (
    <div className="detail cancel-flow">
      <button className="back" onClick={onBack}>
        ‹ {item.name}
      </button>
      <header className="page-header">
        <h1>Cancel {item.name}</h1>
        <p className="muted">
          {item.status === 'trial'
            ? `Cancel before ${shortDate(item.trialEndsAt)} and you won't be charged ${price(item)}.`
            : `Stops ${money(item.yearlyCents, { whole: true })} a year.`}{' '}
          Difficulty: <span className={`difficulty d-${plan.difficulty}`}>{plan.difficulty}</span>
        </p>
      </header>

      {plan.url && (
        <a className="btn btn-primary btn-block btn-lg" href={plan.url} target="_blank" rel="noreferrer" onClick={onStarted}>
          {plan.method === 'app_store' ? 'Open App Store subscriptions' : plan.method === 'google_play' ? 'Open Google Play subscriptions' : plan.method === 'paypal' ? 'Open PayPal automatic payments' : `Open ${item.name} cancel page`} ↗
        </a>
      )}

      <ol className="steps card">
        {plan.steps.map((s, i) => (
          <li key={i} className={checked[i] ? 'done' : ''}>
            <label>
              <input type="checkbox" checked={checked[i]} onChange={() => setChecked(checked.map((c, j) => (j === i ? !c : c)))} />
              <span>{s}</span>
            </label>
          </li>
        ))}
      </ol>
      {plan.phone && (
        <a className="btn btn-secondary btn-block" href={`tel:${plan.phone}`}>
          Call {plan.phone}
        </a>
      )}

      <div className="card tips">
        {plan.tips.map((t, i) => (
          <p key={i}>💡 {t}</p>
        ))}
      </div>

      <details className="card rights" open={plan.difficulty === 'hard'}>
        <summary>Your cancellation rights{me.state ? ` in ${me.state}` : ''}</summary>
        {plan.rights.map((r) => (
          <div key={r.law} className="right">
            <strong>{r.law}</strong>
            <p>{r.summary}</p>
          </div>
        ))}
        {!me.state && <p className="fine">Set your state in Account to see state-specific rights.</p>}
        <p className="fine">General information, not legal advice.</p>
      </details>

      <div className="card finish">
        <label className="field">
          <span>Confirmation number or note (optional, used as proof)</span>
          <input value={proof} onChange={(e) => setProof(e.target.value)} placeholder="e.g. CXL-48213" />
        </label>
        <button className="btn btn-primary btn-block btn-lg" onClick={() => onDone(proof || undefined)}>
          {allDone ? "Done. I've cancelled it" : "I've cancelled it"}
        </button>
        <p className="fine">We'll mark it verified once your next statement shows no charge.</p>
      </div>

      {plan.conciergeAvailable && (
        <div className="card concierge">
          <strong>Rather we do it?</strong>
          <p className="muted">Our team cancels for you and requests any refund. Fee: 30% of your first-year savings, capped at $20.</p>
          <button className="btn btn-secondary btn-block" onClick={onConcierge}>
            Cancel it for me
          </button>
        </div>
      )}

      {item.merchantId && (
        <button className="btn btn-link btn-block" onClick={onReportBroken}>
          These steps didn't work
        </button>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
