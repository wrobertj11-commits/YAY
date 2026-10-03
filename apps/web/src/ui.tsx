import { useEffect, type ReactNode } from 'react';
import type { Item } from './api.ts';
import { avatarColor } from './format.ts';

export function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  return (
    <span className="avatar" style={{ background: avatarColor(name), width: size, height: size, fontSize: size * 0.42 }} aria-hidden>
      {name.replace(/^the /i, '').charAt(0).toUpperCase()}
    </span>
  );
}

export function StatusBadge({ item }: { item: Item }) {
  switch (item.status) {
    case 'trial': {
      const d = item.daysUntilCharge ?? 99;
      return <span className={`badge ${d <= 2 ? 'badge-danger' : d <= 5 ? 'badge-warn' : 'badge-info'}`}>Trial · {d <= 0 ? 'ends today' : `${d}d left`}</span>;
    }
    case 'cancel_pending':
      return <span className="badge badge-info">Cancelled · verifying</span>;
    case 'cancel_verified':
      return <span className="badge badge-ok">Cancelled ✓</span>;
    case 'charged_after_cancel':
      return <span className="badge badge-danger">Charged after cancel</span>;
    case 'dismissed':
      return <span className="badge">Hidden</span>;
    default:
      return item.priceChange && item.priceChange.newCents > item.priceChange.oldCents ? <span className="badge badge-warn">Price up</span> : null;
  }
}

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-header">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden>
        {icon}
      </div>
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}
