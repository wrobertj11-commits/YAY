import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api.ts';

const STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');

export function WelcomeScreen({ onSignedIn }: { onSignedIn: (token: string) => void }) {
  const [email, setEmail] = useState('');
  const [state, setState] = useState('');
  const [mode, setMode] = useState<'signup' | 'login'>('signup');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token: string }>('POST', mode === 'signup' ? '/auth/signup' : '/auth/login', { email, state: state || undefined });
      onSignedIn(r.token);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setMode('login');
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="welcome">
      <div className="welcome-hero">
        <img src="/icon.svg" alt="" width={56} height={56} />
        <h1>Never pay for a trial you forgot.</h1>
        <p>Trialguard finds every subscription and free trial you have, warns you before they charge, and helps you cancel in one tap.</p>
        <ul className="welcome-points">
          <li>
            <strong>48-hour warnings</strong> before trials convert or prices rise
          </li>
          <li>
            <strong>One list</strong> across cards, PayPal and app stores
          </li>
          <li>
            <strong>Cancel for real</strong>, with proof on your next statement
          </li>
        </ul>
      </div>

      <form className="card welcome-form" onSubmit={submit}>
        <label className="field">
          <span>Email</span>
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        </label>
        {mode === 'signup' && (
          <label className="field">
            <span>State (for your cancellation rights)</span>
            <select value={state} onChange={(e) => setState(e.target.value)}>
              <option value="">Choose…</option>
              {STATES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'One sec…' : mode === 'signup' ? 'Get started free' : 'Sign in'}
        </button>
        <button type="button" className="btn btn-link btn-block" onClick={() => setMode(mode === 'signup' ? 'login' : 'signup')}>
          {mode === 'signup' ? 'I already have an account' : 'Create a new account'}
        </button>
        <p className="fine">Read-only access. We never move money, and we never sell or share your data.</p>
      </form>
    </div>
  );
}
