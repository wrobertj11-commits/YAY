import { createHash, createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';
import { safeEqual } from '../crypto.ts';
import { PlaidApiError, type PlaidBank, type PlaidWebhookKey } from '../providers/bank.ts';
import { RateLimiter } from '../ratelimit.ts';

/**
 * Plaid webhook signature verification (Plaid docs: "Webhook verification").
 *
 * Every webhook carries a `Plaid-Verification` header: a JWT signed with ES256 by a key Plaid
 * publishes through /webhook_verification_key/get. Accepting a webhook means all of:
 *   1. the JWT header says alg ES256 (checked before anything is fetched, so `none` / HS256 tokens
 *      can't steer us into a lookup or an algorithm-confusion check);
 *   2. the key named by `kid` exists at Plaid and has not expired;
 *   3. the ES256 signature over `header.payload` verifies with that key;
 *   4. `iat` is under five minutes old (a captured webhook can't be replayed later);
 *   5. the `request_body_sha256` claim equals the SHA-256 of the exact bytes received. The JSON
 *      is never re-serialized: Plaid hashes its own formatting, whitespace included.
 *
 * Parsing is done here with node:crypto; the format is small and a JWT library would add a
 * dependency (and its own, broader, algorithm handling) for no gain.
 */

export type VerifyFailure = 'missing' | 'malformed' | 'alg' | 'unknown_key' | 'key_expired' | 'signature' | 'stale' | 'body_hash';

export type VerifyResult = { ok: true; tokenId: string } | { ok: false; reason: VerifyFailure };

/** The signing key couldn't be fetched right now (Plaid unreachable, or lookups throttled). Worth a retry. */
export class KeyUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'KeyUnavailableError';
  }
}

export interface VerifierOptions {
  /** Looks a key up by kid. Resolves undefined when Plaid says there is no such key; throws when Plaid can't answer. */
  fetchKey: (kid: string) => Promise<PlaidWebhookKey | undefined>;
  clock: () => Date;
  /** Oldest `iat` accepted. Plaid's guidance is five minutes. */
  maxAgeSeconds?: number;
  /** How long a fetched key is trusted before it is looked up again, so a retirement (`expired_at`) is noticed. */
  keyTtlMs?: number;
  /** How long "no such key" is remembered, so a junk kid can't make us call Plaid on every request. */
  missTtlMs?: number;
  /** Key lookups allowed per minute across all callers; random kids can't turn webhooks into Plaid API load. */
  lookupsPerMinute?: number;
}

/** Tolerated clock skew for an `iat` slightly in the future. */
const FUTURE_SKEW_SECONDS = 60;
/** Upper bound on the header we'll parse; real ones are well under 1 KB. */
const MAX_JWT_LENGTH = 8192;
const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;
const KID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;
/** Raw r||s for P-256 (JWS ES256), not DER. */
const ES256_SIGNATURE_BYTES = 64;
const MAX_CACHED_KEYS = 64;
const MAX_CACHED_MISSES = 1024;

interface ParsedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
}

