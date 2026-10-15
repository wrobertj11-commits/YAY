import { createHmac, randomInt } from 'node:crypto';
import { config } from '../config.ts';
import { safeEqual } from '../crypto.ts';
import type { Connection, EmailVerification, Store, User } from '../store.ts';

/**
 * Email verification codes: 6 random digits, sent to the account's address, valid for 30 minutes and
 * for at most 5 wrong guesses. Only a keyed hash is stored, so neither the data file nor an export
 * holds a usable code.
 *
 * A 6-digit code is only safe because guesses are scarce: 5 per code here, and new codes are rate
 * limited per address (the `emailCode` bucket), which bounds guesses no matter how many accounts
 * claim the same address.
 */

export const CODE_TTL_MS = 30 * 60_000;
export const MAX_CODE_ATTEMPTS = 5;
export const CODE_RE = /^\d{6}$/;

/** Separates this use of the link secret from signed links (signPayload), which share it. */
const KEY_LABEL = 'trialguard/email-verification-code/v1';

function codeKey(): Buffer {
  if (!config.linkSecret) throw new Error('LINK_SIGNING_SECRET is not configured');
  return createHmac('sha256', config.linkSecret).update(KEY_LABEL).digest();
}

export function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * HMAC of a code, bound to the account and the address it was sent to. Keyed with a server secret: there
 * are only a million codes, so a plain hash in a leaked data file could be reversed instantly.
 */
export function hashCode(user: Pick<User, 'id' | 'email'>, code: string): string {
  return createHmac('sha256', codeKey()).update(`${user.id}\n${user.email}\n${code}`).digest('hex');
}

/** Replaces any outstanding code with a new one. The code is returned to be sent: never store or log it. */
export function issueCode(user: User, now: Date): { code: string; verification: EmailVerification } {
  const code = newCode();
  const verification: EmailVerification = {
    codeHash: hashCode(user, code),
    sentAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + CODE_TTL_MS).toISOString(),
    attempts: 0,
  };
  user.emailVerification = verification;
  return { code, verification };
}

export type CodeCheck =
  | { ok: true }
  | { ok: false; reason: 'none' | 'expired' | 'locked' }
  | { ok: false; reason: 'wrong'; attemptsLeft: number };

/**
 * Checks a code against the outstanding one, counting wrong guesses. A used or expired code is cleared.
 * A code that has run out of guesses is kept (so the answer stays "send a new code") but never matches
 * again, even when the right digits arrive.
 */
export function checkCode(user: User, code: string, now: Date): CodeCheck {
  const pending = user.emailVerification;
  if (!pending) return { ok: false, reason: 'none' };
  if (!(Date.parse(pending.expiresAt) > now.getTime())) {
    user.emailVerification = undefined;
    return { ok: false, reason: 'expired' };
  }
  if (pending.attempts >= MAX_CODE_ATTEMPTS) return { ok: false, reason: 'locked' };
  // Constant-time: equal-length hex digests compared with timingSafeEqual.
  if (safeEqual(hashCode(user, code), pending.codeHash)) {
    user.emailVerification = undefined;
    return { ok: true };
  }
  pending.attempts++;
  const attemptsLeft = MAX_CODE_ATTEMPTS - pending.attempts;
  return attemptsLeft > 0 ? { ok: false, reason: 'wrong', attemptsLeft } : { ok: false, reason: 'locked' };
}

/**
 * Once an address is verified, other accounts that claimed it without verifying are someone else's
 * (or the same person's abandoned signups): they are deleted, and each deletion is audited. Returns how
 * many, and their connections so the caller can revoke provider access (async) once the store is consistent.
 */
export function removeUnverifiedDuplicates(store: Store, verified: User, at: string): { removed: number; connections: Connection[] } {
  const squatters = store.data.users.filter((u) => u.id !== verified.id && u.email === verified.email && !u.emailVerifiedAt);
  const connections: Connection[] = [];
  for (const u of squatters) {
    connections.push(...store.data.connections.filter((c) => c.userId === u.id));
    // Written first: deleteUser keeps only the account.deleted entries of a deleted account.
    store.audit({
      actor: { type: 'system', id: 'email-verification' },
      userId: u.id,
      action: 'account.deleted',
      details: { reason: 'email_verified_by_another_account' },
      at,
    });
    store.deleteUser(u.id);
  }
  return { removed: squatters.length, connections };
}
