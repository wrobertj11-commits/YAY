import type { IncomingMessage } from 'node:http';
import { HttpError } from '../http.ts';

/**
 * Staff handles: letters, digits, dot, underscore, dash. Not email addresses, so audit entries and logs
 * don't carry staff personal data.
 */
const STAFF_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/;

/**
 * Who is acting on an ops endpoint. ADMIN_TOKEN (checked by the router) proves the caller is ops tooling;
 * the X-Staff-Id header names the person, and becomes the audit actor and the request assignee.
 *
 * It is a declared identity, not a credential: anyone holding ADMIN_TOKEN can send any handle. That is
 * acceptable for a small ops team sharing one token, and why per-person credentials (SSO) should replace
 * the shared token as the team grows (see docs/concierge.md). Handles are lower-cased so "Sam" and "sam"
 * can't hold two different claims.
 */
export function staffIdFrom(req: IncomingMessage): string {
  const raw = req.headers['x-staff-id'];
  const id = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!STAFF_ID.test(id)) throw new HttpError(400, 'X-Staff-Id header required: your staff handle (2-64 letters, digits, ".", "_" or "-")');
  return id;
}
