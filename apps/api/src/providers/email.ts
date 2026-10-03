import { GMAIL_QUERY, type EmailMessage, type ISODate } from '@trialguard/core';
import { sandboxEmails } from '../sandbox.ts';

/**
 * Read-only inbox access, filtered at the provider to receipt and signup patterns so unrelated
 * mail is never downloaded. Bodies are handed to extraction and then dropped.
 */
export interface EmailProvider {
  fetch(opts: { accessToken?: string; since?: string; today: ISODate }): Promise<EmailMessage[]>;
}

export const sandboxInbox: EmailProvider = {
  async fetch({ today }) {
    return sandboxEmails(today);
  },
};

function decodeBase64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8');
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#36;|&dollar;/g, '$')
    .replace(/[ \t]+/g, ' ');
}

interface GmailPart {
  mimeType: string;
  body?: { data?: string };
  parts?: GmailPart[];
  headers?: { name: string; value: string }[];
}

function gmailText(part: GmailPart): string {
  const plain = findPart(part, 'text/plain');
  if (plain?.body?.data) return decodeBase64Url(plain.body.data);
  const html = findPart(part, 'text/html');
  return html?.body?.data ? htmlToText(decodeBase64Url(html.body.data)) : '';
}

function findPart(part: GmailPart, mime: string): GmailPart | undefined {
  if (part.mimeType === mime && part.body?.data) return part;
  for (const p of part.parts ?? []) {
    const found = findPart(p, mime);
    if (found) return found;
  }
  return undefined;
}

/** Gmail API with the gmail.readonly scope (restricted: requires Google verification + CASA assessment). */
export const gmailInbox: EmailProvider = {
  async fetch({ accessToken, since }) {
    if (!accessToken) throw new Error('Missing Gmail access token');
    const headers = { Authorization: `Bearer ${accessToken}` };
    const q = since ? `${GMAIL_QUERY} after:${Math.floor(new Date(since).getTime() / 1000)}` : GMAIL_QUERY;
    const list = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=100&q=${encodeURIComponent(q)}`, { headers });
    if (!list.ok) throw new Error(`Gmail list failed: ${list.status}`);
    const { messages = [] } = (await list.json()) as { messages?: { id: string }[] };
    const out: EmailMessage[] = [];
    for (const { id } of messages) {
      const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers });
      if (!res.ok) continue;
      const msg = (await res.json()) as { id: string; internalDate: string; payload: GmailPart };
      const header = (name: string) => msg.payload.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? '';
      out.push({
        id: `gmail:${msg.id}`,
        from: header('from'),
        subject: header('subject'),
        date: new Date(Number(msg.internalDate)).toISOString(),
        body: gmailText(msg.payload),
      });
    }
    return out;
  },
};

/** Microsoft Graph with Mail.Read. */
export const outlookInbox: EmailProvider = {
  async fetch({ accessToken, since }) {
    if (!accessToken) throw new Error('Missing Outlook access token');
    const search = '"trial OR receipt OR subscription OR membership OR renewal OR price OR invoice OR cancellation"';
    const url =
      `https://graph.microsoft.com/v1.0/me/messages?$top=100&$select=id,subject,from,receivedDateTime,body` +
      `&$search=${encodeURIComponent(search)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Prefer: 'outlook.body-content-type="text"' },
    });
    if (!res.ok) throw new Error(`Outlook fetch failed: ${res.status}`);
    const { value = [] } = (await res.json()) as {
      value?: { id: string; subject: string; receivedDateTime: string; from?: { emailAddress: { name: string; address: string } }; body: { content: string } }[];
    };
    return value
      .filter((m) => !since || m.receivedDateTime > since)
      .map((m) => ({
        id: `outlook:${m.id}`,
        from: m.from ? `${m.from.emailAddress.name} <${m.from.emailAddress.address}>` : '',
        subject: m.subject ?? '',
        date: m.receivedDateTime,
        body: m.body?.content ?? '',
      }));
  },
};
