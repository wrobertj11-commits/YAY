import { z } from 'zod';
import { normalizeAlertPrefs } from '@trialguard/core';
import { config } from '../config.ts';
import { newId, newToken } from '../crypto.ts';
import { assert, Reply } from '../http.ts';
import type { User } from '../store.ts';
import { publicUser, zState, zTimeZone, type RouteDeps } from './shared.ts';

const zEmail = z.email().max(254).transform((e) => e.trim().toLowerCase());

export function register({ router, store, deps }: RouteDeps) {
  router.on(
    'POST',
    '/api/auth/signup',
    { auth: 'none', limit: 'auth', body: z.strictObject({ email: zEmail, state: zState.optional(), timeZone: zTimeZone.optional() }) },
    ({ body }) => {
      assert(!store.data.users.some((u) => u.email === body.email), 'An account with that email already exists', 409);
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
    const user = store.data.users.find((u) => u.email === body.email);
    assert(user, 'No account with that email', 404);
    return { token: user.token, user: publicUser(store, user) };
  });
}
