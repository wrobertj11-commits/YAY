import { readFileSync } from 'node:fs';
import { log } from '../log.ts';
import type { AppleBillingConfig } from './apple.ts';
import { parseCertificates } from './appleJws.ts';
import { playApi, type GoogleBillingConfig } from './google.ts';
import { ANDROID_PUBLISHER_SCOPE, googleJwks, parseServiceAccount, serviceAccountTokens } from './googleAuth.ts';

/**
 * Store billing settings, from the environment:
 *   APPLE_BUNDLE_ID, APPLE_ROOT_CA_PATH        App Store notifications. The root file is Apple Root CA - G3
 *                                               as downloaded from apple.com/certificateauthority (DER or PEM).
 *   APPLE_ENVIRONMENTS                          Accepted environments, default "Production,Sandbox".
 *   GOOGLE_PLAY_PACKAGE_NAME, GOOGLE_PUBSUB_AUDIENCE, GOOGLE_PUBSUB_SERVICE_ACCOUNT,
 *   GOOGLE_PLAY_SERVICE_ACCOUNT_PATH            Play RTDN: push-auth policy, plus the key file used to call
 *                                               the Play Developer API.
 * A store left unconfigured answers 503, so its notifications queue up at Apple / Pub/Sub until it is set
 * up. A half-configured store is a deployment mistake and fails at boot.
 */

export interface BillingDeps {
  apple?: AppleBillingConfig;
  google?: GoogleBillingConfig;
}

const APPLE_VARS = ['APPLE_BUNDLE_ID', 'APPLE_ROOT_CA_PATH'] as const;
const GOOGLE_VARS = ['GOOGLE_PLAY_PACKAGE_NAME', 'GOOGLE_PUBSUB_AUDIENCE', 'GOOGLE_PUBSUB_SERVICE_ACCOUNT', 'GOOGLE_PLAY_SERVICE_ACCOUNT_PATH'] as const;

/** All set → the values; none set → undefined; some set → throws. */
function group<K extends string>(env: NodeJS.ProcessEnv, names: readonly K[], label: string): Record<K, string> | undefined {
  const set = names.filter((n) => env[n]);
  if (!set.length) return undefined;
  const missing = names.filter((n) => !env[n]);
  if (missing.length) throw new Error(`${label} billing is half configured; missing ${missing.join(', ')}`);
  return Object.fromEntries(names.map((n) => [n, env[n] ?? ''])) as Record<K, string>;
}

function readConfigFile(path: string, what: string): Buffer {
  try {
    return readFileSync(path);
  } catch (err) {
    throw new Error(`Cannot read ${what} at ${path}: ${(err as Error).message}`, { cause: err });
  }
}

export function billingFromEnv(opts: { clock: () => Date; env?: NodeJS.ProcessEnv; fetch?: typeof fetch }): BillingDeps {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetch ?? fetch;
  const deps: BillingDeps = {};

  const apple = group(env, APPLE_VARS, 'App Store');
  if (apple) {
    const roots = parseCertificates(readConfigFile(apple.APPLE_ROOT_CA_PATH, 'APPLE_ROOT_CA_PATH'));
    if (!roots.every((r) => r.ca)) throw new Error('APPLE_ROOT_CA_PATH must hold CA certificates (Apple Root CA - G3)');
    const environments = (env.APPLE_ENVIRONMENTS ?? 'Production,Sandbox')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    deps.apple = { bundleId: apple.APPLE_BUNDLE_ID, roots, environments };
  }

  const google = group(env, GOOGLE_VARS, 'Google Play');
  if (google) {
    const account = parseServiceAccount(readConfigFile(google.GOOGLE_PLAY_SERVICE_ACCOUNT_PATH, 'GOOGLE_PLAY_SERVICE_ACCOUNT_PATH').toString('utf8'));
    deps.google = {
      packageName: google.GOOGLE_PLAY_PACKAGE_NAME,
      push: { audience: google.GOOGLE_PUBSUB_AUDIENCE, serviceAccountEmail: google.GOOGLE_PUBSUB_SERVICE_ACCOUNT },
      jwks: googleJwks({ fetch: fetchImpl, clock: opts.clock }),
      play: playApi({ fetch: fetchImpl, tokens: serviceAccountTokens({ account, scope: ANDROID_PUBLISHER_SCOPE, fetch: fetchImpl, clock: opts.clock }) }),
    };
  }

  if (env.NODE_ENV === 'production') {
    if (!deps.apple) log.warn('App Store notifications disabled: set APPLE_BUNDLE_ID and APPLE_ROOT_CA_PATH');
    if (!deps.google) log.warn(`Google Play notifications disabled: set ${GOOGLE_VARS.join(', ')}`);
  }
  return deps;
}
