import { z } from 'zod';
import { config } from '../config.ts';
import { newId, safeEqual } from '../crypto.ts';
import { senderAddressOf } from '@trialguard/core';
import { assert, HttpError } from '../http.ts';
import { LIMITS, RateLimiter } from '../ratelimit.ts';
import { ingestEmail, recompute } from '../pipeline.ts';
import { zText, type RouteDeps } from './shared.ts';

const zForward = z.strictObject({
  text: z.string().min(1, 'Paste the email text').max(100_000),
  subject: zText(300).optional(),
  from: zText(300).optional(),
});

/** Normalized inbound-mail webhook (map your provider's payload to this shape at the edge). */
const zInbound = z.looseObject({
  to: z.string().max(320),
  from: z.string().max(320).optional(),
  originalFrom: z.string().max(320).optional(),
  subject: z.string().max(1000).optional(),
  text: z.string().max(200_000).optional(),
  messageId: z.string().max(256).optional(),
});

const forwardTokenOf = (to: string) => to.match(/^u-([a-z0-9_-]+)@/i)?.[1]?.toLowerCase();

/**
 * Per-forwarding-address limit. The route itself is keyed by IP, but every delivery comes from the
 * mail provider's few IPs, so a per-IP limit alone would let one noisy address block everyone's mail.
 */
const perAddress = new RateLimiter({ inbound: LIMITS.inbound });

export function register({ router, store, deps }: RouteDeps) {
  router.on('POST', '/api/forward', { body: zForward, limit: 'ingest' }, async ({ user, body }) => {
    const subject = body.subject || body.text.split('\n')[0]?.slice(0, 200) || '';
    const signal = await ingestEmail(
      store,
      user,
      { id: newId('fwd'), from: body.from ?? '', subject, date: deps.clock().toISOString(), body: body.text },
      'forwarded',
      deps,
    );
    assert(signal, "We couldn't find a subscription or trial in that email. Try adding it by hand.", 422);
    recompute(store, user, deps);
    const item = store.itemsFor(user.id).find((i) => i.emailIds.includes(signal.emailId));
    const { userId: _u, ...publicSignal } = signal;
    return { signal: publicSignal, item };
  });

  /** Webhook from the inbound-mail provider for u-<token>@<inboundDomain>. */
  router.on(
    'POST',
    '/api/inbound',
    { auth: 'none', body: zInbound, limit: 'webhook', limitKey: ({ ip }) => ip, maxBody: 2_000_000 },
    async ({ req, body }) => {
      if (config.inboundSecret || config.production) {
        assert(safeEqual(req.headers['x-inbound-secret'] as string | undefined, config.inboundSecret), 'Forbidden', 403);
      }
      const token = forwardTokenOf(body.to);
      const user = token ? store.data.users.find((u) => u.forwardToken === token) : undefined;
      assert(user, 'Unknown forwarding address', 404);
      const wait = perAddress.take('inbound', user.id);
      if (wait) throw new HttpError(429, 'Too many forwarded emails', undefined, { 'Retry-After': String(wait) });
      // Mail the user forwarded from their own account address is theirs; anything else is untrusted input.
      const forwarder = senderAddressOf(body.from ?? '');
      const source = forwarder && forwarder === user.email.toLowerCase() ? 'forwarded' : 'inbound';
      const messageId = body.messageId ?? newId('fwd');
      if (!store.markWebhookProcessed('inbound_email', messageId, deps.clock().toISOString())) return { accepted: false, duplicate: true };
      const signal = await ingestEmail(
        store,
        user,
        { id: messageId, from: body.originalFrom ?? body.from ?? '', subject: body.subject ?? '', date: deps.clock().toISOString(), body: body.text ?? '' },
        source,
        deps,
      );
      if (signal) recompute(store, user, deps);
      return { accepted: Boolean(signal) };
    },
  );
}
