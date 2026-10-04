import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const production = env.NODE_ENV === 'production';
const dataFile = env.TRIALGUARD_DATA_FILE ?? path.resolve(here, '../data/db.json');

export const config = {
  production,
  port: Number(env.PORT ?? 8787),
  dataFile,
  devKeyringFile: path.join(path.dirname(dataFile), 'dev-keyring.json'),
  /** Lock file that elects one instance to run background jobs. */
  jobLockFile: env.TRIALGUARD_JOB_LOCK_FILE ?? path.join(path.dirname(dataFile), 'jobs.lock'),
  webDist: path.resolve(here, '../../web/dist'),
  /** Public base URL, used in email links (unsubscribe, deep links). */
  publicUrl: (env.PUBLIC_URL ?? `http://localhost:${env.PORT ?? 8787}`).replace(/\/$/, ''),
  /** Honour X-Forwarded-For (only when running behind a trusted proxy / load balancer). */
  trustProxy: env.TRUST_PROXY === '1',
  /** Domain for personal forwarding addresses (F6). */
  inboundDomain: env.INBOUND_EMAIL_DOMAIN ?? 'in.trialguard.app',
  /** Shared secret the inbound-email provider (e.g. SES/Postmark webhook) sends. Required in production. */
  inboundSecret: env.INBOUND_WEBHOOK_SECRET,
  /** Bearer token for ops/admin endpoints (concierge queue). Unset = admin API disabled. */
  adminToken: env.ADMIN_TOKEN,
  /** Bearer token for GET /metrics. Unset = metrics open in dev, disabled in production. */
  metricsToken: env.METRICS_TOKEN,
  /** HMAC secret for signed links (unsubscribe). Falls back to a dev constant outside production. */
  linkSecret: env.LINK_SIGNING_SECRET ?? (production ? undefined : 'dev-link-secret'),
  plaid: {
    clientId: env.PLAID_CLIENT_ID,
    secret: env.PLAID_SECRET,
    env: env.PLAID_ENV ?? 'sandbox',
    webhookUrl: env.PLAID_WEBHOOK_URL,
  },
  /** LLM extraction runs only when Anthropic credentials are configured. */
  llmEnabled: Boolean(env.ANTHROPIC_API_KEY ?? env.ANTHROPIC_AUTH_TOKEN) && env.TRIALGUARD_DISABLE_LLM !== '1',
  /** Run the background scheduler (alert dispatch, daily re-check). Off in tests. */
  runJobs: env.TRIALGUARD_JOBS !== '0',
  /** Lets the demo app log back in by email without a magic link, and switch plans without billing. */
  devLogin: !production,
};

/** Fail fast on settings production can't run without. */
export function assertProductionConfig(): void {
  if (!production) return;
  const missing = [
    ['INBOUND_WEBHOOK_SECRET', config.inboundSecret],
    ['LINK_SIGNING_SECRET', config.linkSecret],
    ['PUBLIC_URL', env.PUBLIC_URL],
  ].filter(([, v]) => !v);
  if (missing.length) throw new Error(`Missing production config: ${missing.map(([k]) => k).join(', ')}`);
}

export const MIN_NODE = [22, 18] as const;

/** The API runs TypeScript through Node's built-in type stripping, which needs Node ≥ 22.18. */
export function assertNodeVersion(version = process.versions.node): void {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
    throw new Error(`Trialguard needs Node ${MIN_NODE.join('.')}+ (found ${version}).`);
  }
}
