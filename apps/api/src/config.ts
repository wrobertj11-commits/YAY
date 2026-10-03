import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: Number(process.env.PORT ?? 8787),
  dataFile: process.env.TRIALGUARD_DATA_FILE ?? path.resolve(here, '../data/db.json'),
  webDist: path.resolve(here, '../../web/dist'),
  /** 32-byte hex key for encrypting provider tokens at rest. A random key is used in dev (tokens won't survive restarts). */
  tokenKey: process.env.TOKEN_ENCRYPTION_KEY ?? randomBytes(32).toString('hex'),
  /** Domain for personal forwarding addresses (F6). */
  inboundDomain: process.env.INBOUND_EMAIL_DOMAIN ?? 'in.trialguard.app',
  /** Shared secret the inbound-email provider (e.g. SES/Postmark webhook) sends. */
  inboundSecret: process.env.INBOUND_WEBHOOK_SECRET,
  plaid: {
    clientId: process.env.PLAID_CLIENT_ID,
    secret: process.env.PLAID_SECRET,
    env: process.env.PLAID_ENV ?? 'sandbox',
  },
  /** LLM extraction runs only when Anthropic credentials are configured. */
  llmEnabled: Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN) && process.env.TRIALGUARD_DISABLE_LLM !== '1',
  /** Run the background scheduler (alert dispatch, daily re-check). Off in tests. */
  runJobs: process.env.TRIALGUARD_JOBS !== '0',
  /** Lets the demo app log back in by email without a magic link. Never enable in production. */
  devLogin: process.env.NODE_ENV !== 'production',
};
