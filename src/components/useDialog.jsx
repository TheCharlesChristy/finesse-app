/* eslint-disable react-refresh/only-export-components -- DialogModal is an internal component only used by the useDialog hook in this file */
import { useCallback, useRef, useState } from 'react';
import { Modal } from './ui';

function DialogModal({ state, onClose }) {
  const { type, message, title, confirmText, cancelText = 'Cancel', danger = false, placeholder, validate } = state;
  const [input, setInput] = useState(state.defaultValue ?? '');

  const isValid = type !== 'prompt' || !validate || validate(input);
  const defaultTitle = type === 'alert' ? 'Notice' : type === 'prompt' ? 'Enter value' : 'Are you sure?';
  const finalConfirmText = confirmText ?? (type === 'alert' ? 'OK' : 'Confirm');

  const handleConfirm = () => onClose(type === 'prompt' ? input : true);
  const handleCancel  = () => onClose(type === 'prompt' ? null : type === 'alert' ? undefined : false);

  return (
    <Modal title={title ?? defaultTitle} onClose={handleCancel}>
      {message && (
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap', margin: '0 0 18px' }}>
          {message}
        </p>
      )}
      {type === 'prompt' && (
        <input
          className="glass-input"
          autoFocus
          placeholder={placeholder}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && isValid) handleConfirm(); }}
          style={{ marginBottom: 16 }}
        />
      )}
      <div className="modal-actions" style={{ display: 'flex', gap: 10, marginTop: 6 }}>
        {type !== 'alert' && (
          <button className="btn-secondary" onClick={handleCancel} style={{ flex: 1 }}>{cancelText}</button>
        )}
        <button
          className={danger ? 'btn-danger' : 'btn-primary'}
          onClick={handleConfirm}
          disabled={!isValid}
          style={{ flex: type === 'alert' ? 1 : 2 }}
        >
          {finalConfirmText}
        </button>
      </div>
    </Modal>
  );
}

/**
 * Returns Promise-based dialog helpers and a `dialogEl` that must be rendered
 * somewhere in the component tree (typically at the bottom of App).
 *
 * showConfirm(message, { title, confirmText, cancelText, danger }) → Promise<boolean>
 * showAlert(message, { title })                                     → Promise<void>
 * showPrompt(message, { title, confirmText, placeholder, validate, defaultValue })
 *                                                                   → Promise<string|null>
 */
export function useDialog() {
  const [state, setState] = useState(null);
  const resolveRef = useRef(null);

  const _show = useCallback(
    (s) => new Promise(res => { resolveRef.current = res; setState(s); }),
    [],
  );

  const showConfirm = useCallback((message, opts = {}) => _show({ type: 'confirm', message, ...opts }), [_show]);
  const showAlert   = useCallback((message, opts = {}) => _show({ type: 'alert',   message, ...opts }), [_show]);
  const showPrompt  = useCallback((message, opts = {}) => _show({ type: 'prompt',  message, ...opts }), [_show]);

  const handleClose = useCallback((value) => {
    setState(null);
    const r = resolveRef.current;
    resolveRef.current = null;
    r?.(value);
  }, []);

  const dialogEl = state ? <DialogModal state={state} onClose={handleClose} /> : null;

  return { dialogEl, showConfirm, showAlert, showPrompt };
}
