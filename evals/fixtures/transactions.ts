import type { RecurringCaseInput } from '../types.ts';
import { charges, everyDays, feed, monthly, seeded, yearly } from './build.ts';

/**
 * Labeled bank histories for recurring-charge detection. Synthetic: merchants are real brands or
 * invented local businesses, phone numbers use the reserved 555-01xx range, and no person appears.
 *
 * Each case is one slice of a feed. Charges that make up a subscription carry `sub`, and `expected`
 * lists every subscription that is still live on `today`, with what is true about it (not what the
 * detector currently says). Negative cases have `expected: []`.
 */

const TODAY = '2026-09-15';

// ---------- noise generators (seeded, so the dataset never changes between runs) ----------

/** Weekday coffee runs: most weekdays, small varying amounts. */
function coffeeRuns(description: string, from: string, weeks: number): ReturnType<typeof charges> {
  const rnd = seeded(description);
  const dates = everyDays(from, 1, weeks * 7).filter((d) => {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    return dow >= 1 && dow <= 5 && rnd() < 0.7;
  });
  return charges(description, () => 475 + Math.round(rnd() * 44) * 5, dates);
}

/** Two commute rides a week (Tue/Thu) with a mostly fixed fare, plus the odd longer trip. */
function commuteRides(from: string, weeks: number): ReturnType<typeof charges> {
  const rnd = seeded(`rides-${from}`);
  const dates = everyDays(from, 7, weeks).flatMap((tue) => [tue, everyDays(tue, 2, 2)[1] ?? tue]);
  return charges('UBER *TRIP HELP.UBER.COM', () => (rnd() < 0.75 ? 1840 : [2210, 1575, 3120][Math.floor(rnd() * 3)] ?? 2210), dates, {
    prefix: 'ride',
  });
}

