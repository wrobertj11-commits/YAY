import { createHash } from 'node:crypto';
import { getMerchant } from '@trialguard/core';

/**
 * F10 written authorization. Staff act for a user only after the user has read this text, typed their name
 * and ticked "I authorize". The request keeps the version, a hash of the exact text (merchant name filled
 * in), the time, IP and user agent, so it can be shown later exactly what was agreed and when.
 *
 * DRAFT: counsel has not reviewed this wording. Any edit to the text bumps AUTHORIZATION_TEXT_VERSION; the
 * API then refuses requests signed against the old version, so clients must show the new text first.
 * Requests already signed keep the version they were signed under.
 */
export const AUTHORIZATION_TEXT_VERSION = '2026-10-04-draft.1';

/** True until counsel signs off on the wording; clients show it as a draft and the text says so. */
export const AUTHORIZATION_IS_DRAFT: boolean = true;

/** Used when the text is fetched without a merchant (e.g. for review). Requests always name one. */
const ANY_MERCHANT = 'the company named in your request';

/**
 * Plain-language limited authorization, scoped to one merchant and one purpose. It promises only what the
 * system enforces: staff tools never return bank transactions or tokens, a withdrawal closes the request,
 * and the ops API refuses to act on a closed one.
 */
export function authorizationText(merchantName: string = ANY_MERCHANT): string {
  const m = merchantName;
  return [
    'DRAFT: pending review by counsel. This wording may change before launch.',
    '',
    `Limited authorization to cancel ${m}`,
    '',
    `I authorize Trialguard staff to act for me with ${m} for one purpose only: to cancel my ${m} subscription and to ask ${m} for any refund I may be owed.`,
    '',
    'What Trialguard staff may do',
    `• Sign in to my ${m} account, or contact ${m} through its website, chat, email or phone, to cancel this subscription.`,
    `• Ask ${m} to refund charges I may be owed. Any refund is paid back to me by ${m}, never to Trialguard.`,
    `• Give ${m} my name and email address so it can find my account.`,
    '• Keep proof of what was done, such as a confirmation number, and show it to me in the app.',
    '',
    'What Trialguard staff will not do',
    '• Buy anything, change my plan, accept an offer or discount, or pause the subscription instead of cancelling it.',
    '• Change my password, email address, payment details or any other account setting.',
    '• Act for me with any other company, or for any other purpose.',
    '• Look at my bank transactions or connected inbox to do this.',
    '',
    'How long it lasts and how to revoke it',
    '• It ends when the request is done or can’t be completed.',
    `• I can withdraw the request at any time before then from the ${m} page in the Trialguard app. Withdrawing revokes this authorization. Steps already taken with ${m} before I withdraw may not be reversible.`,
    '',
    'Records',
    '• Trialguard keeps a record of this authorization (the name I typed, the time, my IP address and browser) as evidence that I gave it.',
    '',
    `Trialguard is not affiliated with ${m}. This is not a payment authorization: any fee is shown separately before I submit.`,
  ].join('\n');
}

/** SHA-256 (hex) of the text as shown, stored with each signature. */
export function authorizationDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Response of GET /api/concierge/authorization-text. Merchant names are public catalog data. */
export function renderAuthorization(merchantId?: string) {
  const merchantName = getMerchant(merchantId)?.name;
  return {
    version: AUTHORIZATION_TEXT_VERSION,
    draft: AUTHORIZATION_IS_DRAFT,
    merchantName: merchantName ?? null,
    text: authorizationText(merchantName),
  };
}
