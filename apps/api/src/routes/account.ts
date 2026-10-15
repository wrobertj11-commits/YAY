import { z } from 'zod';
import { config } from '../config.ts';
import { assert } from '../http.ts';
import { recompute } from '../pipeline.ts';
import { revokeAtProvider } from './connections.ts';
import { publicUser, zState, type RouteDeps } from './shared.ts';

/** Notification settings (channels, quiet hours, time zone) live at PUT /api/me/notifications. */
const zPatchMe = z.strictObject({
  state: z.union([zState, z.literal('')]).optional(),
  /** Dev builds only: real plan changes come from verified App Store / Play notifications. */
  plan: z.enum(['free', 'plus']).optional(),
});

export function register({ router, store, deps }: RouteDeps) {
  router.on('GET', '/api/me', {}, ({ user }) => publicUser(store, user));

  router.on('PATCH', '/api/me', { body: zPatchMe }, ({ user, body }) => {
    if (body.state !== undefined) user.state = body.state || undefined;
    if (body.plan) {
      assert(config.devLogin, 'Plans change through App Store or Google Play billing', 403);
      user.plan = body.plan;
    }
    recompute(store, user, deps);
    return publicUser(store, user);
  });

  router.on('DELETE', '/api/me', {}, async ({ user, log }) => {
    for (const conn of store.data.connections.filter((c) => c.userId === user.id)) await revokeAtProvider(conn, log);
    store.audit({ actor: { type: 'user', id: user.id }, userId: user.id, action: 'account.deleted', at: deps.clock().toISOString() });
    store.deleteUser(user.id);
    return { deleted: true };
  });
}
