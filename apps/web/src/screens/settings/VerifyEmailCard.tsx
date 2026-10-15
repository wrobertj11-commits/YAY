import { useState, type FormEvent } from 'react';
import { api, ApiError, type EmailCodeSent } from '../../api.ts';
import type { SectionProps } from './types.ts';

const CODE = /^\d{6}$/;

const until = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/**
 * Shown until the account's address is verified. The server holds back alert emails until then, because
 * anyone can sign up with any address; push and the in-app inbox work meanwhile.
 */
export function VerifyEmailCard({ me, busy, run, toast }: Pick<SectionProps, 'me' | 'busy' | 'run' | 'toast'>) {
  const [sent, setSent] = useState<EmailCodeSent | null>(null);
  const [code, setCode] = useState('');

  const send = () =>
    run(async () => {
      try {
        const r = await api<EmailCodeSent>('POST', '/auth/email/send-code', {});
        setSent(r);
        setCode('');
        toast(r.sent ? `Code sent to ${me.email}` : 'Code ready (dev build)');
      } catch (err) {
        // The limit is per address, so a plain "Too many requests" would be confusing here.
        if (err instanceof ApiError && err.status === 429) throw new Error('You’ve asked for several codes already. Please try again later.', { cause: err });
        throw err;
      }
    });

  const verify = (e: FormEvent) => {
    e.preventDefault();
    // On success the refreshed account says it's verified, and this card goes away.
    void run(() => api('POST', '/auth/email/verify', { code }), 'Email verified. Alert emails are on their way.');
  };

  return (
    <div className="card form">
      <div className="stack-sm">
        <strong>Verify your email to get email alerts</strong>
        <small className="muted">
          {sent
            ? `We sent a 6-digit code to ${me.email}. It works until ${until(sent.expiresAt)}.`
            : `We’ll send a 6-digit code to ${me.email}. Until you enter it, alerts arrive by push and in the app only.`}
        </small>
      </div>
      <form className="form" onSubmit={verify}>
        <label className="field">
          <span>Code from the email</span>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="123456"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          />
        </label>
        <div className="actions-row">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={send}>
            {sent ? 'Send a new code' : 'Send code'}
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !CODE.test(code)}>
            Verify
          </button>
        </div>
      </form>
      {me.devMode && sent?.devCode && (
        <p className="fine">
          Dev build with no email sender: your code is <strong className="mono">{sent.devCode}</strong>.
        </p>
      )}
    </div>
  );
}
