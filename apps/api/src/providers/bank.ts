import { z } from 'zod';
import type { ISODate, Transaction } from '@trialguard/core';
import { config } from '../config.ts';
import { sandboxTransactions } from '../sandbox.ts';

export interface BankSyncResult {
  transactions: Transaction[];
  /** Provider ids of transactions to delete (pending charges that dropped off). */
  removedIds: string[];
  cursor?: string;
}

export interface BankProvider {
  sync(opts: { connectionId: string; accessToken?: string; cursor?: string; today: ISODate }): Promise<BankSyncResult>;
}

export const sandboxBank: BankProvider = {
  async sync({ connectionId, today }) {
    return { transactions: sandboxTransactions(today, connectionId), removedIds: [] };
  },
};

interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  amount: number;
  date: string;
  name: string;
  merchant_name?: string | null;
  pending: boolean;
}

/** Credentials and endpoint for one Plaid environment. Defaults come from config; tests pass their own. */
export interface PlaidSettings {
  clientId?: string;
  secret?: string;
  /** "sandbox" or "production": selects https://<env>.plaid.com. */
  env: string;
  /** Public URL of POST /api/webhooks/plaid. Set on every link token so each Item reports changes to us. */
  webhookUrl?: string;
}

export interface PlaidBankOptions {
  settings?: PlaidSettings;
  /** Injected by tests so nothing touches the network. */
  fetch?: typeof fetch;
  /** Per-request timeout, so a slow Plaid call can't hold a sync or a webhook response open. */
  timeoutMs?: number;
}

/** A failed Plaid call. Keeps Plaid's documented error fields so callers can branch on `errorCode`. */
/** Shown on a connection whose bank login expired (Plaid ITEM_LOGIN_REQUIRED), from the webhook or a failed sync. */
export const LOGIN_REQUIRED_MESSAGE = 'Your bank needs you to sign in again. Reconnect to keep tracking charges.';

export class PlaidApiError extends Error {
  endpoint: string;
  status: number;
  errorType?: string;
  errorCode?: string;
  constructor(endpoint: string, status: number, body: { error_type?: unknown; error_code?: unknown; error_message?: unknown }) {
    super(`Plaid ${endpoint}: ${typeof body.error_message === 'string' ? body.error_message : status}`);
    this.name = 'PlaidApiError';
    this.endpoint = endpoint;
    this.status = status;
    if (typeof body.error_type === 'string') this.errorType = body.error_type;
    if (typeof body.error_code === 'string') this.errorCode = body.error_code;
  }
}

/** Public half of a Plaid webhook signing key (a P-256 JWK), from /webhook_verification_key/get. */
export interface PlaidWebhookKey {
  kid: string;
  alg: string;
  kty: string;
  crv: string;
  x: string;
  y: string;
  /** Unix seconds. Null while the key is current; set once Plaid retires it. */
  expiredAt: number | null;
}

const zWebhookKeyResponse = z.object({
  key: z.object({
    kid: z.string(),
    alg: z.string(),
    kty: z.string(),
    crv: z.string(),
    x: z.string(),
    y: z.string(),
    expired_at: z.number().nullable().optional(),
  }),
});

/** Shown on a Plaid connection whose access token is gone (the user revoked access at Plaid or at their bank). */
export const PLAID_DISCONNECTED_MESSAGE = 'Access to this bank was turned off. Remove it and connect it again to keep tracking charges.';

/**
 * Read-only Plaid aggregation (F1). Uses Link for the user-facing connect flow, then
 * /transactions/sync with a stored cursor for incremental updates. Webhooks (plaid/webhooks.ts)
 * tell us when to pull and when an Item needs the user to sign in again.
 */
export class PlaidBank implements BankProvider {
  private settings: PlaidSettings;
  private base: string;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;

  constructor(opts: PlaidBankOptions = {}) {
    this.settings = opts.settings ?? config.plaid;
    this.base = `https://${this.settings.env}.plaid.com`;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private async call<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: this.settings.clientId, secret: this.settings.secret, ...body }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    // Plaid errors are JSON, but a gateway error page in front of it may not be.
    const json = (await res.json().catch(() => ({}))) as T & { error_type?: unknown; error_code?: unknown; error_message?: unknown };
    if (!res.ok) throw new PlaidApiError(endpoint, res.status, json);
    return json;
  }

  static configured(): boolean {
    return Boolean(config.plaid.clientId && config.plaid.secret);
  }

  /** Link token for connecting a new Item. */
  async createLinkToken(userId: string): Promise<string> {
    return this.linkToken(userId, { products: ['transactions'] });
  }

  /**
   * Link token for update mode: Link re-authenticates the existing Item instead of creating a new one,
   * so the access token and item_id stay the same. Plaid takes the access token in place of `products`.
   */
  async createUpdateLinkToken(userId: string, accessToken: string): Promise<string> {
    return this.linkToken(userId, { access_token: accessToken });
  }

  private async linkToken(userId: string, mode: { products: string[] } | { access_token: string }): Promise<string> {
    const r = await this.call<{ link_token: string }>('/link/token/create', {
      user: { client_user_id: userId },
      client_name: 'Trialguard',
      country_codes: ['US'],
      language: 'en',
      ...(this.settings.webhookUrl ? { webhook: this.settings.webhookUrl } : {}),
      ...mode,
    });
    return r.link_token;
  }

  async exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }> {
    const r = await this.call<{ access_token: string; item_id: string }>('/item/public_token/exchange', { public_token: publicToken });
    return { accessToken: r.access_token, itemId: r.item_id };
  }

  /** Ends the Item at Plaid, so we stop receiving its data. For when the user removes a bank. */
  async removeItem(accessToken: string): Promise<void> {
    await this.call('/item/remove', { access_token: accessToken });
  }

  /** The public key a webhook was signed with, by the JWT's `kid`. Shape-checked, since signatures are verified with it. */
  async getWebhookVerificationKey(kid: string): Promise<PlaidWebhookKey> {
    const r = zWebhookKeyResponse.parse(await this.call<unknown>('/webhook_verification_key/get', { key_id: kid }));
    const { expired_at, ...key } = r.key;
    return { ...key, expiredAt: expired_at ?? null };
  }

  async sync({ accessToken, cursor }: { accessToken?: string; cursor?: string }): Promise<BankSyncResult> {
    // The token is deleted when access is revoked; only connecting the bank again brings it back.
    if (!accessToken) throw new Error(PLAID_DISCONNECTED_MESSAGE);
    const transactions: Transaction[] = [];
    const removedIds: string[] = [];
    let next = cursor;
    for (let page = 0; page < 50; page++) {
      const r = await this.call<{
        added: PlaidTransaction[];
        modified: PlaidTransaction[];
        removed: { transaction_id: string }[];
        next_cursor: string;
        has_more: boolean;
      }>('/transactions/sync', { access_token: accessToken, cursor: next, count: 500 });
      for (const t of [...r.added, ...r.modified]) {
        if (t.pending) continue;
        transactions.push({
          id: t.transaction_id,
          accountId: t.account_id,
          date: t.date,
          // Plaid amounts are positive for money leaving the account, which matches ours.
          amountCents: Math.round(t.amount * 100),
          description: t.name || t.merchant_name || 'Unknown',
          paymentMethod: `Account ••${t.account_id.slice(-4)}`,
        });
      }
      removedIds.push(...r.removed.map((x) => x.transaction_id));
      next = r.next_cursor;
      if (!r.has_more) break;
    }
    return { transactions, removedIds, cursor: next };
  }
}
