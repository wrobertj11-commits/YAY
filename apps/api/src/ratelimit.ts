/**
 * Token-bucket rate limiting, in memory. Buckets are per (limit, key) where the key is the user id
 * for signed-in routes and the client IP otherwise. With several API instances, move the buckets
 * to Redis (same interface); per-instance limits are still a useful floor.
 */

export interface LimitSpec {
  /** Bucket size: requests allowed in a burst. */
  capacity: number;
  /** Seconds to refill the whole bucket. */
  per: number;
}

export const LIMITS = {
  /** Sign-up / sign-in: slows down credential stuffing and account enumeration. */
  auth: { capacity: 10, per: 60 },
  /** Paste-an-email and manual adds: each may call the LLM. */
  ingest: { capacity: 30, per: 3600 },
  /** Inbound-email webhook, keyed by forwarding address. */
  inbound: { capacity: 60, per: 3600 },
  /** Provider webhooks (Plaid, App Store, Play). */
  webhook: { capacity: 600, per: 60 },
  /** Manual "sync now" — each one hits Plaid and the mail APIs. */
  sync: { capacity: 10, per: 3600 },
  /** Data export is heavy. */
  export: { capacity: 5, per: 3600 },
  /** Everything else. */
  default: { capacity: 300, per: 60 },
} satisfies Record<string, LimitSpec>;

export type LimitName = keyof typeof LIMITS;

interface Bucket {
  tokens: number;
  updated: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private limits: Record<string, LimitSpec>;
  private now: () => number;

  constructor(limits: Record<string, LimitSpec> = LIMITS, now: () => number = () => Date.now()) {
    this.limits = limits;
    this.now = now;
  }

  /** Takes one token. Returns 0 when allowed, otherwise seconds until a token is available. */
  take(limit: string, key: string): number {
    const spec = this.limits[limit] ?? LIMITS.default;
    const rate = spec.capacity / (spec.per * 1000); // tokens per ms
    const id = `${limit}:${key}`;
    const t = this.now();
    const b = this.buckets.get(id) ?? { tokens: spec.capacity, updated: t };
    b.tokens = Math.min(spec.capacity, b.tokens + (t - b.updated) * rate);
    b.updated = t;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.buckets.set(id, b);
      return 0;
    }
    this.buckets.set(id, b);
    if (this.buckets.size > 100_000) this.prune();
    return Math.ceil((1 - b.tokens) / rate / 1000);
  }

  private prune(): void {
    const cutoff = this.now() - 3_600_000;
    for (const [k, b] of this.buckets) if (b.updated < cutoff) this.buckets.delete(k);
  }
}
