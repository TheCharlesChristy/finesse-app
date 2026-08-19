import { Receipt, X } from 'lucide-react';

import { useBlobUrl } from './useBlobUrl';

/**
 * The receipt marker in a transaction row.
 *
 * Renders the stored thumbnail, so a list of two hundred transactions decodes
 * two hundred 320px JPEGs rather than two hundred full-size ones. Falls back to
 * an icon for rows attached before thumbnails existed, or where the thumbnail
 * failed to encode — a missing preview shouldn't hide the fact a receipt exists.
 */
export function ReceiptThumb({ transaction, onOpen }) {
  const url = useBlobUrl(transaction?.receiptThumb || null);
  if (!transaction?.receipt && !transaction?.receiptThumb) return null;

  const label = `View receipt for ${transaction.note || 'this expense'}`;

  return (
    <button
      type="button"
      onClick={() => onOpen(transaction)}
      aria-label={label}
      title={label}
      style={{
        width: 30, height: 30, borderRadius: 8, flexShrink: 0, padding: 0, cursor: 'pointer',
        border: '1px solid rgba(255,255,255,0.16)', background: 'rgba(255,255,255,0.05)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
        color: 'var(--text-muted)',
      }}
    >
      {url
        ? <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        : <Receipt size={13} aria-hidden="true" />}
    </button>
  );
}

/**
 * Full-size receipt, over everything.
 *
 * Deliberately not the shared Modal: that shell is sized and padded for forms,
 * and a photo wants the whole viewport with nothing around it.
 */
export function ReceiptViewer({ transaction, onClose }) {
  const url = useBlobUrl(transaction?.receipt || transaction?.receiptThumb || null);

  return (
    <div
      className="modal-overlay"
      onMouseDown={e => e.target === e.currentTarget && onClose()}
      style={{ padding: 16, zIndex: 60 }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Receipt for ${transaction?.note || 'expense'}`}
        style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: '100%', maxWidth: 720 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {transaction?.note || 'Receipt'}
          </span>
          <button
            type="button"
            className="btn-secondary"
            onClick={onClose}
            autoFocus
            aria-label="Close receipt"
            style={{ padding: '7px 10px', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}
          >
            <X size={13} /> Close
          </button>
        </div>
        {url && (
          <img
            src={url}
            alt={`Receipt for ${transaction?.note || 'expense'}`}
            style={{
              maxWidth: '100%', minHeight: 0, objectFit: 'contain',
              borderRadius: 12, border: '1px solid rgba(255,255,255,0.14)',
            }}
          />
        )}
      </div>
    </div>
  );
}
