import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Alert, EmailSignal, Plan, Source, TrackedItem, Transaction } from '@trialguard/core';
import type { AlertPrefs } from '@trialguard/core';

export interface User {
  id: string;
  email: string;
  token: string;
  plan: Plan;
  /** Two-letter US state, used to cite cancellation rights. */
  state?: string;
  forwardToken: string;
  alertPrefs: AlertPrefs;
  createdAt: string;
  lastSyncAt?: string;
  firstFoundAt?: string;
}

export type ConnectionType = 'bank' | 'gmail' | 'outlook';

export interface Connection {
  id: string;
  userId: string;
  type: ConnectionType;
  provider: 'sandbox' | 'plaid' | 'gmail' | 'outlook';
  label: string;
  /** Encrypted provider token; never returned by the API. */
  sealedToken?: string;
  cursor?: string;
  status: 'active' | 'error';
  error?: string;
  createdAt: string;
  lastSyncedAt?: string;
}

/** Only extracted fields are stored for emails; bodies are discarded after extraction. */
export type StoredSignal = EmailSignal & { userId: string; source: Source };

export interface OutboxAlert extends Alert {
  userId: string;
  sentAt?: string;
  readAt?: string;
}

export interface ConciergeRequest {
  id: string;
  userId: string;
  itemId: string;
  feeCents: number;
  status: 'queued' | 'in_progress' | 'done' | 'failed';
  createdAt: string;
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
  concierge: ConciergeRequest[];
  brokenLinks: BrokenLinkReport[];
}

const empty = (): Data => ({ users: [], connections: [], transactions: [], signals: [], items: [], alerts: [], concierge: [], brokenLinks: [] });

/**
 * A small JSON-file store so the MVP runs with zero infrastructure. The interface is narrow on
 * purpose: swap it for Postgres (with encryption at rest) without touching routes or the pipeline.
 */
export class Store {
  data: Data;
  private file?: string;
  private timer?: NodeJS.Timeout;

  constructor(file?: string) {
    this.file = file;
    this.data = empty();
    if (file) {
      try {
        this.data = { ...empty(), ...JSON.parse(readFileSync(file, 'utf8')) };
      } catch {
        // first run
      }
    }
  }

  /** Debounced write-through; call after every mutation. */
  save(): void {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.flush(), 50);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.file);
  }

  userByToken(token: string): User | undefined {
    return this.data.users.find((u) => u.token === token);
  }

  itemsFor(userId: string) {
    return this.data.items.filter((i) => i.userId === userId);
  }

  /** One-tap account and data deletion. */
  deleteUser(userId: string): void {
    const d = this.data;
    d.users = d.users.filter((u) => u.id !== userId);
    d.connections = d.connections.filter((c) => c.userId !== userId);
    d.transactions = d.transactions.filter((t) => t.userId !== userId);
    d.signals = d.signals.filter((s) => s.userId !== userId);
    d.items = d.items.filter((i) => i.userId !== userId);
    d.alerts = d.alerts.filter((a) => a.userId !== userId);
    d.concierge = d.concierge.filter((c) => c.userId !== userId);
    d.brokenLinks = d.brokenLinks.filter((b) => b.userId !== userId);
    this.save();
  }
}