function decodeSegment(segment: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Splits a compact JWS into its parts. Strict: three non-empty base64url segments, JSON objects in the first two. */
export function parseJwt(jwt: string): ParsedJwt | undefined {
  if (jwt.length > MAX_JWT_LENGTH) return undefined;
  const parts = jwt.split('.');
  if (parts.length !== 3) return undefined;
  const [h = '', p = '', s = ''] = parts;
  if (![h, p, s].every((x) => SEGMENT_RE.test(x))) return undefined;
  const header = decodeSegment(h);
  const payload = decodeSegment(p);
  if (!header || !payload) return undefined;
  return { header, payload, signingInput: `${h}.${p}`, signature: Buffer.from(s, 'base64url') };
}

interface CachedKey {
  /** Undefined: Plaid has no such key (or it isn't an ES256 key we can use). */
  key?: PlaidWebhookKey;
  publicKey?: KeyObject;
  fetchedAt: number;
}

/** Only P-256 ES256 keys are usable; anything else is treated as unknown rather than trusted. */
function toCached(key: PlaidWebhookKey | undefined, at: number): CachedKey {
  if (!key || key.kty !== 'EC' || key.crv !== 'P-256' || key.alg !== 'ES256') return { fetchedAt: at };
  try {
    const publicKey = createPublicKey({ key: { kty: key.kty, crv: key.crv, x: key.x, y: key.y }, format: 'jwk' });
    return { key, publicKey, fetchedAt: at };
  } catch {
    return { fetchedAt: at };
  }
}

export class PlaidWebhookVerifier {
  private fetchKey: VerifierOptions['fetchKey'];
  private clock: () => Date;
  private maxAgeSeconds: number;
  private keyTtlMs: number;
  private missTtlMs: number;
  private lookups: RateLimiter;
  /** Real keys by kid. */
  private cache = new Map<string, CachedKey>();
  /** Kids Plaid said don't exist, with when we asked. */
  private misses = new Map<string, number>();
  /** Concurrent webhooks naming the same new kid share one lookup. */
  private pending = new Map<string, Promise<CachedKey>>();

  constructor(opts: VerifierOptions) {
    this.fetchKey = opts.fetchKey;
    this.clock = opts.clock;
    this.maxAgeSeconds = opts.maxAgeSeconds ?? 300;
    this.keyTtlMs = opts.keyTtlMs ?? 3_600_000;
    this.missTtlMs = opts.missTtlMs ?? 300_000;
    this.lookups = new RateLimiter({ key: { capacity: opts.lookupsPerMinute ?? 10, per: 60 } }, () => this.clock().getTime());
  }

  /**
   * Checks a webhook. `header` is the Plaid-Verification value, `rawBody` the exact request bytes.
   * Throws KeyUnavailableError when the answer depends on a key we can't fetch right now.
   */
  async verify(header: string | undefined, rawBody: Buffer): Promise<VerifyResult> {
    const fail = (reason: VerifyFailure): VerifyResult => ({ ok: false, reason });
    if (!header) return fail('missing');
    const jwt = parseJwt(header);
    if (!jwt) return fail('malformed');
    if (jwt.header.alg !== 'ES256') return fail('alg');
    // We implement no JWS extensions, so a token that marks any as critical must be refused (RFC 7515 §4.1.11).
    if (jwt.header.crit !== undefined) return fail('malformed');
    const kid = jwt.header.kid;
    if (typeof kid !== 'string' || !KID_RE.test(kid)) return fail('malformed');

    const nowMs = this.clock().getTime();
    const entry = await this.lookup(kid, nowMs);
    if (!entry.key || !entry.publicKey) return fail('unknown_key');
    if (entry.key.expiredAt !== null && entry.key.expiredAt * 1000 <= nowMs) return fail('key_expired');

    if (jwt.signature.length !== ES256_SIGNATURE_BYTES) return fail('signature');
    if (!verifySignature('sha256', Buffer.from(jwt.signingInput), { key: entry.publicKey, dsaEncoding: 'ieee-p1363' }, jwt.signature)) return fail('signature');

    const { iat, request_body_sha256: claimedHash } = jwt.payload;
    if (typeof iat !== 'number' || !Number.isFinite(iat)) return fail('malformed');
    const nowSeconds = nowMs / 1000;
    if (nowSeconds - iat > this.maxAgeSeconds || iat - nowSeconds > FUTURE_SKEW_SECONDS) return fail('stale');

    if (typeof claimedHash !== 'string' || !SHA256_HEX_RE.test(claimedHash)) return fail('body_hash');
    const actualHash = createHash('sha256').update(rawBody).digest('hex');
    if (!safeEqual(claimedHash.toLowerCase(), actualHash)) return fail('body_hash');

    // Identifies the signed content (header + payload, which carries iat and the body hash), not the header's
    // spelling: ECDSA signatures are malleable (high-S, spare base64url bits), so keying on the raw header
    // would let a re-encoded copy of the same delivery count as new.
    return { ok: true, tokenId: createHash('sha256').update(jwt.signingInput).digest('hex').slice(0, 32) };
  }

  private async lookup(kid: string, nowMs: number): Promise<CachedKey> {
    const missedAt = this.misses.get(kid);
    if (missedAt !== undefined && nowMs - missedAt < this.missTtlMs) return { fetchedAt: missedAt };
    const cached = this.cache.get(kid);
    if (cached && nowMs - cached.fetchedAt < this.keyTtlMs) return cached;
    try {
      return await this.refresh(kid);
    } catch (err) {
      // Plaid unreachable or lookups throttled: a key we already hold stays usable until it expires.
      if (cached?.key) return cached;
      throw err;
    }
  }

  private refresh(kid: string): Promise<CachedKey> {
    const inflight = this.pending.get(kid);
    if (inflight) return inflight;
    const run = (async () => {
      if (this.lookups.take('key', 'all')) throw new KeyUnavailableError('Plaid key lookups are throttled');
      let key: PlaidWebhookKey | undefined;
      try {
        key = await this.fetchKey(kid);
      } catch (err) {
        throw new KeyUnavailableError('Could not fetch the Plaid webhook key', { cause: err });
      }
      const entry = toCached(key, this.clock().getTime());
      if (entry.key) {
        this.misses.delete(kid);
        this.cache.delete(kid);
        this.cache.set(kid, entry);
        // Only real keys live here, and only Plaid can mint them, so junk kids can't evict a real key.
        for (const oldest of this.cache.keys()) {
          if (this.cache.size <= MAX_CACHED_KEYS) break;
          this.cache.delete(oldest);
        }
      } else {
        // Unknown kids are remembered separately (bounded), so a flood of them only evicts other misses.
        this.misses.delete(kid);
        this.misses.set(kid, entry.fetchedAt);
        for (const oldest of this.misses.keys()) {
          if (this.misses.size <= MAX_CACHED_MISSES) break;
          this.misses.delete(oldest);
        }
      }
      return entry;
    })().finally(() => this.pending.delete(kid));
    this.pending.set(kid, run);
    return run;
  }
}

/**
 * Adapts PlaidBank to the verifier's contract. A 400/404 from /webhook_verification_key/get is taken
 * as "no such key" (the kid is invalid); anything else (5xx, 429, network) is a failure to answer.
 * Plaid doesn't document a dedicated error code for an unknown key_id, so this keys off the HTTP status.
 */
export function plaidKeySource(plaid: Pick<PlaidBank, 'getWebhookVerificationKey'>): VerifierOptions['fetchKey'] {
  return async (kid) => {
    try {
      return await plaid.getWebhookVerificationKey(kid);
    } catch (err) {
      if (err instanceof PlaidApiError && (err.status === 400 || err.status === 404)) return undefined;
      throw err;
    }
  };
}
