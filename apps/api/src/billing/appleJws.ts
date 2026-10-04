import { verify, X509Certificate } from 'node:crypto';
import { z } from 'zod';
import { extensionOids } from './der.ts';
import { BillingRejection } from './errors.ts';

/**
 * Verification of the JWS objects the App Store signs (notification payloads, transactions, renewal
 * info). Apple signs with ES256 and puts the chain in the `x5c` header: [leaf, intermediate, root].
 * The chain is only as good as its anchor, so the root must byte-match a pinned copy of Apple Root
 * CA - G3 that ops downloads from apple.com/certificateauthority. Nothing in the JWS itself is trusted
 * until the chain and the signature check out.
 */

/** Apple's marker extensions: the leaf is an App Store receipt-signing certificate, issued by Apple WWDR. */
export const APPLE_LEAF_MARKER_OID = '1.2.840.113635.100.6.11.1';
export const APPLE_INTERMEDIATE_MARKER_OID = '1.2.840.113635.100.6.2.1';

/** Why a JWS was rejected. Low-cardinality, so it is safe as a metric label. */
export type JwsFailure = 'malformed' | 'algorithm' | 'chain' | 'untrusted_root' | 'certificate_validity' | 'marker' | 'signature';

export class JwsError extends BillingRejection {
  constructor(reason: JwsFailure, message: string) {
    super(reason, message, 400);
    this.name = 'JwsError';
  }
}

const SEGMENT = /^[A-Za-z0-9_-]+$/;
/** ES256 signatures in JWS are raw r||s (RFC 7518 §3.4), 32 bytes each for P-256. */
const ES256_SIGNATURE_BYTES = 64;

const zHeader = z.looseObject({
  alg: z.string(),
  // Apple's certificates are well under 2 KB each; the cap only bounds parsing work.
  x5c: z.array(z.string().max(8192)).optional(),
});

function decodeJson(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new JwsError('malformed', 'segment is not base64url JSON');
  }
}

/**
 * Parses trusted roots from a file's bytes: one or more PEM certificates, or a single DER certificate
 * (Apple publishes AppleRootCA-G3.cer in DER).
 */
export function parseCertificates(bytes: Buffer): X509Certificate[] {
  const pems = bytes.toString('latin1').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  return pems ? pems.map((pem) => new X509Certificate(pem)) : [new X509Certificate(bytes)];
}

function withinValidity(cert: X509Certificate, now: Date): boolean {
  const t = now.getTime();
  return t >= cert.validFromDate.getTime() && t <= cert.validToDate.getTime();
}

function hasExtension(cert: X509Certificate, oid: string): boolean {
  try {
    return extensionOids(cert.raw).includes(oid);
  } catch {
    return false;
  }
}

/**
 * Checks an x5c chain [leaf, intermediate, root] the way Apple's own server library does: exactly three
 * certificates, a pinned root, each certificate signed by the next, all valid at `now`, the CA flags in
 * the right places and Apple's marker extensions present. Returns the leaf.
 */
export function verifyAppleChain(chain: readonly X509Certificate[], roots: readonly X509Certificate[], now: Date): X509Certificate {
  const [leaf, intermediate, root] = chain;
  if (chain.length !== 3 || !leaf || !intermediate || !root) throw new JwsError('chain', 'x5c must hold exactly leaf, intermediate and root');
  if (!roots.some((pinned) => pinned.raw.equals(root.raw))) throw new JwsError('untrusted_root', 'root is not the pinned Apple root');
  for (const cert of chain) {
    if (!withinValidity(cert, now)) throw new JwsError('certificate_validity', 'certificate outside its validity period');
  }
  if (leaf.ca || !intermediate.ca || !root.ca) throw new JwsError('chain', 'unexpected CA flags');
  if (!leaf.checkIssued(intermediate) || !leaf.verify(intermediate.publicKey)) throw new JwsError('chain', 'leaf not issued by intermediate');
  if (!intermediate.checkIssued(root) || !intermediate.verify(root.publicKey)) throw new JwsError('chain', 'intermediate not issued by root');
  if (!hasExtension(leaf, APPLE_LEAF_MARKER_OID)) throw new JwsError('marker', 'leaf lacks the App Store marker extension');
  if (!hasExtension(intermediate, APPLE_INTERMEDIATE_MARKER_OID)) throw new JwsError('marker', 'intermediate lacks the Apple WWDR marker extension');
  return leaf;
}

/**
 * Verifies an App Store JWS and returns its decoded payload (still to be schema-checked by the caller).
 * Throws JwsError on anything short of a valid ES256 signature by a leaf that chains to a pinned root.
 */
export function verifyAppleJws(jws: string, roots: readonly X509Certificate[], now: Date): unknown {
  const parts = jws.split('.');
  const [h, p, s] = parts;
  if (parts.length !== 3 || !h || !p || !s || !parts.every((x) => SEGMENT.test(x))) throw new JwsError('malformed', 'not a compact JWS');

  const header = zHeader.safeParse(decodeJson(h));
  if (!header.success) throw new JwsError('malformed', 'bad JWS header');
  // Pin the algorithm before touching keys: no "none", no HMAC-with-a-public-key confusion.
  if (header.data.alg !== 'ES256') throw new JwsError('algorithm', 'alg must be ES256');
  if (!header.data.x5c) throw new JwsError('chain', 'x5c header missing');

  let chain: X509Certificate[];
  try {
    chain = header.data.x5c.map((der) => new X509Certificate(Buffer.from(der, 'base64')));
  } catch {
    throw new JwsError('chain', 'x5c holds an unparseable certificate');
  }
  const leaf = verifyAppleChain(chain, roots, now);

  const key = leaf.publicKey;
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new JwsError('algorithm', 'leaf key is not P-256');
  const signature = Buffer.from(s, 'base64url');
  if (signature.length !== ES256_SIGNATURE_BYTES) throw new JwsError('signature', 'bad signature length');
  const ok = verify('sha256', Buffer.from(`${h}.${p}`, 'ascii'), { key, dsaEncoding: 'ieee-p1363' }, signature);
  if (!ok) throw new JwsError('signature', 'signature does not verify');
  return decodeJson(p);
}
