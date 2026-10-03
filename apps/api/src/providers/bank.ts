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

/**
 * Read-only Plaid aggregation (F1). Uses Link for the user-facing connect flow, then
 * /transactions/sync with a stored cursor for incremental updates.
 */
export class PlaidBank implements BankProvider {
  private base = `https://${config.plaid.env}.plaid.com`;

  private async call<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.base}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: config.plaid.clientId, secret: config.plaid.secret, ...body }),
    });
    const json = (await res.json()) as T & { error_message?: string };
    if (!res.ok) throw new Error(`Plaid ${endpoint}: ${json.error_message ?? res.status}`);
    return json;
  }

  static configured(): boolean {
    return Boolean(config.plaid.clientId && config.plaid.secret);
  }

  async createLinkToken(userId: string): Promise<string> {
    const r = await this.call<{ link_token: string }>('/link/token/create', {
      user: { client_user_id: userId },
      client_name: 'Trialguard',
      products: ['transactions'],
      country_codes: ['US'],
      language: 'en',
    });
    return r.link_token;
  }

  async exchangePublicToken(publicToken: string): Promise<string> {
    const r = await this.call<{ access_token: string }>('/item/public_token/exchange', { public_token: publicToken });
    return r.access_token;
  }

  async sync({ accessToken, cursor }: { accessToken?: string; cursor?: string }): Promise<BankSyncResult> {
    if (!accessToken) throw new Error('Missing Plaid access token');
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
