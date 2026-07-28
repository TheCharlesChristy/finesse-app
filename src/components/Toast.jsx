/* eslint-disable react-refresh/only-export-components -- ToastStack is internal to the useToast hook in this file */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

const DEFAULT_DURATION = 6000;

function Toast({ toast, onDismiss }) {
  const { id, message, detail, severity, action } = toast;

  const accent = severity === 'danger' ? 'var(--danger)'
    : severity === 'warn' ? 'var(--warn)'
    : 'var(--accent-mint)';

  return (
    <div className="toast" style={{ borderLeft: `3px solid ${accent}` }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{message}</div>
        {detail && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{detail}</div>
        )}
      </div>
      {action && (
        <button
          type="button"
          className="btn-secondary"
          style={{ padding: '5px 11px', fontSize: 12, flexShrink: 0 }}
          onClick={() => { action.onClick(); onDismiss(id); }}
        >
          {action.label}
        </button>
      )}
      <button
        type="button"
        className="btn-icon"
        aria-label="Dismiss notification"
        style={{ width: 26, height: 26, flexShrink: 0 }}
        onClick={() => onDismiss(id)}
      >
        <X size={12} />
      </button>
    </div>
  );
}

function ToastStack({ toasts, onDismiss }) {
  if (!toasts.length) return null;

  return createPortal(
    // Announced politely rather than assertively: toasts here confirm an action
    // the user just took, so they shouldn't interrupt what a screen reader is
    // already saying.
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map(toast => (
        <Toast key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>,
    document.body,
  );
}

/**
 * Transient confirmations, with an optional single action (typically Undo).
 *
 * Render `toastEl` once, near the bottom of App's tree.
 *
 *   showToast('Expense deleted', { action: { label: 'Undo', onClick: restore } })
 *
 * A toast with an action is the right shape for anything reversible — it
 * confirms without blocking, where a modal confirm would interrupt. Keep modal
 * confirms for actions that genuinely cannot be undone.
 */
export function useToast() {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());
  const nextId = useRef(1);

  const dismissToast = useCallback((id) => {
    setToasts(current => current.filter(toast => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const showToast = useCallback((message, options = {}) => {
    const { detail, severity = 'info', action = null, duration = DEFAULT_DURATION } = options;
    const id = nextId.current++;

    setToasts(current => [...current, { id, message, detail, severity, action }]);

    if (duration > 0) {
      timers.current.set(id, setTimeout(() => dismissToast(id), duration));
    }
    return id;
  }, [dismissToast]);

  // Clear any pending timers if the host unmounts mid-countdown.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, []);

  return {
    showToast,
    dismissToast,
    toastEl: <ToastStack toasts={toasts} onDismiss={dismissToast} />,
  };
}
