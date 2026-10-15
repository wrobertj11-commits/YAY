import { createPrivateKey, type KeyObject } from 'node:crypto';
import { connect, constants, type ClientHttp2Session } from 'node:http2';
import { log } from '../log.ts';
import { signJwt } from './jwt.ts';
import type { Http2Response, Http2Transport, PushMessage, PushOutcome, PushProvider } from './types.ts';

/**
 * Apple Push Notification service over HTTP/2 with token-based auth: an ES256 JWT signed with the
 * team's .p8 key (header `kid` = key id, claims `iss` = team id, `iat`).
 */

export interface ApnsConfig {
  /** Contents of AuthKey_<KEYID>.p8 (PKCS#8 PEM, P-256). */
  keyPem: string;
  keyId: string;
  teamId: string;
  /** The app's bundle id; sent as apns-topic. */
  bundleId: string;
  /** Production gateway vs sandbox (development builds). Tokens from one are BadDeviceToken on the other. */
  production: boolean;
}

export const APNS_ORIGINS = { production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' } as const;

/** Apple rejects provider tokens older than an hour and throttles refreshing more than every 20 minutes. */
const PROVIDER_TOKEN_TTL_MS = 50 * 60_000;
/** Reasons that mean the device token itself is dead (app removed, token rotated, wrong environment). */
const DEAD_TOKEN_REASONS = new Set(['BadDeviceToken', 'Unregistered']);
const STALE_PROVIDER_TOKEN = new Set(['ExpiredProviderToken', 'InvalidProviderToken']);

interface ApnsOptions {
  transport?: Http2Transport;
  clock?: () => Date;
  timeoutMs?: number;
}

export class ApnsProvider implements PushProvider {
  readonly name = 'apns' as const;
  private cfg: ApnsConfig;
  private key: KeyObject;
  private transport: Http2Transport;
  private clock: () => Date;
  private timeoutMs: number;
  private providerToken?: { jwt: string; issuedAt: number };

  constructor(cfg: ApnsConfig, opts: ApnsOptions = {}) {
    this.cfg = cfg;
    // Parse now so a bad key fails at boot, not on the first alert.
    this.key = createPrivateKey(cfg.keyPem);
    if (this.key.asymmetricKeyType !== 'ec') throw new Error('APNs key must be the EC (P-256) .p8 key from the Apple Developer portal');
    this.transport = opts.transport ?? http2Transport();
    this.clock = opts.clock ?? (() => new Date());
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async send(pushToken: string, msg: PushMessage): Promise<PushOutcome> {
    const headers: Record<string, string> = {
      authorization: `bearer ${this.authToken()}`,
      'apns-topic': this.cfg.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-collapse-id': msg.collapseId,
      'content-type': 'application/json',
    };
    // No point delivering a "trial ends soon" warning after the charge.
    const expires = msg.expiresAt ? Date.parse(msg.expiresAt) : Number.NaN;
    if (Number.isFinite(expires)) headers['apns-expiration'] = String(Math.floor(expires / 1000));

    const res = await this.transport.request({
      origin: this.cfg.production ? APNS_ORIGINS.production : APNS_ORIGINS.sandbox,
      method: 'POST',
      path: `/3/device/${encodeURIComponent(pushToken)}`,
      headers,
      body: apnsPayload(msg),
      timeoutMs: this.timeoutMs,
    });
    return this.outcome(res);
  }

  close(): void {
    this.transport.close();
  }

  private outcome(res: Http2Response): PushOutcome {
    if (res.status === 200) return { ok: true };
    const reason = parseReason(res.body) ?? `HTTP ${res.status}`;
    if (res.status === 410 || DEAD_TOKEN_REASONS.has(reason)) return { ok: false, invalidToken: true, retryable: false, reason };
    if (STALE_PROVIDER_TOKEN.has(reason)) {
      this.providerToken = undefined; // mint a fresh JWT on the retry
      return { ok: false, invalidToken: false, retryable: true, reason };
    }
    if (res.status === 429 || res.status >= 500) return { ok: false, invalidToken: false, retryable: true, reason, retryAfterMs: retryAfterMs(res.headers['retry-after']) };
    // BadTopic, PayloadTooLarge, DeviceTokenNotForTopic...: retrying the same request won't help, and
    // they point at our configuration rather than a dead token, so the device stays enabled.
    return { ok: false, invalidToken: false, retryable: false, reason };
  }

  private authToken(): string {
    const now = this.clock().getTime();
    if (this.providerToken && now - this.providerToken.issuedAt < PROVIDER_TOKEN_TTL_MS) return this.providerToken.jwt;
    const jwt = signJwt('ES256', { kid: this.cfg.keyId }, { iss: this.cfg.teamId, iat: Math.floor(now / 1000) }, this.key);
    this.providerToken = { jwt, issuedAt: now };
    return jwt;
  }
}

/** APNs caps the payload at 4 KB; alert copy is short, but cap it so a long item name can't break delivery. */
export function apnsPayload(msg: PushMessage): string {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const { aps: _reserved, ...data } = msg.data;
  return JSON.stringify({ aps: { alert: { title: clip(msg.title, 120), body: clip(msg.body, 600) }, sound: 'default' }, ...data });
}

function parseReason(body: string): string | undefined {
  try {
    const reason = (JSON.parse(body) as { reason?: unknown }).reason;
    return typeof reason === 'string' ? reason.slice(0, 64) : undefined;
  } catch {
    return undefined;
  }
}

export function retryAfterMs(header: string | string[] | undefined): number | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  const seconds = Number(value);
  return value && Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 3600) * 1000 : undefined;
}

/**
 * Pooled HTTP/2 client. APNs wants long-lived connections (opening one per push gets you throttled),
 * so one session per origin is reused and dropped when the server sends GOAWAY or it errors or idles.
 */
export function http2Transport(idleMs = 5 * 60_000): Http2Transport {
  const sessions = new Map<string, ClientHttp2Session>();

  const session = (origin: string): ClientHttp2Session => {
    const existing = sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const s = connect(origin);
    const drop = () => {
      if (sessions.get(origin) === s) sessions.delete(origin);
    };
    s.on('error', (err) => {
      log.warn('http2 session error', { origin, err });
      drop();
    });
    s.on('goaway', drop);
    s.on('close', drop);
    s.setTimeout(idleMs, () => s.close());
    sessions.set(origin, s);
    return s;
  };

  return {
    request({ origin, method, path, headers, body, timeoutMs }) {
      return new Promise<Http2Response>((resolve, reject) => {
        let stream;
        try {
          stream = session(origin).request({ ':method': method, ':path': path, ...headers });
        } catch (err) {
          reject(err);
          return;
        }
        const req = stream;
        const chunks: Buffer[] = [];
        let status = 0;
        let resHeaders: Http2Response['headers'] = {};
        req.setTimeout(timeoutMs, () => {
          req.close(constants.NGHTTP2_CANCEL);
          reject(new Error(`HTTP/2 request timed out after ${timeoutMs}ms`));
        });
        req.on('response', (h) => {
          status = Number(h[':status']);
          resHeaders = Object.fromEntries(Object.entries(h).map(([k, v]) => [k, typeof v === 'number' ? String(v) : v]));
        });
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => resolve({ status, headers: resHeaders, body: Buffer.concat(chunks).toString('utf8') }));
        req.on('error', reject);
        req.end(body);
      });
    },
    close() {
      for (const s of sessions.values()) s.close();
      sessions.clear();
    },
  };
}
