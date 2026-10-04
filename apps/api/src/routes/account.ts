import { z } from 'zod';
import { normalizeAlertPrefs, type AlertPrefs } from '@trialguard/core';
import { config } from '../config.ts';
import { assert } from '../http.ts';
import { recompute } from '../pipeline.ts';
import { publicUser, zState, zTimeZone, type RouteDeps } from './shared.ts';

const zPatchMe = z.strictObject({
  state: z.union([zState, z.literal('')]).optional(),
  timeZone: zTimeZone.optional(),
  /** Compatibility alias; notification settings live at /api/me/notifications. */
  alertPrefs: z.strictObject({ push: z.boolean().optional(), email: z.boolean().optional() }).optional(),
  /** Dev builds only: real plan changes come from verified App Store / Play notifications. */
  plan: z.enum(['free', 'plus']).optional(),
});

export function register({ router, store, deps }: RouteDeps) {
  router.on('GET', '/api/me', {}, ({ user }) => publicUser(store, user));

  router.on('PATCH', '/api/me', { body: zPatchMe }, ({ user, body }) => {
    if (body.state !== undefined) user.state = body.state || undefined;
    const prefs: Partial<AlertPrefs> = { ...user.alertPrefs };
    if (body.timeZone) prefs.timeZone = body.timeZone;
    if (body.alertPrefs?.push !== undefined) prefs.push = body.alertPrefs.push;
    if (body.alertPrefs?.email !== undefined) prefs.email = body.alertPrefs.email;
    user.alertPrefs = normalizeAlertPrefs(prefs);
    if (body.plan) {
      assert(config.devLogin, 'Plans change through App Store or Google Play billing', 403);
      user.plan = body.plan;
    }
    recompute(store, user, deps);
    return publicUser(store, user);
  });

  router.on('DELETE', '/api/me', {}, ({ user }) => {
    store.audit({ actor: { type: 'user', id: user.id }, userId: user.id, action: 'account.deleted', at: deps.clock().toISOString() });
    store.deleteUser(user.id);
    return { deleted: true };
  });
}
