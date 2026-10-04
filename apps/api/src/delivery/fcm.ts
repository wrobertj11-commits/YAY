import { createPrivateKey, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { retryAfterMs } from './apns.ts';
import { collapseKey, signJwt } from './jwt.ts';
import { DeliveryError, type FetchLike, type PushMessage, type PushOutcome, type PushProvider } from './types.ts';

/**
 * Firebase Cloud Messaging, HTTP v1 API, for Android (and web tokens issued by the Firebase JS SDK).
 * Auth is a short-lived OAuth2 access token obtained with the service account's key through the
 * JWT-bearer grant (RFC 7523), cached until shortly before it expires.
 */

const zServiceAccount = z.looseObject({
  project_id: z.string().min(1),
  client_email: z.string().min(1),
  private_key: z.string().min(1),
  private_key_id: z.string().optional(),
});
export type ServiceAccount = z.infer<typeof zServiceAccount>;

export function parseServiceAccount(json: string): ServiceAccount {
  const parsed = zServiceAccount.safeParse(JSON.parse(json));
  if (!parsed.success) throw new Error('FCM service account JSON is missing project_id, client_email or private_key');
  return parsed.data;
}

export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
export const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';

interface TokenOptions {
  fetch?: FetchLike;
  clock?: () => Date;
  scope?: string;
}

/** OAuth2 access token for a service account, shared by concurrent sends and refreshed a minute early. */
export class GoogleAccessToken {
  private sa: ServiceAccount;
  private key: KeyObject;
  private fetch: FetchLike;
  private clock: () => Date;
  private scope: string;
  private cached?: { token: string; expiresAt: number };
  private inflight?: Promise<string>;

  constructor(sa: ServiceAccount, opts: TokenOptions = {}) {
    this.sa = sa;
    this.key = createPrivateKey(sa.private_key);
    this.fetch = opts.fetch ?? fetch;
    this.clock = opts.clock ?? (() => new Date());
    this.scope = opts.scope ?? FCM_SCOPE;
  }

  async get(): Promise<string> {
    if (this.cached && this.clock().getTime() < this.cached.expiresAt) return this.cached.token;
    this.inflight ??= this.request().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /** Drop the cached token (after a 401) so the next send mints a new one. */
  invalidate(): void {
    this.cached = undefined;
  }

  private async request(): Promise<string> {
    // Pinned rather than read from the file's token_uri, so the signed assertion can only go to Google.
    const audience = GOOGLE_TOKEN_URI;
    const iat = Math.floor(this.clock().getTime() / 1000);
    const assertion = signJwt(
      'RS256',
      { typ: 'JWT', ...(this.sa.private_key_id ? { kid: this.sa.private_key_id } : {}) },
      { iss: this.sa.client_email, scope: this.scope, aud: audience, iat, exp: iat + 3600 },
      this.key,
    );
    const res = await this.fetch(audience, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown };
    if (!res.ok || typeof json.access_token !== 'string') {
      // Usually a revoked key or clock skew: retry later rather than lose the alert.
      throw new DeliveryError(`Google OAuth token request failed (HTTP ${res.status})`, { retryable: true });
    }
    const lifetime = typeof json.expires_in === 'number' ? json.expires_in : 3600;
    this.cached = { token: json.access_token, expiresAt: this.clock().getTime() + Math.max(0, lifetime - 60) * 1000 };
    return json.access_token;
  }
}

interface FcmOptions extends TokenOptions {
  tokens?: GoogleAccessToken;
  timeoutMs?: number;
}

interface FcmErrorBody {
  error?: { status?: string; details?: { '@type'?: string; errorCode?: string }[] };
}

export class FcmProvider implements PushProvider {
  readonly name = 'fcm' as const;
  private projectId: string;
  private tokens: GoogleAccessToken;
  private fetch: FetchLike;
  private clock: () => Date;
  private timeoutMs: number;

  constructor(sa: ServiceAccount, opts: FcmOptions = {}) {
    this.projectId = sa.project_id;
    this.tokens = opts.tokens ?? new GoogleAccessToken(sa, opts);
    this.fetch = opts.fetch ?? fetch;
    this.clock = opts.clock ?? (() => new Date());
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async send(pushToken: string, msg: PushMessage): Promise<PushOutcome> {
    const access = await this.tokens.get();
    const res = await this.fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.projectId)}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: fcmMessage(pushToken, msg, this.clock()) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.ok) return { ok: true };

    const body = (await res.json().catch(() => ({}))) as FcmErrorBody;
    const errorCode = body.error?.details?.find((d) => typeof d.errorCode === 'string')?.errorCode;
    const reason = (errorCode ?? body.error?.status ?? `HTTP ${res.status}`).slice(0, 64);
    if (errorCode === 'UNREGISTERED' || res.status === 404) return { ok: false, invalidToken: true, retryable: false, reason };
    if (res.status === 401) {
      this.tokens.invalidate();
      return { ok: false, invalidToken: false, retryable: true, reason };
    }
    if (res.status === 429 || res.status >= 500) {
      return { ok: false, invalidToken: false, retryable: true, reason, retryAfterMs: retryAfterMs(res.headers.get('retry-after') ?? undefined) };
    }
    // INVALID_ARGUMENT, SENDER_ID_MISMATCH...: not retryable, and not proof the token is dead.
    return { ok: false, invalidToken: false, retryable: false, reason };
  }
}

/**
 * The v1 message. Android's `collapse_key` is deliberately not used: FCM keeps at most four collapse
 * keys per device, so one key per alert could drop queued alerts while a phone is offline. Instead
 * `notification.tag` (Android) and the Web Push `Topic` header + notification `tag` make a re-send of
 * the same alert replace the earlier notification rather than add a second one.
 */
export function fcmMessage(token: string, msg: PushMessage, now: Date) {
  const ttlSeconds = msg.expiresAt ? Math.max(0, Math.floor((Date.parse(msg.expiresAt) - now.getTime()) / 1000)) : undefined;
  return {
    token,
    notification: { title: msg.title, body: msg.body },
    data: msg.data,
    android: {
      notification: { tag: msg.collapseId },
      ...(ttlSeconds !== undefined ? { ttl: `${ttlSeconds}s` } : {}),
    },
    webpush: {
      headers: { Topic: collapseKey(msg.collapseId, 32, /^[\w-]+$/), ...(ttlSeconds !== undefined ? { TTL: String(ttlSeconds) } : {}) },
      notification: { title: msg.title, body: msg.body, tag: msg.collapseId },
    },
  };
}
