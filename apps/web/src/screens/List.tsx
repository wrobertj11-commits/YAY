import { useState } from 'react';
import type { Nav } from '../App.tsx';
import type { Item, Summary } from '../api.ts';
import { money, price, RAIL_LABEL, relativeDays, shortDate } from '../format.ts';
import { Avatar, Empty, StatusBadge } from '../ui.tsx';

type Filter = 'active' | 'trials' | 'cancelled' | 'hidden';

const FILTERS: [Filter, string, (i: Item) => boolean][] = [
  ['active', 'Active', (i) => i.status === 'active'],
  ['trials', 'Trials', (i) => i.status === 'trial'],
  ['cancelled', 'Cancelled', (i) => ['cancel_pending', 'cancel_verified', 'charged_after_cancel'].includes(i.status)],
  ['hidden', 'Hidden', (i) => i.status === 'dismissed'],
];

type Sort = 'next' | 'cost';

export function ListScreen({ items, summary, nav }: { items: Item[]; summary: Summary; nav: Nav }) {
  const [filter, setFilter] = useState<Filter>('active');
  const [sort, setSort] = useState<Sort>('next');
  const match = FILTERS.find((f) => f[0] === filter)![2];
  const shown = items.filter(match).sort((a, b) =>
    sort === 'cost' ? b.yearlyCents - a.yearlyCents : (a.daysUntilCharge ?? 9999) - (b.daysUntilCharge ?? 9999),
  );

  return (
    <div>
      <header className="page-header">
        <h1>Subscriptions</h1>
        <p className="muted">
          {money(summary.monthlyCents)}/mo · {money(summary.yearlyCents, { whole: true })}/yr
        </p>
      </header>

      <div className="segmented" role="tablist">
        {FILTERS.map(([key, label, fn]) => {
          const n = items.filter(fn).length;
          if (key === 'hidden' && !n) return null;
          return (
            <button key={key} role="tab" aria-selected={filter === key} className={filter === key ? 'on' : ''} onClick={() => setFilter(key)}>
              {label} <span className="count">{n}</span>
            </button>
          );
        })}
      </div>

      {filter === 'active' && shown.length > 1 && (
        <div className="sort-row">
          <button className={sort === 'next' ? 'on' : ''} onClick={() => setSort('next')}>
            Next charge
          </button>
          <button className={sort === 'cost' ? 'on' : ''} onClick={() => setSort('cost')}>
            Biggest first
          </button>
        </div>
      )}

      {shown.length === 0 ? (
        <Empty icon={filter === 'cancelled' ? '✂️' : '✨'} title={filter === 'cancelled' ? 'Nothing cancelled yet' : 'Nothing here'}>
          {filter === 'cancelled' && <p className="muted">When you cancel something, we'll watch your next statement to make sure it stays cancelled.</p>}
        </Empty>
      ) : (
        <div className="card list-card">
          {shown.map((i) => (
            <button key={i.id} className="row" onClick={() => nav.item(i.id)}>
              <Avatar name={i.name} />
              <div className="row-main">
                <div className="row-title">
                  {i.name} <StatusBadge item={i} />
                </div>
                <div className="row-sub">
                  {i.status === 'trial'
                    ? `Converts ${shortDate(i.trialEndsAt)} · then ${price(i)}`
                    : i.status === 'active'
                      ? `${shortDate(i.nextChargeDate)} (${relativeDays(i.daysUntilCharge)})${i.paymentMethod ? ` · ${i.paymentMethod}` : ''} ${RAIL_LABEL[i.rail]}`
                      : i.cancelledAt
                        ? `Cancelled ${shortDate(i.cancelledAt)}`
                        : i.category}
                </div>
              </div>
              <div className="row-end">
                <div>{i.amountCents ? money(i.amountCents) : '—'}</div>
                <small className="muted">{i.cadence === 'annual' ? 'yearly' : i.cadence}</small>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
