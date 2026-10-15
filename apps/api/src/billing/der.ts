/**
 * Just enough DER to list a certificate's extension OIDs. node:crypto's X509Certificate verifies
 * signatures and exposes dates, issuer and the CA flag, but not arbitrary extensions, and Apple marks
 * its App Store signing certificates with private extensions we must check. Anything malformed throws.
 */

interface Tlv {
  tag: number;
  /** Offset of the first value byte. */
  start: number;
  /** Offset just past the value. */
  end: number;
}

const SEQUENCE = 0x30;
const OID = 0x06;
/** [3] EXPLICIT, constructed: the extensions field of TBSCertificate. */
const EXTENSIONS = 0xa3;

function readTlv(buf: Uint8Array, offset: number, limit: number): Tlv {
  const tag = buf[offset];
  const first = buf[offset + 1];
  if (tag === undefined || first === undefined || offset + 2 > limit) throw new Error('DER: truncated');
  // X.509 never needs high tag numbers; refusing them keeps the reader simple.
  if ((tag & 0x1f) === 0x1f) throw new Error('DER: unsupported tag');
  let start = offset + 2;
  let length = first;
  if (first & 0x80) {
    const n = first & 0x7f;
    // 0x80 is BER's indefinite length, which DER forbids. Four length bytes cover any certificate.
    if (n === 0 || n > 4) throw new Error('DER: bad length');
    length = 0;
    for (let i = 0; i < n; i++) {
      const b = buf[start + i];
      if (b === undefined) throw new Error('DER: truncated');
      length = length * 256 + b;
    }
    start += n;
  }
  const end = start + length;
  if (end > limit) throw new Error('DER: length overruns its container');
  return { tag, start, end };
}

/** Child elements of a constructed value. */
function children(buf: Uint8Array, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let at = parent.start; at < parent.end; ) {
    const t = readTlv(buf, at, parent.end);
    out.push(t);
    at = t.end;
  }
  return out;
}

/** Dotted form of an OBJECT IDENTIFIER value, e.g. "1.2.840.113635.100.6.11.1". */
export function decodeOid(bytes: Uint8Array): string {
  const subids: number[] = [];
  let value = 0;
  let pending = false;
  for (const b of bytes) {
    value = value * 128 + (b & 0x7f);
    if (value > Number.MAX_SAFE_INTEGER) throw new Error('DER: OID arc too large');
    pending = (b & 0x80) !== 0;
    if (!pending) {
      subids.push(value);
      value = 0;
    }
  }
  const [head, ...rest] = subids;
  if (head === undefined || pending) throw new Error('DER: bad OID');
  // The first subidentifier packs the first two arcs as 40 * a + b.
  const a = head < 40 ? 0 : head < 80 ? 1 : 2;
  return [a, head - a * 40, ...rest].join('.');
}

/** OIDs of every extension in a DER certificate (Certificate → TBSCertificate → [3] → Extensions). */
export function extensionOids(der: Uint8Array): string[] {
  const cert = readTlv(der, 0, der.length);
  if (cert.tag !== SEQUENCE || cert.end !== der.length) throw new Error('DER: not a certificate');
  const tbs = children(der, cert)[0];
  if (tbs?.tag !== SEQUENCE) throw new Error('DER: missing TBSCertificate');
  const wrapper = children(der, tbs).find((t) => t.tag === EXTENSIONS);
  if (!wrapper) return [];
  const [list] = children(der, wrapper);
  if (list?.tag !== SEQUENCE) throw new Error('DER: bad extensions');
  return children(der, list).map((ext) => {
    const [id] = children(der, ext);
    if (ext.tag !== SEQUENCE || id?.tag !== OID) throw new Error('DER: bad extension');
    return decodeOid(der.subarray(id.start, id.end));
  });
}
