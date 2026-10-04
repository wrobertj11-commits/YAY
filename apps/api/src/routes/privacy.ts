import { toISODate } from '@trialguard/core';
import { config } from '../config.ts';
import { Reply } from '../http.ts';
import { MAX_BODY_CHARS } from '../llm.ts';
import { PlaidBank } from '../providers/bank.ts';
import type {
  AuditEntry,
  BillingSubscription,
  BrokenLinkReport,
  ConciergeRequest,
  Connection,
  Data,
  Device,
  OutboxAlert,
  Store,
  StoredSignal,
  User,
} from '../store.ts';
import type { RouteDeps } from './shared.ts';

/**
 * Data export (right to access) and the privacy disclosures shown in the app.
 *
 * The disclosures are generated from this server's configuration, so the copy can't drift from what the
 * pipeline does: when LLM extraction is on, users are told that email text goes to Anthropic.
 */

// ---------- disclosures ----------

/** What the email-filter screen says. `llmExtraction` is whether this server sends emails to the LLM step. */
export function emailFilterDescription(llmExtraction: boolean): string {
  const read = 'We only read emails whose subject looks like a receipt, signup, renewal, price change or cancellation.';
  const kept = 'Trialguard keeps only the extracted fields (service, price, dates); the email itself is not stored.';
  if (!llmExtraction) return `${read} ${kept}`;
  return (
    `${read} When our rules can't fully read one of those emails, its sender, subject and text are sent to ` +
    `Anthropic, an AI provider, to extract the service, price and dates. ${kept}`
  );
}

export interface Processor {
  name: string;
  purpose: string;
  /** What Trialguard sends it, or what it collects from the user on Trialguard's behalf. */
  receives: string[];
  /** What it gives back to Trialguard, for services that are a source of the user's data. */
  provides?: string[];
  when: string;
  /** Whether this server is set up to use it. Omitted where that depends on deployment settings the API doesn't track. */
  enabled?: boolean;
}

export interface PrivacyDisclosures {
  llmExtraction: boolean;
  emailHandling: string;
  processors: Processor[];
  retention: { data: string; kept: string }[];
}

export function privacyDisclosures(llmExtraction: boolean): PrivacyDisclosures {
  const alertText = 'Alert text: the service name, amount and date';
  return {
    llmExtraction,
    emailHandling: emailFilterDescription(llmExtraction),
    processors: [
      {
        name: 'Plaid',
        purpose: 'Read-only bank and card connection',
        receives: ["Your bank sign-in, entered in Plaid's own window (Trialguard never sees it)", 'An internal Trialguard id that links the connection to your account'],
        provides: ['Transactions: date, amount, merchant description and the card or account label'],
        when: 'Only if you connect a bank account.',
        enabled: PlaidBank.configured(),
      },
      {
        name: 'Google (Gmail API)',
        purpose: 'Read-only access to matching emails',
        receives: ['Searches limited to the receipt and signup filter, sent with the access you granted'],
        provides: ['Sender, subject, date and text of matching emails'],
        when: 'Only if you connect Gmail.',
      },
      {
        name: 'Microsoft (Microsoft Graph)',
        purpose: 'Read-only access to matching emails',
        receives: ['Searches limited to the receipt and signup filter, sent with the access you granted'],
        provides: ['Sender, subject, date and text of matching emails'],
        when: 'Only if you connect Outlook.',
      },
      {
        name: 'Anthropic',
        purpose: 'AI extraction of the service, price and dates from emails our rules cannot fully read',
        receives: [`Sender, subject, received date and text of those emails (the text is capped at ${MAX_BODY_CHARS.toLocaleString('en-US')} characters)`],
        when: llmExtraction
          ? 'Only for emails that match the filter (from a connected inbox, or that you forward or paste) and that our rules cannot fully parse.'
          : 'Not used: AI extraction is turned off on this server.',
        enabled: llmExtraction,
      },
      {
        name: 'Apple Push Notification service / Firebase Cloud Messaging',
        purpose: 'Push alerts on your phone',
        receives: ["Your device's push token", alertText],
        when: 'Only if push alerts are on for a device.',
      },
      {
        name: 'Postmark',
        purpose: 'Alert emails',
        receives: ['Your email address', `${alertText}, and an unsubscribe link`],
        when: 'Only if email alerts are on.',
      },
      {
        name: 'Inbound email provider',
        purpose: 'Receives mail sent to your Trialguard forwarding address',
        receives: ['The full content of emails you forward to that address'],
        when: 'Only for emails you forward.',
      },
      {
        name: 'Apple App Store / Google Play',
        purpose: 'Trialguard Plus purchases',
        receives: ['A random account token that links your purchase to your Trialguard account'],
        provides: ['Your Plus subscription status and renewal date'],
        when: 'Only if you buy Trialguard Plus.',
      },
    ],
    retention: [
      { data: 'Email text', kept: 'Not stored by Trialguard. It is held in memory while the fields are extracted.' },
      { data: 'Fields extracted from emails', kept: 'Until you delete your account.' },
      { data: 'Bank transactions', kept: 'Until you disconnect that bank or delete your account.' },
      { data: 'Subscriptions, alerts, devices, purchases and concierge requests', kept: 'Until you delete your account.' },
      { data: 'Audit log of sensitive actions', kept: 'Deleted with your account, except a record that the deletion happened.' },
    ],
  };
}

