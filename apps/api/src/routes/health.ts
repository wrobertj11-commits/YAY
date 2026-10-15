import { config } from '../config.ts';
import { safeEqual } from '../crypto.ts';
import { HttpError, Reply } from '../http.ts';
import { renderPrometheus } from '../metrics.ts';
import { PlaidBank } from '../providers/bank.ts';
import type { RouteDeps } from './shared.ts';

const startedAt = new Date().toISOString();

export function register({ router, store }: RouteDeps) {
  /** Liveness: the process is up and serving. */
  router.on('GET', '/healthz', { auth: 'none' }, () => ({ ok: true }));

  /** Readiness: dependencies are usable, so the instance can take traffic. */
  router.on('GET', '/readyz', { auth: 'none' }, () => {
    const checks: Record<string, boolean> = { store: Array.isArray(store.data.users), storeWritable: store.writable() };
    const ok = Object.values(checks).every(Boolean);
    return new Reply(ok ? 200 : 503, { ok, checks, startedAt });
  });

  /** Prometheus scrape endpoint. Requires METRICS_TOKEN in production. */
  router.on('GET', '/metrics', { auth: 'none' }, ({ req }) => {
    if (config.metricsToken) {
      const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (!safeEqual(bearer, config.metricsToken)) throw new HttpError(401, 'Metrics token required');
    } else if (config.production) {
      throw new HttpError(404, 'Not found');
    }
    return Reply.text(renderPrometheus(), 200, 'text/plain; version=0.0.4');
  });

  /** Feature flags the app can read. */
  router.on('GET', '/api/health', { auth: 'none' }, () => ({ ok: true, llm: config.llmEnabled, plaid: PlaidBank.configured() }));
}
