import { useState } from 'react';
import { Camera, Loader2, Trash2 } from 'lucide-react';

import { buildReceipt, receiptsSupported } from '../receipts';
import { formatBytes } from '../storage';
import { useBlobUrl } from './useBlobUrl';

/**
 * Attach one photo to a transaction.
 *
 * `capture="environment"` is what makes the phone open straight to the rear
 * camera instead of the photo library, which is the difference between logging
 * a receipt at the till and meaning to do it later.
 */
export default function ReceiptField({ value, onChange, disabled = false }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const previewUrl = useBlobUrl(value?.receiptThumb || value?.receipt || null);

  if (!receiptsSupported()) return null;

  const handlePick = async (event) => {
    const file = event.target.files?.[0];
    // Reset immediately: picking the same file twice in a row must still fire.
    event.target.value = '';
    if (!file) return;

    setBusy(true);
    setError('');
    try {
      onChange(await buildReceipt(file));
    } catch (problem) {
      setError(problem.message || 'That image couldn’t be attached.');
    } finally {
      setBusy(false);
    }
  };

  if (previewUrl) {
    return (
      <div>
        <div className="field-label">Receipt</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <img
            src={previewUrl}
            alt="Attached receipt"
            style={{
              width: 54, height: 54, objectFit: 'cover', borderRadius: 10,
              border: '1px solid rgba(255,255,255,0.14)', flexShrink: 0,
            }}
          />
          <div style={{ flex: 1, minWidth: 0, fontSize: 11, color: 'var(--text-muted)' }}>
            Attached
            {value?.receiptMeta?.bytes ? ` · ${formatBytes(value.receiptMeta.bytes)}` : ''}
          </div>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => { setError(''); onChange(null); }}
            disabled={disabled}
            style={{ padding: '7px 11px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}
          >
            <Trash2 size={12} /> Remove
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="field-label">Receipt (optional)</div>
      <label
        className="btn-secondary"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 7, cursor: disabled || busy ? 'default' : 'pointer',
          padding: '8px 12px', fontSize: 12, opacity: disabled || busy ? 0.6 : 1,
        }}
      >
        {busy ? <Loader2 size={13} className="spin" aria-hidden="true" /> : <Camera size={13} aria-hidden="true" />}
        {busy ? 'Processing…' : 'Add a photo'}
        <input
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handlePick}
          disabled={disabled || busy}
          style={{ display: 'none' }}
        />
      </label>
      {error
        ? <div style={{ color: 'var(--danger)', fontSize: 11, marginTop: 7 }}>{error}</div>
        : <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 7 }}>
            Shrunk before saving, so it costs about 150 KB rather than several megabytes.
          </div>}
    </div>
  );
}