// ---------- export ----------

export const EXPORT_VERSION = 1;

/**
 * How one stored field appears in an export: kept, omitted (secrets and internal bookkeeping), or
 * transformed (e.g. masked). Policies are total over each stored type, so adding a field to a stored
 * record fails to compile here until someone decides whether users get it back.
 */
type FieldRule<V> = 'keep' | 'omit' | ((value: V) => unknown);
type FieldPolicy<T> = { readonly [K in keyof T]-?: FieldRule<NonNullable<T[K]>> };

/** Keeps the last 4 characters: enough to tell two devices or purchases apart, useless as a credential. */
export function maskToken(value: unknown): string {
  const s = String(value);
  return s.length > 8 ? `…${s.slice(-4)}` : '…';
}

function exportRow<T extends object>(row: T, policy: FieldPolicy<T>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(policy) as (keyof T & string)[]) {
    const rule = policy[key] as FieldRule<unknown>;
    const value = row[key];
    if (rule === 'omit' || value === undefined) continue;
    out[key] = rule === 'keep' || value === null ? value : rule(value);
  }
  return out;
}

const USER_FIELDS: FieldPolicy<User> = {
  id: 'keep',
  email: 'keep',
  token: 'omit', // the sign-in credential
  plan: 'keep',
  state: 'keep',
  forwardToken: 'omit', // exported as part of forwardingAddress
  alertPrefs: 'omit', // its own section
  createdAt: 'keep',
  lastSyncAt: 'keep',
  firstFoundAt: 'keep',
  emailUnsubscribedAt: 'keep',
  emailVerifiedAt: 'keep',
  emailVerification: 'omit', // a short-lived code hash: a credential while it lasts, and meaningless after
  billingAccountToken: maskToken,
};

const CONNECTION_FIELDS: FieldPolicy<Connection> = {
  id: 'keep',
  userId: 'omit', // the exporting user
  type: 'keep',
  provider: 'keep',
  label: 'keep',
  sealedToken: 'omit', // encrypted provider access token
  externalId: maskToken,
  cursor: 'omit', // Plaid's opaque sync position
  status: 'keep',
  error: 'keep',
  createdAt: 'keep',
  lastSyncedAt: 'keep',
};

const TRANSACTION_FIELDS: FieldPolicy<Data['transactions'][number]> = {
  id: 'keep',
  accountId: 'keep',
  date: 'keep',
  amountCents: 'keep',
  description: 'keep',
  paymentMethod: 'keep',
  userId: 'omit',
  connectionId: 'keep',
};

const SIGNAL_FIELDS: FieldPolicy<StoredSignal> = {
  kind: 'keep',
  emailId: 'keep',
  merchantId: 'keep',
  serviceName: 'keep',
  receivedAt: 'keep',
  priceCents: 'keep',
  cadence: 'keep',
  trialDays: 'keep',
  chargeDate: 'keep',
  oldPriceCents: 'keep',
  effectiveDate: 'keep',
  confidence: 'keep',
  extractedBy: 'keep',
  senderDomain: 'keep',
  userId: 'omit',
  source: 'keep',
};

const ITEM_FIELDS: FieldPolicy<Data['items'][number]> = {
  id: 'keep',
  matchKey: 'keep',
  merchantId: 'keep',
  name: 'keep',
  kind: 'keep',
  status: 'keep',
  amountCents: 'keep',
  cadence: 'keep',
  nextChargeDate: 'keep',
  trialEndsAt: 'keep',
  paymentMethod: 'keep',
  rail: 'keep',
  sources: 'keep',
  confidence: 'keep',
  confirmedByUser: 'keep',
  transactionIds: 'keep',
  emailIds: 'keep',
  priceHistory: 'keep',
  priceChange: 'keep',
  cancelStartedAt: 'keep',
  cancelledAt: 'keep',
  cancelProof: 'keep',
  cancelVerifiedAt: 'keep',
  postCancelChargeIds: 'keep',
  createdAt: 'keep',
  updatedAt: 'keep',
  userId: 'omit',
};

const ALERT_FIELDS: FieldPolicy<OutboxAlert> = {
  id: 'keep',
  itemId: 'keep',
  type: 'keep',
  channel: 'keep',
  leadHours: 'keep',
  catchUp: 'keep',
  sendAt: 'keep',
  dueAt: 'keep',
  title: 'keep',
  body: 'keep',
  userId: 'omit',
  status: 'keep',
  attempts: 'keep',
  claimedBy: 'omit', // which server instance sent it
  claimedAt: 'omit',
  nextAttemptAt: 'keep',
  skipReason: 'keep',
  lastError: 'omit', // delivery-provider diagnostics; status and attempts say what happened
  sentAt: 'keep',
  readAt: 'keep',
};

