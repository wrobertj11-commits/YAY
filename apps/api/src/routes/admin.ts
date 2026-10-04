import { z } from 'zod';
import { changeStatus, claimRequest, queue, queueRow, viewRequest, workView } from '../concierge/requests.ts';
import { staffIdFrom } from '../concierge/staff.ts';
import { zText, type RouteDeps } from './shared.ts';

const zQueueQuery = z.object({
  status: z.enum(['queued', 'in_progress', 'done', 'failed']).default('queued'),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

/** Closing a request needs evidence: proof for 'done', a reason the user will read for 'failed'. */
const zStatusChange = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('in_progress') }),
  z.strictObject({
    status: z.literal('done'),
    proof: zText(200).pipe(z.string().min(1, 'proof is required: a confirmation number or email reference')),
    note: zText(500).optional(),
  }),
  z.strictObject({
    status: z.literal('failed'),
    note: zText(500).pipe(z.string().min(1, 'note is required: tell the user why it could not be done')),
    proof: zText(200).optional(),
  }),
]);

const zAuditQuery = z.object({
  userId: z.string().max(64).optional(),
  /** A concierge request (or other subject) id, to read one request's trail. */
  subjectId: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/**
 * Internal ops endpoints: the concierge queue and the audit trail. The router requires ADMIN_TOKEN (404
 * when unset, 401 when wrong); every handler also requires X-Staff-Id, the person acting, which becomes
 * the audit actor. Staff never get transactions, provider tokens, IP or user agent from these routes.
 */
export function register({ router, store, deps }: RouteDeps): void {
  router.on('GET', '/api/admin/concierge', { auth: 'admin', query: zQueueQuery }, ({ req, query }) => {
    staffIdFrom(req);
    return { requests: queue(store, query.status, query.limit).map((r) => queueRow(store, r)) };
  });

  router.on('GET', '/api/admin/concierge/:id', { auth: 'admin' }, ({ req, params }) => {
    const staffId = staffIdFrom(req);
    return { request: workView(store, viewRequest(store, staffId, params.id, deps), staffId) };
  });

  router.on('POST', '/api/admin/concierge/:id/claim', { auth: 'admin', body: z.strictObject({}) }, ({ req, params, log }) => {
    const staffId = staffIdFrom(req);
    const request = claimRequest(store, staffId, params.id, deps);
    log.info('concierge claimed', { conciergeId: request.id, staffId });
    return { request: workView(store, request, staffId) };
  });

  router.on('POST', '/api/admin/concierge/:id/status', { auth: 'admin', body: zStatusChange }, ({ req, params, body, log }) => {
    const staffId = staffIdFrom(req);
    const request = changeStatus(store, staffId, params.id, body, deps);
    log.info('concierge status changed', { conciergeId: request.id, staffId, status: request.status });
    return { request: workView(store, request, staffId) };
  });

  router.on('GET', '/api/admin/audit', { auth: 'admin', query: zAuditQuery }, ({ req, query }) => {
    const staffId = staffIdFrom(req);
    const entries = store.data.audit
      .filter((e) => (!query.userId || e.userId === query.userId) && (!query.subjectId || e.subject?.id === query.subjectId))
      .slice(-query.limit)
      .reverse();
    // Reading the trail is itself recorded, after the read so it doesn't list itself.
    store.audit({
      at: deps.clock().toISOString(),
      actor: { type: 'staff', id: staffId },
      action: 'audit.viewed',
      userId: query.userId,
      details: { subjectId: query.subjectId, returned: entries.length },
    });
    return { entries };
  });
}
