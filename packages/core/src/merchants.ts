import type { CancelDifficulty, Merchant } from './types.ts';

/**
 * Seed of the maintained merchant catalog (PRD F5 targets the top 200 services).
 * Each entry drives three things: descriptor normalization, email attribution and the cancel guide.
 * Cancel URLs and steps are checked weekly by the link checker (see apps/api/src/jobs.ts).
 */
type Seed = [
  id: string,
  name: string,
  category: string,
  patterns: string[],
  emailDomains: string[],
  cancelUrl: string,
  steps: string[],
  difficulty?: CancelDifficulty,
  extra?: Partial<Merchant>,
];

const SEEDS: Seed[] = [
  ['netflix', 'Netflix', 'Streaming', ['NETFLIX', 'NFLX'], ['netflix.com'], 'https://www.netflix.com/cancelplan',
    ['Sign in at netflix.com on the web (cancelling in the app may not be offered).', 'Open Account, then choose Cancel Membership.', 'Confirm with Finish Cancellation. You keep access until the end of the billing period.'],
    'easy', { conciergeSupported: true }],
  ['spotify', 'Spotify', 'Music', ['SPOTIFY'], ['spotify.com'], 'https://www.spotify.com/account/subscription/',
    ['Sign in at spotify.com/account in a browser.', 'Go to Your plan, then Change plan.', 'Scroll to Spotify Free and choose Cancel Premium.'],
    'easy', { conciergeSupported: true }],
  ['hulu', 'Hulu', 'Streaming', ['HULU'], ['hulu.com'], 'https://secure.hulu.com/account',
    ['Sign in at hulu.com/account.', 'Under Your Subscription, select Cancel.', 'Decline the pause offer and confirm the cancellation.'], 'medium', { conciergeSupported: true }],
  ['disney-plus', 'Disney+', 'Streaming', ['DISNEY PLUS', 'DISNEYPLUS', 'DISNEY+'], ['disneyplus.com'], 'https://www.disneyplus.com/account/subscription',
    ['Sign in at disneyplus.com and open Account.', 'Select your subscription, then Cancel Subscription.', 'Complete the short survey and confirm.'], 'easy', { conciergeSupported: true }],
  ['max', 'Max', 'Streaming', ['HBO MAX', 'HBOMAX', 'MAX.COM', 'WBD MAX'], ['max.com', 'hbomax.com'], 'https://auth.max.com/subscription',
    ['Sign in at max.com and open Subscription.', 'Choose Manage Subscription, then Cancel Your Subscription.', 'Confirm. Billed through a partner? Cancel with that partner instead.'], 'easy'],
  ['paramount-plus', 'Paramount+', 'Streaming', ['PARAMOUNT+', 'PARAMOUNT PLUS', 'PARAMOUNTPLUS', 'CBS ALL ACCESS'], ['paramountplus.com'], 'https://www.paramountplus.com/account/',
    ['Sign in at paramountplus.com and open Account.', 'Select Cancel Subscription at the bottom of the page.', 'Confirm the cancellation.'], 'easy'],
  ['peacock', 'Peacock', 'Streaming', ['PEACOCK'], ['peacocktv.com'], 'https://www.peacocktv.com/account/plans',
    ['Sign in at peacocktv.com and open Account, then Plans & Payment.', 'Choose Change Plan, then Cancel Plan.', 'Confirm the cancellation.'], 'easy'],
  ['youtube-premium', 'YouTube Premium', 'Streaming', ['YOUTUBE PREMIUM', 'YOUTUBEPREMIUM', 'GOOGLE *YOUTUBE', 'YOUTUBE TV'], ['youtube.com'], 'https://www.youtube.com/paid_memberships',
    ['Open youtube.com/paid_memberships while signed in.', 'Select Manage membership, then Deactivate.', 'Choose Continue to cancel and confirm.'], 'easy'],
  ['apple-tv', 'Apple TV+', 'Streaming', ['APPLE TV'], ['apple.com'], 'https://apps.apple.com/account/subscriptions',
    ['Open Settings, tap your name, then Subscriptions.', 'Select Apple TV+.', 'Tap Cancel Subscription.'], 'easy'],
  ['amazon-prime', 'Amazon Prime', 'Shopping', ['AMAZON PRIME', 'PRIME VIDEO', 'AMZN PRIME', 'PRIME MEMBERSHIP'], ['amazon.com'], 'https://www.amazon.com/mc',
    ['Open amazon.com/mc while signed in.', 'Select Manage membership, then End membership.', 'Click through the retention pages and confirm End Membership.'], 'medium', { conciergeSupported: true }],
  ['audible', 'Audible', 'Books', ['AUDIBLE'], ['audible.com'], 'https://www.audible.com/account/overview',
    ['Sign in at audible.com on the web (not the app).', 'Open Account Details, then Cancel membership.', 'Use your remaining credits first: they expire when you cancel.'], 'medium'],
  ['kindle-unlimited', 'Kindle Unlimited', 'Books', ['KINDLE UNLTD', 'KINDLE UNLIMITED'], ['amazon.com'], 'https://www.amazon.com/kindle-dbs/ku/ku-central',
    ['Open Kindle Unlimited settings on amazon.com.', 'Select Cancel Kindle Unlimited Membership.', 'Confirm the cancellation.'], 'easy'],
  ['chatgpt', 'ChatGPT Plus', 'AI tools', ['OPENAI', 'CHATGPT'], ['openai.com'], 'https://chatgpt.com/#settings/Subscription',
    ['Sign in at chatgpt.com on the web.', 'Open Settings, then Account (or Subscription).', 'Select Manage, then Cancel plan.'], 'easy'],
  ['claude', 'Claude Pro', 'AI tools', ['ANTHROPIC', 'CLAUDE.AI'], ['anthropic.com'], 'https://claude.ai/settings/billing',
    ['Sign in at claude.ai.', 'Open Settings, then Billing.', 'Select Cancel plan and confirm.'], 'easy'],
  ['midjourney', 'Midjourney', 'AI tools', ['MIDJOURNEY'], ['midjourney.com'], 'https://www.midjourney.com/account',
    ['Sign in at midjourney.com and open Manage Subscription.', 'Choose Cancel Plan.', 'Confirm the cancellation.'], 'easy'],
  ['github-copilot', 'GitHub Copilot', 'AI tools', ['GITHUB'], ['github.com'], 'https://github.com/settings/billing',
    ['Open github.com/settings/billing.', 'Find Copilot under Add-ons and choose Cancel.', 'Confirm the cancellation.'], 'easy'],
  ['adobe', 'Adobe Creative Cloud', 'Software', ['ADOBE'], ['adobe.com'], 'https://account.adobe.com/plans',
    ['Sign in at account.adobe.com/plans.', 'Select Manage plan, then Cancel your plan.', 'Watch for an early-termination fee on annual plans paid monthly; cancelling within 14 days of signup avoids it.'], 'hard'],
  ['microsoft-365', 'Microsoft 365', 'Software', ['MICROSOFT*365', 'MICROSOFT 365', 'MSFT *OFFICE', 'MICROSOFT*SUBSCRIPTION'], ['microsoft.com'], 'https://account.microsoft.com/services',
    ['Sign in at account.microsoft.com/services.', 'Find Microsoft 365 and select Manage.', 'Choose Cancel subscription (or turn off recurring billing).'], 'easy'],
  ['dropbox', 'Dropbox', 'Software', ['DROPBOX'], ['dropbox.com'], 'https://www.dropbox.com/account/plan',
    ['Sign in at dropbox.com and open Settings, then Plan.', 'Select Cancel plan.', 'Confirm the downgrade.'], 'easy'],
  ['icloud', 'iCloud+', 'Software', ['ICLOUD'], ['apple.com'], 'https://apps.apple.com/account/subscriptions',
    ['Open Settings, tap your name, then iCloud.', 'Tap Manage Account Storage, then Change Storage Plan.', 'Choose Downgrade Options and select the free plan.'], 'easy'],
  ['google-one', 'Google One', 'Software', ['GOOGLE *GOOGLE ONE', 'GOOGLE ONE', 'GOOGLE STORAGE'], ['google.com'], 'https://one.google.com/settings',
    ['Open one.google.com/settings.', 'Select Cancel membership.', 'Confirm.'], 'easy'],
  ['grammarly', 'Grammarly', 'Software', ['GRAMMARLY'], ['grammarly.com'], 'https://account.grammarly.com/subscription',
    ['Sign in at account.grammarly.com.', 'Open Subscription, then Cancel Subscription.', 'Confirm.'], 'easy'],
  ['canva', 'Canva Pro', 'Software', ['CANVA'], ['canva.com'], 'https://www.canva.com/settings/billing-and-plans',
    ['Open Canva Settings, then Billing & plans.', 'Select the plan, then Cancel subscription.', 'Confirm.'], 'easy'],
  ['notion', 'Notion', 'Software', ['NOTION LABS', 'NOTION.SO'], ['makenotion.com', 'notion.so'], 'https://www.notion.so/settings/billing',
    ['Open Settings, then Billing in Notion.', 'Choose Change plan, then downgrade to Free.', 'Confirm.'], 'easy'],
  ['linkedin-premium', 'LinkedIn Premium', 'Career', ['LINKEDIN'], ['linkedin.com'], 'https://www.linkedin.com/premium/manage/',
    ['Click Me, then Premium features.', 'Select Manage Premium account, then Cancel subscription.', 'Confirm.'], 'easy'],
  ['nytimes', 'The New York Times', 'News', ['NYTIMES', 'NY TIMES', 'NEW YORK TIMES'], ['nytimes.com'], 'https://myaccount.nytimes.com/seg/subscription',
    ['Sign in at myaccount.nytimes.com.', 'Open Subscription overview and select Cancel subscription.', 'Online cancel is available in many states; otherwise use chat. Cite your state rights below.'], 'medium'],
  ['wsj', 'The Wall Street Journal', 'News', ['WSJ', 'DOW JONES'], ['wsj.com', 'dowjones.com'], 'https://customercenter.wsj.com/',
    ['Sign in to the WSJ Customer Center.', 'Open Subscriptions and select Cancel.', 'If online cancel is not offered, use chat or call and ask for a confirmation number.'], 'hard', { phone: '1-800-369-2834' }],
  ['peloton', 'Peloton', 'Fitness', ['PELOTON'], ['onepeloton.com'], 'https://members.onepeloton.com/preferences/subscriptions',
    ['Sign in at members.onepeloton.com.', 'Open Preferences, then Subscriptions.', 'Select your membership and choose Cancel Subscription.'], 'easy'],
  ['planet-fitness', 'Planet Fitness', 'Fitness', ['PLANET FITNESS', 'PF CLUB', 'PLANET FIT'], ['planetfitness.com'], 'https://www.planetfitness.com/my-account',
    ['Check whether your home club allows online cancellation in My Account.', 'If not, cancel in person at your home club or send a certified letter.', 'Ask for written confirmation and keep it.'], 'hard'],
  ['headspace', 'Headspace', 'Wellness', ['HEADSPACE'], ['headspace.com'], 'https://www.headspace.com/subscriptions',
    ['Sign in at headspace.com and open Account, then Subscription.', 'Select Cancel subscription.', 'If billed through Apple or Google, cancel in that store instead.'], 'easy'],
  ['calm', 'Calm', 'Wellness', ['CALM.COM', 'CALM APP'], ['calm.com'], 'https://www.calm.com/account',
    ['Sign in at calm.com/account.', 'Select Manage Subscription, then turn off auto-renew.', 'If billed through Apple or Google, cancel in that store instead.'], 'easy'],
  ['noom', 'Noom', 'Wellness', ['NOOM'], ['noom.com'], 'https://www.noom.com/support/',
    ['Open the Noom app, then Settings.', 'Choose Manage subscription, then Cancel.', 'Confirm and save the confirmation email.'], 'medium'],
  ['duolingo', 'Duolingo Super', 'Education', ['DUOLINGO'], ['duolingo.com'], 'https://www.duolingo.com/settings/subscription',
    ['Open duolingo.com/settings/subscription.', 'Select Cancel subscription.', 'If billed through Apple or Google, cancel in that store instead.'], 'easy'],
  ['masterclass', 'MasterClass', 'Education', ['MASTERCLASS'], ['masterclass.com'], 'https://www.masterclass.com/account/edit',
    ['Sign in at masterclass.com and open Settings.', 'Turn off auto-renew under Membership.', 'Confirm.'], 'easy'],
  ['hellofresh', 'HelloFresh', 'Meal kits', ['HELLOFRESH', 'HELLO FRESH'], ['hellofresh.com'], 'https://www.hellofresh.com/account-settings/plan-settings',
    ['Sign in at hellofresh.com, then open Account settings, then Plan settings.', 'Select Cancel plan, before the weekly cutoff.', 'Confirm. Boxes past the cutoff still ship.'], 'medium', { conciergeSupported: true }],
  ['factor', 'Factor', 'Meal kits', ['FACTOR75', 'FACTOR MEALS'], ['factor75.com'], 'https://www.factor75.com/account-settings/plan-settings',
    ['Sign in and open Account settings, then Plan settings.', 'Select Cancel plan before the weekly cutoff.', 'Confirm.'], 'medium'],
  ['blue-apron', 'Blue Apron', 'Meal kits', ['BLUE APRON', 'BLUEAPRON'], ['blueapron.com'], 'https://www.blueapron.com/account',
    ['Sign in at blueapron.com and open Account settings.', 'Select Cancel plan.', 'Confirm before the next weekly cutoff.'], 'medium'],
  ['uber-one', 'Uber One', 'Delivery', ['UBER ONE', 'UBER *ONE'], ['uber.com'], 'https://www.uber.com/account',
    ['Open the Uber app, then Account, then Uber One.', 'Select Manage membership, then End membership.', 'Confirm.'], 'easy'],
  ['doordash', 'DashPass', 'Delivery', ['DASHPASS', 'DOORDASH DASHPASS'], ['doordash.com'], 'https://www.doordash.com/consumer/membership/',
    ['Open DoorDash, then Account, then Manage DashPass.', 'Select End Subscription.', 'Confirm.'], 'easy'],
  ['instacart', 'Instacart+', 'Delivery', ['INSTACART+', 'INSTACART PLUS', 'INSTACART MEMBERSHIP'], ['instacart.com'], 'https://www.instacart.com/store/account/instacart-plus',
    ['Open Instacart, then Account, then Instacart+.', 'Select End membership.', 'Confirm.'], 'easy'],
  ['walmart-plus', 'Walmart+', 'Shopping', ['WALMART+', 'WALMART PLUS', 'WMT PLUS'], ['walmart.com'], 'https://www.walmart.com/plus/account',
    ['Open walmart.com/plus/account.', 'Select Cancel membership.', 'Confirm.'], 'easy'],
  ['xbox', 'Xbox Game Pass', 'Gaming', ['XBOX', 'MICROSOFT*XBOX', 'MSFT *XBOX'], ['microsoft.com', 'xbox.com'], 'https://account.microsoft.com/services',
    ['Sign in at account.microsoft.com/services.', 'Find Xbox Game Pass and select Manage.', 'Choose Cancel subscription.'], 'easy'],
  ['playstation-plus', 'PlayStation Plus', 'Gaming', ['PLAYSTATION', 'SONY INTERACTIVE', 'PLAYSTATIONNETWORK'], ['playstation.com', 'sony.com'], 'https://www.playstation.com/acct/management',
    ['Sign in to Account Management on playstation.com.', 'Open Subscription Management.', 'Select Turn Off Auto-Renew.'], 'easy'],
  ['nintendo', 'Nintendo Switch Online', 'Gaming', ['NINTENDO'], ['nintendo.com'], 'https://accounts.nintendo.com/shop',
    ['Sign in to your Nintendo Account.', 'Open Shop Menu, then Nintendo Switch Online.', 'Turn off Automatic Renewal.'], 'easy'],
  ['siriusxm', 'SiriusXM', 'Music', ['SIRIUSXM', 'SIRIUS XM', 'SXM'], ['siriusxm.com'], 'https://care.siriusxm.com/',
    ['Try online chat at siriusxm.com first; cancel online where available.', 'Otherwise call and say "cancel" at each prompt; decline offers.', 'Get a confirmation number and keep it.'], 'hard', { phone: '1-866-635-2349' }],
  ['tinder', 'Tinder', 'Dating', ['TINDER'], ['gotinder.com'], 'https://account.gotinder.com/',
    ['If you subscribed in the app, cancel in the App Store or Google Play.', 'If you subscribed on the web, open Account at tinder.com, then Manage Payment Account.', 'Select Cancel Subscription.'], 'easy'],
  ['bumble', 'Bumble', 'Dating', ['BUMBLE'], ['bumble.com'], 'https://bumble.com/en/help',
    ['If you subscribed in the app, cancel in the App Store or Google Play.', 'Otherwise open Settings, then Manage Payment.', 'Turn off auto-renewal.'], 'easy'],
  ['apple-app-store', 'App Store subscription', 'App stores', ['APPLE.COM/BILL', 'APPLE COM BILL', 'ITUNES.COM/BILL'], [], 'https://apps.apple.com/account/subscriptions',
    ['On iPhone: open Settings, tap your name, then Subscriptions.', 'Select the subscription.', 'Tap Cancel Subscription.'], 'easy'],
  ['google-play', 'Google Play subscription', 'App stores', ['GOOGLE *PLAY', 'GOOGLE PLAY'], [], 'https://play.google.com/store/account/subscriptions',
    ['Open play.google.com/store/account/subscriptions.', 'Select the subscription.', 'Tap Cancel subscription.'], 'easy'],
];

