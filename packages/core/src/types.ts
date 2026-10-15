/** Calendar dates are ISO `YYYY-MM-DD` strings; instants are full ISO timestamps. */
export type ISODate = string;
export type ISODateTime = string;

export type Cadence = 'weekly' | 'monthly' | 'quarterly' | 'annual';

export type ItemKind = 'subscription' | 'trial';

export type ItemStatus =
  | 'active' // recurring and expected to charge again
  | 'trial' // in a free trial, has not charged yet
  | 'cancel_pending' // user says they cancelled; waiting for the next statement to prove it
  | 'cancel_verified' // expected charge date passed with no charge: the product promise
  | 'charged_after_cancel' // a charge landed after cancellation (post-cancel check, F8)
  | 'dismissed'; // user said "this isn't a subscription"

/**
 * Where a fact came from. `forwarded` is something the signed-in user handed us (pasted in the app);
 * `inbound` arrived at their forwarding address, where anyone can send mail with any From line, so its
 * claimed sender can't be trusted.
 */
export type Source = 'bank' | 'email' | 'forwarded' | 'inbound' | 'manual' | 'app_store' | 'google_play';

/** Billing rails that hide the real merchant behind their own descriptor. */
export type PaymentRail = 'card' | 'paypal' | 'app_store' | 'google_play';

export type Plan = 'free' | 'plus';

export interface Transaction {
  id: string;
  accountId: string;
  date: ISODate;
  /** Positive for a debit. Refunds and credits are negative and ignored by detection. */
  amountCents: number;
  description: string;
  /** Human label such as "Visa ••4242". */
  paymentMethod: string;
}

export interface EmailMessage {
  id: string;
  from: string;
  subject: string;
  date: ISODateTime;
  /** Plain-text body. Processed in memory and never persisted. */
  body: string;
}

export type CancelDifficulty = 'easy' | 'medium' | 'hard';

export interface Merchant {
  id: string;
  name: string;
  category: string;
  /** Upper-case substrings matched against cleaned bank descriptors. */
  patterns: string[];
  /** Sender domains used to attribute emails. */
  emailDomains: string[];
  cancelUrl: string;
  cancelSteps: string[];
  difficulty: CancelDifficulty;
  phone?: string;
  /** Merchant supports done-for-you cancellation (F10). */
  conciergeSupported?: boolean;
}

export interface NormalizedMerchant {
  merchantId?: string;
  name: string;
  rail: PaymentRail;
  /** Key used to group charges from the same merchant. */
  key: string;
}

export interface PricePoint {
  date: ISODate;
  amountCents: number;
}

export interface RecurringCharge {
  key: string;
  merchantId?: string;
  name: string;
  rail: PaymentRail;
  cadence: Cadence;
  amountCents: number;
  lastChargeDate: ISODate;
  nextChargeDate: ISODate;
  paymentMethod: string;
  transactionIds: string[];
  priceHistory: PricePoint[];
  /** 0..1 */
  confidence: number;
}

export type EmailSignalKind = 'trial_signup' | 'receipt' | 'price_increase' | 'cancellation_confirmation';

export interface EmailSignal {
  kind: EmailSignalKind;
  emailId: string;
  merchantId?: string;
  serviceName: string;
  receivedAt: ISODate;
  priceCents?: number;
  cadence?: Cadence;
  trialDays?: number;
  /** Date the trial converts or the next renewal charges. */
  chargeDate?: ISODate;
  oldPriceCents?: number;
  effectiveDate?: ISODate;
  confidence: number;
  extractedBy: 'rules' | 'llm';
  /**
   * Lower-case domain of the sender's actual address (inside the angle brackets, never the display
   * name). A cancellation email for a catalog merchant only counts when this is one of the merchant's
   * email domains, because anyone can write "Your Netflix membership is cancelled" in a subject.
   */
  senderDomain?: string;
}

export interface PriceChange {
  oldCents: number;
  newCents: number;
  effectiveDate?: ISODate;
  detectedFrom: 'email' | 'charges';
}

export interface TrackedItem {
  id: string;
  /** Grouping key shared with bank descriptors (catalog id, or a cleaned descriptor). */
  matchKey: string;
  merchantId?: string;
  name: string;
  kind: ItemKind;
  status: ItemStatus;
  /** Price per cadence period (post-trial price for trials). 0 when unknown. */
  amountCents: number;
  cadence: Cadence;
  nextChargeDate?: ISODate;
  trialEndsAt?: ISODate;
  paymentMethod?: string;
  rail: PaymentRail;
  sources: Source[];
  confidence: number;
  confirmedByUser: boolean;
  transactionIds: string[];
  emailIds: string[];
  priceHistory: PricePoint[];
  priceChange?: PriceChange;
  cancelStartedAt?: ISODateTime;
  cancelledAt?: ISODate;
  cancelProof?: string;
  cancelVerifiedAt?: ISODate;
  /** Charge that landed after the user cancelled. */
  postCancelChargeIds?: string[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type AlertType = 'trial_converting' | 'renewal' | 'price_increase' | 'charge_after_cancel' | 'cancel_verified';
export type AlertChannel = 'push' | 'email';

export interface Alert {
  /** Deterministic so the daily re-check is idempotent. */
  id: string;
  itemId: string;
  type: AlertType;
  channel: AlertChannel;
  leadHours?: number;
  /** Lead-time alert sent late because its send moment had passed when the item was found; it cannot meet `leadHours`. */
  catchUp?: boolean;
  /** When the alert should go out. */
  sendAt: ISODateTime;
  /** The moment the alert is warning about (charge time). */
  dueAt?: ISODateTime;
  title: string;
  body: string;
}
