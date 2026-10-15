import { PostmarkSender } from '../delivery/email.ts';
import { readDeliverySettings, type DeliveryEnv } from '../delivery/env.ts';
import type { EmailSender } from '../delivery/types.ts';

/** What sending a verification code needs: a transactional sender, its From address and the footer's postal address. */
export interface VerificationMailer {
  sender: EmailSender;
  from: string;
  postalAddress?: string;
}

let mailer: VerificationMailer | null | undefined;

/**
 * The transactional sender alert emails use: the same Postmark server and stream, read from the same
 * variables with the same checks (delivery/env.ts). Only the email settings are passed on, so push
 * credentials aren't re-read. Built on first use; null when email isn't configured.
 */
export function verificationMailer(env: DeliveryEnv = process.env): VerificationMailer | null {
  if (mailer === undefined) {
    const { NODE_ENV, PUBLIC_URL, POSTMARK_SERVER_TOKEN, POSTMARK_MESSAGE_STREAM, EMAIL_FROM, COMPANY_POSTAL_ADDRESS } = env;
    const s = readDeliverySettings({ NODE_ENV, PUBLIC_URL, POSTMARK_SERVER_TOKEN, POSTMARK_MESSAGE_STREAM, EMAIL_FROM, COMPANY_POSTAL_ADDRESS });
    mailer = s.postmark && s.emailFrom ? { sender: new PostmarkSender(s.postmark), from: s.emailFrom, postalAddress: s.postalAddress } : null;
  }
  return mailer;
}

/** Tests inject a sender (or null for "email not configured"); undefined goes back to reading the environment. */
export function setVerificationMailer(next: VerificationMailer | null | undefined): void {
  mailer = next;
}
