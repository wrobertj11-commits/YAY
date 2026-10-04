import { escapeHtml } from '../delivery/alert-email.ts';
import type { OutgoingEmail } from '../delivery/types.ts';

export interface VerificationEmailOptions {
  from: string;
  publicUrl: string;
  /** Sender's physical postal address (CAN-SPAM footer, as on alert emails). */
  postalAddress?: string;
  /** How long the code stays valid, for the copy. */
  minutes: number;
}

/**
 * The verification-code email, in plain text and simple HTML, with the same footer as alert emails
 * (why you got it, then the postal address). It goes to an address nobody has proved they own yet, so it
 * carries nothing a user typed: only the code and fixed copy, which tells a recipient who didn't ask for
 * it that ignoring it is enough. No unsubscribe link: it is a one-off, and an unverified address gets
 * nothing else (and the bucket limits how often even this is sent).
 */
export function renderVerificationEmail(to: string, code: string, opts: VerificationEmailOptions): OutgoingEmail {
  const subject = 'Your Trialguard verification code';
  const appUrl = `${opts.publicUrl}/`;
  const intro = `Enter this code in Trialguard to confirm this is your email address. It expires in ${opts.minutes} minutes.`;
  const ignore = "If you didn't ask for it, you can ignore this email: Trialguard won't send alerts to this address unless the code is entered.";
  const why = "You're getting this because someone asked Trialguard to verify this email address.";
  const footer = `Trialguard${opts.postalAddress ? ` · ${opts.postalAddress}` : ''}`;

  const text = [subject, '', code, '', intro, '', ignore, '', `Open Trialguard: ${appUrl}`, '', '--', why, footer].join('\n');

  const e = escapeHtml;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(subject)}</title></head>
<body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111827">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px">
<h1 style="font-size:20px;margin:0 0 12px">${e(subject)}</h1>
<p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:0 0 16px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${e(code)}</p>
<p style="font-size:16px;line-height:1.5;margin:0 0 12px">${e(intro)}</p>
<p style="font-size:14px;line-height:1.5;margin:0;color:#4b5563">${e(ignore)}</p>
</div>
<p style="max-width:520px;margin:16px auto 0;font-size:12px;line-height:1.5;color:#6b7280">
${e(why)}<br>
${e(footer)}
</p>
</body></html>`;

  return { from: opts.from, to, subject, text, html, headers: {}, tag: 'email_verification' };
}
