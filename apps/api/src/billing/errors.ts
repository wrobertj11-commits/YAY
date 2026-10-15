/**
 * A store message or purchase we refuse: forged, for another app, malformed, or presented by the wrong
 * account. `reason` is low-cardinality (safe as a metric label); `status` is the HTTP status to answer.
 * Only these map to 4xx. Anything else (store API down, JWKS fetch failed) is a 5xx, so the store retries.
 */
export class BillingRejection extends Error {
  reason: string;
  status: number;
  constructor(reason: string, message: string, status = 400) {
    super(message);
    this.name = 'BillingRejection';
    this.reason = reason;
    this.status = status;
  }
}
