import type { EmailCaseInput } from '../types.ts';
import { mail } from './build.ts';

/**
 * Labeled emails for trial / receipt / price-change / cancellation extraction. Synthetic: senders are
 * real brands' domains (attribution is part of what's measured) or `.example` domains, and the copy is
 * written for this eval. Nobody's name, address or real card number appears.
 *
 * Labeling conventions (see README):
 *  - `gold` is what a careful human reads from the email, not what the rules currently produce.
 *  - A field left out is not scored; `null` means it must be absent (e.g. a price in euros or pounds,
 *    which Trialguard can't store as USD cents).
 *  - Trial lengths in months count 30 days per month; dates use the calendar.
 *  - `priceCents` is what will be charged each period (after the trial; the total including tax when the
 *    email shows one), because that is the amount the bank charge will show.
 *  - `chargeDate` is the trial's first charge, or the next renewal a receipt states.
 */
export const EMAIL_CASES: EmailCaseInput[] = [
  // ======================= trial signups =======================
  {
    id: 'trial-spotify-iso',
    note: 'ISO date, $/month, length in digits.',
    tags: ['trial', 'catalog', 'iso-date'],
    email: mail('e-trial-spotify-iso', 'Spotify <no-reply@spotify.com>', 'Your Spotify Premium trial has started', '2026-09-14T09:12:00Z', [
      'Hi there,',
      '',
      'Your 1-month free trial of Spotify Premium starts today. Your free trial ends on 2026-10-14.',
      "After that you'll be charged $11.99/month unless you cancel.",
    ]),
    gold: { kind: 'trial_signup', merchantId: 'spotify', priceCents: 1199, cadence: 'monthly', trialDays: 30, chargeDate: '2026-10-14' },
  },
  {
    id: 'trial-max-words',
    note: 'Long-form date, "per month".',
    tags: ['trial', 'catalog'],
    email: mail('e-trial-max-words', 'Max <hello@mail.max.com>', 'Your 7-day free trial has started', '2026-09-20T18:40:00Z', [
      'Welcome to Max! Your 7-day free trial starts today.',
      "We'll charge $16.99 per month starting September 27, 2026. Cancel anytime before then and you won't be charged.",
    ]),
    gold: { kind: 'trial_signup', merchantId: 'max', priceCents: 1699, cadence: 'monthly', trialDays: 7, chargeDate: '2026-09-27' },
  },
  {
    id: 'trial-us-slash',
    note: 'US MM/DD/YYYY date, "/mo".',
    tags: ['trial', 'catalog', 'slash-date'],
    email: mail('e-trial-us-slash', 'Disney+ <disneyplus@mail.disneyplus.com>', 'Your free trial details', '2026-09-10T08:00:00Z', [
      'Thanks for starting your free trial.',
      'Your trial ends 09/17/2026 and your membership will automatically continue at $13.99/mo.',
    ]),
    gold: { kind: 'trial_signup', merchantId: 'disney-plus', priceCents: 1399, cadence: 'monthly', chargeDate: '2026-09-17' },
  },
  {
    id: 'trial-uk-date-dmy',
    note: 'DD/MM/YYYY from a UK-style sender: 10/09/2026 is 10 September (7 days after the email), not 9 October.',
    tags: ['trial', 'catalog', 'slash-date', 'international'],
    email: mail('e-trial-uk-date', 'Calm <hello@calm.com>', 'Your Calm free trial', '2026-09-03T07:30:00Z', [
      'Your 7-day free trial ends on 10/09/2026.',
      "From then, you'll pay $69.99 per year.",
    ]),
    gold: { kind: 'trial_signup', merchantId: 'calm', priceCents: 6999, cadence: 'annual', trialDays: 7, chargeDate: '2026-09-10' },
  },
  {
    id: 'trial-dmy-unambiguous',
    note: 'DD/MM date that cannot be read as MM/DD.',
    tags: ['trial', 'catalog', 'slash-date', 'international'],
    email: mail('e-trial-dmy-unambiguous', 'Headspace <hello@headspace.com>', 'Your trial is live', '2026-09-16T12:00:00Z', [
      'Your 14 day free trial ends on 30/09/2026. Then it’s $12.99/month.',
    ]),
    gold: { kind: 'trial_signup', merchantId: 'headspace', priceCents: 1299, cadence: 'monthly', trialDays: 14, chargeDate: '2026-09-30' },
  },
  {
    id: 'trial-audible-month-words',
    note: 'Trial length in words ("one month"), "a month".',
    tags: ['trial', 'catalog', 'words'],
    email: mail('e-trial-audible', 'Audible <no-reply@audible.com>', 'Welcome to Audible', '2026-09-05T15:20:00Z', [
      'Your one month free trial has begun.',
      'Your membership will renew at $14.95 a month on October 5, 2026.',
    ]),
    gold: { kind: 'trial_signup', merchantId: 'audible', priceCents: 1495, cadence: 'monthly', trialDays: 30, chargeDate: '2026-10-05' },
  },
  {
    id: 'trial-14day-noprice',
    note: 'No price and no date: the conversion date is implied by the length.',
    tags: ['trial', 'catalog', 'no-price', 'no-date'],
    email: mail('e-trial-notion', 'Notion <team@makenotion.com>', 'Your Notion Plus trial', '2026-09-11T10:00:00Z', [
      "You've started a 14-day free trial of Notion Plus. We'll remind you before it ends.",
    ]),
    gold: { kind: 'trial_signup', merchantId: 'notion', priceCents: null, trialDays: 14, chargeDate: '2026-09-25' },
  },
  {
    id: 'trial-thirty-days-free',
    note: '"thirty days free", no explicit date.',
    tags: ['trial', 'catalog', 'words', 'no-date'],
    email: mail('e-trial-peacock', 'Peacock <noreply@peacocktv.com>', 'Welcome to Peacock Premium', '2026-09-01T19:00:00Z', [
      'Enjoy thirty days free on us. After your trial, Peacock Premium is $10.99/month.',
    ]),
    gold: { kind: 'trial_signup', merchantId: 'peacock', priceCents: 1099, cadence: 'monthly', trialDays: 30, chargeDate: '2026-10-01' },
  },
  {
    id: 'trial-two-weeks',
    note: '"free for two weeks", no explicit date.',
    tags: ['trial', 'catalog', 'words', 'no-date'],
    email: mail('e-trial-duolingo', 'Duolingo <hello@duolingo.com>', 'Your Super trial has started', '2026-09-18T07:45:00Z', [
      'Super is free for two weeks. Then $12.99/month.',
    ]),
    gold: { kind: 'trial_signup', merchantId: 'duolingo', priceCents: 1299, cadence: 'monthly', trialDays: 14, chargeDate: '2026-10-02' },
  },
  {
    id: 'trial-twenty-one-days',
    note: 'Compound number word ("twenty-one").',
    tags: ['trial', 'catalog', 'words', 'no-date'],
    email: mail('e-trial-grammarly', 'Grammarly <info@grammarly.com>', 'Your Grammarly Pro trial', '2026-09-08T16:30:00Z', [
      "Your twenty-one day free trial is active. After it ends you'll be billed $30.00 per month.",
    ]),
    gold: { kind: 'trial_signup', merchantId: 'grammarly', priceCents: 3000, cadence: 'monthly', trialDays: 21, chargeDate: '2026-09-29' },
  },
  {
    id: 'trial-three-month',
    note: 'Three-month trial with an explicit renewal date.',
    tags: ['trial', 'catalog'],
    email: mail('e-trial-paramount', 'Paramount+ <paramountplus@mail.paramountplus.com>', 'Your 3-month trial starts now', '2026-09-02T11:00:00Z', [
      'Your 3-month free trial of Paramount+ has started.',
      'Your plan renews at $7.99/month on December 2, 2026.',
    ]),
    gold: { kind: 'trial_signup', merchantId: 'paramount-plus', priceCents: 799, cadence: 'monthly', trialDays: 90, chargeDate: '2026-12-02' },
  },
  {
    id: 'trial-annual-billed',
    note: 'Cadence word before the price ("billed annually at $120.00").',
    tags: ['trial', 'catalog', 'annual'],
    email: mail('e-trial-masterclass', 'MasterClass <billing@masterclass.com>', 'Your free trial has started', '2026-09-12T13:10:00Z', [
      "Your 7-day free trial has started. After your trial, you'll be billed annually at $120.00 on Sep 19, 2026.",
    ]),
    gold: { kind: 'trial_signup', merchantId: 'masterclass', priceCents: 12000, cadence: 'annual', trialDays: 7, chargeDate: '2026-09-19' },
  },
  {
    id: 'trial-usd-suffix',
    note: '"14.99 USD per month" and a relative length ("ends in 30 days").',
    tags: ['trial', 'catalog', 'currency-format', 'no-date'],
    email: mail('e-trial-canva', 'Canva <noreply@canva.com>', 'Your Canva Pro free trial', '2026-09-21T09:00:00Z', [
      'Your free trial ends in 30 days. After that, Canva Pro costs 14.99 USD per month.',
    ]),
    gold: { kind: 'trial_signup', merchantId: 'canva', priceCents: 1499, cadence: 'monthly', trialDays: 30, chargeDate: '2026-10-21' },
  },
  {
    id: 'trial-usd-prefix',
    note: '"USD 11.99 monthly" (currency code before the amount).',
    tags: ['trial', 'catalog', 'currency-format'],
    email: mail('e-trial-dropbox', 'Dropbox <no-reply@dropbox.com>', 'Your Dropbox Plus trial', '2026-09-09T17:25:00Z', [
      'Your 30-day free trial ends Oct 9, 2026. Then USD 11.99 monthly.',
    ]),
    gold: { kind: 'trial_signup', merchantId: 'dropbox', priceCents: 1199, cadence: 'monthly', trialDays: 30, chargeDate: '2026-10-09' },
  },
  {
    id: 'trial-tax-mo',
    note: '"$13.99 + tax/mo".',
    tags: ['trial', 'catalog'],
    email: mail('e-trial-youtube', 'YouTube <noreply@youtube.com>', 'Your YouTube Premium free trial', '2026-09-07T20:00:00Z', [
      'Your 1 month free trial has started. Then $13.99 + tax/mo starting Oct 7, 2026.',
    ]),
    gold: { kind: 'trial_signup', merchantId: 'youtube-premium', priceCents: 1399, cadence: 'monthly', trialDays: 30, chargeDate: '2026-10-07' },
  },
  {
    id: 'trial-html',
    note: 'HTML body; merchant outside the catalog, named only in the subject.',
    tags: ['trial', 'unknown-merchant', 'html'],
    email: mail(
      'e-trial-html',
      'Brightline Yoga <hello@brightlineyoga.example>',
      'Welcome to Brightline Yoga!',
      '2026-09-15T08:00:00Z',
      '<html><body><table><tr><td><h1>Welcome to Brightline Yoga!</h1><p>Your <b>10-day free trial</b> starts today.</p><p>Your trial ends on <span class="date">Sep 25, 2026</span>.</p><p>Then <strong>$29.00</strong>/month.</p></td></tr></table></body></html>',
    ),
    gold: { kind: 'trial_signup', merchantId: null, serviceName: 'Brightline Yoga', priceCents: 2900, cadence: 'monthly', trialDays: 10, chargeDate: '2026-09-25' },
  },
  {
    id: 'trial-html-entities',
    note: 'HTML entities: &nbsp; inside the length and &#36; for the dollar sign.',
    tags: ['trial', 'catalog', 'html'],
    email: mail(
      'e-trial-entities',
      'Midjourney <billing@midjourney.com>',
      'Your trial',
      '2026-09-19T14:00:00Z',
      '<p>Your 7&nbsp;day free trial has started.</p><p>After the trial: &#36;10.00&nbsp;/&nbsp;month, first charge on September 26, 2026.</p>',
    ),
    gold: { kind: 'trial_signup', merchantId: 'midjourney', priceCents: 1000, cadence: 'monthly', trialDays: 7, chargeDate: '2026-09-26' },
  },
  {
    id: 'trial-no-date-words',
    note: '"seven-day trial", no date, no "free".',
    tags: ['trial', 'catalog', 'words', 'no-date'],
    email: mail('e-trial-noom', 'Noom <hello@noom.com>', 'Your trial has begun', '2026-09-13T06:30:00Z', [
      'Your seven-day trial has begun. When it ends, your plan continues at $70.00 per month.',
    ]),
    gold: { kind: 'trial_signup', merchantId: 'noom', priceCents: 7000, cadence: 'monthly', trialDays: 7, chargeDate: '2026-09-20' },
  },
  {
    id: 'trial-ordinal-of',
    note: '"the 3rd of October" with no year, "a free month".',
    tags: ['trial', 'catalog', 'words'],
    email: mail('e-trial-linkedin', 'LinkedIn <billing@linkedin.com>', 'Your Premium free trial', '2026-09-03T12:00:00Z', [
      "Your free month of Premium Career has started. Your trial ends on the 3rd of October and you'll then be charged $39.99 monthly.",
    ]),
    gold: { kind: 'trial_signup', merchantId: 'linkedin-premium', priceCents: 3999, cadence: 'monthly', trialDays: 30, chargeDate: '2026-10-03' },
  },
  {
    id: 'trial-weekday-dmy-words',
    note: '"Friday, 23 October 2026"; billed every 4 weeks (no cadence enum, so cadence unscored).',
    tags: ['trial', 'catalog', 'four-weekly'],
    email: mail('e-trial-wsj', 'The Wall Street Journal <wsj@dowjones.com>', 'Your trial subscription', '2026-09-25T10:00:00Z', [
      'Thanks for starting your 4-week trial. Your trial ends Friday, 23 October 2026; from then your subscription renews at $38.99 every 4 weeks.',
    ]),
    gold: { kind: 'trial_signup', merchantId: 'wsj', priceCents: 3899, trialDays: 28, chargeDate: '2026-10-23' },
  },
  {
    id: 'trial-reminder-tomorrow',
    note: 'Reminder that the trial ends "tomorrow" (relative date).',
    tags: ['trial', 'catalog', 'relative-date'],
    email: mail('e-trial-reminder', 'Spotify <no-reply@spotify.com>', 'Your free trial ends tomorrow', '2026-10-13T09:00:00Z', [
      "Heads up: your Spotify Premium free trial ends tomorrow. You'll be charged $11.99 for your first month.",
    ]),
    gold: { kind: 'trial_signup', merchantId: 'spotify', priceCents: 1199, cadence: 'monthly', chargeDate: '2026-10-14' },
  },
  {
    id: 'trial-zero-today',
    note: '"Due today: $0.00" before the real price; sender domain is not the catalog one.',
    tags: ['trial', 'catalog', 'sender-domain'],
    email: mail('e-trial-hulu-zero', 'Hulu <hulu@hulumail.com>', 'Your Hulu trial has started', '2026-09-17T21:00:00Z', [
      'Due today: $0.00',
      'Starting Oct 17, 2026: $18.99/month',
    ]),
    gold: { kind: 'trial_signup', merchantId: 'hulu', priceCents: 1899, cadence: 'monthly', chargeDate: '2026-10-17' },
  },
  {
    id: 'trial-german-eur',
    note: 'German-language email, DD.MM.YYYY date, price in euros.',
    tags: ['trial', 'catalog', 'international', 'foreign-currency'],
    email: mail('e-trial-german', 'Spotify <no-reply@spotify.com>', 'Deine kostenlose Testphase hat begonnen', '2026-09-14T08:00:00Z', [
      'Dein kostenloser Probemonat für Spotify Premium hat begonnen. Ab dem 14.10.2026 zahlst du 10,99 € pro Monat.',
    ]),
    gold: { kind: 'trial_signup', merchantId: 'spotify', priceCents: null, cadence: 'monthly', trialDays: 30, chargeDate: '2026-10-14' },
  },
  {
    id: 'trial-eur-english',
    note: 'English email with a euro price.',
    tags: ['trial', 'catalog', 'foreign-currency'],
    email: mail('e-trial-peloton', 'Peloton <no-reply@onepeloton.com>', 'Your App+ free trial', '2026-09-06T18:00:00Z', [
      'Your 30-day free trial of Peloton App+ has started. After 6 October 2026 you will be charged €24.00 per month.',
    ]),
    gold: { kind: 'trial_signup', merchantId: 'peloton', priceCents: null, cadence: 'monthly', trialDays: 30, chargeDate: '2026-10-06' },
  },
  {
    id: 'trial-cad-dollar',
    note: 'Canadian dollars written "CA$": must not be read as USD.',
    tags: ['trial', 'catalog', 'foreign-currency'],
    email: mail('e-trial-nintendo', 'Nintendo <no-reply@accounts.nintendo.com>', 'Nintendo Switch Online free trial', '2026-09-04T16:00:00Z', [
      'Your 7-day free trial of Nintendo Switch Online ends on September 11, 2026.',
      'Your membership will then renew automatically at CA$4.99 per month.',
    ]),
    gold: { kind: 'trial_signup', merchantId: 'nintendo', priceCents: null, cadence: 'monthly', trialDays: 7, chargeDate: '2026-09-11' },
  },
  {
    id: 'trial-aud',
    note: 'Australian dollars written "A$", weekly price.',
    tags: ['trial', 'catalog', 'foreign-currency', 'weekly'],
    email: mail('e-trial-bumble', 'Bumble <billing@bumble.com>', 'Your Bumble Premium trial', '2026-09-22T22:15:00Z', [
      'Your 7 day free trial has started. Then A$29.99/week.',
    ]),
    gold: { kind: 'trial_signup', merchantId: 'bumble', priceCents: null, cadence: 'weekly', trialDays: 7, chargeDate: '2026-09-29' },
  },
  {
    id: 'trial-gbp',
    note: 'Pound price; Apple sender shared by several catalog merchants.',
    tags: ['trial', 'catalog', 'foreign-currency'],
    email: mail('e-trial-appletv', 'Apple <no_reply@email.apple.com>', 'Your Apple TV+ free trial', '2026-09-01T10:00:00Z', [
      'Your 7-day free trial of Apple TV+ ends on 8 September 2026. After that, the subscription renews at £8.99/month.',
    ]),
    gold: { kind: 'trial_signup', merchantId: 'apple-tv', priceCents: null, cadence: 'monthly', trialDays: 7, chargeDate: '2026-09-08' },
  },
  {
    id: 'trial-kindle-amazon-domain',
    note: 'Kindle Unlimited trial sent from amazon.com, a domain shared with Amazon Prime.',
    tags: ['trial', 'catalog', 'sender-domain'],
    email: mail('e-trial-kindle', 'Amazon.com <digital-no-reply@amazon.com>', 'Your Kindle Unlimited free trial', '2026-09-10T13:00:00Z', [
      'Your 30-day free trial of Kindle Unlimited has started. On October 10, 2026, your membership will auto-renew at $11.99/month.',
    ]),
    gold: { kind: 'trial_signup', merchantId: 'kindle-unlimited', priceCents: 1199, cadence: 'monthly', trialDays: 30, chargeDate: '2026-10-10' },
  },
  {
    id: 'trial-unknown-display-name',
    note: 'Merchant outside the catalog, named only by the display name.',
    tags: ['trial', 'unknown-merchant', 'no-date'],
    email: mail('e-trial-lumen', 'Lumen Meditation <support@lumen-meditation.example>', 'Your free trial is ready', '2026-09-12T07:00:00Z', [
      "Hi! Your 7-day free trial starts now. After it ends, you'll be billed $8.99 monthly.",
    ]),
    gold: { kind: 'trial_signup', merchantId: null, serviceName: 'Lumen Meditation', priceCents: 899, cadence: 'monthly', trialDays: 7, chargeDate: '2026-09-19' },
  },
  {
    id: 'trial-whole-dollars',
    note: 'Whole-dollar price ("$20 per month"), subdomain sender.',
    tags: ['trial', 'catalog'],
    email: mail('e-trial-chatgpt', 'ChatGPT <noreply@tm.openai.com>', 'Your ChatGPT Plus trial', '2026-09-23T15:00:00Z', [
      'Your free trial of ChatGPT Plus has started. You will be charged $20 per month beginning October 23, 2026.',
    ]),
    gold: { kind: 'trial_signup', merchantId: 'chatgpt', priceCents: 2000, cadence: 'monthly', chargeDate: '2026-10-23' },
  },

  // ======================= receipts =======================
  {
    id: 'receipt-netflix',
    note: 'Cadence only in "(monthly)" after the plan name.',
    tags: ['receipt', 'catalog'],
    email: mail('e-receipt-netflix', 'Netflix <info@account.netflix.com>', 'Your Netflix receipt', '2026-09-03T06:00:00Z', [
      'Thanks for your payment.',
      'Amount: $15.49',
      'Plan: Standard (monthly)',
      'Next billing date: October 3, 2026',
    ]),
    gold: { kind: 'receipt', merchantId: 'netflix', priceCents: 1549, cadence: 'monthly', chargeDate: '2026-10-03' },
  },
  {
    id: 'receipt-spotify-slash',
    note: 'Two slash dates: the charge date and the next payment.',
    tags: ['receipt', 'catalog', 'slash-date'],
    email: mail('e-receipt-spotify', 'Spotify <no-reply@spotify.com>', 'Your receipt from Spotify', '2026-09-12T05:00:00Z', [
      'Premium Individual — $11.99/month',
      'Charged to Visa ending in 4242 on 09/12/2026.',
      'Your next payment is on 10/12/2026.',
    ]),
    gold: { kind: 'receipt', merchantId: 'spotify', priceCents: 1199, cadence: 'monthly', chargeDate: '2026-10-12' },
  },
  {
    id: 'receipt-prime-annual',
    note: 'Annual renewal receipt.',
    tags: ['receipt', 'catalog', 'annual'],
    email: mail('e-receipt-prime', 'Amazon.com <auto-confirm@amazon.com>', 'Your Prime membership has renewed', '2026-09-20T04:00:00Z', [
      'Your Amazon Prime membership renewed today for $139.00/year. Your next renewal date is Sep 20, 2027.',
    ]),
    gold: { kind: 'receipt', merchantId: 'amazon-prime', priceCents: 13900, cadence: 'annual', chargeDate: '2027-09-20' },
  },
  {
    id: 'receipt-app-store-calm',
    note: 'App Store receipt for a third-party app: the merchant is the app, not Apple.',
    tags: ['receipt', 'app-store', 'sender-domain'],
    email: mail('e-receipt-apple-calm', 'Apple <no_reply@email.apple.com>', 'Your receipt from Apple.', '2026-09-09T03:00:00Z', [
      'Receipt',
      'Calm: Sleep & Meditation',
      'Calm Premium (Annual)',
      'Renews September 9, 2027',
      '$69.99',
      'Billed to: Visa •••• 4242',
    ]),
    gold: { kind: 'receipt', merchantId: 'calm', priceCents: 6999, cadence: 'annual', chargeDate: '2027-09-09' },
  },
  {
    id: 'receipt-google-play-duolingo',
    note: 'Google Play receipt for a third-party app.',
    tags: ['receipt', 'google-play', 'sender-domain'],
    email: mail('e-receipt-play-duolingo', 'Google Play <googleplay-noreply@google.com>', 'Your Google Play Order Receipt from Sep 18, 2026', '2026-09-18T11:00:00Z', [
      "Thank you. You've made a purchase from Google Play.",
      'Item: Super Duolingo (Duolingo)',
      'Auto-renewing subscription',
      'Price: $12.99/month',
      'Next charge: Oct 18, 2026',
    ]),
    gold: { kind: 'receipt', merchantId: 'duolingo', priceCents: 1299, cadence: 'monthly', chargeDate: '2026-10-18' },
  },
  {
    id: 'receipt-paypal-unknown',
    note: 'PayPal automatic-payment receipt for a merchant outside the catalog.',
    tags: ['receipt', 'paypal', 'unknown-merchant'],
    email: mail('e-receipt-paypal', 'PayPal <service@paypal.com>', 'Receipt for your payment to Northwind VPN Ltd', '2026-09-27T09:30:00Z', [
      'You sent an automatic payment of $5.99 USD to Northwind VPN Ltd.',
      'This is a recurring monthly payment.',
      'Transaction date: Sep 27, 2026',
    ]),
    gold: { kind: 'receipt', merchantId: null, serviceName: 'Northwind VPN', priceCents: 599, cadence: 'monthly' },
  },
  {
    id: 'receipt-dropbox-html-invoice',
    note: 'HTML invoice table: plan price, tax and total (the total is what will be charged).',
    tags: ['receipt', 'catalog', 'html'],
    email: mail(
      'e-receipt-dropbox',
      'Dropbox <no-reply@dropbox.com>',
      'Your Dropbox invoice',
      '2026-09-05T02:00:00Z',
      '<table><tr><td>Dropbox Plus (monthly)</td><td>$11.99</td></tr><tr><td>Sales tax</td><td>$0.99</td></tr><tr><td><b>Total</b></td><td><b>$12.98</b></td></tr></table><p>Your plan renews on October 5, 2026.</p>',
    ),
    gold: { kind: 'receipt', merchantId: 'dropbox', priceCents: 1298, cadence: 'monthly', chargeDate: '2026-10-05' },
  },
  {
    id: 'receipt-usd-suffix-period',
    note: '"10.00 USD", cadence only implied by a one-month billing period.',
    tags: ['receipt', 'catalog', 'currency-format'],
    email: mail('e-receipt-github', 'GitHub <billing@github.com>', '[GitHub] Payment receipt', '2026-09-14T00:30:00Z', [
      'We received payment for your GitHub Copilot Pro subscription.',
      'Amount: 10.00 USD',
      'Billing period: Sep 14, 2026 – Oct 13, 2026',
      'Next payment due Oct 14, 2026.',
    ]),
    gold: { kind: 'receipt', merchantId: 'github-copilot', priceCents: 1000, cadence: 'monthly', chargeDate: '2026-10-14' },
  },
  {
    id: 'receipt-us-dollar-prefix',
    note: '"US$10.99", cadence in a later sentence.',
    tags: ['receipt', 'catalog', 'currency-format'],
    email: mail('e-receipt-sirius', 'SiriusXM <siriusxm@siriusxm.com>', 'Your SiriusXM payment confirmation', '2026-09-08T13:00:00Z', [
      'Payment received: US$10.99 for your Music & Entertainment plan. Your plan renews monthly.',
    ]),
    gold: { kind: 'receipt', merchantId: 'siriusxm', priceCents: 1099, cadence: 'monthly' },
  },
  {
    id: 'receipt-eur-annual',
    note: 'Euro total with a decimal comma and a DD.MM.YYYY renewal date.',
    tags: ['receipt', 'catalog', 'foreign-currency', 'international', 'annual'],
    email: mail('e-receipt-m365', 'Microsoft <microsoft-noreply@microsoft.com>', 'Your Microsoft 365 subscription has renewed', '2026-09-28T07:00:00Z', [
      'Microsoft 365 Family',
      'Total: 99,00 €',
      'Annual subscription — next renewal 28.09.2027',
    ]),
    gold: { kind: 'receipt', merchantId: 'microsoft-365', priceCents: null, cadence: 'annual', chargeDate: '2027-09-28' },
  },
  {
    id: 'receipt-upcoming-renewal',
    note: 'Upcoming-renewal notice for an annual plan.',
    tags: ['receipt', 'catalog', 'annual'],
    email: mail('e-receipt-adobe', 'Adobe <mail@mail.adobe.com>', 'Your Adobe plan will renew soon', '2026-09-25T16:00:00Z', [
      'Your Creative Cloud All Apps annual plan will automatically renew on October 1, 2026 for $659.88/year.',
    ]),
    gold: { kind: 'receipt', merchantId: 'adobe', priceCents: 65988, cadence: 'annual', chargeDate: '2026-10-01' },
  },
  {
    id: 'receipt-youtube-yearly',
    note: '"Billing: yearly" on its own line, two-digit year date.',
    tags: ['receipt', 'catalog', 'annual', 'slash-date'],
    email: mail('e-receipt-youtube', 'YouTube <noreply-purchases@youtube.com>', 'Your YouTube Premium membership receipt', '2026-09-30T05:00:00Z', [
      'Order total: $139.99',
      'Billing: yearly',
      'Next billing date: 9/30/27',
    ]),
    gold: { kind: 'receipt', merchantId: 'youtube-premium', priceCents: 13999, cadence: 'annual', chargeDate: '2027-09-30' },
  },
  {
    id: 'receipt-hellofresh-weekly',
    note: 'Weekly meal-kit receipt; the price appears twice.',
    tags: ['receipt', 'catalog', 'weekly'],
    email: mail('e-receipt-hellofresh', 'HelloFresh <hello@hellofresh.com>', 'Your HelloFresh order receipt', '2026-09-16T12:00:00Z', [
      "Thanks for your order! Box total: $74.99. Your next box ships Sep 23 and you'll be charged $74.99 per week until you skip or pause.",
    ]),
    gold: { kind: 'receipt', merchantId: 'hellofresh', priceCents: 7499, cadence: 'weekly' },
  },

  // ======================= price increases =======================
  {
    id: 'price-netflix',
    note: '"from $X to $Y per month", effective date.',
    tags: ['price', 'catalog'],
    email: mail('e-price-netflix', 'Netflix <info@account.netflix.com>', 'Changes to your Netflix price', '2026-09-12T15:00:00Z', [
      "We're writing to let you know that your Standard plan price will change from $15.49 to $17.99 per month.",
      'The new price will apply starting with your billing date on or after October 12, 2026.',
    ]),
    gold: { kind: 'price_increase', merchantId: 'netflix', priceCents: 1799, oldPriceCents: 1549, cadence: 'monthly', effectiveDate: '2026-10-12' },
  },
  {
    id: 'price-spotify-changing',
    note: 'New price first, old price in a later sentence.',
    tags: ['price', 'catalog'],
    email: mail('e-price-spotify', 'Spotify <no-reply@spotify.com>', 'Your Premium price is changing', '2026-09-02T10:00:00Z', [
      'Your Premium Individual price is changing to $12.99/month.',
      'The new price starts on your November billing date, Nov 12, 2026. You currently pay $11.99/month.',
    ]),
    gold: { kind: 'price_increase', merchantId: 'spotify', priceCents: 1299, oldPriceCents: 1199, cadence: 'monthly', effectiveDate: '2026-11-12' },
  },
  {
    id: 'price-annual-will-increase',
    note: '"price will increase" (no listed phrase) on an annual plan.',
    tags: ['price', 'catalog', 'annual'],
    email: mail('e-price-disney', 'Disney+ <disneyplus@mail.disneyplus.com>', 'An update to your Disney+ subscription', '2026-09-30T14:00:00Z', [
      'Your annual Disney+ Premium price will increase from $139.99/year to $159.99/year, effective November 1, 2026.',
    ]),
    gold: { kind: 'price_increase', merchantId: 'disney-plus', priceCents: 15999, oldPriceCents: 13999, cadence: 'annual', effectiveDate: '2026-11-01' },
  },
  {
    id: 'price-increase-by',
    note: '"increases by $2.00 to $19.99": the $2.00 is the difference, not the old price.',
    tags: ['price', 'catalog', 'sender-domain'],
    email: mail('e-price-hulu', 'Hulu <hulu@hulumail.com>', 'Hulu price increase', '2026-09-10T17:00:00Z', [
      'Starting October 10, 2026, your monthly price increases by $2.00 to $19.99.',
    ]),
    gold: { kind: 'price_increase', merchantId: 'hulu', priceCents: 1999, oldPriceCents: 1799, cadence: 'monthly', effectiveDate: '2026-10-10' },
  },
  {
    id: 'price-arrow-usd',
    note: '"13.99 USD → 15.99 USD per month".',
    tags: ['price', 'catalog', 'currency-format', 'slash-date'],
    email: mail('e-price-youtube', 'YouTube <noreply@youtube.com>', 'Price update for your YouTube Premium membership', '2026-09-15T18:00:00Z', [
      'Your price: 13.99 USD → 15.99 USD per month, beginning with your next billing cycle on 10/07/2026.',
    ]),
    gold: { kind: 'price_increase', merchantId: 'youtube-premium', priceCents: 1599, oldPriceCents: 1399, cadence: 'monthly', effectiveDate: '2026-10-07' },
  },
  {
    id: 'price-gbp',
    note: 'Price change in pounds.',
    tags: ['price', 'catalog', 'foreign-currency'],
    email: mail('e-price-gbp', 'Spotify <no-reply@spotify.com>', 'Your Premium price is changing', '2026-09-20T09:00:00Z', [
      'From your next billing date on 20 October 2026, Premium will cost £12.99/month instead of £11.99/month.',
    ]),
    gold: { kind: 'price_increase', merchantId: 'spotify', priceCents: null, oldPriceCents: null, cadence: 'monthly', effectiveDate: '2026-10-20' },
  },
  {
    id: 'price-marketing-new-customers',
    note: 'Prices rise for new customers only; this subscriber keeps their price.',
    tags: ['none', 'hard-negative', 'catalog'],
    email: mail('e-price-max-new', 'Max <hello@mail.max.com>', 'Price update for new subscribers', '2026-09-05T16:00:00Z', [
      "We're updating prices for new subscribers. As a current member, your price stays the same: $16.99/month. No action needed.",
    ]),
    gold: { kind: 'none' },
  },

  // ======================= cancellations =======================
  {
    id: 'cancel-netflix',
    note: 'Plain "membership has been cancelled".',
    tags: ['cancel', 'catalog'],
    email: mail('e-cancel-netflix', 'Netflix <info@account.netflix.com>', 'Your Netflix membership has been cancelled', '2026-09-18T20:00:00Z', [
      "We've cancelled your membership. You can keep watching until October 3, 2026.",
    ]),
    gold: { kind: 'cancellation_confirmation', merchantId: 'netflix' },
  },
  {
    id: 'cancel-spotify-youve',
    note: '"You\'ve cancelled".',
    tags: ['cancel', 'catalog'],
    email: mail('e-cancel-spotify', 'Spotify <no-reply@spotify.com>', "You've cancelled Premium", '2026-09-21T09:00:00Z', [
      "You've cancelled your Premium plan. You'll keep Premium until Oct 12, 2026, then switch to Spotify Free.",
    ]),
    gold: { kind: 'cancellation_confirmation', merchantId: 'spotify' },
  },
  {
    id: 'cancel-confirmed-unknown',
    note: 'Cancellation from a merchant outside the catalog.',
    tags: ['cancel', 'unknown-merchant'],
    email: mail('e-cancel-brightline', 'Brightline Yoga <hello@brightlineyoga.example>', 'Cancellation confirmed', '2026-09-22T19:00:00Z', [
      "Your cancellation is confirmed. Your membership will end on Sep 30, 2026 and you won't be charged again.",
    ]),
    gold: { kind: 'cancellation_confirmation', merchantId: null, serviceName: 'Brightline Yoga' },
  },
  {
    id: 'cancel-wont-renew',
    note: '"won\'t renew" phrasing with no form of "cancel".',
    tags: ['cancel', 'catalog'],
    email: mail('e-cancel-headspace', 'Headspace <hello@headspace.com>', "We're sorry to see you go", '2026-09-25T11:00:00Z', [
      "Your subscription won't renew. You'll have access to Headspace until Oct 16, 2026.",
    ]),
    gold: { kind: 'cancellation_confirmation', merchantId: 'headspace' },
  },
  {
    id: 'cancel-auto-renew-off',
    note: '"turned off auto-renew".',
    tags: ['cancel', 'catalog'],
    email: mail('e-cancel-playstation', 'PlayStation <reply@txn-email.playstation.com>', 'Auto-renew turned off', '2026-09-09T08:00:00Z', [
      "You've turned off auto-renew for PlayStation Plus Essential. Your membership ends on 9 October 2026.",
    ]),
    gold: { kind: 'cancellation_confirmation', merchantId: 'playstation-plus' },
  },
  {
    id: 'cancel-trial-canceled',
    note: 'Trial cancelled (US spelling) before conversion.',
    tags: ['cancel', 'catalog'],
    email: mail('e-cancel-peacock', 'Peacock <noreply@peacocktv.com>', 'Your trial has been canceled', '2026-09-20T13:00:00Z', [
      "Your Peacock Premium trial has been canceled. You won't be charged.",
    ]),
    gold: { kind: 'cancellation_confirmation', merchantId: 'peacock' },
  },

  // ======================= not subscription emails =======================
  {
    id: 'none-marketing-trial',
    note: 'Promotion inviting a free trial; nothing was started.',
    tags: ['none', 'hard-negative', 'marketing'],
    email: mail('e-none-hulu-promo', 'Hulu <hulu@hulumail.com>', 'Start your free trial today', '2026-09-06T17:00:00Z', [
      'Stream thousands of shows. Try Hulu free for 30 days — sign up now and get your first month on us. Plans from $9.99/month.',
    ]),
    gold: { kind: 'none' },
  },
  {
    id: 'none-trial-size',
    note: '"free trial-size samples" in a shop newsletter.',
    tags: ['none', 'hard-negative', 'marketing'],
    email: mail('e-none-trial-size', 'Petal & Pine Skincare <news@petalpine.example>', 'Free trial-size samples with every order', '2026-09-11T15:00:00Z', [
      'This week only: free trial-size samples with every order over $40.',
    ]),
    gold: { kind: 'none' },
  },
  {
    id: 'none-newsletter-subscribing',
    note: 'Free newsletter sign-up.',
    tags: ['none', 'hard-negative'],
    email: mail('e-none-newsletter', 'The Weekend Reader <newsletter@weekendreader.example>', 'Thanks for subscribing!', '2026-09-07T08:00:00Z', [
      'Thanks for subscribing to The Weekend Reader, our free weekly newsletter. Look out for your first issue on Saturday.',
    ]),
    gold: { kind: 'none' },
  },
  {
    id: 'none-password-reset',
    note: 'Account email from a catalog merchant.',
    tags: ['none', 'catalog'],
    email: mail('e-none-reset', 'Netflix <info@account.netflix.com>', 'Complete your password reset', '2026-09-08T22:00:00Z', [
      "Click the link below to reset your password. If you didn't request this, ignore this email.",
    ]),
    gold: { kind: 'none' },
  },
  {
    id: 'none-shipping',
    note: 'Shipping notice from a catalog merchant domain.',
    tags: ['none', 'catalog'],
    email: mail('e-none-shipping', 'Amazon.com <shipment-tracking@amazon.com>', 'Your package has shipped', '2026-09-09T12:00:00Z', [
      "Your order of 'Ceramic pour-over coffee dripper' has shipped and will arrive Sep 12.",
    ]),
    gold: { kind: 'none' },
  },
  {
    id: 'none-order-receipt',
    note: 'One-off shopping receipt.',
    tags: ['none', 'hard-negative', 'one-off'],
    email: mail('e-none-order-receipt', 'Amazon.com <auto-confirm@amazon.com>', 'Your Amazon.com order receipt', '2026-09-10T12:00:00Z', [
      'Order total: $34.99',
      'Items: Ceramic pour-over coffee dripper',
      'Arriving Sep 12',
    ]),
    gold: { kind: 'none' },
  },
  {
    id: 'none-uber-trip',
    note: 'Ride receipt from a company that also sells a membership.',
    tags: ['none', 'hard-negative', 'one-off'],
    email: mail('e-none-uber-trip', 'Uber Receipts <noreply@uber.com>', 'Your Tuesday evening trip with Uber', '2026-09-15T23:00:00Z', [
      "Thanks for riding. Here's your receipt.",
      'Total: $18.40',
      'Trip fare $15.10, booking fee $3.30',
    ]),
    gold: { kind: 'none' },
  },
  {
    id: 'none-library-membership',
    note: 'Free library membership.',
    tags: ['none', 'hard-negative'],
    email: mail('e-none-library', 'Springfield Public Library <noreply@springfieldlibrary.example>', 'Your library membership card is ready', '2026-09-04T14:00:00Z', [
      'Your free library membership is now active. Pick up your card at the front desk.',
    ]),
    gold: { kind: 'none' },
  },
  {
    id: 'none-concert-ticket',
    note: 'One-off ticket receipt.',
    tags: ['none', 'hard-negative', 'one-off'],
    email: mail('e-none-ticket', 'Ticket Hub <orders@tickethub.example>', 'Your ticket receipt', '2026-09-19T20:00:00Z', [
      'Thanks for your order. 2 tickets — Saturday Oct 10, 2026. Total charged: $86.50.',
    ]),
    gold: { kind: 'none' },
  },
  {
    id: 'none-trial-ended-no-charge',
    note: 'Trial ended without converting; nothing will be charged.',
    tags: ['none', 'hard-negative'],
    email: mail('e-none-trial-ended', 'Calm <hello@calm.com>', 'Your free trial has ended', '2026-09-17T09:00:00Z', [
      "Your free trial has ended and you haven't been charged. Subscribe anytime to keep using Calm Premium.",
    ]),
    gold: { kind: 'none' },
  },
  {
    id: 'none-promo-new-subscribers',
    note: 'Promotion for new subscribers with a price in it.',
    tags: ['none', 'marketing'],
    email: mail('e-none-spotify-promo', 'Spotify <no-reply@spotify.com>', 'Get 3 months of Premium for $0', '2026-09-26T15:00:00Z', [
      'Limited time: new Premium subscribers get 3 months for $0. Then $11.99/month. Offer ends Oct 15.',
    ]),
    gold: { kind: 'none' },
  },
  {
    id: 'none-clinical-trial',
    note: '"trial" in the medical sense.',
    tags: ['none', 'hard-negative'],
    email: mail('e-none-clinical', 'Northside Health <news@northsidehealth.example>', 'Volunteers wanted for our clinical trial', '2026-09-14T16:00:00Z', [
      "We're recruiting adults for a 12-week clinical trial of a new sleep program. Participants receive $200.",
    ]),
    gold: { kind: 'none' },
  },
  {
    id: 'none-free-plan-welcome',
    note: '"Welcome to" a free plan with an upsell price.',
    tags: ['none', 'hard-negative'],
    email: mail('e-none-free-plan', 'Fernway Notes <hello@fernway.example>', 'Welcome to Fernway Notes!', '2026-09-02T10:00:00Z', [
      "You're on the Free plan. Upgrade to Pro anytime for $4/month.",
    ]),
    gold: { kind: 'none' },
  },
  {
    id: 'none-flight-cancelled',
    note: 'A cancelled flight, not a subscription.',
    tags: ['none', 'hard-negative'],
    email: mail('e-none-flight', 'SkyHarbor Airlines <notifications@skyharbor.example>', 'Your flight has been cancelled', '2026-09-23T06:00:00Z', [
      "We're sorry: flight SH 482 on Sep 25 has been cancelled. You'll receive a refund of $412.00 within 7 days.",
    ]),
    gold: { kind: 'none' },
  },
  {
    id: 'none-order-cancelled',
    note: 'A cancelled shop order.',
    tags: ['none', 'hard-negative'],
    email: mail('e-none-order-cancelled', 'Brightline Outfitters <orders@brightline-outfitters.example>', 'Your order has been cancelled', '2026-09-24T12:00:00Z', [
      'Your order #48213 has been cancelled and you have not been charged.',
    ]),
    gold: { kind: 'none' },
  },
  {
    id: 'none-class-booking',
    note: 'Gym class booking confirmation from a merchant that also sells memberships.',
    tags: ['none', 'hard-negative'],
    email: mail('e-none-class', 'Riverbend Climbing <frontdesk@riverbendclimbing.example>', 'Your class booking', '2026-09-18T17:00:00Z', [
      'You are booked for Intro to Bouldering on Sep 22 at 6pm. Members attend free; drop-in price $25.',
    ]),
    gold: { kind: 'none' },
  },
];
