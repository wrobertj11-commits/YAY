import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { renderAuthorization } from '../concierge/authorization.ts';
import { createRequest, userView, withdrawRequest } from '../concierge/requests.ts';
import { userItem, zText, type RouteDeps } from './shared.ts';

/** The typed signature: a real-looking name on one line, not a tick-box in disguise. */
const zSignedName = zText(80).pipe(
  z
    .string()
    .min(2, 'type your full name')
    .regex(/^[^\t\n\r]*$/, 'must be on one line')
    .regex(/\p{L}/u, 'must contain letters'),
);

const zConciergeRequest = z.strictObject({
  /** The version of the text the user was shown (GET /api/concierge/authorization-text). */
  textVersion: z.string().min(1).max(64),
  signedName: zSignedName,
  agree: z.literal(true, 'you must tick "I authorize"'),
});

/** Kept with the signature as evidence; capped and stripped of control characters. */
function userAgentOf(req: IncomingMessage): string | undefined {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' && ua ? ua.replace(/\p{Cc}/gu, '').slice(0, 256) : undefined;
}

/** F10: done-for-you cancellation requests, each backed by a written, revocable authorization. */
export function register({ router, store, deps }: RouteDeps) {
  // Public so counsel and App Review can read it; merchant names are catalog data.
  router.on('GET', '/api/concierge/authorization-text', { auth: 'none', query: z.object({ merchantId: z.string().max(64).optional() }) }, ({ query }) =>
    renderAuthorization(query.merchantId),
  );

  router.on('POST', '/api/items/:id/concierge', { body: zConciergeRequest }, ({ req, user, params, body, ip, log }) => {
    const item = userItem(store, user, params.id);
    const request = createRequest(store, user, item, { textVersion: body.textVersion, signedName: body.signedName, ip, userAgent: userAgentOf(req) }, deps);
    log.info('concierge requested', { conciergeId: request.id, merchantId: request.merchantId });
    return { concierge: userView(store, request) };
  });

  router.on('GET', '/api/concierge', { query: z.object({ itemId: z.string().max(64).optional() }) }, ({ user, query }) => {
    const mine = store.data.concierge.filter((r) => r.userId === user.id && (!query.itemId || r.itemId === query.itemId));
    // Newest first; reversing first keeps same-timestamp requests newest first too (sort is stable).
    const requests = mine.reverse().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { requests: requests.map((r) => userView(store, r)) };
  });

  router.on('POST', '/api/concierge/:id/withdraw', { body: z.strictObject({}) }, ({ user, params, log }) => {
    const request = withdrawRequest(store, user, params.id, deps);
    log.info('concierge withdrawn', { conciergeId: request.id });
    return { concierge: userView(store, request) };
  });
}
