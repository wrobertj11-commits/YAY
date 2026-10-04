import { z } from 'zod';
import { ALERT_TYPES, LOCAL_TIME_RE, normalizeAlertPrefs, type AlertType } from '@trialguard/core';
import { newId } from '../crypto.ts';
import { escapeHtml } from '../delivery/alert-email.ts';
import { verifyUnsubscribeToken } from '../delivery/unsubscribe.ts';
import { assert, Reply } from '../http.ts';
import { recompute } from '../pipeline.ts';
import type { Device, Store, User } from '../store.ts';
import { zTimeZone, type RouteDeps } from './shared.ts';

/** Phones, tablets and browsers per account. The least recently seen device makes room for a new one. */
export const MAX_DEVICES_PER_USER = 10;

const zDevice = z.strictObject({
  platform: z.enum(['ios', 'android', 'web']),
  /** APNs device tokens are hex; FCM registration tokens use [A-Za-z0-9_:-]. Nothing that could alter a URL path. */
  pushToken: z.string().min(8).max(1024).regex(/^[A-Za-z0-9_:-]+$/, 'must be an APNs device token or FCM registration token'),
  appVersion: z.string().max(32).regex(/^[\w.+-]+$/, 'must look like 1.4.2').optional(),
});

const zLocalTime = z.string().regex(LOCAL_TIME_RE, 'must be HH:MM, 24-hour');

// `satisfies` makes this fail to compile if core adds an alert type the schema doesn't cover.
const zTypes = z.strictObject({
  trial_converting: z.boolean().optional(),
  renewal: z.boolean().optional(),
  price_increase: z.boolean().optional(),
  charge_after_cancel: z.boolean().optional(),
  cancel_verified: z.boolean().optional(),
} satisfies Record<AlertType, z.ZodOptional<z.ZodBoolean>>);

/** Mirrors AlertPrefs. Every field is optional; what is sent replaces the saved value (types merge per type). */
const zNotificationSettings = z.strictObject({
  push: z.boolean().optional(),
  email: z.boolean().optional(),
  types: zTypes.optional(),
  quietHours: z
    .strictObject({ start: zLocalTime, end: zLocalTime })
    .refine((q) => q.start !== q.end, 'quiet hours must start and end at different times')
    .nullable()
    .optional(),
  timeZone: zTimeZone.optional(),
});

const zTokenQuery = z.object({ token: z.string().max(512).optional() });

function publicDevice(d: Device) {
  return { id: d.id, platform: d.platform, appVersion: d.appVersion, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, enabled: !d.disabledAt };
}

function notificationSettings(store: Store, user: User) {
  return {
    prefs: user.alertPrefs,
    emailUnsubscribedAt: user.emailUnsubscribedAt ?? null,
    devices: store.data.devices.filter((d) => d.userId === user.id).map(publicDevice),
  };
}

/** Over the cap, evict dead devices first, then the least recently seen; never the one just registered. */
function enforceDeviceCap(store: Store, userId: string, keepId: string): void {
  const mine = store.data.devices.filter((d) => d.userId === userId);
  if (mine.length <= MAX_DEVICES_PER_USER) return;
  const evict = new Set(
    mine
      .filter((d) => d.id !== keepId)
      .sort((a, b) => Number(!a.disabledAt) - Number(!b.disabledAt) || a.lastSeenAt.localeCompare(b.lastSeenAt))
      .slice(0, mine.length - MAX_DEVICES_PER_USER)
      .map((d) => d.id),
  );
  store.data.devices = store.data.devices.filter((d) => !evict.has(d.id));
}

