import type { AppData, Nav } from '../App.tsx';
import type { Item } from '../api.ts';
import { money, price, relativeDays, shortDate } from '../format.ts';
import { Avatar, Empty } from '../ui.tsx';

function TrialCard({ item, onClick }: { item: Item; onClick: () => void }) {
  const d = item.daysUntilCharge ?? 0;
  return (
    <button className={`trial-card ${d <= 2 ? 'urgent' : ''}`} onClick={onClick}>
      <div className="trial-top">
        <Avatar name={item.name} size={32} />
        <span className="trial-days">
          <strong>{Math.max(d, 0)}</strong>
          <small>{d === 1 ? 'day' : 'days'}</small>
        </span>
      </div>
      <div className="trial-name">{item.name}</div>
      <div className="trial-price">then {price(item)}</div>
      {!item.alertsOn && <div className="trial-noalert">No alert on Free</div>}
    </button>
  );
}

export function HomeScreen({ data, nav }: { data: AppData; nav: Nav }) {
  const { items, summary, me } = data;
  const trials = items.filter((i) => i.status === 'trial').sort((a, b) => (a.daysUntilCharge ?? 0) - (b.daysUntilCharge ?? 0));
  const priceUps = items.filter((i) => i.status === 'active' && i.priceChange && i.priceChange.newCents > i.priceChange.oldCents);
  const afterCancel = items.filter((i) => i.status === 'charged_after_cancel');
  const review = items.filter((i) => i.needsReview && (i.status === 'active' || i.status === 'trial'));
  const upcoming = items
    .filter((i) => i.status === 'active' && i.daysUntilCharge !== undefined && i.daysUntilCharge <= 7)
    .sort((a, b) => (a.daysUntilCharge ?? 0) - (b.daysUntilCharge ?? 0));

  if (!items.length) {
    return (
      <Empty icon="🔍" title="Nothing found yet">
        <p className="muted">Connect a bank or inbox, or add a trial by hand.</p>
        <button className="btn btn-primary" onClick={nav.connect}>
          Connect accounts
        </button>
      </Empty>
    );
  }

  return (
    <div className="home">
      <section className="total-card">
        <div className="total-label">You spend</div>
        <div className="total-amount">
          {money(summary.monthlyCents)}
          <span>/month</span>
        </div>
        <div className="total-sub">
          {money(summary.yearlyCents, { whole: true })} a year on {summary.activeCount} subscriptions
          {summary.trialCount > 0 && ` · trials will add ${money(summary.trialsMonthlyCents)}/mo`}
        </div>
        <div className="saved-row">
          {summary.savedSoFarCents !== null ? (
            <>
              <span>Saved so far</span>
              <strong>{money(summary.savedSoFarCents)}</strong>
            </>
          ) : (
            <>
              <span>Track what you save with Plus</span>
              <button className="btn btn-small btn-on-dark" onClick={() => nav.tab('settings')}>
                Upgrade
              </button>
            </>
          )}
        </div>
      </section>

      {afterCancel.map((i) => (
        <button key={i.id} className="alert-banner danger" onClick={() => nav.item(i.id)}>
          <strong>{i.name} charged you after you cancelled.</strong>
          <span>Tap to get your money back →</span>
        </button>
      ))}

      {trials.length > 0 && (
        <section>
          <div className="section-head">
            <h2>Trials ending soon</h2>
            <span className="muted">{trials.length}</span>
          </div>
          <div className="trial-row">
            {trials.map((t) => (
              <TrialCard key={t.id} item={t} onClick={() => nav.item(t.id)} />
            ))}
          </div>
          {me.plan === 'free' && trials.some((t) => !t.alertsOn) && (
            <p className="fine">Free covers alerts for your 3 soonest trials. Plus covers them all.</p>
          )}
        </section>
      )}

      {priceUps.length > 0 && (
        <section>
          <div className="section-head">
            <h2>Price increases</h2>
          </div>
          {priceUps.map((i) => (
            <button key={i.id} className="row card" onClick={() => nav.item(i.id)}>
              <Avatar name={i.name} />
              <div className="row-main">
                <div className="row-title">{i.name}</div>
                <div className="row-sub">
                  <s>{money(i.priceChange!.oldCents)}</s> → <strong className="text-warn">{money(i.priceChange!.newCents)}</strong>
                  {i.priceChange!.effectiveDate && ` from ${shortDate(i.priceChange!.effectiveDate)}`}
                </div>
              </div>
              <div className="row-end text-warn">+{money((i.priceChange!.newCents - i.priceChange!.oldCents) * (i.cadence === 'annual' ? 1 : 12), { whole: true })}/yr</div>
            </button>
          ))}
        </section>
      )}

      {review.length > 0 && (
        <section>
          <div className="section-head">
            <h2>Is this right?</h2>
          </div>
          {review.map((i) => (
            <button key={i.id} className="row card" onClick={() => nav.item(i.id)}>
              <Avatar name={i.name} />
              <div className="row-main">
                <div className="row-title">{i.name}</div>
                <div className="row-sub">We think this is {price(i)}. Tap to confirm.</div>
              </div>
              <div className="row-end">›</div>
            </button>
          ))}
        </section>
      )}

      {upcoming.length > 0 && (
        <section>
          <div className="section-head">
            <h2>Charging this week</h2>
          </div>
          <div className="card list-card">
            {upcoming.map((i) => (
              <button key={i.id} className="row" onClick={() => nav.item(i.id)}>
                <Avatar name={i.name} size={34} />
                <div className="row-main">
                  <div className="row-title">{i.name}</div>
                  <div className="row-sub">
                    {shortDate(i.nextChargeDate)} · {relativeDays(i.daysUntilCharge)}
                  </div>
                </div>
                <div className="row-end">{money(i.amountCents)}</div>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
