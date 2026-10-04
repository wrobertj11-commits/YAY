import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type ConciergeAuthorizationText, type ConciergeRequest, type ConciergeStatus, type ItemDetail } from '../api.ts';
import { money, shortDate } from '../format.ts';
import { Sheet, Spinner } from '../ui.tsx';

/** What the item screen sends to POST /api/items/:id/concierge (plus `agree: true`). */
export interface ConciergeSignature {
  textVersion: string;
  signedName: string;
}

const STATUS: Record<ConciergeStatus, { label: string; badge: string; hint: string }> = {
  queued: { label: 'Queued', badge: 'badge-info', hint: 'Our team will pick this up soon.' },
  in_progress: { label: 'In progress', badge: 'badge-info', hint: 'Someone on our team is cancelling it for you now.' },
  done: { label: 'Done', badge: 'badge-ok', hint: "We cancelled it for you. We'll watch your next statement to confirm." },
  failed: { label: "Couldn't complete", badge: 'badge-danger', hint: "We couldn't cancel it for you. You can still cancel it yourself with the guide." },
  cancelled: { label: 'Withdrawn', badge: '', hint: 'You withdrew this request and your authorization.' },
};

const FEE_RULE = 'Fee: 30% of your first-year savings, capped at $20.';

export function isOpenRequest(r: ConciergeRequest | undefined): r is ConciergeRequest {
  return r?.status === 'queued' || r?.status === 'in_progress';
}

/** The item's done-for-you requests; `latest` is the newest. */
export function useConciergeRequests(itemId: string) {
  const [requests, setRequests] = useState<ConciergeRequest[]>([]);
  const reload = useCallback(
    () => api<{ requests: ConciergeRequest[] }>('GET', `/concierge?itemId=${encodeURIComponent(itemId)}`).then((r) => setRequests(r.requests)),
    [itemId],
  );
  useEffect(() => {
    // The card is an extra; the item screen works without it.
    reload().catch(() => {});
  }, [reload]);
  return { latest: requests[0], reload };
}

