import { accessSync, constants, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeAlertPrefs, type Alert, type AlertPrefs, type EmailSignal, type Plan, type Source, type TrackedItem, type Transaction } from '@trialguard/core';

export interface User {
  id: string;
  email: string;
  token: string;
  /**
   * Effective plan. Written by the billing module from verified App Store / Play notifications
   * (and by the dev-only plan switch). Read everywhere entitlements are checked.
   */
  plan: Plan;
  /** Two-letter US state, used to cite cancellation rights. */
  state?: string;
  forwardToken: string;
  alertPrefs: AlertPrefs;
  createdAt: string;
  lastSyncAt?: string;
  firstFoundAt?: string;
  /** Set when the user unsubscribes from alert emails via the one-click link. */
  emailUnsubscribedAt?: string;
}

export type ConnectionType = 'bank' | 'gmail' | 'outlook';

export interface Connection {
  id: string;
  userId: string;
  type: ConnectionType;
  provider: 'sandbox' | 'plaid' | 'gmail' | 'outlook';
  label: string;
  /** Encrypted provider token (keyring envelope); never returned by the API. */
  sealedToken?: string;
  /** Provider-side id (Plaid item_id), used to route webhooks. */
  externalId?: string;
  cursor?: string;
  /**
   * active: syncing normally. error: last sync failed. reauth_required: the user must re-link
   * (Plaid ITEM_LOGIN_REQUIRED / expired OAuth). pending_expiration: consent expires soon.
   */
  status: 'active' | 'error' | 'reauth_required' | 'pending_expiration';
  error?: string;
  createdAt: string;
  lastSyncedAt?: string;
}

/** Only extracted fields are stored for emails; bodies are discarded after extraction. */
export type StoredSignal = EmailSignal & { userId: string; source: Source };

export type DeliveryStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';

export interface OutboxAlert extends Alert {
  userId: string;
  /** Lifecycle for send-once delivery. `id` is the idempotency key. */
  status: DeliveryStatus;
  attempts: number;
  /** Instance that claimed the alert, and when (lease). */
  claimedBy?: string;
  claimedAt?: string;
  /** After a failed attempt: not before this time (exponential backoff). */
  nextAttemptAt?: string;
  /** Why a `skipped` alert was not sent (unsubscribed, item gone, ...). */
  skipReason?: string;
  lastError?: string;
  sentAt?: string;
  readAt?: string;
}

export interface Device {
  id: string;
  userId: string;
  platform: 'ios' | 'android' | 'web';
  /** APNs device token / FCM registration token. */
  pushToken: string;
  appVersion?: string;
  createdAt: string;
  lastSeenAt: string;
  /** Set when the push provider reports the token as invalid. */
  disabledAt?: string;
}

export interface BillingSubscription {
  id: string;
  userId: string;
  platform: 'app_store' | 'google_play';
  productId: string;
  /** App Store originalTransactionId, or Play purchaseToken. */
  externalId: string;
  status: 'active' | 'grace_period' | 'billing_retry' | 'expired' | 'revoked' | 'refunded' | 'paused';
  expiresAt?: string;
  autoRenew?: boolean;
  environment?: string;
  updatedAt: string;
}

/** Processed webhook ids, for idempotency and replay protection. */
export interface WebhookEvent {
  id: string;
  provider: 'app_store' | 'google_play' | 'plaid' | 'inbound_email';
  receivedAt: string;
}

/** Append-only record of sensitive actions (concierge, billing, data export, deletion). */
export interface AuditEntry {
  id: string;
  at: string;
  actor: { type: 'user' | 'staff' | 'system'; id: string };
  action: string;
  userId?: string;
  subject?: { type: string; id: string };
  details?: Record<string, unknown>;
}

export interface ConciergeAuthorization {
  /** Version of the authorization text the user agreed to. */
  textVersion: string;
  /** Name the user typed as their signature. */
  signedName: string;
  signedAt: string;
  ip?: string;
  userAgent?: string;
}

