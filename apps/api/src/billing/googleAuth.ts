import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { BillingRejection } from './errors.ts';

/**
 * Google-side credentials, both directions:
 * - inbound: Pub/Sub push requests carry an OIDC JWT (RS256, signed by Google) that names the service
 *   account the push subscription runs as. Without checking it, anyone could post fake Play notifications.
 * - outbound: the Play Developer API takes an OAuth2 access token minted from our service account key
 *   with the JWT-bearer grant.
 * Every network call goes through an injected fetch so tests run offline.
 */

type Fetch = typeof fetch;
type Clock = () => Date;

export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
export const ANDROID_PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

/** Allowed clock drift between Google and us when checking exp / iat. */
const SKEW_SECONDS = 60;
/** Google's ID tokens live one hour; anything claiming longer wasn't minted for a push. */
const MAX_TOKEN_LIFETIME_SECONDS = 3600;

// ---------- JWKS ----------

const zJwks = z.looseObject({
  keys: z.array(z.looseObject({ kty: z.string(), kid: z.string().optional(), n: z.string().optional(), e: z.string().optional() })),
});

export interface JwksSource {
  key(kid: string): Promise<KeyObject | undefined>;
}

/** Cache lifetime from Cache-Control max-age, clamped to [1 min, 1 day]; 1 hour when absent. */
export function maxAgeMs(cacheControl: string | null): number {
  const m = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl ?? '');
  const seconds = m?.[1] ? Number(m[1]) : 3600;
  return Math.min(Math.max(seconds, 60), 86_400) * 1000;
}

/**
 * Google's signing keys, cached for as long as Google's Cache-Control allows. An unknown kid triggers a
 * refetch (Google rotates keys), at most once per `minRefetchMs` so junk tokens can't make us hammer Google.
 */
