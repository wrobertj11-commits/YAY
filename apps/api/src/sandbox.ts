import { addDays, addMonths, type EmailMessage, type ISODate, type Transaction } from '@trialguard/core';

/**
 * Realistic demo data, generated relative to today, so the full flow (found subscriptions,
 * a trial about to convert, a price hike, a lapsed service, noise) works without real accounts.
 */

function monthlySeries(today: ISODate, dayOffset: number, count: number): ISODate[] {
  const last = addDays(today, -dayOffset);
  return Array.from({ length: count }, (_, i) => addMonths(last, -(count - 1 - i)));
}

export function sandboxTransactions(today: ISODate, accountId: string): Transaction[] {
  const out: Transaction[] = [];
  const card = 'Visa ••4242';
  const amex = 'Amex ••1005';
  const add = (date: ISODate, description: string, amountCents: number, paymentMethod = card) =>
    out.push({ id: `sbx_${accountId}_${out.length}`, accountId, date, description, amountCents, paymentMethod });

  // Netflix: price went from $15.49 to $17.99 on the latest charge.
  monthlySeries(today, 18, 6).forEach((d, i) => add(d, 'NETFLIX.COM 866-579-7172 CA', i < 5 ? 1549 : 1799));
  // Spotify through PayPal.
  monthlySeries(today, 9, 6).forEach((d) => add(d, 'PAYPAL *SPOTIFY 4029357733', 1199));
  // Two App Store subscriptions hidden behind Apple's descriptor.
  monthlySeries(today, 4, 5).forEach((d) => add(d, 'APPLE.COM/BILL 866-712-7753 CA', 999));
  monthlySeries(today, 22, 5).forEach((d) => add(d, 'APPLE.COM/BILL 866-712-7753 CA', 299));
  // A gym the catalog doesn't know.
  monthlySeries(today, 2, 6).forEach((d) => add(d, 'CRUNCH FITNESS #1234 BROOKLYN NY', 2499, amex));
  // AI tool on the work card.
  monthlySeries(today, 25, 4).forEach((d) => add(d, 'OPENAI *CHATGPT SUBSCR', 2000, amex));
  // Weekly news subscription.
  for (let i = 0; i < 20; i++) add(addDays(today, -3 - 7 * i), 'NYTIMES*NYTDIGITAL', 400);
  // Annual Amazon Prime charged ~10 months ago.
  add(addDays(today, -300), 'AMAZON PRIME*2K4LM8 AMZN.COM/BILL WA', 13900);
  // Lapsed: Hulu stopped 7 months ago.
  monthlySeries(today, 210, 3).forEach((d) => add(d, 'HULU 877-8244858 CA', 1799));

  // Noise that must not be detected.
  for (let i = 0; i < 26; i++) add(addDays(today, -1 - 6 * i - (i % 3)), 'WHOLEFDS BRK 10234', 4200 + ((i * 1731) % 5000));
  for (let i = 0; i < 30; i++) add(addDays(today, -2 - 5 * i - (i % 4)), 'UBER *TRIP HELP.UBER.COM', 1100 + ((i * 977) % 2600), amex);
  for (let i = 0; i < 40; i++) add(addDays(today, -1 - 4 * i - (i % 2)), 'STARBUCKS STORE 10223', 450 + ((i * 313) % 600));
  add(addDays(today, -12), 'SHELL OIL 57444 BROOKLYN NY', 5230);
  add(addDays(today, -40), 'IKEA BROOKLYN', 21999);
  add(addDays(today, -5), 'NETFLIX.COM REFUND', -1549);

  return out.sort((a, b) => a.date.localeCompare(b.date));
}

function longDate(iso: ISODate): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function sandboxEmails(today: ISODate): EmailMessage[] {
  const at = (daysAgo: number) => `${addDays(today, -daysAgo)}T14:05:00Z`;
  return [
    {
      id: 'sbx-email-headspace',
      from: 'Headspace <hello@headspace.com>',
      subject: 'Your 7-day free trial has started',
      date: at(5),
      body: `Welcome to Headspace! Your free trial ends on ${longDate(addDays(today, 2))}. After your trial, you'll be charged $69.99/year unless you cancel at least 24 hours before.`,
    },
    {
      id: 'sbx-email-max',
      from: 'Max <no-reply@max.com>',
      subject: 'Welcome to Max',
      date: at(1),
      body: 'Thanks for signing up. Enjoy your 7 day free trial. Then $16.99 per month. Cancel anytime.',
    },
    {
      id: 'sbx-email-duolingo',
      from: 'Duolingo <hello@duolingo.com>',
      subject: 'Your Super free trial is active',
      date: at(3),
      body: `You started a 14-day free trial of Super Duolingo. Your first payment of $12.99/month will be charged on ${longDate(addDays(today, 11))}.`,
    },
    {
      id: 'sbx-email-peloton',
      from: 'Peloton <support@onepeloton.com>',
      subject: 'Your Peloton App membership trial',
      date: at(20),
      body: `Your 30-day free trial is underway. Your membership renews at $24.00/month on ${longDate(addDays(today, 16))}.`,
    },
    {
      id: 'sbx-email-netflix-price',
      from: 'Netflix <info@account.netflix.com>',
      subject: 'An update to your Netflix price',
      date: at(40),
      body: `We're updating your price from $15.49 to $17.99/month, starting with your billing date on ${longDate(addDays(today, -18))}.`,
    },
    {
      id: 'sbx-email-hellofresh',
      from: 'HelloFresh <receipts@hellofresh.com>',
      subject: 'Your HelloFresh order receipt',
      date: at(4),
      body: `Thanks for your order! You were charged $79.95 per week. Your next box will be billed on ${longDate(addDays(today, 3))}.`,
    },
    {
      id: 'sbx-email-newsletter',
      from: 'The Gadget Shop <news@gadgetshop.example>',
      subject: 'Fall sale: 20% off headphones',
      date: at(2),
      body: 'Our biggest sale of the season.',
    },
    {
      id: 'sbx-email-personal',
      from: 'Sam <sam@example.com>',
      subject: 'Dinner Sunday?',
      date: at(1),
      body: 'Are you free?',
    },
  ];
}
