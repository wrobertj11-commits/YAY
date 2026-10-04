import { scrub } from '../log.ts';
import { DeliveryError, type EmailSender, type FetchLike, type OutgoingEmail } from './types.ts';

/**
 * Transactional email (alert emails) behind `EmailSender`, with Postmark as the implementation.
 *
 * Env: POSTMARK_SERVER_TOKEN (enables sending), EMAIL_FROM ("Trialguard <alerts@trialguard.app>"),
 * COMPANY_POSTAL_ADDRESS (CAN-SPAM; required in production when sending is enabled),
 * POSTMARK_MESSAGE_STREAM (default "outbound", Postmark's default transactional stream).
 *
 * DNS checklist for the sending domain (example: trialguard.app). Do all of it before launch; Gmail and
 * Yahoo reject or spam-folder mail from domains without it.
 *
 *  1. Postmark → Sender Signatures → add the domain (not a single address) so any @trialguard.app From works.
 *  2. DKIM: add the TXT record Postmark shows, at `<selector>pm._domainkey.trialguard.app`, value
 *     `k=rsa; p=<public key>` copied exactly (one string; some DNS UIs split it at 255 chars, which is fine).
 *     Click "Verify" in Postmark. The signature then carries d=trialguard.app, which DMARC aligns on.
 *  3. Return-Path (bounce domain, gives SPF alignment): CNAME `pm-bounces.trialguard.app` → `pm.mtasv.net`,
 *     then verify it in Postmark. SPF is evaluated on this domain, so the root SPF record does not need
 *     a Postmark include.
 *  4. SPF on the root: exactly ONE TXT record starting `v=spf1`, listing only the services that send
 *     with a trialguard.app envelope sender (e.g. `v=spf1 include:_spf.google.com ~all` for staff mail),
 *     at most 10 DNS lookups. Don't add a second v=spf1 record (two records = permerror).
 *  5. DMARC: TXT `_dmarc.trialguard.app` = `v=DMARC1; p=none; rua=mailto:dmarc@trialguard.app; adkim=r; aspf=r`.
 *     Watch the aggregate reports for 2-4 weeks, then move to `p=quarantine`, then `p=reject`.
 *  6. One-click unsubscribe (RFC 8058, required by Gmail/Yahoo for bulk senders): every alert email has
 *     `List-Unsubscribe: <https://…/api/unsubscribe?token=…>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
 *     (see alert-email.ts). RFC 8058 requires both headers to be covered by the DKIM signature: in a
 *     received message, check that the DKIM-Signature `h=` tag lists list-unsubscribe and list-unsubscribe-post.
 *     PUBLIC_URL must be https in production for the header to be honoured.
 *  7. Verify end to end: send an alert to a Gmail account, "Show original" must say SPF: PASS, DKIM: PASS
 *     (trialguard.app), DMARC: PASS, and Gmail must show the "Unsubscribe" link next to the sender.
 *  8. Keep the spam-complaint rate under 0.3% (Google Postmaster Tools for the domain) and act on
 *     Postmark bounce/complaint webhooks; Postmark itself stops sending to hard-bounced addresses.
 */

export const POSTMARK_URL = 'https://api.postmarkapp.com/email';

/**
 * Postmark API error codes (returned with HTTP 422) that are about this message or recipient, so a
 * retry can't succeed: 300 invalid email request, 406 inactive recipient (bounced or complained).
 * Other 422 codes are account-level (sender signature, account pending) and an operator can fix them
 * within the retry window, so those are retried.
 */
const PERMANENT_CODES = new Set([300, 406]);

interface PostmarkOptions {
  serverToken: string;
  messageStream?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export class PostmarkSender implements EmailSender {
  readonly name = 'postmark';
  private serverToken: string;
  private messageStream: string;
  private fetch: FetchLike;
  private timeoutMs: number;

  constructor(opts: PostmarkOptions) {
    this.serverToken = opts.serverToken;
    this.messageStream = opts.messageStream ?? 'outbound';
    this.fetch = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async send(msg: OutgoingEmail): Promise<{ messageId?: string }> {
    const res = await this.fetch(POSTMARK_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': this.serverToken },
      body: JSON.stringify({
        From: msg.from,
        To: msg.to,
        Subject: msg.subject,
        TextBody: msg.text,
        HtmlBody: msg.html,
        Headers: Object.entries(msg.headers).map(([Name, Value]) => ({ Name, Value })),
        MessageStream: this.messageStream,
        Tag: msg.tag,
        // No open pixels, and no link rewriting: the unsubscribe link must stay exactly as signed.
        TrackOpens: false,
        TrackLinks: 'None',
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const json = (await res.json().catch(() => ({}))) as { ErrorCode?: unknown; Message?: unknown; MessageID?: unknown };
    const code = typeof json.ErrorCode === 'number' ? json.ErrorCode : undefined;
    if (res.ok && !code) return { messageId: typeof json.MessageID === 'string' ? json.MessageID : undefined };

    const detail = `Postmark HTTP ${res.status}${code !== undefined ? ` error ${code}` : ''}${typeof json.Message === 'string' ? `: ${scrub(json.Message).slice(0, 160)}` : ''}`;
    const permanent = res.status === 422 && code !== undefined && PERMANENT_CODES.has(code);
    throw new DeliveryError(detail, { retryable: !permanent });
  }
}