/** Request status on the item screen, with a two-step withdraw (it revokes the authorization). */
export function ConciergeStatusCard({ request, onWithdraw }: { request: ConciergeRequest; onWithdraw: (requestId: string) => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const s = STATUS[request.status];
  const merchant = request.merchantName ?? request.itemName ?? 'the service';
  return (
    <div className="card concierge">
      <div className="section-head">
        <strong>Done-for-you cancellation</strong>
        <span className={`badge ${s.badge}`}>{s.label}</span>
      </div>
      <p className="muted">{s.hint}</p>
      {request.note && <p>From our team: {request.note}</p>}
      {request.proof && <p className="fine">Proof: {request.proof}</p>}
      <p className="fine">
        Requested {shortDate(request.createdAt)}
        {request.authorization ? `, authorized by ${request.authorization.signedName}` : ''}.
        {/* A failed or withdrawn request shouldn't read as if a fee is coming. */}
        {request.status !== 'failed' && request.status !== 'cancelled' && ` Fee: ${money(request.feeCents)}.`}
      </p>
      {isOpenRequest(request) &&
        (confirming ? (
          <>
            <p className="fine">Withdrawing revokes your authorization. Anything we've already done with {merchant} may not be reversible.</p>
            <div className="actions-row">
              <button className="btn btn-secondary" onClick={() => setConfirming(false)}>
                Keep it
              </button>
              <button className="btn btn-danger" onClick={() => onWithdraw(request.id).finally(() => setConfirming(false))}>
                Withdraw
              </button>
            </div>
          </>
        ) : (
          <button className="btn btn-link btn-block" onClick={() => setConfirming(true)}>
            Withdraw request
          </button>
        ))}
    </div>
  );
}

/** The "Rather we do it?" card in the cancel guide: opens the authorization step, or shows the open request. */
export function ConciergeOffer({ item, request, onRequest }: { item: ItemDetail; request?: ConciergeRequest; onRequest: (s: ConciergeSignature) => Promise<void> }) {
  const [authorizing, setAuthorizing] = useState(false);
  if (isOpenRequest(request)) {
    return (
      <div className="card concierge">
        <div className="section-head">
          <strong>We're cancelling it for you</strong>
          <span className={`badge ${STATUS[request.status].badge}`}>{STATUS[request.status].label}</span>
        </div>
        <p className="muted">{STATUS[request.status].hint} You can withdraw the request from the item page.</p>
      </div>
    );
  }
  return (
    <div className="card concierge">
      <strong>Rather we do it?</strong>
      <p className="muted">Our team cancels for you and requests any refund. {FEE_RULE}</p>
      <button className="btn btn-secondary btn-block" onClick={() => setAuthorizing(true)}>
        Cancel it for me
      </button>
      {authorizing && <AuthorizationSheet item={item} onClose={() => setAuthorizing(false)} onSubmit={onRequest} />}
    </div>
  );
}

/**
 * The written authorization step: the full text from the server, a typed name and an explicit tick.
 * The text's version goes back with the signature; if it changed meanwhile the server refuses (409) and
 * the sheet loads the new text and asks again.
 */
function AuthorizationSheet({ item, onClose, onSubmit }: { item: ItemDetail; onClose: () => void; onSubmit: (s: ConciergeSignature) => Promise<void> }) {
  const [auth, setAuth] = useState<ConciergeAuthorizationText | null>(null);
  const [name, setName] = useState('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadText = useCallback(
    () => api<ConciergeAuthorizationText>('GET', `/concierge/authorization-text${item.merchantId ? `?merchantId=${encodeURIComponent(item.merchantId)}` : ''}`).then(setAuth),
    [item.merchantId],
  );
  useEffect(() => {
    loadText().catch((e: Error) => setError(e.message));
  }, [loadText]);

  const signedName = name.trim();
  const ready = Boolean(auth) && agree && signedName.length >= 2 && !busy;
  const merchant = auth?.merchantName ?? item.name;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!auth || !ready) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ textVersion: auth.version, signedName });
      onClose();
    } catch (err) {
      setError((err as Error).message);
      if (err instanceof ApiError && err.status === 409) {
        // The wording may have changed: show the current text and ask for a fresh tick.
        setAgree(false);
        await loadText().catch(() => {});
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onClose={onClose} title={`Let us cancel ${merchant}`}>
      {!auth ? (
        <div className="empty">{error ? <p className="error">{error}</p> : <Spinner />}</div>
      ) : (
        <form className="form" onSubmit={submit}>
          {auth.draft && (
            <p className="fine">
              <span className="badge badge-warn">Draft</span> This wording is pending legal review and may change.
            </p>
          )}
          <AuthorizationText text={auth.text} />
          <label className="field">
            <span>Type your full name to sign</span>
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={80} required />
          </label>
          <label className="toggle">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span>I authorize Trialguard to cancel {merchant} for me, as described above.</span>
          </label>
          <p className="fine">{FEE_RULE} You can withdraw the request until it's done.</p>
          {error && <p className="error">{error}</p>}
          <button className="btn btn-primary btn-block btn-lg" disabled={!ready}>
            {busy ? 'Sending…' : 'I authorize. Cancel it for me'}
          </button>
        </form>
      )}
    </Sheet>
  );
}

/**
 * Renders the plain-text authorization as is (it's the exact wording the signature covers). Only the
 * presentation is inferred: a line that is neither a bullet nor a sentence is a heading.
 */
function AuthorizationText({ text }: { text: string }) {
  return (
    <div className="card muted-card tips" role="region" aria-label="Authorization text">
      {text.split('\n').map((line, i) =>
        !line ? null : !line.startsWith('•') && !/[.:!?]$/.test(line) ? (
          <p key={i}>
            <strong>{line}</strong>
          </p>
        ) : (
          <p key={i}>{line}</p>
        ),
      )}
    </div>
  );
}
