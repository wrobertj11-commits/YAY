import { createHash, sign, type KeyObject } from 'node:crypto';

/**
 * Compact JWS for provider auth: ES256 for APNs token auth, RS256 for Google's OAuth2 JWT-bearer grant.
 * ES256 signatures in a JWT are raw r||s (IEEE P1363), not the DER that node:crypto emits by default.
 */
export function signJwt(alg: 'ES256' | 'RS256', header: Record<string, string>, claims: Record<string, unknown>, key: KeyObject): string {
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const input = `${encode({ alg, ...header })}.${encode(claims)}`;
  const signature = alg === 'ES256' ? sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }) : sign('sha256', Buffer.from(input), key);
  return `${input}.${signature.toString('base64url')}`;
}

/**
 * Collapse identifier for an alert. Alert ids are already stable; ids longer than `max` bytes (APNs
 * allows 64, Web Push topics 32 base64url characters) or outside `allowed` are hashed, so the result
 * stays stable and within the provider's limits.
 */
export function collapseKey(alertId: string, max = 64, allowed = /^[\w:.-]+$/): string {
  if (Buffer.byteLength(alertId) <= max && allowed.test(alertId)) return alertId;
  return createHash('sha256').update(alertId).digest('base64url').slice(0, max);
}
