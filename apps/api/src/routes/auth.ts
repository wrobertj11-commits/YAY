import { z } from 'zod';
import { normalizeAlertPrefs } from '@trialguard/core';
import { verificationMailer } from '../auth/mailer.ts';
import { renderVerificationEmail } from '../auth/verification-email.ts';
import { CODE_RE, CODE_TTL_MS, checkCode, issueCode, removeUnverifiedDuplicates, type CodeCheck } from '../auth/verification.ts';
import { config } from '../config.ts';
import { newId, newToken } from '../crypto.ts';
import { assert, HttpError, Reply } from '../http.ts';
import type { User } from '../store.ts';
import { revokeAtProvider } from './connections.ts';
import { publicUser, zState, zTimeZone, type RouteDeps } from './shared.ts';

const zEmail = z.email().max(254).transform((e) => e.trim().toLowerCase());

/** Spaces and dashes people type or paste ("123 456") are dropped before the 6-digit check. */
const zCode = z
  .string()
  .max(32)
  .transform((s) => s.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(CODE_RE, 'must be the 6-digit code from the email'));

/** The answer for a code that didn't verify. A malformed code is a 400 from the schema and costs no attempt. */
function codeError(result: Exclude<CodeCheck, { ok: true }>): HttpError {
  switch (result.reason) {
    case 'wrong':
      return new HttpError(400, `That code isn't right. ${result.attemptsLeft} ${result.attemptsLeft === 1 ? 'try' : 'tries'} left.`);
    case 'locked':
      return new HttpError(429, 'Too many wrong codes. Send a new code.');
    case 'expired':
      return new HttpError(410, 'That code has expired. Send a new code.');
    case 'none':
      return new HttpError(400, 'No code is waiting for this account. Send a new code.');
  }
}

/** The account (other than `except`) that has proved it owns the address, if any. Only such an account reserves it. */
function verifiedHolder(users: User[], email: string, except?: string): User | undefined {
  return users.find((u) => u.email === email && u.emailVerifiedAt && u.id !== except);
}

export function register({ router, store, deps }: RouteDeps) {
  /**
   * New accounts start unverified: they get a session at once, but no alert email until the address is
   * verified. An unverified account doesn't hold its address either, or anyone could lock the real owner
   * out by signing up first; the owner signs up anyway, and verifying removes the impostor.
   */
  router.on(
    'POST',
    '/api/auth/signup',
    { auth: 'none', limit: 'auth', body: z.strictObject({ email: zEmail, state: zState.optional(), timeZone: zTimeZone.optional() }) },
    ({ body }) => {
      assert(!verifiedHolder(store.data.users, body.email), 'An account with that email already exists', 409);
      const user: User = {
        id: newId('usr'),
        email: body.email,
        token: newToken(),
        plan: 'free',
        state: body.state,
        forwardToken: newToken().slice(0, 10).toLowerCase().replace(/[^a-z0-9]/g, 'x'),
        alertPrefs: normalizeAlertPrefs({ timeZone: body.timeZone }),
        createdAt: deps.clock().toISOString(),
      };
      store.data.users.push(user);
      store.save();
      return { token: user.token, user: publicUser(store, user) };
    },
  );

  router.on('POST', '/api/auth/login', { auth: 'none', limit: 'auth', body: z.strictObject({ email: zEmail }) }, ({ body }) => {
    // Production sends a magic link (not built yet); the dev build signs straight in so the demo is usable.
    if (!config.devLogin) return new Reply(202, { message: 'Check your email for a sign-in link' });
    // Unverified duplicates can share an address; the verified account is the one that owns it.
    const user = verifiedHolder(store.data.users, body.email) ?? store.data.users.find((u) => u.email === body.email);
    assert(user, 'No account with that email', 404);
    return { token: user.token, user: publicUser(store, user) };
  });

  /**
   * Emails a verification code to the account's address. The rate-limit bucket is keyed by the address,
   * not the account: every account claiming an address shares its codes, so its inbox can't be flooded
   * and the number of guesses at it stays small however many accounts claim it.
   */
  router.on(
    'POST',
    '/api/auth/email/send-code',
    { limit: 'emailCode', limitKey: ({ user, ip }) => user?.email ?? ip, body: z.strictObject({}) },
    async ({ user, log }) => {
      assert(!user.emailVerifiedAt, 'Your email address is already verified', 409);
      const mailer = verificationMailer();
      // The dev build without a sender hands the code back so the demo works; production must really send it.
      assert(mailer || config.devLogin, 'Email verification is unavailable right now. Please try again later.', 503);

      const previous = user.emailVerification;
      const { code, verification } = issueCode(user, deps.clock());
      store.save();
      if (!mailer) return { sent: false, expiresAt: verification.expiresAt, devCode: code };

      try {
        await mailer.sender.send(
          renderVerificationEmail(user.email, code, { from: mailer.from, publicUrl: config.publicUrl, postalAddress: mailer.postalAddress, minutes: CODE_TTL_MS / 60_000 }),
        );
      } catch (err) {
        // Nobody has this code. Restore the previous one (it may be in the inbox already) unless a newer request replaced it.
        if (user.emailVerification === verification) user.emailVerification = previous;
        store.save();
        log.warn('verification email not sent', { err });
        throw new HttpError(502, "We couldn't send the email. Please try again in a few minutes.");
      }
      log.info('verification code sent');
      return { sent: true, expiresAt: verification.expiresAt };
    },
  );

  /** Checks the code. On success the address is the account's, and unverified accounts claiming it are deleted. */
  router.on('POST', '/api/auth/email/verify', { limit: 'auth', body: z.strictObject({ code: zCode }) }, async ({ user, body, log }) => {
    if (user.emailVerifiedAt) return { user: publicUser(store, user) };
    // Defensive: verifying removes unverified duplicates in the same step, so two accounts can't both get here.
    assert(!verifiedHolder(store.data.users, user.email, user.id), 'This email address is already verified on another account', 409);

    const now = deps.clock();
    const result = checkCode(user, body.code, now);
    store.save();
    if (!result.ok) throw codeError(result);

    // No await until the duplicates are gone, so no request can see two verified owners or act as a removed account.
    const at = now.toISOString();
    user.emailVerifiedAt = at;
    const { removed, connections } = removeUnverifiedDuplicates(store, user, at);
    store.audit({ actor: { type: 'user', id: user.id }, userId: user.id, action: 'email.verified', details: { duplicateAccountsRemoved: removed }, at });
    log.info('email verified', { duplicateAccountsRemoved: removed });
    for (const conn of connections) await revokeAtProvider(conn, log);
    return { user: publicUser(store, user) };
  });
}