export interface ConciergeRequest {
  id: string;
  userId: string;
  itemId: string;
  feeCents: number;
  status: 'queued' | 'in_progress' | 'done' | 'failed' | 'cancelled';
  authorization?: ConciergeAuthorization;
  assignedTo?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface BrokenLinkReport {
  merchantId: string;
  userId: string;
  note?: string;
  createdAt: string;
}

export interface Data {
  users: User[];
  connections: Connection[];
  transactions: (Transaction & { userId: string; connectionId: string })[];
  signals: StoredSignal[];
  items: (TrackedItem & { userId: string })[];
  alerts: OutboxAlert[];
  devices: Device[];
  billing: BillingSubscription[];
  webhookEvents: WebhookEvent[];
  audit: AuditEntry[];
  concierge: ConciergeRequest[];
  brokenLinks: BrokenLinkReport[];
}

const empty = (): Data => ({
  users: [],
  connections: [],
  transactions: [],
  signals: [],
  items: [],
  alerts: [],
  devices: [],
  billing: [],
  webhookEvents: [],
  audit: [],
  concierge: [],
  brokenLinks: [],
});

/** Brings data written by older versions up to the current shape. */
function migrate(raw: Partial<Data>): Data {
  const data: Data = { ...empty(), ...raw };
  for (const u of data.users) u.alertPrefs = normalizeAlertPrefs(u.alertPrefs);
  for (const a of data.alerts) {
    a.status ??= a.sentAt ? 'sent' : 'pending';
    a.attempts ??= a.sentAt ? 1 : 0;
  }
  return data;
}

/**
 * A small JSON-file store so the MVP runs with zero infrastructure. The interface is narrow on
 * purpose: swap it for Postgres (with encryption at rest) without touching routes or the pipeline.
 * It is single-process: background jobs take a lock file (see jobs.ts) so only one instance runs them.
 */
export class Store {
  data: Data;
  private file?: string;
  private timer?: NodeJS.Timeout;

  constructor(file?: string) {
    this.file = file;
    this.data = empty();
    if (file) {
      let raw: string | undefined;
      try {
        raw = readFileSync(file, 'utf8');
      } catch {
        // first run
      }
      if (raw !== undefined) this.data = migrate(JSON.parse(raw) as Partial<Data>);
    }
  }

  /** Debounced write-through; call after every mutation. */
  save(): void {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.flush(), 50);
  }

  /** Synchronous, atomic write (temp file + rename). Use before side effects that must not repeat. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.file);
  }

  /** Readiness: can we persist? In-memory stores always can. */
  writable(): boolean {
    if (!this.file) return true;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      accessSync(path.dirname(this.file), constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  userByToken(token: string): User | undefined {
    return this.data.users.find((u) => u.token === token);
  }

  itemsFor(userId: string) {
    return this.data.items.filter((i) => i.userId === userId);
  }

  audit(entry: Omit<AuditEntry, 'id' | 'at'> & { at?: string }): void {
    this.data.audit.push({ id: `aud_${this.data.audit.length + 1}_${Date.now().toString(36)}`, at: entry.at ?? new Date().toISOString(), ...entry });
    this.save();
  }

  /** True the first time an event id is seen; false for retries and replays. */
  markWebhookProcessed(provider: WebhookEvent['provider'], id: string, at: string): boolean {
    if (this.data.webhookEvents.some((e) => e.provider === provider && e.id === id)) return false;
    this.data.webhookEvents.push({ provider, id, receivedAt: at });
    // Keep the dedupe window bounded.
    if (this.data.webhookEvents.length > 50_000) this.data.webhookEvents.splice(0, 10_000);
    this.save();
    return true;
  }

  /** One-tap account and data deletion. The audit trail keeps only the fact that deletion happened. */
  deleteUser(userId: string): void {
    const d = this.data;
    d.users = d.users.filter((u) => u.id !== userId);
    d.connections = d.connections.filter((c) => c.userId !== userId);
    d.transactions = d.transactions.filter((t) => t.userId !== userId);
    d.signals = d.signals.filter((s) => s.userId !== userId);
    d.items = d.items.filter((i) => i.userId !== userId);
    d.alerts = d.alerts.filter((a) => a.userId !== userId);
    d.devices = d.devices.filter((x) => x.userId !== userId);
    d.billing = d.billing.filter((b) => b.userId !== userId);
    d.concierge = d.concierge.filter((c) => c.userId !== userId);
    d.brokenLinks = d.brokenLinks.filter((b) => b.userId !== userId);
    d.audit = d.audit.filter((a) => a.userId !== userId || a.action === 'account.deleted');
    this.save();
  }
}
