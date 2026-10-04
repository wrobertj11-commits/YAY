import type { OutboxAlert } from '../store.ts';
import type { OutgoingEmail } from './types.ts';

export interface AlertEmailOptions {
  from: string;
  publicUrl: string;
  unsubscribeUrl: string;
  /** Sender's physical postal address (CAN-SPAM). Required in production; see delivery/env.ts. */
  postalAddress?: string;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Header values can't carry line breaks; a title with one would otherwise inject a header. */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

/**
 * Plain-text + simple HTML alert email with an unsubscribe link in the body and RFC 8058 one-click
 * headers (List-Unsubscribe + List-Unsubscribe-Post), plus the postal address in the footer.
 */
export function renderAlertEmail(to: string, alert: Pick<OutboxAlert, 'title' | 'body' | 'type'>, opts: AlertEmailOptions): OutgoingEmail {
  const subject = oneLine(alert.title);
  const appUrl = `${opts.publicUrl}/`;
  const why = "You're getting this because email alerts are on for your Trialguard account.";

  const text = [
    subject,
    '',
    alert.body,
    '',
    `Open Trialguard: ${appUrl}`,
    '',
    '--',
    why,
    `Unsubscribe from alert emails: ${opts.unsubscribeUrl}`,
    `Trialguard${opts.postalAddress ? ` · ${opts.postalAddress}` : ''}`,
  ].join('\n');

  const e = escapeHtml;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(subject)}</title></head>
<body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111827">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px">
<h1 style="font-size:20px;margin:0 0 12px">${e(subject)}</h1>
<p style="font-size:16px;line-height:1.5;margin:0 0 20px">${e(alert.body)}</p>
<p style="margin:0"><a href="${e(appUrl)}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">Open Trialguard</a></p>
</div>
<p style="max-width:520px;margin:16px auto 0;font-size:12px;line-height:1.5;color:#6b7280">
${e(why)} <a href="${e(opts.unsubscribeUrl)}" style="color:#6b7280">Unsubscribe from alert emails</a>.<br>
Trialguard${opts.postalAddress ? ` · ${e(opts.postalAddress)}` : ''}
</p>
</body></html>`;

  return {
    from: opts.from,
    to,
    subject,
    text,
    html,
    headers: {
      'List-Unsubscribe': `<${opts.unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
    tag: alert.type,
  };
}
