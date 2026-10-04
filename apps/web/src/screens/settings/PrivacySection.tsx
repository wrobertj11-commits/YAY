import { useState } from 'react';
import { api } from '../../api.ts';
import type { SectionProps } from './types.ts';

export function PrivacySection({ busy, onSignOut }: SectionProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <section>
      <h2 className="section-title">Privacy</h2>
      <div className="card">
        <p className="muted">
          Read-only access everywhere; we never move money. We read only receipt and signup emails, and keep just the extracted fields, never the email itself. We don't sell or share your data.
        </p>
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