/** Small standalone page for the unsubscribe link (opened from an email, outside the app). */
function page(status: number, title: string, bodyHtml: string): Reply {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${escapeHtml(title)} · Trialguard</title>
<style>body{margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111827}
main{max-width:440px;margin:40px auto;background:#fff;border-radius:14px;padding:24px}h1{font-size:1.3rem;margin:0 0 12px}p{line-height:1.5;color:#4b5563}
button{min-height:44px;padding:10px 18px;border:0;border-radius:10px;background:#4f46e5;color:#fff;font-size:1rem;font-weight:600;cursor:pointer}</style>
</head><body><main><h1>${escapeHtml(title)}</h1>${bodyHtml}</main></body></html>`;
  return new Reply(status, html, {
    'Content-Type': 'text/html; charset=utf-8',
    // The token is in the URL: never leak it in a Referer, never let the page be framed.
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    'X-Frame-Options': 'DENY',
  });
}

const INVALID_LINK = () =>
  page(400, 'This link isn’t valid', '<p>The unsubscribe link is incomplete or has been changed. You can turn off alert emails in the Trialguard app under Account → Notifications.</p>');

/** Devices (push tokens), notification settings and one-click email unsubscribe. */
export function register({ router, store, deps }: RouteDeps): void {
  router.on('GET', '/api/devices', {}, ({ user }) => store.data.devices.filter((d) => d.userId === user.id).map(publicDevice));

  /**
   * Registers (or refreshes) a push token. Upsert by token: a token already on another account moves to
   * this one, because a device delivers to whoever signed in on it last. It gets a new id so the
   * previous account can't address it any more.
   */
  router.on('POST', '/api/devices', { body: zDevice }, ({ user, body, log }) => {
    const now = deps.clock().toISOString();
    let device = store.data.devices.find((d) => d.pushToken === body.pushToken);
    if (device && device.userId !== user.id) {
      log.info('push token moved to another account', { deviceId: device.id });
      Object.assign(device, { id: newId('dev'), userId: user.id, createdAt: now, appVersion: body.appVersion });
    }
    if (device) {
      device.platform = body.platform;
      device.appVersion = body.appVersion ?? device.appVersion;
      device.lastSeenAt = now;
      // The app re-registered, so the token is believed good again; the provider will say otherwise if not.
      device.disabledAt = undefined;
    } else {
      device = { id: newId('dev'), userId: user.id, platform: body.platform, pushToken: body.pushToken, appVersion: body.appVersion, createdAt: now, lastSeenAt: now };
      store.data.devices.push(device);
    }
    enforceDeviceCap(store, user.id, device.id);
    store.save();
    return publicDevice(device);
  });

  router.on('DELETE', '/api/devices/:id', {}, ({ user, params }) => {
    const i = store.data.devices.findIndex((d) => d.id === params.id && d.userId === user.id);
    assert(i >= 0, 'Device not found', 404);
    store.data.devices.splice(i, 1);
    store.save();
    return { deleted: true };
  });

  router.on('GET', '/api/me/notifications', {}, ({ user }) => notificationSettings(store, user));

  router.on('PUT', '/api/me/notifications', { body: zNotificationSettings }, ({ user, body }) => {
    const current = user.alertPrefs;
    const types = { ...current.types };
    for (const t of ALERT_TYPES) {
      const v = body.types?.[t];
      if (v !== undefined) types[t] = v;
    }
    user.alertPrefs = normalizeAlertPrefs({
      push: body.push ?? current.push,
      email: body.email ?? current.email,
      types,
      quietHours: body.quietHours === undefined ? current.quietHours : body.quietHours,
      timeZone: body.timeZone ?? current.timeZone,
    });
    // Turning email alerts on in settings is an explicit opt-in after a one-click unsubscribe.
    if (body.email === true && user.emailUnsubscribedAt) {
      user.emailUnsubscribedAt = undefined;
      store.audit({ actor: { type: 'user', id: user.id }, userId: user.id, action: 'email.resubscribed', at: deps.clock().toISOString() });
    }
    // Rebuild the outbox so pending alerts match the new channels, types and time zone.
    recompute(store, user, deps);
    return notificationSettings(store, user);
  });

  /**
   * The unsubscribe link from an alert email. GET only shows a confirmation: link scanners and mail
   * previews fetch GET URLs, so a GET must never unsubscribe anyone.
   */
  router.on('GET', '/api/unsubscribe', { auth: 'none', query: zTokenQuery }, ({ query }) => {
    if (!query.token || !verifyUnsubscribeToken(query.token)) return INVALID_LINK();
    const action = `/api/unsubscribe?token=${encodeURIComponent(query.token)}`;
    return page(
      200,
      'Stop alert emails?',
      `<p>You won't get Trialguard alert emails any more. Push notifications and the in-app inbox are not affected.</p>
<form method="post" action="${escapeHtml(action)}"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit">Unsubscribe</button></form>`,
    );
  });

  /**
   * RFC 8058 one-click unsubscribe (mail clients POST `List-Unsubscribe=One-Click` to the List-Unsubscribe
   * URL) and the confirm page's form. The signed token is the authorization, so the body isn't needed.
   */
  router.on('POST', '/api/unsubscribe', { auth: 'none', raw: true, maxBody: 4096, query: zTokenQuery }, ({ query }) => {
    const userId = query.token ? verifyUnsubscribeToken(query.token) : undefined;
    if (!userId) return INVALID_LINK();
    const user = store.data.users.find((u) => u.id === userId);
    // A deleted account gets the same answer: there is nothing left to email.
    if (user && (!user.emailUnsubscribedAt || user.alertPrefs.email)) {
      const now = deps.clock().toISOString();
      user.emailUnsubscribedAt ??= now;
      user.alertPrefs = normalizeAlertPrefs({ ...user.alertPrefs, email: false });
      store.audit({ actor: { type: 'user', id: user.id }, userId: user.id, action: 'email.unsubscribed', at: now });
      recompute(store, user, deps);
    }
    return page(200, 'You’re unsubscribed', '<p>We won’t send you alert emails any more. Changed your mind? Turn email alerts back on in the Trialguard app under Account → Notifications.</p>');
  });
}
