import type { Cadence, Item } from './api.ts';

export function money(cents: number, opts: { whole?: boolean } = {}): string {
  const v = cents / 100;
  return v.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: opts.whole ? 0 : 2,
    maximumFractionDigits: opts.whole ? 0 : 2,
  });
}

export const CADENCE_SHORT: Record<Cadence, string> = { weekly: '/wk', monthly: '/mo', quarterly: '/qtr', annual: '/yr' };
export const CADENCE_LABEL: Record<Cadence, string> = { weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Every 3 months', annual: 'Yearly' };

export function price(item: Pick<Item, 'amountCents' | 'cadence'>): string {
  return item.amountCents ? `${money(item.amountCents)}${CADENCE_SHORT[item.cadence]}` : 'Price unknown';
}

export function shortDate(iso?: string): string {
  if (!iso) return '—';
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function relativeDays(days?: number): string {
  if (days === undefined) return '';
  if (days < 0) return `${-days}d ago`;
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

export function timeAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export const SOURCE_LABEL: Record<string, string> = {
  bank: 'Bank',
  email: 'Email',
  forwarded: 'Forwarded',
  manual: 'Added by you',
  app_store: 'App Store',
  google_play: 'Google Play',
};

export const RAIL_LABEL: Record<Item['rail'], string> = {
  card: '',
  paypal: 'via PayPal',
  app_store: 'via App Store',
  google_play: 'via Google Play',
};

const PALETTE = ['#0f766e', '#7c3aed', '#c2410c', '#2563eb', '#be123c', '#4d7c0f', '#a16207', '#0e7490'];
export function avatarColor(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length] ?? '#0f766e';
}