export const MERCHANTS: Merchant[] = SEEDS.map(([id, name, category, patterns, emailDomains, cancelUrl, cancelSteps, difficulty, extra]) => ({
  id,
  name,
  category,
  patterns,
  emailDomains,
  cancelUrl,
  cancelSteps,
  difficulty: difficulty ?? 'easy',
  ...extra,
}));

const BY_ID = new Map(MERCHANTS.map((m) => [m.id, m]));

export function getMerchant(id: string | undefined): Merchant | undefined {
  return id ? BY_ID.get(id) : undefined;
}

export function searchMerchants(query: string, limit = 10): Merchant[] {
  const q = query.trim().toLowerCase();
  if (!q) return MERCHANTS.slice(0, limit);
  return MERCHANTS.filter((m) => m.name.toLowerCase().includes(q) || m.id.includes(q)).slice(0, limit);
}

export function merchantByEmailDomain(fromAddress: string): Merchant | undefined {
  const domain = fromAddress.toLowerCase().match(/@([a-z0-9.-]+)/)?.[1];
  if (!domain) return undefined;
  return MERCHANTS.find((m) => m.emailDomains.some((d) => domain === d || domain.endsWith(`.${d}`)));
}

/** Finds a catalog merchant whose name appears in free text (e.g. an email subject). */
export function merchantByName(text: string): Merchant | undefined {
  const t = text.toLowerCase();
  let best: Merchant | undefined;
  for (const m of MERCHANTS) {
    const names = [m.name.toLowerCase(), m.name.toLowerCase().replace(/\s+(plus|pro|premium|super|\+)$/, '')];
    if (names.some((n) => n.length > 2 && new RegExp(`\\b${escapeRegExp(n)}(?![a-z])`).test(t))) {
      if (!best || m.name.length > best.name.length) best = m;
    }
  }
  return best;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
