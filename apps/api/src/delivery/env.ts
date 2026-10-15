import { readFileSync } from 'node:fs';
import { config } from '../config.ts';
import { log } from '../log.ts';
import type { Store } from '../store.ts';
import { ApnsProvider, type ApnsConfig } from './apns.ts';
import { PostmarkSender } from './email.ts';
import { FcmProvider, parseServiceAccount, type ServiceAccount } from './fcm.ts';
import { createDeliveryNotifier } from './notifier.ts';
import type { Notifier, PushProvider } from './types.ts';

/**
 * Delivery providers from the environment. Each channel is off until fully configured; a channel
 * that is half-configured fails at boot rather than silently dropping alerts.
 *
 *   APNs:  APNS_KEY_PATH (or APNS_KEY, the .p8 contents; "\n" escapes allowed), APNS_KEY_ID, APNS_TEAM_ID,
 *          APNS_BUNDLE_ID, APNS_PRODUCTION ("1"/"0"; defaults to on when NODE_ENV=production, because
 *          production tokens sent to the sandbox gateway come back BadDeviceToken and would disable devices).
 *   FCM:   FCM_SERVICE_ACCOUNT_PATH (service account JSON with the Firebase Cloud Messaging role).
 *   Email: POSTMARK_SERVER_TOKEN, EMAIL_FROM, COMPANY_POSTAL_ADDRESS (required in production), POSTMARK_MESSAGE_STREAM;
 *          in production PUBLIC_URL must be https (it is the unsubscribe link's origin).
 */

export interface DeliveryEnv {
  NODE_ENV?: string;
  PUBLIC_URL?: string;
  APNS_KEY_PATH?: string;
  APNS_KEY?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_BUNDLE_ID?: string;
  APNS_PRODUCTION?: string;
  FCM_SERVICE_ACCOUNT_PATH?: string;
  POSTMARK_SERVER_TOKEN?: string;
  POSTMARK_MESSAGE_STREAM?: string;
  EMAIL_FROM?: string;
  COMPANY_POSTAL_ADDRESS?: string;
}

export interface DeliverySettings {
  apns?: ApnsConfig;
  fcm?: ServiceAccount;
  postmark?: { serverToken: string; messageStream?: string };
  emailFrom?: string;
  postalAddress?: string;
}

const flag = (v: string | undefined, fallback: boolean) => (v === undefined || v === '' ? fallback : v === '1' || v.toLowerCase() === 'true');

export function readDeliverySettings(env: DeliveryEnv = process.env, readFile: (p: string) => string = (p) => readFileSync(p, 'utf8')): DeliverySettings {
  const production = env.NODE_ENV === 'production';
  const problems: string[] = [];
  const settings: DeliverySettings = {
    emailFrom: env.EMAIL_FROM?.trim() || undefined,
    postalAddress: env.COMPANY_POSTAL_ADDRESS?.trim() || undefined,
  };

  const keyPem = env.APNS_KEY ? env.APNS_KEY.replace(/\\n/g, '\n') : env.APNS_KEY_PATH ? readFile(env.APNS_KEY_PATH) : undefined;
  const { APNS_KEY_ID: keyId, APNS_TEAM_ID: teamId, APNS_BUNDLE_ID: bundleId } = env;
  if (keyPem && keyId && teamId && bundleId) {
    settings.apns = { keyPem, keyId, teamId, bundleId, production: flag(env.APNS_PRODUCTION, production) };
  } else if (keyPem || keyId || teamId || bundleId) {
    const missing = Object.entries({ 'APNS_KEY_PATH or APNS_KEY': keyPem, APNS_KEY_ID: keyId, APNS_TEAM_ID: teamId, APNS_BUNDLE_ID: bundleId }).filter(([, v]) => !v);
    problems.push(`APNs is partly configured; missing ${missing.map(([k]) => k).join(', ')}`);
  }

  if (env.FCM_SERVICE_ACCOUNT_PATH) settings.fcm = parseServiceAccount(readFile(env.FCM_SERVICE_ACCOUNT_PATH));

  if (env.POSTMARK_SERVER_TOKEN) {
    settings.postmark = { serverToken: env.POSTMARK_SERVER_TOKEN, messageStream: env.POSTMARK_MESSAGE_STREAM || undefined };
    if (!settings.emailFrom) problems.push('EMAIL_FROM is required when POSTMARK_SERVER_TOKEN is set');
    if (production && !settings.postalAddress) problems.push('COMPANY_POSTAL_ADDRESS is required in production when email is enabled (CAN-SPAM)');
    // Mail clients only offer one-click unsubscribe for an https List-Unsubscribe URL (RFC 8058).
    if (production && !env.PUBLIC_URL?.startsWith('https://')) problems.push('PUBLIC_URL must be https in production when email is enabled');
  }

  if (problems.length) throw new Error(`Delivery config: ${problems.join('; ')}`);
  return settings;
}

export interface Delivery {
  notifier: Notifier;
  /** Which channels really leave the building (for the boot log and ops). */
  channels: { push: string[]; email: string };
  close(): void;
}

/** Builds the production notifier from env. Throws on incomplete config so a bad deploy fails at boot. */
export function createDeliveryFromEnv(store: Store, env: DeliveryEnv = process.env, clock: () => Date = () => new Date()): Delivery {
  const s = readDeliverySettings(env);
  const production = env.NODE_ENV === 'production';
  const apns = s.apns ? new ApnsProvider(s.apns, { clock }) : undefined;
  const fcm: PushProvider | undefined = s.fcm ? new FcmProvider(s.fcm, { clock }) : undefined;
  const email = s.postmark ? new PostmarkSender(s.postmark) : undefined;

  const channels = { push: [apns && 'apns', fcm && 'fcm'].filter((x): x is string => Boolean(x)), email: email ? 'postmark' : production ? 'off' : 'console' };
  log.info('alert delivery channels', { pushProviders: channels.push.join(',') || 'inbox only', emailProvider: channels.email });
  if (production && !email) log.warn('email delivery is not configured; alert emails will be skipped');
  if (production && !apns && !fcm) log.warn('push delivery is not configured; push alerts reach the in-app inbox only');

  const notifier = createDeliveryNotifier(store, {
    apns,
    fcm,
    email,
    emailFrom: s.emailFrom,
    postalAddress: s.postalAddress,
    publicUrl: config.publicUrl,
    production,
    clock,
  });
  return {
    notifier,
    channels,
    close() {
      apns?.close();
      fcm?.close?.();
    },
  };
}
