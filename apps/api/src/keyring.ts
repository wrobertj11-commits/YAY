import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Versioned envelope for provider tokens at rest: `v2.<kid>.<iv>.<tag>.<ciphertext>` (AES-256-GCM).
 * The key id lets us rotate: new writes use the active key, old ciphertexts still decrypt with their
 * own key, and `scripts/rotate-tokens.ts` re-encrypts everything under the active key.
 *
 * Key sources, in order:
 *   TOKEN_KEYRING_FILE   JSON {"active":"kid","keys":{"kid":"<64 hex>"}} — mount it from your KMS /
 *                        secrets manager (e.g. AWS Secrets Manager CSI driver) so keys never live in env.
 *   TOKEN_ENCRYPTION_KEYS "kid1:<hex>,kid2:<hex>" — first entry is active.
 *   TOKEN_ENCRYPTION_KEY  single legacy key, kid "k0".
 *   (dev only) a generated keyring persisted next to the data file.
 */

export interface KeyProvider {
  activeKid(): string;
  key(kid: string): Buffer | undefined;
  kids(): string[];
}

const HEX_KEY = /^[0-9a-f]{64}$/i;

export class StaticKeyring implements KeyProvider {
  private keys: Map<string, Buffer>;
  private active: string;

  constructor(keys: Record<string, string>, active: string) {
    this.keys = new Map();
    for (const [kid, hex] of Object.entries(keys)) {
      if (!/^[\w-]{1,32}$/.test(kid)) throw new Error(`Invalid key id "${kid}"`);
      if (!HEX_KEY.test(hex)) throw new Error(`Key "${kid}" must be 32 bytes of hex`);
      this.keys.set(kid, Buffer.from(hex, 'hex'));
    }
    if (!this.keys.has(active)) throw new Error(`Active key "${active}" is not in the keyring`);
    this.active = active;
  }

  activeKid(): string {
    return this.active;
  }

  key(kid: string): Buffer | undefined {
    return this.keys.get(kid);
  }

  kids(): string[] {
    return [...this.keys.keys()];
  }
}

export interface KeyringEnv {
  TOKEN_KEYRING_FILE?: string;
  TOKEN_ENCRYPTION_KEYS?: string;
  TOKEN_ENCRYPTION_KEY?: string;
  NODE_ENV?: string;
}

export function loadKeyring(env: KeyringEnv, devKeyringPath: string): KeyProvider {
  if (env.TOKEN_KEYRING_FILE) {
    const parsed = JSON.parse(readFileSync(env.TOKEN_KEYRING_FILE, 'utf8')) as { active: string; keys: Record<string, string> };
    return new StaticKeyring(parsed.keys, parsed.active);
  }
  if (env.TOKEN_ENCRYPTION_KEYS) {
    const entries = env.TOKEN_ENCRYPTION_KEYS.split(',').map((e) => e.trim().split(':') as [string, string]);
    const first = entries[0];
    if (!first) throw new Error('TOKEN_ENCRYPTION_KEYS is empty');
    return new StaticKeyring(Object.fromEntries(entries), first[0]);
  }
  if (env.TOKEN_ENCRYPTION_KEY) return new StaticKeyring({ k0: env.TOKEN_ENCRYPTION_KEY }, 'k0');
  if (env.NODE_ENV === 'production') {
    throw new Error('No token encryption key configured. Set TOKEN_KEYRING_FILE (preferred) or TOKEN_ENCRYPTION_KEYS.');
  }
  // Dev convenience: persist a generated key so sandbox tokens survive restarts.
  if (existsSync(devKeyringPath)) {
    const parsed = JSON.parse(readFileSync(devKeyringPath, 'utf8')) as { active: string; keys: Record<string, string> };
    return new StaticKeyring(parsed.keys, parsed.active);
  }
  const ring = { active: 'dev', keys: { dev: randomBytes(32).toString('hex') } };
  mkdirSync(path.dirname(devKeyringPath), { recursive: true });
  writeFileSync(devKeyringPath, JSON.stringify(ring), { mode: 0o600 });
  return new StaticKeyring(ring.keys, ring.active);
}

const b64 = (b: Buffer) => b.toString('base64url');
const unb64 = (s: string | undefined) => Buffer.from(s ?? '', 'base64url');

export function seal(keys: KeyProvider, plain: string): string {
  const kid = keys.activeKid();
  const key = keys.key(kid);
  if (!key) throw new Error(`Active key "${kid}" missing`);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`v2.${kid}`));
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v2', kid, b64(iv), b64(cipher.getAuthTag()), b64(data)].join('.');
}

function open(key: Buffer, iv: Buffer, tag: Buffer, data: Buffer, aad?: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function unseal(keys: KeyProvider, sealed: string): string {
  const parts = sealed.split('.');
  if (parts[0] === 'v2' && parts.length === 5) {
    const kid = parts[1] ?? '';
    const key = keys.key(kid);
    if (!key) throw new Error(`Unknown encryption key id "${kid}"`);
    return open(key, unb64(parts[2]), unb64(parts[3]), unb64(parts[4]), Buffer.from(`v2.${kid}`));
  }
  if (parts.length === 3) {
    // Legacy v1 format (no key id, no AAD): try every key.
    for (const kid of keys.kids()) {
      const key = keys.key(kid);
      if (!key) continue;
      try {
        return open(key, unb64(parts[0]), unb64(parts[1]), unb64(parts[2]));
      } catch {
        // wrong key, keep trying
      }
    }
    throw new Error('Could not decrypt legacy token with any configured key');
  }
  throw new Error('Unrecognized sealed token format');
}

/** True when a ciphertext should be rewritten under the active key. */
export function needsRotation(keys: KeyProvider, sealed: string): boolean {
  const parts = sealed.split('.');
  return !(parts[0] === 'v2' && parts[1] === keys.activeKid());
}
