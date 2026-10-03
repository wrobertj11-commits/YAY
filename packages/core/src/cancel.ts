import { getMerchant } from './merchants.ts';
import type { CancelDifficulty, TrackedItem } from './types.ts';

export interface StateRight {
  state: string;
  law: string;
  summary: string;
}

/**
 * Cancellation rights cited in cancel guides. The FTC click-to-cancel rule was vacated in
 * July 2025, so guides cite ROSCA and state auto-renewal laws. Keep summaries plain and short;
 * they are information, not legal advice.
 */
const FEDERAL: StateRight = {
  state: 'US',
  law: 'Restore Online Shoppers’ Confidence Act (ROSCA)',
  summary: 'Online subscriptions must disclose terms before billing and give you a simple way to stop recurring charges.',
};

const STATE_RIGHTS: Record<string, StateRight> = {
  CA: {
    state: 'CA',
    law: 'California Automatic Renewal Law (Bus. & Prof. Code § 17600 et seq.)',
    summary: 'If you signed up online, the business must let you cancel online, without forcing a call or chat.',
  },
  NY: {
    state: 'NY',
    law: 'New York General Business Law § 527-a',
    summary: 'Auto-renewing offers must clearly disclose terms and provide an easy, cost-effective way to cancel; online sign-ups must be cancellable online.',
  },
  CO: {
    state: 'CO',
    law: 'Colorado automatic renewal law (C.R.S. § 6-1-732)',
    summary: 'Businesses must offer an easy cancellation method, including online for online sign-ups.',
  },
  VT: {
    state: 'VT',
    law: 'Vermont automatic renewal law (9 V.S.A. § 2454a)',
    summary: 'You must be able to cancel online if you signed up online.',
  },
  VA: {
    state: 'VA',
    law: 'Virginia automatic renewal law (Va. Code § 59.1-207.46)',
    summary: 'Businesses must provide a simple cancellation method, and online cancellation for online sign-ups.',
  },
};

export function cancellationRights(state?: string): StateRight[] {
  const local = state ? STATE_RIGHTS[state.toUpperCase()] : undefined;
  return local ? [local, FEDERAL] : [FEDERAL];
}

export type CancelMethod = 'deep_link' | 'app_store' | 'google_play' | 'paypal' | 'guide_only';

export interface CancelPlan {
  method: CancelMethod;
  url?: string;
  steps: string[];
  difficulty: CancelDifficulty;
  phone?: string;
  conciergeAvailable: boolean;
  rights: StateRight[];
  tips: string[];
}

const APP_STORE_URL = 'https://apps.apple.com/account/subscriptions';
const GOOGLE_PLAY_URL = 'https://play.google.com/store/account/subscriptions';

/** F5: the per-merchant deep link and step-by-step guide behind the Cancel button. */
export function buildCancelPlan(item: TrackedItem, userState?: string): CancelPlan {
  const merchant = getMerchant(item.merchantId);
  const rights = cancellationRights(userState);
  const tips = [
    'Expect a retention offer. You can say no; it does not affect your right to cancel.',
    'Screenshot the final confirmation screen or save the email. We use it as proof.',
  ];
  if (item.status === 'trial') tips.unshift('Most services keep your trial access until it ends, so cancelling now costs you nothing.');

  // Billing rail decides where the cancel happens, not the brand.
  if (item.rail === 'app_store') {
    return {
      method: 'app_store',
      url: APP_STORE_URL,
      steps: getMerchant('apple-app-store')!.cancelSteps,
      difficulty: 'easy',
      conciergeAvailable: false,
      rights,
      tips: ['This is billed by Apple, so cancel it in your Apple account, not with the app itself.', ...tips],
    };
  }
  if (item.rail === 'google_play') {
    return {
      method: 'google_play',
      url: GOOGLE_PLAY_URL,
      steps: getMerchant('google-play')!.cancelSteps,
      difficulty: 'easy',
      conciergeAvailable: false,
      rights,
      tips: ['This is billed by Google Play, so cancel it in the Play Store.', ...tips],
    };
  }
  if (merchant) {
    const steps = [...merchant.cancelSteps];
    if (item.rail === 'paypal') steps.push('Also remove the automatic payment at paypal.com → Settings → Payments → Manage automatic payments.');
    return {
      method: 'deep_link',
      url: merchant.cancelUrl,
      steps,
      difficulty: merchant.difficulty,
      phone: merchant.phone,
      conciergeAvailable: Boolean(merchant.conciergeSupported),
      rights,
      tips,
    };
  }
  if (item.rail === 'paypal') {
    return {
      method: 'paypal',
      url: 'https://www.paypal.com/myaccount/autopay/',
      steps: [
        'Cancel in your account with the service first, if you can find it.',
        'Then open PayPal → Settings → Payments → Manage automatic payments.',
        'Select the merchant and choose Cancel.',
      ],
      difficulty: 'medium',
      conciergeAvailable: false,
      rights,
      tips,
    };
  }
  return {
    method: 'guide_only',
    steps: [
      `Sign in to your ${item.name} account on the web and look for Account, Billing, Plan or Subscription.`,
      'Choose Cancel (or turn off auto-renew) and confirm.',
      'No online option? Email support and ask for written confirmation. If you signed up online, cite your rights below.',
    ],
    difficulty: 'medium',
    conciergeAvailable: false,
    rights,
    tips,
  };
}
