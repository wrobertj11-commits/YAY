import { useEffect, useState } from 'react';
import { api, ApiError, getToken } from '../../api.ts';
import type { SectionProps } from './types.ts';

/** GET /api/privacy: generated from the server's configuration, so it says exactly what this server does. */
interface Processor {
  name: string;
  purpose: string;
  receives: string[];
  when: string;
  enabled?: boolean;
}

interface Disclosures {
  llmExtraction: boolean;
  emailHandling: string;
  processors: Processor[];
}

/** Shown until the server's own copy loads. It covers the AI step, so it is never less than the truth. */
const FALLBACK_EMAIL_COPY =
  "We only read emails whose subject looks like a receipt, signup, renewal, price change or cancellation. When our rules can't fully read one of those emails, its text may be sent to Anthropic, an AI provider, to extract the service, price and dates. Trialguard keeps only the extracted fields; the email itself is not stored.";

/** The server names the file; accept only a plain name so a header can't steer the download path. */
function attachmentName(header: string | null): string {
  return header?.match(/filename="([\w.-]+)"/)?.[1] ?? 'trialguard-export.json';
}

/** Fetches the export with the bearer token, then saves it through an object URL (a plain link can't send the token). */
async function downloadMyData(): Promise<void> {
  const token = getToken();
  const res = await fetch('/api/me/export', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    if (res.status === 429) throw new ApiError(429, 'You can download your data a few times an hour. Please try again later.');
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, json.error ?? `Download failed (${res.status})`);
  }
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = attachmentName(res.headers.get('Content-Disposition'));
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking right away can cancel the download in some browsers; give it time to start.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function PrivacySection({ busy, toast, onSignOut }: SectionProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [disclosures, setDisclosures] = useState<Disclosures | null>(null);

  useEffect(() => {
    api<Disclosures>('GET', '/privacy').then(setDisclosures).catch(() => {});
  }, []);

  async function download() {
    setDownloading(true);
    try {
      await downloadMyData();
      toast('Your data download has started');
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setDownloading(false);
    }
  }

  // Services this server doesn't use (e.g. AI extraction switched off) are left out of the list.
  const processors = disclosures?.processors.filter((p) => p.enabled !== false) ?? [];

  return (
    <section>
      <h2 className="section-title">Privacy</h2>
      <div className="card">
        <p className="muted">Read-only access everywhere; we never move money. We don't sell your data.</p>
        <p className="muted">{disclosures?.emailHandling ?? FALLBACK_EMAIL_COPY}</p>
        {processors.length > 0 && (
          <details className="rights">
            <summary>Who processes your data</summary>
            {processors.map((p) => (
              <div key={p.name} className="right">
                <strong>{p.name}</strong>: {p.purpose}
                <p>Receives: {p.receives.join('; ')}.</p>
                <p>{p.when}</p>
              </div>
            ))}
          </details>
        )}
        <button className="btn btn-secondary btn-block" disabled={busy || downloading} onClick={download}>
          {downloading ? 'Preparing your data…' : 'Download my data'}
        </button>
        <p className="fine">A JSON file with everything we hold about you: your account, connections, transactions, extracted email fields, subscriptions and alerts.</p>
        {confirmDelete ? (
          <div className="actions-row">
            <button className="btn btn-secondary" onClick={() => setConfirmDelete(false)}>
              Keep my account
            </button>
            <button
              className="btn btn-danger"
              disabled={busy}
              onClick={async () => {
                await api('DELETE', '/me');
                onSignOut();
              }}
            >
              Delete everything
            </button>
          </div>
        ) : (
          <button className="btn btn-link danger-text" onClick={() => setConfirmDelete(true)}>
            Delete my account and data
          </button>
        )}
      </div>
    </section>
  );
}