export const RECURRING_CASES: RecurringCaseInput[] = [
  // ---------- straightforward positives ----------
  {
    id: 'netflix-monthly',
    note: 'Catalog merchant, steady monthly price.',
    tags: ['positive', 'catalog'],
    today: TODAY,
    transactions: charges('NETFLIX.COM 800-555-0101 CA', 1549, monthly('2026-02-03', 8), { sub: 'a' }),
    expected: [{ sub: 'a', merchantId: 'netflix', cadence: 'monthly', amountCents: 1549, nextChargeDate: '2026-10-03' }],
  },
  {
    id: 'dropbox-tax-variation',
    note: 'Sales tax makes the amount wobble by a few cents; the current price is the latest charge.',
    tags: ['positive', 'catalog'],
    today: TODAY,
    transactions: charges('DROPBOX*7NK2QR8 SAN FRANCISCO CA', [1283, 1285, 1283, 1290, 1290, 1290], monthly('2026-04-05', 6), { sub: 'a' }),
    expected: [{ sub: 'a', merchantId: 'dropbox', cadence: 'monthly', amountCents: 1290, nextChargeDate: '2026-10-05' }],
  },
  {
    id: 'disney-first-charge',
    note: 'A trial just converted: one charge from a catalog streaming service.',
    tags: ['positive', 'catalog', 'single-charge'],
    today: TODAY,
    transactions: charges('DISNEY PLUS 888-555-0109', 1399, ['2026-09-01'], { sub: 'a' }),
    expected: [{ sub: 'a', merchantId: 'disney-plus', cadence: 'monthly', amountCents: 1399, nextChargeDate: '2026-10-01' }],
  },
  {
    id: 'spotify-auth-capture-dupes',
    note: 'Two months post an authorization and a capture on the same day.',
    tags: ['positive', 'catalog', 'duplicates'],
    today: TODAY,
    transactions: feed(
      charges('SPOTIFY USA 8775550110', 1199, monthly('2026-03-20', 6), { sub: 'a' }),
      charges('SPOTIFY USA 8775550110', 1199, ['2026-06-20', '2026-08-20'], { sub: 'a', prefix: 'dup' }),
    ),
    expected: [{ sub: 'a', merchantId: 'spotify', cadence: 'monthly', amountCents: 1199, nextChargeDate: '2026-09-20' }],
  },
  {
    id: 'month-end-31st-after-long-month',
    note: 'Billed on the 31st (clamped in short months); the last charge fell on a 31st.',
    tags: ['positive', 'month-end'],
    today: TODAY,
    transactions: charges('DISNEY PLUS 888-555-0109', 1399, monthly('2026-03-31', 6), { sub: 'a' }),
    expected: [{ sub: 'a', merchantId: 'disney-plus', cadence: 'monthly', amountCents: 1399, nextChargeDate: '2026-09-30' }],
  },

  // ---------- hard positives: price changes ----------
  {
    id: 'hulu-small-increase',
    note: 'Price went from $17.99 to $18.99 mid-history.',
    tags: ['hard-positive', 'price-increase'],
    today: TODAY,
    transactions: feed(
      charges('HULU *HULU PLUS 800-555-0102', 1799, monthly('2026-02-21', 4), { sub: 'a' }),
      charges('HULU *HULU PLUS 800-555-0102', 1899, monthly('2026-06-21', 3), { sub: 'a', prefix: 'a-new' }),
    ),
    expected: [{ sub: 'a', merchantId: 'hulu', cadence: 'monthly', amountCents: 1899, nextChargeDate: '2026-09-21' }],
  },
  {
    id: 'peacock-big-increase',
    note: 'A 37% increase, with only one charge at the new price so far.',
    tags: ['hard-positive', 'price-increase'],
    today: TODAY,
    transactions: feed(
      charges('PEACOCKTV 800-555-0103 NY', 799, monthly('2026-03-08', 6), { sub: 'a' }),
      charges('PEACOCKTV 800-555-0103 NY', 1099, ['2026-09-08'], { sub: 'a', prefix: 'a-new' }),
    ),
    expected: [{ sub: 'a', merchantId: 'peacock', cadence: 'monthly', amountCents: 1099, nextChargeDate: '2026-10-08' }],
  },
  {
    id: 'unknown-price-increase',
    note: 'Local studio outside the catalog raised its price from $49 to $59.',
    tags: ['hard-positive', 'unknown-merchant', 'price-increase'],
    today: TODAY,
    transactions: feed(
      charges('LUMEN FITNESS STUDIO 0042 AUSTIN TX', 4900, monthly('2026-03-01', 5), { sub: 'a' }),
      charges('LUMEN FITNESS STUDIO 0042 AUSTIN TX', 5900, monthly('2026-08-01', 2), { sub: 'a', prefix: 'a-new' }),
    ),
    expected: [{ sub: 'a', name: 'Lumen Fitness', cadence: 'monthly', amountCents: 5900, nextChargeDate: '2026-10-01' }],
  },

  // ---------- hard positives: annual and odd cadences ----------
  {
    id: 'prime-annual',
    note: 'Annual plan, two renewals a year apart.',
    tags: ['hard-positive', 'annual'],
    today: TODAY,
    transactions: charges('AMAZON PRIME*AB12CD34E', 13900, yearly('2024-11-02', 2), { sub: 'a' }),
    expected: [{ sub: 'a', merchantId: 'amazon-prime', cadence: 'annual', amountCents: 13900, nextChargeDate: '2026-11-02' }],
  },
  {
    id: 'adobe-annual-single',
    note: 'Annual plan bought six months ago: a single large charge from a catalog merchant.',
    tags: ['hard-positive', 'annual', 'single-charge'],
    today: TODAY,
    transactions: charges('ADOBE *CREATIVE CLOUD 408-555-0104 CA', 26388, ['2026-03-10'], { sub: 'a' }),
    expected: [{ sub: 'a', merchantId: 'adobe', cadence: 'annual', amountCents: 26388, nextChargeDate: '2027-03-10' }],
  },
  {
    id: 'annual-unknown-3',
    note: 'Annual backup plan from a merchant outside the catalog, three renewals.',
    tags: ['hard-positive', 'annual', 'unknown-merchant'],
    today: TODAY,
    transactions: charges('NORTHWIND CLOUD BACKUP', 9900, yearly('2023-10-01', 3), { sub: 'a' }),
    expected: [{ sub: 'a', name: 'Northwind Cloud', cadence: 'annual', amountCents: 9900, nextChargeDate: '2026-10-01' }],
  },
  {
    id: 'annual-unknown-2',
    note: 'Annual app plan outside the catalog, two identical renewals exactly a year apart.',
    tags: ['hard-positive', 'annual', 'unknown-merchant'],
    today: TODAY,
    transactions: charges('QUILLPAD NOTES PRO', 4999, yearly('2024-12-05', 2), { sub: 'a' }),
    expected: [{ sub: 'a', name: 'Quillpad', cadence: 'annual', amountCents: 4999, nextChargeDate: '2026-12-05' }],
  },
  {
    id: 'quarterly-wine',
    note: 'Quarterly wine club outside the catalog.',
    tags: ['hard-positive', 'quarterly', 'unknown-merchant'],
    today: TODAY,
    transactions: charges('BLUEHARBOR WINE CLUB', 8900, ['2025-12-10', '2026-03-10', '2026-06-10', '2026-09-10'], { sub: 'a' }),
    expected: [{ sub: 'a', name: 'Blueharbor Wine', cadence: 'quarterly', amountCents: 8900, nextChargeDate: '2026-12-10' }],
  },
  {
    id: 'weekly-news-unknown',
    note: 'Weekly digital newspaper outside the catalog.',
    tags: ['hard-positive', 'weekly', 'unknown-merchant'],
    today: TODAY,
    transactions: charges('HARBOR GAZETTE DIGITAL', 399, everyDays('2026-06-04', 7, 15), { sub: 'a' }),
    expected: [{ sub: 'a', name: 'Harbor Gazette', cadence: 'weekly', amountCents: 399, nextChargeDate: '2026-09-17' }],
  },
  {
    id: 'four-weekly-nyt',
    note: 'Billed every 4 weeks (13 times a year). Closest supported cadence is monthly; the next date is last + 28 days.',
    tags: ['hard-positive', 'four-weekly'],
    today: '2026-09-12',
    transactions: charges('NYTIMES*NYTIMES DIGITAL', 2500, everyDays('2026-01-06', 28, 9), { sub: 'a' }),
    expected: [{ sub: 'a', merchantId: 'nytimes', cadence: 'monthly', amountCents: 2500, nextChargeDate: '2026-09-15' }],
  },
  {
    id: 'hellofresh-weekly-skips',
    note: 'Weekly meal kit with skipped weeks and one bigger box.',
    tags: ['hard-positive', 'weekly'],
    today: TODAY,
    transactions: charges(
      'HELLOFRESH 646-555-0111',
      (i) => (i === 8 ? 8299 : 7499),
      ['2026-06-03', '2026-06-10', '2026-06-17', '2026-07-01', '2026-07-08', '2026-07-29', '2026-08-05', '2026-08-12', '2026-08-19', '2026-08-26', '2026-09-02', '2026-09-09'],
      { sub: 'a' },
    ),
    expected: [{ sub: 'a', merchantId: 'hellofresh', cadence: 'weekly', amountCents: 7499, nextChargeDate: '2026-09-16' }],
  },
  {
    id: 'factor-biweekly',
    note: 'Meal kit delivered every 2 weeks. No enum value for the cadence, so only detection and dates are scored.',
    tags: ['hard-positive', 'biweekly'],
    today: TODAY,
    transactions: charges('FACTOR75 MEALS 800-555-0112', 8999, everyDays('2026-05-05', 14, 10), { sub: 'a' }),
    expected: [{ sub: 'a', merchantId: 'factor', amountCents: 8999, nextChargeDate: '2026-09-22' }],
  },
  {
    id: 'semiannual-vpn',
    note: 'VPN billed every 6 months. No enum value for the cadence.',
    tags: ['hard-positive', 'semiannual', 'unknown-merchant'],
    today: TODAY,
    transactions: charges('SKYLARK VPN SEMIANNUAL', 3594, ['2025-03-18', '2025-09-18', '2026-03-18'], { sub: 'a' }),
    expected: [{ sub: 'a', name: 'Skylark', amountCents: 3594, nextChargeDate: '2026-09-18' }],
  },
  {
    id: 'month-end-31st',
    note: 'Billed on the 31st; the last charge was clamped to Sep 30, but the next one is Oct 31.',
    tags: ['hard-positive', 'month-end'],
    today: '2026-10-05',
    transactions: charges('PARAMOUNT+ 800-555-0107 NY', 1299, monthly('2026-01-31', 9), { sub: 'a' }),
    expected: [{ sub: 'a', merchantId: 'paramount-plus', cadence: 'monthly', amountCents: 1299, nextChargeDate: '2026-10-31' }],
  },
  {
    id: 'business-day-shift',
    note: 'Due on the 1st, posted on the next business day when the 1st falls on a weekend.',
    tags: ['hard-positive', 'unknown-merchant', 'posting-shift'],
    today: TODAY,
    transactions: charges(
      'CEDAR & PINE PILATES 0042',
      12000,
      ['2026-02-02', '2026-03-02', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-03', '2026-09-01'],
      { sub: 'a' },
    ),
    expected: [{ sub: 'a', name: 'Cedar & Pine', cadence: 'monthly', amountCents: 12000, nextChargeDate: '2026-10-01' }],
  },

  // ---------- hard positives: billing rails and unknown merchants ----------
  {
    id: 'spotify-paypal',
    note: 'Spotify billed through PayPal.',
    tags: ['hard-positive', 'paypal'],
    today: TODAY,
    transactions: charges('PAYPAL *SPOTIFY 8005550142', 1199, monthly('2026-03-12', 7), { sub: 'a' }),
    expected: [{ sub: 'a', merchantId: 'spotify', cadence: 'monthly', amountCents: 1199, nextChargeDate: '2026-10-12' }],
  },
  {
    id: 'paypal-unknown-vpn',
    note: 'Merchant outside the catalog billed through PayPal.',
    tags: ['hard-positive', 'paypal', 'unknown-merchant'],
    today: TODAY,
    transactions: charges('PAYPAL *NORTHWINDVPN 8005550106', 599, monthly('2026-02-27', 7), { sub: 'a' }),
    expected: [{ sub: 'a', name: 'Northwindvpn', cadence: 'monthly', amountCents: 599, nextChargeDate: '2026-09-27' }],
  },
  {
    id: 'app-store-two-subs',
    note: 'Two App Store subscriptions behind one descriptor, plus one-off app purchases.',
    tags: ['hard-positive', 'app-store'],
    today: TODAY,
    transactions: feed(
      charges('APPLE.COM/BILL 800-555-0105 CA', 299, monthly('2026-05-14', 5), { sub: 'a' }),
      charges('APPLE.COM/BILL 800-555-0105 CA', 999, monthly('2026-04-22', 5), { sub: 'b' }),
      charges('APPLE.COM/BILL 800-555-0105 CA', [99, 499], ['2026-07-04', '2026-08-19']),
    ),
    expected: [
      { sub: 'a', merchantId: 'apple-app-store', cadence: 'monthly', amountCents: 299, nextChargeDate: '2026-10-14' },
      { sub: 'b', merchantId: 'apple-app-store', cadence: 'monthly', amountCents: 999, nextChargeDate: '2026-09-22' },
    ],
  },
  {
    id: 'app-store-annual',
    note: 'Annual App Store subscription.',
    tags: ['hard-positive', 'app-store', 'annual'],
    today: TODAY,
    transactions: charges('APPLE.COM/BILL 800-555-0105 CA', 6999, yearly('2025-01-20', 2), { sub: 'a' }),
    expected: [{ sub: 'a', merchantId: 'apple-app-store', cadence: 'annual', amountCents: 6999, nextChargeDate: '2027-01-20' }],
  },
  {
    id: 'google-play-calm',
    note: 'Calm billed through Google Play: the descriptor names the app, so the true merchant is knowable.',
    tags: ['hard-positive', 'google-play'],
    today: TODAY,
    transactions: charges('GOOGLE *Calm g.co/helppay#', 699, monthly('2026-04-09', 6), { sub: 'a' }),
    expected: [{ sub: 'a', merchantId: 'calm', cadence: 'monthly', amountCents: 699, nextChargeDate: '2026-10-09' }],
  },
  {
    id: 'local-climbing-gym',
    note: 'Local gym outside the catalog, descriptor with store number, city and state.',
    tags: ['hard-positive', 'unknown-merchant'],
    today: TODAY,
    transactions: charges('RIVERBEND CLIMBING GYM 0423 DENVER CO', 7900, monthly('2026-03-01', 7), { sub: 'a' }),
    expected: [{ sub: 'a', name: 'Riverbend Climbing', cadence: 'monthly', amountCents: 7900, nextChargeDate: '2026-10-01' }],
  },
  {
    id: 'patreon-variable',
    note: 'Membership total rose when the user joined a second creator.',
    tags: ['hard-positive', 'unknown-merchant', 'price-increase'],
    today: TODAY,
    transactions: charges('PATREON* MEMBERSHIP', [500, 500, 800, 800, 800, 800], monthly('2026-04-01', 6), { sub: 'a' }),
    expected: [{ sub: 'a', name: 'Patreon', cadence: 'monthly', amountCents: 800, nextChargeDate: '2026-10-01' }],
  },

  // ---------- hard positives: subscriptions mixed with other spend at the same merchant ----------
  {
    id: 'planet-fitness-plus-annual-fee',
    note: 'Monthly dues and a yearly club fee from the same gym: two subscriptions.',
    tags: ['hard-positive', 'same-merchant-two-plans', 'annual'],
    today: TODAY,
    transactions: feed(
      charges('PLANET FITNESS CLUB DUES 800-555-0114', 1500, monthly('2026-01-17', 8), { sub: 'a' }),
      charges('PLANET FITNESS ANNUAL FEE 800-555-0114', 4999, yearly('2025-07-25', 2), { sub: 'b' }),
    ),
    expected: [
      { sub: 'a', merchantId: 'planet-fitness', cadence: 'monthly', amountCents: 1500, nextChargeDate: '2026-09-17' },
      { sub: 'b', merchantId: 'planet-fitness', cadence: 'annual', amountCents: 4999, nextChargeDate: '2027-07-25' },
    ],
  },
  {
    id: 'chatgpt-plus-api-usage',
    note: 'ChatGPT Plus plus pay-as-you-go API charges from the same company; the newest charge is API usage.',
    tags: ['hard-positive', 'mixed-noise'],
    today: TODAY,
    transactions: feed(
      charges('OPENAI *CHATGPT SUBSCR', 2000, monthly('2026-03-02', 7), { sub: 'a' }),
      charges('OPENAI API 4155550108', [537, 1210], ['2026-08-14', '2026-09-13'], { prefix: 'api' }),
    ),
    expected: [{ sub: 'a', merchantId: 'chatgpt', cadence: 'monthly', amountCents: 2000, nextChargeDate: '2026-10-02' }],
  },
  {
    id: 'amazon-prime-plus-shopping',
    note: 'Monthly Prime among a dozen marketplace orders, some at the same price as Prime.',
    tags: ['hard-positive', 'mixed-noise'],
    today: TODAY,
    transactions: feed(
      charges('AMAZON PRIME*2K4LM0RT1', 1499, monthly('2026-04-09', 6), { sub: 'a' }),
      ...(
        [
          ['2026-04-02', 2399, 'RT5Y81QZ3'],
          ['2026-04-19', 1499, 'H27KD0PX1'],
          ['2026-05-06', 4512, '9QW3LM2B7'],
          ['2026-05-28', 899, 'TT8V2N1Z4'],
          ['2026-06-11', 1499, 'P0O9I8U7Y'],
          ['2026-06-30', 3150, 'ZX4C5V6B7'],
          ['2026-07-15', 1299, 'M1N2B3V4C'],
          ['2026-07-29', 2675, 'Q9W8E7R6T'],
          ['2026-08-08', 899, 'L5K4J3H2G'],
          ['2026-08-24', 5600, 'A1S2D3F4G'],
          ['2026-09-03', 1499, 'Z9X8C7V6B'],
          ['2026-09-12', 1999, 'Y6T5R4E3W'],
        ] as const
      ).map(([date, cents, ref], i) => charges(`AMZN MKTP US*${ref}`, cents, [date], { prefix: `order${i + 1}` })),
    ),
    expected: [{ sub: 'a', merchantId: 'amazon-prime', cadence: 'monthly', amountCents: 1499, nextChargeDate: '2026-10-09' }],
  },
  {
    id: 'uber-one-among-rides',
    note: 'Uber One membership alongside twice-weekly rides from the same company.',
    tags: ['hard-positive', 'mixed-noise'],
    today: TODAY,
    transactions: feed(charges('UBER *ONE MEMBERSHIP', 999, monthly('2026-04-28', 5), { sub: 'a' }), commuteRides('2026-07-07', 10)),
    expected: [{ sub: 'a', merchantId: 'uber-one', cadence: 'monthly', amountCents: 999, nextChargeDate: '2026-09-28' }],
  },
  {
    id: 'foreign-fx-fee',
    note: 'Subscription billed in SEK (USD amount wobbles) with a monthly foreign transaction fee line; the fee is not a subscription.',
    tags: ['hard-positive', 'hard-negative', 'fees'],
    today: TODAY,
    transactions: feed(
      charges('SPOTIFY AB STOCKHOLM', [1121, 1148, 1097, 1135, 1160, 1109], monthly('2026-04-14', 6), { sub: 'a' }),
      charges('FOREIGN TRANSACTION FEE', [34, 34, 33, 34, 35, 33], monthly('2026-04-14', 6), { prefix: 'fee' }),
    ),
    expected: [{ sub: 'a', merchantId: 'spotify', cadence: 'monthly', amountCents: 1109, nextChargeDate: '2026-10-14' }],
  },

  // ---------- hard negatives: habits ----------
  {
    id: 'coffee-daily',
    note: 'Coffee on most weekdays at varying amounts.',
    tags: ['hard-negative', 'habit'],
    today: TODAY,
    transactions: coffeeRuns('STARBUCKS STORE 08812 SEATTLE WA', '2026-07-01', 11),
    expected: [],
  },
  {
    id: 'coffee-every-monday',
    note: 'The same $5.25 coffee every Monday morning: a habit, not a subscription.',
    tags: ['hard-negative', 'habit', 'weekly'],
    today: TODAY,
    transactions: charges('SQ *BLUE HERON COFFEE', 525, everyDays('2026-06-01', 7, 16)),
    expected: [],
  },
  {
    id: 'grocery-weekly',
    note: 'Saturday grocery shop with the odd midweek top-up.',
    tags: ['hard-negative', 'habit'],
    today: TODAY,
    transactions: (() => {
      const rnd = seeded('grocery');
      const saturdays = everyDays('2026-06-06', 7, 15);
      const topUps = saturdays.filter(() => rnd() < 0.35).map((d) => everyDays(d, 4, 2)[1] ?? d);
      return feed(
        charges("TRADER JOE'S #552 PORTLAND OR", () => 6000 + Math.round(rnd() * 80) * 100, saturdays, { prefix: 'shop' }),
        charges("TRADER JOE'S #552 PORTLAND OR", () => 1500 + Math.round(rnd() * 25) * 100, topUps, { prefix: 'topup' }),
      );
    })(),
    expected: [],
  },
  {
    id: 'rideshare-commute',
    note: 'Rides to work every Tuesday and Thursday at a mostly fixed fare.',
    tags: ['hard-negative', 'habit'],
    today: TODAY,
    transactions: commuteRides('2026-06-02', 15),
    expected: [],
  },
  {
    id: 'gas-station',
    note: 'Fill-ups every 5–9 days at varying amounts.',
    tags: ['hard-negative', 'habit'],
    today: TODAY,
    transactions: (() => {
      const rnd = seeded('gas');
      const dates: string[] = [];
      for (let d = '2026-06-01'; d <= '2026-09-13'; d = everyDays(d, 5 + Math.floor(rnd() * 5), 2)[1] ?? d) dates.push(d);
      return charges('SHELL OIL 57444212 BELLEVUE WA', () => 3800 + Math.round(rnd() * 24) * 100, dates);
    })(),
    expected: [],
  },
  {
    id: 'pharmacy-copay',
    note: 'Monthly prescription refill copay; refill dates drift by a few days.',
    tags: ['hard-negative', 'habit'],
    today: TODAY,
    transactions: charges('CVS/PHARMACY #08123', 1000, ['2026-03-04', '2026-04-02', '2026-05-05', '2026-06-03', '2026-07-06', '2026-08-04', '2026-09-02']),
    expected: [],
  },

  // ---------- hard negatives: one-offs, refunds and lapsed ----------
  {
    id: 'one-off-laptop',
    note: 'One big purchase.',
    tags: ['hard-negative', 'one-off'],
    today: TODAY,
    transactions: charges('BEST BUY 00012345 SEATTLE WA', 129999, ['2026-08-21']),
    expected: [],
  },
  {
    id: 'three-flights',
    note: 'Three similar-priced flights about a month apart.',
    tags: ['hard-negative', 'one-off'],
    today: TODAY,
    transactions: charges('SKYHARBOR AIR 0062345678901', [41200, 38900, 44700], ['2026-06-12', '2026-07-14', '2026-08-15']),
    expected: [],
  },
  {
    id: 'refund-reorder',
    note: 'Bought, returned and re-ordered the same shoes three months running.',
    tags: ['hard-negative', 'refunds'],
    today: TODAY,
    transactions: feed(
      charges('RIVERSTONE OUTFITTERS ONLINE', 12000, ['2026-06-03', '2026-07-05', '2026-08-04'], { prefix: 'buy' }),
      charges('RIVERSTONE OUTFITTERS ONLINE', -12000, ['2026-06-10', '2026-07-12', '2026-08-11'], { prefix: 'refund' }),
    ),
    expected: [],
  },
  {
    id: 'refunded-single-charge',
    note: 'A catalog subscription charged once and refunded in full three days later (cancelled at conversion).',
    tags: ['hard-negative', 'refunds', 'single-charge'],
    today: TODAY,
    transactions: feed(
      charges('CANVA* I03045-12345678', 1499, ['2026-09-02'], { prefix: 'charge' }),
      charges('CANVA* I03045-12345678', -1499, ['2026-09-05'], { prefix: 'refund' }),
    ),
    expected: [],
  },
  {
    id: 'lapsed-hulu',
    note: 'Subscription that stopped charging five months ago.',
    tags: ['negative', 'lapsed'],
    today: TODAY,
    transactions: charges('HULU 800-555-0102 HULU.COM', 1799, monthly('2026-01-10', 4)),
    expected: [],
  },
  {
    id: 'apple-one-off-purchases',
    note: 'One-off App Store purchases, some at the same price, at irregular intervals.',
    tags: ['hard-negative', 'app-store', 'one-off'],
    today: TODAY,
    transactions: charges(
      'APPLE.COM/BILL 800-555-0105 CA',
      [99, 99, 199, 99, 499, 299],
      ['2026-05-02', '2026-05-14', '2026-06-10', '2026-07-01', '2026-08-19', '2026-08-30'],
    ),
    expected: [],
  },

  // ---------- hard negatives: bills that recur but aren't subscriptions ----------
  {
    id: 'utility-electric',
    note: 'Electric bill: monthly, but the amount follows the season.',
    tags: ['hard-negative', 'utility'],
    today: TODAY,
    transactions: charges(
      'CITY OF SPRINGFIELD UTIL',
      [8210, 9544, 7930, 12055, 8802, 9110, 13490, 14820],
      ['2026-01-14', '2026-02-13', '2026-03-16', '2026-04-14', '2026-05-14', '2026-06-15', '2026-07-14', '2026-08-14'],
    ),
    expected: [],
  },
  {
    id: 'utility-gas',
    note: 'Gas bill on autopay: monthly, amount varies with usage.',
    tags: ['hard-negative', 'utility'],
    today: TODAY,
    transactions: charges(
      'METRO POWER & GAS AUTOPAY',
      [4512, 3890, 2975, 2410, 2260, 2390, 2875, 3310],
      ['2026-01-22', '2026-02-23', '2026-03-23', '2026-04-22', '2026-05-22', '2026-06-22', '2026-07-22', '2026-08-24'],
    ),
    expected: [],
  },
  {
    id: 'rent-ach',
    note: 'Rent by ACH: fixed and monthly, but not something to cancel from a subscription tracker.',
    tags: ['hard-negative', 'bill'],
    today: TODAY,
    transactions: charges('GREENLEAF PROPERTY MGMT ACH', 185000, monthly('2026-02-01', 8)),
    expected: [],
  },
  {
    id: 'ezpass-replenish',
    note: 'Toll account auto-replenishes a fixed $25 whenever the balance runs low.',
    tags: ['hard-negative', 'bill'],
    today: TODAY,
    transactions: charges('E-ZPASS REPLENISHMENT', 2500, ['2026-03-03', '2026-04-14', '2026-05-09', '2026-06-20', '2026-07-11', '2026-08-25']),
    expected: [],
  },
];
