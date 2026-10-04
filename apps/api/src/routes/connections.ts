import { z } from 'zod';
import { entitlements, READABLE_SUBJECT_TERMS } from '@trialguard/core';
import { decrypt, encrypt, newId } from '../crypto.ts';
import { assert } from '../http.ts';
import { PlaidBank } from '../providers/bank.ts';
import { syncUser } from '../pipeline.ts';
import type { Connection } from '../store.ts';
import { publicConnection, zText, type RouteDeps } from './shared.ts';

const zLabel = zText(60).optional();
const zConnect = z.union([
  z.strictObject({ mode: z.literal('sandbox').default('sandbox'), type: z.enum(['bank', 'gmail', 'outlook']), label: zLabel }),
  z.strictObject({ mode: z.literal('live'), type: z.literal('bank'), publicToken: z.string().min(1).max(512), label: zLabel }),
  z.strictObject({ mode: z.literal('live'), type: z.enum(['gmail', 'outlook']), accessToken: z.string().min(1).max(4096), label: zLabel }),
]);

export function register({ router, store, deps }: RouteDeps) {
  router.on('GET', '/api/connections/email-filter', { auth: 'none' }, () => ({
    description:
      'We only read emails whose subject looks like a receipt, signup, renewal, price change or cancellation. ' +
      'Only the extracted fields (service, price, dates) are kept; the email itself is not stored.',
    subjectTerms: READABLE_SUBJECT_TERMS,
    senders: 'Plus receipts from billing / no-reply addresses of known subscription services.',
  }));

  router.on('POST', '/api/connections/plaid/link-token', {}, async ({ user }) => {
    assert(PlaidBank.configured(), 'Plaid is not configured on this server; use sandbox mode', 501);
    return { linkToken: await new PlaidBank().createLinkToken(user.id) };
  });

  router.on('POST', '/api/connections', { body: zConnect, limit: 'sync' }, async ({ user, body }) => {
    const ent = entitlements(user.plan);
    const mine = store.data.connections.filter((c) => c.userId === user.id);
    if (body.type === 'bank') assert(mine.filter((c) => c.type === 'bank').length < ent.maxBankConnections, 'Free includes 1 bank connection. Upgrade to Plus for unlimited.', 402);
    else assert(mine.filter((c) => c.type !== 'bank').length < ent.maxInboxes, 'Free includes 1 inbox. Upgrade to Plus for unlimited.', 402);

    let sealedToken: string | undefined;
    let externalId: string | undefined;
    let provider: Connection['provider'] = 'sandbox';
    if (body.mode === 'live') {
      if ('publicToken' in body) {
        assert(PlaidBank.configured(), 'Plaid is not configured on this server', 501);
        const exchanged = await new PlaidBank().exchangePublicToken(body.publicToken);
        sealedToken = encrypt(exchanged.accessToken);
        externalId = exchanged.itemId;
        provider = 'plaid';
      } else {
        // The mobile client runs the OAuth consent flow (read-only scope) and hands us the token.
        sealedToken = encrypt(body.accessToken);
        provider = body.type;
      }
    }
    const sandbox = body.mode === 'sandbox';
    const defaultLabel = body.type === 'bank' ? (sandbox ? 'Demo Bank (sandbox)' : 'Bank account') : `${body.type === 'gmail' ? 'Gmail' : 'Outlook'}${sandbox ? ' (sandbox)' : ''}`;
    const conn: Connection = {
      id: newId('con'),
      userId: user.id,
      type: body.type,
      provider,
      label: body.label || defaultLabel,
      sealedToken,
      externalId,
      status: 'active',
      createdAt: deps.clock().toISOString(),
    };
    store.data.connections.push(conn);
    const summary = await syncUser(store, user, deps);
    return { connection: publicConnection(conn), summary };
  });

  router.on('DELETE', '/api/connections/:id', {}, async ({ user, params, log }) => {
    const conn = store.data.connections.find((c) => c.id === params.id && c.userId === user.id);
    assert(conn, 'Connection not found', 404);
    // Revoke our access at Plaid too, so the bank link doesn't outlive the connection. Best effort:
    // a Plaid outage must not stop the user from disconnecting, and the token is deleted either way.
    if (conn.provider === 'plaid' && conn.sealedToken && PlaidBank.configured()) {
      try {
        await new PlaidBank().removeItem(decrypt(conn.sealedToken));
      } catch (err) {
        log.warn('plaid item removal failed', { connectionId: conn.id, err });
      }
    }
    store.data.connections = store.data.connections.filter((c) => c !== conn);
    // Disconnecting removes the raw data that came through it.
    store.data.transactions = store.data.transactions.filter((t) => t.connectionId !== conn.id);
    store.save();
    return { deleted: true };
  });

  router.on('POST', '/api/sync', { limit: 'sync' }, ({ user }) => syncUser(store, user, deps));
}
