import { existsSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { config } from './config.ts';
import { Router } from './http.ts';
import { reportError } from './log.ts';
import type { PipelineDeps } from './pipeline.ts';
import type { RateLimiter } from './ratelimit.ts';
import { registerRoutes } from './routes/index.ts';
import type { Store } from './store.ts';

export function createRouter(store: Store, deps: PipelineDeps, limiter?: RateLimiter): Router {
  const router = new Router(store, limiter);
  registerRoutes({ router, store, deps });
  return router;
}

export function createApp(store: Store, deps: PipelineDeps, limiter?: RateLimiter) {
  const router = createRouter(store, deps, limiter);
  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (await router.handle(req, res)) return;
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname.startsWith('/api/')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    serveStatic(pathname, res);
  }
  // node:http ignores the handler's return value, so failures must be caught here.
  return (req: IncomingMessage, res: ServerResponse): void => {
    handle(req, res).catch((err: unknown) => {
      reportError(err, { source: 'http' });
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end();
    });
  };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

function serveStatic(pathname: string, res: ServerResponse) {
  const root = config.webDist;
  let file = path.join(root, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(root, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Web app not built. Run `npm run build -w @trialguard/web` or use `npm run dev`.');
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(readFileSync(file));
}
