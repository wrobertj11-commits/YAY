import { signPayload, verifySignedPayload } from '../crypto.ts';

/**
 * One-click unsubscribe tokens: an HMAC-signed user id (signPayload, LINK_SIGNING_SECRET). The purpose
 * prefix stops a token signed for anything else from being replayed here. No expiry on purpose: an
 * unsubscribe link must keep working for as long as the email exists (CAN-SPAM: at least 30 days).
 */
const PURPOSE = 'unsub:email:v1:';

export function unsubscribeToken(userId: string): string {
  return signPayload(`${PURPOSE}${userId}`);
}

/** The user id, or undefined for a malformed, tampered or wrong-purpose token. */
export function verifyUnsubscribeToken(token: string): string | undefined {
  const payload = verifySignedPayload(token);
  if (!payload?.startsWith(PURPOSE)) return undefined;
  return payload.slice(PURPOSE.length) || undefined;
}

export function unsubscribeUrl(publicUrl: string, userId: string): string {
  return `${publicUrl}/api/unsubscribe?token=${encodeURIComponent(unsubscribeToken(userId))}`;
}
