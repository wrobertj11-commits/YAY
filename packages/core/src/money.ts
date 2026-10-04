import type { Cadence } from './types.ts';

export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

/** Parses "$1,299.99", "12.5", "USD 9" into cents. */
export function parseMoney(text: string): number | undefined {
  const m = text.replace(/,/g, '').match(/(\d+(?:\.\d{1,2})?)/);
  if (!m?.[1]) return undefined;
  return Math.round(parseFloat(m[1]) * 100);
}

export function monthlyEquivalent(amountCents: number, cadence: Cadence): number {
  switch (cadence) {
    case 'weekly':
      return Math.round((amountCents * 52) / 12);
    case 'monthly':
      return amountCents;
    case 'quarterly':
      return Math.round(amountCents / 3);
    case 'annual':
      return Math.round(amountCents / 12);
  }
}

export function yearlyEquivalent(amountCents: number, cadence: Cadence): number {
  return { weekly: amountCents * 52, monthly: amountCents * 12, quarterly: amountCents * 4, annual: amountCents }[
    cadence
  ];
}