export function googleJwks(opts: { fetch: Fetch; clock: Clock; url?: string; minRefetchMs?: number }): JwksSource {
  const url = opts.url ?? GOOGLE_JWKS_URL;
  const minRefetchMs = opts.minRefetchMs ?? 60_000;
  let keys = new Map<string, KeyObject>();
  let expiresAt = 0;
  let fetchedAt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<void> | undefined;

  async function refresh(): Promise<void> {
    // Counted from the attempt, so a failing endpoint is throttled the same way.
    fetchedAt = opts.clock().getTime();
    const res = await opts.fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Google JWKS fetch failed (${res.status})`);
    const body = zJwks.parse(await res.json());
    const next = new Map<string, KeyObject>();
    for (const jwk of body.keys) {
      if (jwk.kty !== 'RSA' || !jwk.kid || !jwk.n || !jwk.e) continue;
      try {
        next.set(jwk.kid, createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' }));
      } catch {
        // skip a key we can't use; the others still verify
      }
    }
    keys = next;
    expiresAt = opts.clock().getTime() + maxAgeMs(res.headers.get('cache-control'));
  }

  return {
    async key(kid) {
      const now = opts.clock().getTime();
      if (now >= expiresAt || (!keys.has(kid) && now - fetchedAt >= minRefetchMs)) {
        inflight ??= refresh().finally(() => {
          inflight = undefined;
        });
        await inflight;
      }
      return keys.get(kid);
    },
  };
}

// ---------- Pub/Sub push OIDC token ----------

export interface PushAuthPolicy {
  /** The audience configured on the push subscription (GOOGLE_PUBSUB_AUDIENCE). */
  audience: string;
  /** The service account the push subscription authenticates as (GOOGLE_PUBSUB_SERVICE_ACCOUNT). */
  serviceAccountEmail: string;
}

const zJwtHeader = z.looseObject({ alg: z.string(), kid: z.string().max(256).optional() });
const zPushClaims = z.looseObject({
  iss: z.string(),
  aud: z.string(),
  email: z.string().optional(),
  email_verified: z.union([z.boolean(), z.literal('true'), z.literal('false')]).optional(),
  exp: z.number(),
  iat: z.number(),
});
export type PushClaims = z.infer<typeof zPushClaims>;

const JWT_RE = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

function unauthorized(why: string): BillingRejection {
  return new BillingRejection(why, 'Push token rejected', 401);
}

function decodeJson(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Verifies the Authorization header Pub/Sub attaches to push requests. Cheap claim checks run before the
 * signature so a junk token never costs a JWKS fetch. Throws a 401 BillingRejection (reason names the check).
 */
export async function verifyPushToken(authorization: string | undefined, policy: PushAuthPolicy, jwks: JwksSource, now: Date): Promise<PushClaims> {
  const m = JWT_RE.exec(authorization ?? '');
  const [, h, p, s] = m ?? [];
  if (!h || !p || !s) throw unauthorized('auth_missing');

  const header = zJwtHeader.safeParse(decodeJson(h));
  if (!header.success) throw unauthorized('auth_malformed');
  if (header.data.alg !== 'RS256' || !header.data.kid) throw unauthorized('auth_algorithm');
  const claims = zPushClaims.safeParse(decodeJson(p));
  if (!claims.success) throw unauthorized('auth_malformed');
  const c = claims.data;

  const t = Math.floor(now.getTime() / 1000);
  if (!GOOGLE_ISSUERS.has(c.iss)) throw unauthorized('auth_issuer');
  if (c.aud !== policy.audience) throw unauthorized('auth_audience');
  if (c.email !== policy.serviceAccountEmail || (c.email_verified !== true && c.email_verified !== 'true')) throw unauthorized('auth_email');
  if (t >= c.exp + SKEW_SECONDS || c.iat > t + SKEW_SECONDS || c.exp - c.iat > MAX_TOKEN_LIFETIME_SECONDS + SKEW_SECONDS) throw unauthorized('auth_time');

  const key = await jwks.key(header.data.kid);
  if (!key) throw unauthorized('auth_unknown_key');
  const ok = verify('sha256', Buffer.from(`${h}.${p}`, 'ascii'), key, Buffer.from(s, 'base64url'));
  if (!ok) throw unauthorized('auth_signature');
  return c;
}

// ---------- service account access tokens ----------

const zServiceAccount = z.looseObject({
  client_email: z.string().min(3),
  private_key: z.string().min(1),
  private_key_id: z.string().optional(),
  token_uri: z.url({ protocol: /^https$/ }).optional(),
});
export type ServiceAccount = z.infer<typeof zServiceAccount>;

/** Parses a service account key file (the JSON Google Cloud console downloads). Throws on anything else. */
export function parseServiceAccount(json: string): ServiceAccount {
  const account = zServiceAccount.parse(JSON.parse(json));
  createPrivateKey(account.private_key); // fail at boot, not on the first notification
  return account;
}

const zTokenResponse = z.looseObject({ access_token: z.string().min(1), expires_in: z.number().positive() });

export interface AccessTokenSource {
  token(): Promise<string>;
  /** Drop the cached token (e.g. after a 401) so the next call mints a fresh one. */
  invalidate(): void;
}

const b64json = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

/** OAuth2 JWT-bearer grant (RFC 7523) for a service account, cached until a minute before expiry. */
export function serviceAccountTokens(opts: { account: ServiceAccount; scope: string; fetch: Fetch; clock: Clock }): AccessTokenSource {
  const { account } = opts;
  const tokenUri = account.token_uri ?? DEFAULT_TOKEN_URI;
  const privateKey = createPrivateKey(account.private_key);
  let cached: { token: string; expiresAt: number } | undefined;
  let inflight: Promise<string> | undefined;

  async function mint(): Promise<string> {
    const iat = Math.floor(opts.clock().getTime() / 1000);
    const header = b64json({ alg: 'RS256', typ: 'JWT', ...(account.private_key_id ? { kid: account.private_key_id } : {}) });
    const claims = b64json({ iss: account.client_email, scope: opts.scope, aud: tokenUri, iat, exp: iat + 3600 });
    const signature = sign('sha256', Buffer.from(`${header}.${claims}`), privateKey).toString('base64url');
    const res = await opts.fetch(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${signature}` }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Google token endpoint returned ${res.status}`);
    const body = zTokenResponse.parse(await res.json());
    cached = { token: body.access_token, expiresAt: opts.clock().getTime() + body.expires_in * 1000 };
    return body.access_token;
  }

  return {
    async token() {
      if (cached && opts.clock().getTime() < cached.expiresAt - 60_000) return cached.token;
      inflight ??= mint().finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
    invalidate() {
      cached = undefined;
    },
  };
}
