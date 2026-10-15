import { useEffect, useState, type FormEvent } from 'react';
import { api, type Cadence, type Item, type Me } from '../api.ts';
import { CADENCE_LABEL } from '../format.ts';
import { Sheet } from '../ui.tsx';

interface Props {
  open: boolean;
  me: Me;
  onClose: () => void;
  onAdded: (message: string, itemId?: string) => void;
}

function inDays(n: number) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

export function AddSheet({ open, me, onClose, onAdded }: Props) {
  const [mode, setMode] = useState<'manual' | 'paste'>('manual');
  const [isTrial, setIsTrial] = useState(true);
  const [name, setName] = useState('');
  const [merchantId, setMerchantId] = useState<string | undefined>();
  const [suggestions, setSuggestions] = useState<{ id: string; name: string }[]>([]);
  const [amount, setAmount] = useState('');
  const [cadence, setCadence] = useState<Cadence>('monthly');
  const [date, setDate] = useState(inDays(7));
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The parent mounts this sheet fresh each time it opens, so form state never leaks between uses.
  const visibleSuggestions = name.trim() && !merchantId ? suggestions : [];

  useEffect(() => {
    if (!name.trim() || merchantId) return;
    const t = setTimeout(() => {
      api<{ id: string; name: string }[]>('GET', `/merchants?q=${encodeURIComponent(name)}`).then((r) => setSuggestions(r.slice(0, 5))).catch(() => {});
    }, 150);
    return () => clearTimeout(t);
  }, [name, merchantId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'manual') {
        const item = await api<Item>('POST', '/items', {
          name,
          merchantId,
          amountCents: Math.round(parseFloat(amount || '0') * 100),
          cadence,
          date,
          isTrial,
        });
        onAdded(isTrial ? `Got it. We'll warn you before ${item.name} charges.` : `${item.name} added.`, item.id);
      } else {
        const r = await api<{ item?: Item }>('POST', '/forward', { text });
        onAdded(r.item ? `Found ${r.item.name} in that email.` : 'Email processed.', r.item?.id);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Add a trial or subscription">
      <div className="segmented small">
        <button className={mode === 'manual' ? 'on' : ''} onClick={() => setMode('manual')}>
          Enter details
        </button>
        <button className={mode === 'paste' ? 'on' : ''} onClick={() => setMode('paste')}>
          Paste an email
        </button>
      </div>
      <form className="form" onSubmit={submit}>
        {mode === 'manual' ? (
          <>
            <div className="segmented small">
              <button type="button" className={isTrial ? 'on' : ''} onClick={() => setIsTrial(true)}>
                Free trial
              </button>
              <button type="button" className={!isTrial ? 'on' : ''} onClick={() => setIsTrial(false)}>
                Subscription
              </button>
            </div>
            <label className="field">
              <span>Service</span>
              <input
                required
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setMerchantId(undefined);
                }}
                placeholder="e.g. Peacock"
                autoFocus
              />
            </label>
            {visibleSuggestions.length > 0 && (
              <div className="chips">
                {visibleSuggestions.map((s) => (
                  <button
                    type="button"
                    key={s.id}
                    className="chip"
                    onClick={() => {
                      setName(s.name);
                      setMerchantId(s.id);
                      setSuggestions([]);
                    }}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            )}
            <div className="field-row">
              <label className="field">
                <span>{isTrial ? 'Price after trial ($)' : 'Price ($)'}</span>
                <input required inputMode="decimal" pattern="[0-9]*[.,]?[0-9]{0,2}" value={amount} onChange={(e) => setAmount(e.target.value.replace(',', '.'))} placeholder="9.99" />
              </label>
              <label className="field">
                <span>Billing</span>
                <select value={cadence} onChange={(e) => setCadence(e.target.value as Cadence)}>
                  {Object.entries(CADENCE_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field">
              <span>{isTrial ? 'Trial ends on' : 'Next charge on'}</span>
              <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            {isTrial && (
              <div className="chips">
                {[3, 7, 14, 30].map((n) => (
                  <button type="button" key={n} className="chip" onClick={() => setDate(inDays(n))}>
                    {n}-day trial
                  </button>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <label className="field">
              <span>Paste the signup or receipt email</span>
              <textarea required rows={7} value={text} onChange={(e) => setText(e.target.value)} placeholder="Your 7-day free trial ends on…" />
            </label>
            <p className="fine">
              Or forward it to <code>{me.forwardingAddress}</code>. We keep only the service, price and dates.
            </p>
          </>
        )}
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary btn-block btn-lg" disabled={busy}>
          {busy ? 'Adding…' : mode === 'manual' ? 'Add' : 'Find the trial'}
        </button>
      </form>
    </Sheet>
  );
}
