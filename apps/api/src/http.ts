import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { config } from './config.ts';
import { safeEqual } from './crypto.ts';
import { log, reportError, type Logger } from './log.ts';
import { inc, observe } from './metrics.ts';
import { RateLimiter, type LimitName } from './ratelimit.ts';
import type { Store, User } from './store.ts';

export class HttpError extends Error {
  status: number;
  details?: unknown;
  headers?: Record<string, string>;
  constructor(status: number, message: string, details?: unknown, headers?: Record<string, string>) {
    super(message);
    this.status = status;
    this.details = details;
    this.headers = headers;
  }
}

export function assert(cond: unknown, message: string, status = 400): asserts cond {
  if (!cond) throw new HttpError(status, message);
}

/** A handler can return a Reply for non-200 statuses, custom headers or non-JSON bodies. */
export class Reply {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  constructor(status: number, body: unknown, headers: Record<string, string> = {}) {
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
  static html(html: string, status = 200) {
    return new Reply(status, html, { 'Content-Type': 'text/html; charset=utf-8' });
  }
  static text(text: string, status = 200, contentType = 'text/plain; charset=utf-8') {
    return new Reply(status, text, { 'Content-Type': contentType });
  }
}

/** Extracts `{ id: string }` from "/api/items/:id". */
type PathParams<P extends string> = P extends `${string}:${infer K}/${infer Rest}`
  ? { [k in K]: string } & PathParams<`/${Rest}`>
  : P extends `${string}:${infer K}`
    ? { [k in K]: string }
    : Record<never, string>;

export type AuthMode = 'user' | 'admin' | 'none';

export interface Context<P extends string, B, Q, A extends AuthMode> {
  req: IncomingMessage;
  params: PathParams<P>;
  body: B;
  /** Exact request bytes, for webhook signature checks. */
  rawBody: Buffer;
  query: Q;
  user: A extends 'user' ? User : undefined;
  ip: string;
  requestId: string;
  log: Logger;
}

export interface RouteOptions<B, Q, A extends AuthMode> {
  /** Who may call it. Default 'user' (Bearer token). */
  auth?: A;
  /** Zod schema for the JSON body. Requests that don't match get a 400 listing each problem. */
  body?: z.ZodType<B>;
  query?: z.ZodType<Q>;
  /** Rate-limit bucket. Default 'default'. */
  limit?: LimitName;
  /** Custom bucket key (default: user id when signed in, else client IP). */
  limitKey?: (ctx: { ip: string; user?: User; params: Record<string, string> }) => string;
  /** Max body size in bytes. Default 1 MB. */
  maxBody?: number;
  /**
   * Skip JSON parsing and body validation; the handler reads `rawBody` itself. Only for bodies that
   * aren't JSON (e.g. RFC 8058 one-click unsubscribe posts `List-Unsubscribe=One-Click` form data).
   */
  raw?: boolean;
}

interface Route {
  method: string;
  path: string;
  pattern: RegExp;
  keys: string[];
  opts: RouteOptions<unknown, unknown, AuthMode>;
  handler: (ctx: Context<string, unknown, unknown, AuthMode>) => unknown;
}

export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.length ? i.path.join('.') : 'body'}: ${i.message}`);
}

async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > max) throw new HttpError(413, 'Body too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new HttpError(413, 'Body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function isEmptyObject(v: unknown): boolean {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0;
}

/**
 * The caller's address. Behind proxies, X-Forwarded-For is "<whatever the client sent>, …, <added by our proxies>":
 * load balancers append, so the left-most entries are attacker-controlled. Count `trustProxyHops` entries from
 * the right instead (1 = a single load balancer in front of us).
 */
export function clientIp(req: IncomingMessage, hops = config.trustProxyHops): string {
  if (hops > 0) {
    const fwd = req.headers['x-forwarded-for'];
    const parts = (Array.isArray(fwd) ? fwd.join(',') : (fwd ?? '')).split(',').map((p) => p.trim()).filter(Boolean);
    const chosen = parts[parts.length - hops];
    if (chosen) return chosen;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export class Router {
  private routes: Route[] = [];
  private store: Store;
  private limiter: RateLimiter;

  constructor(store: Store, limiter = new RateLimiter()) {
    this.store = store;
    this.limiter = limiter;
  }

  on<P extends string, B = Record<string, never>, Q = Record<string, string | undefined>, A extends AuthMode = 'user'>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: P,
    opts: RouteOptions<B, Q, A>,
    handler: (ctx: Context<P, B, Q, A>) => unknown,
  ): void {
    const keys: string[] = [];
    const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, k: string) => (keys.push(k), '([^/]+)'))}$`);
    this.routes.push({
      method,
      path,
      pattern,
      keys,
      opts: opts as RouteOptions<unknown, unknown, AuthMode>,
      handler: handler as unknown as Route['handler'],
    });
  }

  /** Lists routes (used by tests to assert every mutating route validates its body). */
  list(): { method: string; path: string; validated: boolean; raw: boolean; auth: AuthMode }[] {
    return this.routes.map((r) => ({ method: r.method, path: r.path, validated: Boolean(r.opts.body), raw: Boolean(r.opts.raw), auth: r.opts.auth ?? 'user' }));
  }

  /** Returns true when it handled the request. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const candidates = this.routes.filter((r) => r.pattern.test(url.pathname));
    if (!candidates.length) return false;

    const started = performance.now();
    const requestId = (req.headers['x-request-id'] as string | undefined)?.slice(0, 64) || randomUUID();
    const ip = clientIp(req);
    const route = candidates.find((r) => r.method === req.method);
    const reqLog = log.child({ requestId, method: req.method, route: route?.path ?? url.pathname });
    let status = 500;

    const send = (code: number, payload: unknown, headers: Record<string, string> = {}) => {
      status = code;
      const isJson = !headers['Content-Type'];
      res.writeHead(code, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Request-Id': requestId,
        'X-Content-Type-Options': 'nosniff',
        ...headers,
      });
      res.end(isJson ? JSON.stringify(payload) : String(payload));
    };

    try {
      if (!route) throw new HttpError(405, 'Method not allowed', undefined, { Allow: candidates.map((r) => r.method).join(', ') });
      const opts = route.opts;
      const auth = opts.auth ?? 'user';

      let user: User | undefined;
      const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (auth === 'user') {
        user = bearer ? this.store.userByToken(bearer) : undefined;
        if (!user) {
          // Unauthenticated attempts share the auth bucket so token guessing is throttled too.
          const wait = this.limiter.take('auth', ip);
          if (wait) throw new HttpError(429, 'Too many requests', undefined, { 'Retry-After': String(wait) });
          throw new HttpError(401, 'Sign in required');
        }
      } else if (auth === 'admin') {
        if (!config.adminToken || !safeEqual(bearer, config.adminToken)) {
          // Wrong admin tokens drain the same per-IP auth bucket, so the token can't be brute-forced.
          const wait = this.limiter.take('auth', ip);
          if (wait) throw new HttpError(429, 'Too many requests', undefined, { 'Retry-After': String(wait) });
          throw new HttpError(config.adminToken ? 401 : 404, config.adminToken ? 'Admin token required' : 'Not found');
        }
      }

      const m = route.pattern.exec(url.pathname);
      const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m?.[i + 1] ?? '')]));

      const limitName = opts.limit ?? 'default';
      const limitKey = opts.limitKey?.({ ip, user, params }) ?? user?.id ?? ip;
      const wait = this.limiter.take(limitName, limitKey);
      if (wait) {
        inc('rate_limited_total', { bucket: limitName });
        throw new HttpError(429, 'Too many requests', undefined, { 'Retry-After': String(wait) });
      }

      const rawBody = req.method === 'GET' || req.method === 'DELETE' ? Buffer.alloc(0) : await readBody(req, opts.maxBody ?? 1_000_000);
      let json: unknown = {};
      if (rawBody.length && !opts.raw) {
        try {
          json = JSON.parse(rawBody.toString('utf8'));
        } catch {
          throw new HttpError(400, 'Invalid JSON');
        }
      }

      let body: unknown = json;
      if (opts.body) {
        const parsed = opts.body.safeParse(json);
        if (!parsed.success) throw new HttpError(400, 'Invalid request', formatIssues(parsed.error));
        body = parsed.data;
      } else if (rawBody.length && !opts.raw && !isEmptyObject(json)) {
        // Every route that accepts a body must declare a schema.
        throw new HttpError(400, 'This endpoint takes no body');
      }

      let query: unknown = Object.fromEntries(url.searchParams);
      if (opts.query) {
        const parsed = opts.query.safeParse(query);
        if (!parsed.success) throw new HttpError(400, 'Invalid query', formatIssues(parsed.error));
        query = parsed.data;
      }

      const result = await route.handler({ req, params, body, rawBody, query, user, ip, requestId, log: reqLog } as Context<string, unknown, unknown, AuthMode>);
      if (result instanceof Reply) send(result.status, result.body, result.headers);
      else send(200, result ?? { ok: true });
    } catch (err) {
      if (err instanceof HttpError) {
        send(err.status, { error: err.message, ...(err.details ? { details: err.details } : {}) }, err.headers);
      } else {
        reportError(err, { requestId, route: route?.path });
        send(500, { error: 'Something went wrong', requestId });
      }
    } finally {
      const seconds = (performance.now() - started) / 1000;
      const routeLabel = route?.path ?? 'unmatched';
      inc('http_requests_total', { route: routeLabel, method: req.method ?? '', status: `${Math.floor(status / 100)}xx` });
      observe('http_request_duration_seconds', seconds, { route: routeLabel });
      reqLog.info('request', { status, ms: Math.round(seconds * 1000) });
    }
    return true;
  }
}
