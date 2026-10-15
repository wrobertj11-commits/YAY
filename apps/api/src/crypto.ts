import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';
import { loadKeyring, needsRotation, seal, unseal, type KeyProvider } from './keyring.ts';

let keyring: KeyProvider | undefined;

export function keys(): KeyProvider {
  keyring ??= loadKeyring(process.env, config.devKeyringFile);
  return keyring;
}

/** Tests and the rotation script inject a keyring explicitly. */
export function setKeyring(next: KeyProvider): void {
  keyring = next;
}

/** AES-256-GCM with a key id, for provider access tokens at rest. */
export function encrypt(plain: string): string {
  return seal(keys(), plain);
}

export function decrypt(sealed: string): string {
  return unseal(keys(), sealed);
}

export function isStale(sealed: string): boolean {
  return needsRotation(keys(), sealed);
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

export function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Signed, tamper-proof link payloads (e.g. one-click unsubscribe). */
export function signPayload(payload: string): string {
  if (!config.linkSecret) throw new Error('LINK_SIGNING_SECRET is not configured');
  const mac = createHmac('sha256', config.linkSecret).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${mac}`;
}

export function verifySignedPayload(token: string): string | undefined {
  if (!config.linkSecret) return undefined;
  const [body, mac] = token.split('.');
  if (!body || !mac) return undefined;
  const payload = Buffer.from(body, 'base64url').toString('utf8');
  const expected = createHmac('sha256', config.linkSecret).update(payload).digest('base64url');
  return safeEqual(mac, expected) ? payload : undefined;
}
