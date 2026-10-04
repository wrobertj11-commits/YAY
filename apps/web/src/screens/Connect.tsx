import { useEffect, useState } from 'react';
import { api, type Me, type SyncSummary } from '../api.ts';
import { Spinner } from '../ui.tsx';

/** GET /connections/email-filter. The description is generated for this server, AI step included. */
interface Filter {
  description: string;
  /** Whether emails the rules can't parse are sent to the AI provider on this server. */
  llmExtraction?: boolean;
  subjectTerms: string[];
  senders: string;
}

export function ConnectScreen({ me, onChanged, onDone }: { me: Me; onChanged: () => Promise<unknown>; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<SyncSummary | null>(null);
  const [filter, setFilter] = useState<Filter | null>(null);
  const [filterFailed, setFilterFailed] = useState(false);
  const [showFilter, setShowFilter] = useState(false);

  useEffect(() => {
    api<Filter>('GET', '/connections/email-filter')
      .then(setFilter)
      .catch(() => setFilterFailed(true));
  }, []);

  const has = (t: string) => me.connections.some((c) => (t === 'inbox' ? c.type !== 'bank' : c.type === t));

  async function connect(type: 'bank' | 'gmail' | 'outlook') {
    setBusy(type);
    setError(null);
    try {
      // Sandbox mode for the demo. In the native app this is Plaid Link / Google or Microsoft OAuth.
      const r = await api<{ summary: SyncSummary }>('POST', '/connections', { type, mode: 'sandbox' });
      setFound(r.summary);
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="connect">
      <header className="page-header">
        <h1>Connect your accounts</h1>
        <p className="muted">Two sources cover each other's blind spots: your bank shows what was charged; your inbox shows what's about to be.</p>
      </header>

      {found && (
        <div className="found card" role="status">
          <div className="found-number">{found.itemsFound}</div>
          <div>
            <strong>
              {found.itemsFound} subscriptions{found.trials ? `, including ${found.trials} free trial${found.trials > 1 ? 's' : ''}` : ''}
            </strong>
            <p className="muted">found so far. {has('bank') && has('inbox') ? "You're all set." : 'Add the other source to catch the rest.'}</p>
          </div>
        </div>
      )}

      <div className="connect-option card">
        <div className="connect-icon" aria-hidden>
          🏦
        </div>
        <div className="connect-body">
          <h3>Bank or card</h3>
          <p className="muted">Finds every recurring charge, price changes and charges after you cancel. Read-only via Plaid.</p>
        </div>
        {has('bank') ? (
          <span className="badge badge-ok">Connected</span>
        ) : (
          <button className="btn btn-primary" disabled={!!busy} onClick={() => connect('bank')}>
            {busy === 'bank' ? <Spinner /> : 'Connect'}
          </button>
        )}
      </div>

      <div className="connect-option card">
        <div className="connect-icon" aria-hidden>
          ✉️
        </div>
        <div className="connect-body">
          <h3>Email inbox</h3>
          <p className="muted">
            Catches free trials before the first charge, from signup emails. Read-only, receipts and signups only.
            {/* Said up front, before anyone connects, not only inside the details panel. */}
            {filter?.llmExtraction && " Emails our rules can't fully read are sent to Anthropic, an AI provider, to pull out the details."}
          </p>
          <button className="btn btn-link btn-small" onClick={() => setShowFilter(!showFilter)}>
            {showFilter ? 'Hide' : 'See exactly which emails we read'}
          </button>
          {showFilter && filter && (
            <div className="filter-box">
              <p>{filter.description}</p>
              <p className="muted">Subjects containing: {filter.subjectTerms.join(' · ')}</p>
              <p className="muted">{filter.senders}</p>
            </div>
          )}
          {showFilter && filterFailed && <p className="fine">Couldn't load the filter details. Check your connection and try again.</p>}
        </div>
        {has('inbox') ? (
          <span className="badge badge-ok">Connected</span>
        ) : (
          <div className="stack-sm">
            <button className="btn btn-primary" disabled={!!busy} onClick={() => connect('gmail')}>
              {busy === 'gmail' ? <Spinner /> : 'Gmail'}
            </button>
            <button className="btn btn-secondary" disabled={!!busy} onClick={() => connect('outlook')}>
              {busy === 'outlook' ? <Spinner /> : 'Outlook'}
            </button>
          </div>
        )}
      </div>

      <div className="card muted-card">
        <strong>Rather not connect email?</strong>
        <p className="muted">
          Forward any signup email to <code>{me.forwardingAddress}</code> and we'll track the trial.
        </p>
      </div>

      {error && <p className="error">{error}</p>}
      <p className="fine">Demo build: connections use realistic sandbox data instead of your real accounts.</p>

      <button className="btn btn-primary btn-block btn-lg" onClick={onDone}>
        {me.connections.length ? 'See what we found' : 'Skip for now'}
      </button>
    </div>
  );
}
