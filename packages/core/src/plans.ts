import type { Plan } from './types.ts';

export interface Entitlements {
  maxBankConnections: number;
  maxInboxes: number;
  /** Active trials that get conversion alerts. */
  maxTrialAlerts: number;
  priceHikeAlerts: boolean;
  postCancelCheck: boolean;
  savingsTracker: boolean;
}

export const PLAN_PRICES = {
  plus: { monthlyCents: 399, yearlyCents: 2999 },
} as const;

export function entitlements(plan: Plan): Entitlements {
  if (plan === 'plus') {
    return {
      maxBankConnections: Infinity,
      maxInboxes: Infinity,
      maxTrialAlerts: Infinity,
      priceHikeAlerts: true,
      postCancelCheck: true,
      savingsTracker: true,
    };
  }
  return {
    maxBankConnections: 1,
    maxInboxes: 1,
    maxTrialAlerts: 3,
    priceHikeAlerts: false,
    postCancelCheck: false,
    savingsTracker: false,
  };
}

/** Concierge add-on: 30% of first-year savings, capped at $20 per cancel. */
export function conciergeFeeCents(firstYearSavingsCents: number): number {
  return Math.min(2000, Math.round(firstYearSavingsCents * 0.3));
}
