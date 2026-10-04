/** Shapes returned by the Trialguard API (see apps/api/src/app.ts). */

export type Cadence = 'weekly' | 'monthly' | 'quarterly' | 'annual';
export type Status = 'active' | 'trial' | 'cancel_pending' | 'cancel_verified' | 'charged_after_cancel' | 'dismissed';

export interface Connection {
  id: string;
  type: 'bank' | 'gmail' | 'outlook';
  provider: string;
  label: string;
  status: 'active' | 'error' | 'reauth_required' | 'pending_expiration';
  error?: string;
  lastSyncedAt?: string;
}

export type AlertType = 'trial_converting' | 'renewal' | 'price_increase' | 'charge_after_cancel' | 'cancel_verified';

export interface AlertPrefs {
  push: boolean;
  email: boolean;
  types: Record<AlertType, boolean>;
  quietHours: { start: string; end: string } | null;
  timeZone: string;
}

export interface Me {
  id: string;
  email: string;
  /** False until the code sent to `email` is entered; alert emails wait for it. */
  emailVerified: boolean;
  plan: 'free' | 'plus';
  state?: string;
  alertPrefs: AlertPrefs;
  /** Dev builds allow plan switching and email-only sign-in. */
  devMode: boolean;
  forwardingAddress: string;
  entitlements: { maxTrialAlerts: number | null; priceHikeAlerts: boolean; postCancelCheck: boolean; savingsTracker: boolean };
  connections: Connection[];
  lastSyncAt?: string;
}

/** POST /api/auth/email/send-code. `devCode` comes back only from a dev server with no email sender. */
export interface EmailCodeSent {
  sent: boolean;
  expiresAt: string;
  devCode?: string;
}

export interface Item {
  id: string;
  name: string;
  merchantId?: string;
  kind: 'subscription' | 'trial';
  status: Status;
  amountCents: number;
  cadence: Cadence;
  nextChargeDate?: string;
  trialEndsAt?: string;
  paymentMethod?: string;
  rail: 'card' | 'paypal' | 'app_store' | 'google_play';
  sources: string[];
  confidence: number;
  confirmedByUser: boolean;
  priceChange?: { oldCents: number; newCents: number; effectiveDate?: string; detectedFrom: string };
  cancelledAt?: string;
  cancelProof?: string;
  cancelVerifiedAt?: string;
  cancelStartedAt?: string;
  postCancelChargeIds?: string[];
  category: string;
  cancelDifficulty?: 'easy' | 'medium' | 'hard';
  daysUntilCharge?: number;
  yearlyCents: number;
  alertsOn: boolean;
  needsReview: boolean;
}

export interface CancelPlan {
  method: 'deep_link' | 'app_store' | 'google_play' | 'paypal' | 'guide_only';
  url?: string;
  steps: string[];
  difficulty: 'easy' | 'medium' | 'hard';
  phone?: string;
  conciergeAvailable: boolean;
  rights: { state: string; law: string; summary: string }[];
  /** ISO date of the last legal review of the rights wording, or null if it hasn't had one. */
  rightsLastReviewed: string | null;
  rightsNeedCounselReview: boolean;
  tips: string[];
}

export interface ItemDetail extends Item {
  transactions: { id: string; date: string; amountCents: number; description: string; paymentMethod: string }[];
  cancelPlan: CancelPlan;
}

export type ConciergeStatus = 'queued' | 'in_progress' | 'done' | 'failed' | 'cancelled';

/** A done-for-you cancellation request (GET /api/concierge). `cancelled` means the user withdrew it. */
export interface ConciergeRequest {
  id: string;
  itemId: string;
  itemName?: string;
  merchantName?: string;
  status: ConciergeStatus;
  feeCents: number;
  /** From our team: what happened, or why it couldn't be done. */
  note?: string;
  /** Cancellation proof our team captured (confirmation number, email reference). */
  proof?: string;
  createdAt: string;
  updatedAt?: string;
  closedAt?: string;
  authorization: { textVersion: string; signedName: string; signedAt: string; revokedAt?: string } | null;
}

/** GET /api/concierge/authorization-text. Submitting requires the same `version`. */
export interface ConciergeAuthorizationText {
  version: string;
  /** True until counsel has reviewed the wording. */
  draft: boolean;
  merchantName: string | null;
  text: string;
}

export interface Summary {
  monthlyCents: number;
  yearlyCents: number;
  activeCount: number;
  trialCount: number;
  trialsMonthlyCents: number;
  savedSoFarCents: number | null;
  verifiedSavedCents: number | null;
  projectedYearlySavingsCents: number;
  cancelledCount: number;
  plusPrice: { monthlyCents: number; yearlyCents: number };
}

export interface Alert {
  id: string;
  itemId: string;
  type: string;
  title: string;
  body: string;
  sendAt: string;
  sentAt?: string;
  readAt?: string;
}

export interface SyncSummary {
  itemsFound: number;
  trials: number;
  newItems: number;
  errors: string[];
}

const TOKEN_KEY = 'trialguard.token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable (private mode); session lasts until reload
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json.error ?? `Request failed (${res.status})`);
  return json as T;
}
