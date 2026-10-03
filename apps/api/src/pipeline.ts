import {
  alertsForEvents,
  detectRecurring,
  extractEmailSignal,
  isRelevantEmail,
  needsLlmExtraction,
  reconcile,
  scheduleAlerts,
  toISODate,
  type EmailMessage,
  type ItemEvent,
  type Source,
  type TrackedItem,
} from '@trialguard/core';
import { config } from './config.ts';
import { decrypt, newId } from './crypto.ts';
import { llmExtract, mergeSignals } from './llm.ts';
import { consoleNotifier, dispatchDueAlerts, type Notifier } from './notify.ts';
import { PlaidBank, sandboxBank, type BankProvider } from './providers/bank.ts';
import { gmailInbox, outlookInbox, sandboxInbox, type EmailProvider } from './providers/email.ts';
import type { Connection, Store, StoredSignal, User } from './store.ts';

export interface PipelineDeps {
  bank: (c: Connection) => BankProvider;
  inbox: (c: Connection) => EmailProvider;
  llm?: (email: EmailMessage) => Promise<import('@trialguard/core').EmailSignal | undefined>;
  clock: () => Date;
  /** When set, alerts that are already due go out as soon as a sync finishes. */
  notifier?: Notifier;
}

export const defaultDeps: PipelineDeps = {
  bank: (c) => (c.provider === 'plaid' ? new PlaidBank() : sandboxBank),
  inbox: (c) => (c.provider === 'gmail' ? gmailInbox : c.provider === 'outlook' ? outlookInbox : sandboxInbox),
  llm: config.llmEnabled ? llmExtract : undefined,
  clock: () => new Date(),
  notifier: consoleNotifier,
};

export interface SyncSummary {
  itemsFound: number;
  trials: number;
  newItems: number;
  events: ItemEvent[];
  errors: string[];
}

/** Extract one email into a stored signal. The body is used here and then goes out of scope. */
export async function ingestEmail(store: Store, user: User, email: EmailMessage, source: Source, deps: PipelineDeps): Promise<StoredSignal | undefined> {
  if (store.data.signals.some((s) => s.userId === user.id && s.emailId === email.id)) return undefined;
  let signal = extractEmailSignal(email);
  if (deps.llm && needsLlmExtraction(signal)) signal = mergeSignals(signal, await deps.llm(email));
  if (!signal) return undefined;
  const stored: StoredSignal = { ...signal, userId: user.id, source };
  store.data.signals.push(stored);
  return stored;
}

async function pullConnection(store: Store, user: User, c: Connection, deps: PipelineDeps): Promise<void> {
  const today = toISODate(deps.clock());
  const accessToken = c.sealedToken ? decrypt(c.sealedToken) : undefined;
  if (c.type === 'bank') {
    const r = await deps.bank(c).sync({ connectionId: c.id, accessToken, cursor: c.cursor, today });
    const removed = new Set(r.removedIds);
    const existing = new Set(store.data.transactions.filter((t) => t.userId === user.id).map((t) => t.id));
    store.data.transactions = store.data.transactions.filter((t) => !removed.has(t.id));
    for (const t of r.transactions) {
      if (!existing.has(t.id)) store.data.transactions.push({ ...t, userId: user.id, connectionId: c.id });
    }
    c.cursor = r.cursor;
  } else {
    const emails = await deps.inbox(c).fetch({ accessToken, since: c.lastSyncedAt, today });
    for (const email of emails) {
      if (!isRelevantEmail(email.from, email.subject)) continue;
      await ingestEmail(store, user, email, 'email', deps);
    }
  }
  c.lastSyncedAt = deps.clock().toISOString();
  c.status = 'active';
  c.error = undefined;
}

/** Re-runs detection and reconciliation from stored data, then (re)schedules alerts. */
export function recompute(store: Store, user: User, deps: Pick<PipelineDeps, 'clock'>): { events: ItemEvent[]; newItems: number } {
  const now = deps.clock();
  const today = toISODate(now);
  const transactions = store.data.transactions.filter((t) => t.userId === user.id);
  const signals = store.data.signals.filter((s) => s.userId === user.id);
  const before = store.itemsFor(user.id);

  const { items, events } = reconcile({
    items: before,
    transactions,
    recurring: detectRecurring(transactions, { today }),
    signals,
    today,
    now: now.toISOString(),
    newId: () => newId('itm'),
  });

  store.data.items = [...store.data.items.filter((i) => i.userId !== user.id), ...items.map((i) => ({ ...(i as TrackedItem), userId: user.id }))];

  // Event alerts go out now. Scheduled alerts are rebuilt: unsent ones are replaced, sent ones kept.
  const outbox = store.data.alerts;
  const sentIds = new Set(outbox.filter((a) => a.userId === user.id && a.sentAt).map((a) => a.id));
  const fresh = [
    ...alertsForEvents(events, items, user.plan, now, user.alertPrefs),
    ...scheduleAlerts(items, user.plan, now, user.alertPrefs),
  ].filter((a) => !sentIds.has(a.id));
  store.data.alerts = [...outbox.filter((a) => a.userId !== user.id || a.sentAt), ...fresh.map((a) => ({ ...a, userId: user.id }))];

  if (!user.firstFoundAt && items.length) user.firstFoundAt = now.toISOString();
  store.save();
  return { events, newItems: events.filter((e) => e.type === 'new_item').length };
}

/** Full sync for one user: pull every connection, then recompute. */
export async function syncUser(store: Store, user: User, deps: PipelineDeps = defaultDeps): Promise<SyncSummary> {
  const errors: string[] = [];
  for (const c of store.data.connections.filter((c) => c.userId === user.id)) {
    try {
      await pullConnection(store, user, c, deps);
    } catch (err) {
      c.status = 'error';
      c.error = (err as Error).message;
      errors.push(`${c.label}: ${c.error}`);
    }
  }
  const { events, newItems } = recompute(store, user, deps);
  user.lastSyncAt = deps.clock().toISOString();
  // A trial found inside its 48h window should warn the user now, not on the next tick.
  if (deps.notifier) await dispatchDueAlerts(store, deps.notifier, deps.clock());
  store.save();
  const items = store.itemsFor(user.id).filter((i) => i.status !== 'dismissed');
  return {
    itemsFound: items.length,
    trials: items.filter((i) => i.status === 'trial').length,
    newItems,
    events,
    errors,
  };
}
