import { advanceByCadence } from './dates.ts';
import { monthlyEquivalent, yearlyEquivalent } from './money.ts';
import type { ISODate, TrackedItem } from './types.ts';

export interface SpendSummary {
  monthlyCents: number;
  yearlyCents: number;
  activeCount: number;
  trialCount: number;
  /** What active trials will add per month if none are cancelled. */
  trialsMonthlyCents: number;
  /** Savings already realized: months elapsed since each cancellation times its monthly price. */
  savedSoFarCents: number;
  /** Savings still to come over the 12 months after each cancellation. */
  projectedYearlySavingsCents: number;
  /** Only cancellations proven by a statement with no charge. */
  verifiedSavedCents: number;
  cancelledCount: number;
}

/** F7: totals and "saved so far". A cancelled item saves from the charge it would have made. */
export function summarize(items: TrackedItem[], today: ISODate): SpendSummary {
  const s: SpendSummary = {
    monthlyCents: 0,
    yearlyCents: 0,
    activeCount: 0,
    trialCount: 0,
    trialsMonthlyCents: 0,
    savedSoFarCents: 0,
    projectedYearlySavingsCents: 0,
    verifiedSavedCents: 0,
    cancelledCount: 0,
  };

  for (const item of items) {
    const monthly = monthlyEquivalent(item.amountCents, item.cadence);
    if (item.status === 'active') {
      s.activeCount++;
      s.monthlyCents += monthly;
      s.yearlyCents += yearlyEquivalent(item.amountCents, item.cadence);
    } else if (item.status === 'trial') {
      s.trialCount++;
      s.trialsMonthlyCents += monthly;
    } else if ((item.status === 'cancel_pending' || item.status === 'cancel_verified') && item.cancelledAt) {
      s.cancelledCount++;
      const savingStarts = item.nextChargeDate && item.nextChargeDate > item.cancelledAt ? item.nextChargeDate : item.cancelledAt;
      // A period counts as saved once the charge date it would have billed on has passed.
      let skipped = 0;
      const cap = yearlyEquivalent(1, item.cadence);
      for (let d = savingStarts; d <= today && skipped < cap; d = advanceByCadence(d, item.cadence)) skipped++;
      const saved = skipped * item.amountCents;
      s.savedSoFarCents += saved;
      s.projectedYearlySavingsCents += yearlyEquivalent(item.amountCents, item.cadence);
      if (item.status === 'cancel_verified') s.verifiedSavedCents += saved;
    }
  }
  return s;
}