const DEVICE_FIELDS: FieldPolicy<Device> = {
  id: 'keep',
  userId: 'omit',
  platform: 'keep',
  pushToken: maskToken, // anyone holding the full token (and our push keys) could message the device
  appVersion: 'keep',
  createdAt: 'keep',
  lastSeenAt: 'keep',
  disabledAt: 'keep',
};

const BILLING_FIELDS: FieldPolicy<BillingSubscription> = {
  id: 'keep',
  userId: 'omit',
  platform: 'keep',
  productId: 'keep',
  externalId: maskToken, // Play purchase tokens are credentials for the store's purchase APIs
  status: 'keep',
  expiresAt: 'keep',
  gracePeriodExpiresAt: 'keep',
  autoRenew: 'keep',
  environment: 'keep',
  lastEventAt: 'keep',
  createdAt: 'keep',
  updatedAt: 'keep',
};

const CONCIERGE_FIELDS: FieldPolicy<ConciergeRequest> = {
  id: 'keep',
  userId: 'omit',
  itemId: 'keep',
  feeCents: 'keep',
  status: 'keep',
  authorization: 'keep', // the user's own signature, IP and browser at signing
  assignedTo: 'omit', // staff identity; status says where the request is
  merchantId: 'keep',
  claimedAt: 'keep',
  closedAt: 'keep',
  proof: 'keep', // the cancellation evidence staff captured for the user
  note: 'keep', // shown to the user already (e.g. why a request failed)
  createdAt: 'keep',
  updatedAt: 'keep',
};

const BROKEN_LINK_FIELDS: FieldPolicy<BrokenLinkReport> = {
  merchantId: 'keep',
  userId: 'omit',
  note: 'keep',
  createdAt: 'keep',
};

const AUDIT_FIELDS: FieldPolicy<AuditEntry> = {
  id: 'keep',
  at: 'keep',
  // Staff are named by role, not identity.
  actor: (a) => (a.type === 'staff' ? { type: 'staff' } : a),
  action: 'keep',
  userId: 'omit',
  subject: 'keep',
  details: 'keep',
};

const ABOUT = [
  'Everything Trialguard holds about your account at exportedAt, in JSON.',
  'Email text is never stored, so it is not in this file. emailSignals lists the fields extracted from each email that was read.',
  'Left out for security: your sign-in token and the encrypted bank and inbox access tokens. Push tokens, purchase ids and connection ids are cut to their last 4 characters.',
  'Left out as internal bookkeeping: bank sync positions, which server sent an alert, delivery-provider error messages, and which staff member handles a concierge request.',
  'Operational server logs are not included. They are built to exclude email content, addresses and tokens.',
  'disclosures lists the service providers that process your data and what each one receives.',
];

/** A complete, machine-readable copy of one user's data. Rows are filtered by user id, collection by collection. */
export function buildExport(store: Store, user: User, now: Date, llmExtraction: boolean) {
  const d = store.data;
  const mine = <T extends { userId?: string }>(rows: T[]) => rows.filter((r) => r.userId === user.id);
  return {
    format: 'trialguard-export',
    version: EXPORT_VERSION,
    exportedAt: now.toISOString(),
    about: ABOUT,
    profile: { ...exportRow(user, USER_FIELDS), forwardingAddress: `u-${user.forwardToken}@${config.inboundDomain}` },
    alertPrefs: user.alertPrefs,
    connections: mine(d.connections).map((r) => exportRow(r, CONNECTION_FIELDS)),
    transactions: mine(d.transactions).map((r) => exportRow(r, TRANSACTION_FIELDS)),
    emailSignals: mine(d.signals).map((r) => exportRow(r, SIGNAL_FIELDS)),
    items: mine(d.items).map((r) => exportRow(r, ITEM_FIELDS)),
    alerts: mine(d.alerts).map((r) => exportRow(r, ALERT_FIELDS)),
    devices: mine(d.devices).map((r) => exportRow(r, DEVICE_FIELDS)),
    billing: mine(d.billing).map((r) => exportRow(r, BILLING_FIELDS)),
    concierge: mine(d.concierge).map((r) => exportRow(r, CONCIERGE_FIELDS)),
    brokenLinkReports: mine(d.brokenLinks).map((r) => exportRow(r, BROKEN_LINK_FIELDS)),
    audit: mine(d.audit).map((r) => exportRow(r, AUDIT_FIELDS)),
    disclosures: privacyDisclosures(llmExtraction),
  };
}

export function register({ router, store, deps }: RouteDeps): void {
  /** Public: the app shows this before anyone connects anything. */
  router.on('GET', '/api/privacy', { auth: 'none' }, () => privacyDisclosures(Boolean(deps.llm)));

  router.on('GET', '/api/me/export', { limit: 'export' }, ({ user, log }) => {
    const now = deps.clock();
    const body = JSON.stringify(buildExport(store, user, now, Boolean(deps.llm)), null, 2);
    store.audit({
      actor: { type: 'user', id: user.id },
      userId: user.id,
      action: 'data.exported',
      details: { format: 'json', version: EXPORT_VERSION },
      at: now.toISOString(),
    });
    log.info('data exported', { bytes: Buffer.byteLength(body) });
    return new Reply(200, body, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="trialguard-export-${toISODate(now)}.json"`,
    });
  });
}
