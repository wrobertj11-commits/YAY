import { getMerchant } from './merchants.ts';
import type { CancelDifficulty, ISODate, TrackedItem } from './types.ts';

export interface StateRight {
  state: string;
  law: string;
  summary: string;
}

/**
 * Cancellation rights cited in cancel guides. The FTC click-to-cancel rule was vacated in
 * July 2025, so guides cite ROSCA and state auto-renewal laws. Keep summaries plain and short;
 * they are information, not legal advice.
 *
 * Coverage is partial on purpose: only the states below have a summary. Other states are believed to have
 * automatic-renewal laws too, and are listed here as leads for counsel, not as statements of law. Which of
 * them apply to consumer subscriptions, what they require and when they took effect is to be confirmed by
 * counsel before any summary is added: CT, DC, DE, FL, GA, HI, ID, IL, LA, ME, MN, NC, ND, NH, OR, SD, TN, UT.
 * The list itself is not exhaustive and also needs counsel's check (newer or amended laws included).
 * Users in those states get the federal entry only. Any wording change here bumps RIGHTS_CONTENT_VERSION.
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

/**
 * When counsel last reviewed the rights wording (FEDERAL and STATE_RIGHTS), or null if never.
 * No lawyer has reviewed it yet. Set it only after a review of the current RIGHTS_CONTENT_VERSION.
 */
export const RIGHTS_LAST_REVIEWED: ISODate | null = null;

/** True until counsel signs off on the current wording; clients must show it as unreviewed general information. */
export const RIGHTS_NEEDS_COUNSEL_REVIEW: boolean = true;

/** Identifies the wording users saw (support and audit trails). Bump on any edit to FEDERAL or STATE_RIGHTS. */
export const RIGHTS_CONTENT_VERSION = '2026-10-03';

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
  /** Review status of `rights`, so the UI can label unreviewed legal content as such. */
  rightsLastReviewed: ISODate | null;
  rightsNeedCounselReview: boolean;
  rightsContentVersion: string;
  tips: string[];
}

const APP_STORE_URL = 'https://apps.apple.com/account/subscriptions';
const GOOGLE_PLAY_URL = 'https://play.google.com/store/account/subscriptions';

/** F5: the per-merchant deep link and step-by-step guide behind the Cancel button. */
export function buildCancelPlan(item: TrackedItem, userState?: string): CancelPlan {
  const merchant = getMerchant(item.merchantId);
  const rights = cancellationRights(userState);
  const review = {
    rightsLastReviewed: RIGHTS_LAST_REVIEWED,
    rightsNeedCounselReview: RIGHTS_NEEDS_COUNSEL_REVIEW,
    rightsContentVersion: RIGHTS_CONTENT_VERSION,
  };
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
      ...review,
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
      ...review,
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
      ...review,
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
      ...review,
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
    ...review,
    tips,
  };
}
