import type { OutboxAlert, User } from '../store.ts';

/**
 * What a channel reports back for one alert. `void` means delivered (older notifiers and test
 * doubles return nothing). `skipped` is a deliberate non-delivery (unsubscribed, nothing to send to).
 * `via` says where a delivered alert ended up: 'inbox' means only the in-app inbox (no device took it).
 */
export type SendResult = void | { status: 'sent'; via?: 'push' | 'email' | 'inbox' | 'log'; note?: string } | { status: 'skipped'; reason: string };

/** A delivery channel. Throw a DeliveryError (or anything) to fail; the outbox decides about retries. */
export interface Notifier {
  send(user: User, alert: OutboxAlert): Promise<SendResult>;
}

/**
 * A failed delivery with a retry hint. Errors that are not DeliveryErrors (network resets, timeouts)
 * are treated as retryable, because that is what they usually are.
 */
export class DeliveryError extends Error {
  retryable: boolean;
  /** Provider asked us to wait at least this long (429 Retry-After). */
  retryAfterMs?: number;
  constructor(message: string, opts: { retryable: boolean; retryAfterMs?: number }) {
    super(message);
    this.name = 'DeliveryError';
    this.retryable = opts.retryable;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

// ---------- push ----------

export interface PushMessage {
  title: string;
  body: string;
  /**
   * Stable per alert (derived from the alert id). A re-send after a crash replaces the earlier
   * notification on the device instead of showing a duplicate.
   */
  collapseId: string;
  /** Don't deliver after this instant (the charge the alert warns about). */
  expiresAt?: string;
  /** Small string map for deep-linking in the app. */
  data: Record<string, string>;
}

export type PushOutcome =
  | { ok: true }
  | {
      ok: false;
      /** The token is dead (app uninstalled, token rotated): disable the device. */
      invalidToken: boolean;
      retryable: boolean;
      /** Provider's reason code, e.g. "BadDeviceToken" or "UNREGISTERED". Never contains the token. */
      reason: string;
      retryAfterMs?: number;
    };

export interface PushProvider {
  readonly name: 'apns' | 'fcm';
  send(pushToken: string, msg: PushMessage): Promise<PushOutcome>;
  close?(): void;
}

// ---------- email ----------

export interface OutgoingEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Extra MIME headers (List-Unsubscribe, List-Unsubscribe-Post). */
  headers: Record<string, string>;
  /** Low-cardinality label for the provider's dashboards (the alert type). */
  tag?: string;
}

export interface EmailSender {
  readonly name: string;
  /** Resolves when the provider accepted the message; throws DeliveryError otherwise. */
  send(msg: OutgoingEmail): Promise<{ messageId?: string }>;
}

// ---------- transports (injectable so tests never touch the network) ----------

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface Http2Response {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface Http2Transport {
  /** One request on a pooled HTTP/2 session to `origin`. `headers` excludes pseudo-headers. */
  request(req: { origin: string; method: string; path: string; headers: Record<string, string>; body: string; timeoutMs: number }): Promise<Http2Response>;
  close(): void;
}
