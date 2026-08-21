import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

// ── Focus management ──────────────────────────────────────────────────────────
const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'textarea:not([disabled])',
  'input:not([disabled])', 'select:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

function getFocusable(container) {
  if (!container) return [];
  return Array.from(container.querySelectorAll(FOCUSABLE))
    .filter(el => el.offsetParent !== null || el === document.activeElement);
}

/**
 * Accessible modal dialog. Adds role/aria, traps Tab focus, restores focus to
 * the previously-focused element on close, closes on Escape and overlay click.
 */
export function Modal({ title, subtitle, onClose, children, maxWidth, headerExtra }) {
  const boxRef = useRef(null);
  const restoreRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();

  // Keep the ref current so the stable event listener always calls the latest onClose.
  useEffect(() => { onCloseRef.current = onClose; });

  // Run only on mount/unmount — never re-run just because onClose changed reference.
  useEffect(() => {
    restoreRef.current = document.activeElement;

    // Initial focus: first field with autoFocus, else first focusable, else box.
    const box = boxRef.current;
    const auto = box?.querySelector('[autofocus]');
    const target = auto || getFocusable(box)[0] || box;
    target?.focus?.();

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = getFocusable(boxRef.current);
      if (!focusable.length) {
        e.preventDefault();
        boxRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      const el = restoreRef.current;
      if (el && typeof el.focus === 'function') el.focus();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="modal-overlay" onMouseDown={e => e.target === e.currentTarget && onCloseRef.current()}>
      <div
        ref={boxRef}
        className="modal-box"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={maxWidth ? { maxWidth } : undefined}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 22 }}>
          <div style={{ minWidth: 0 }}>
            <h2 id={titleId} className="font-display" style={{ fontSize: 22, fontWeight: 400, lineHeight: 1.15 }}>{title}</h2>
            {subtitle && (
              <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 3 }}>{subtitle}</div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {headerExtra}
            <IconButton onClick={onClose} label="Close dialog"><X size={15} /></IconButton>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── Icon button ───────────────────────────────────────────────────────────────
export function IconButton({ label, onClick, children, className = 'btn-icon', style, disabled, size }) {
  return (
    <button
      type="button"
      className={className}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      style={size ? { width: size, height: size, ...style } : style}
    >
      {children}
    </button>
  );
}

// ── Form field with associated label ──────────────────────────────────────────
export function Field({ label, hint, children, style }) {
  const id = useId();
  return (
    <div style={style}>
      {label && <label htmlFor={id} className="field-label">{label}</label>}
      {hint && <div className="field-hint">{hint}</div>}
      {typeof children === 'function' ? children(id) : children}
    </div>
  );
}

// ── Section card + heading ────────────────────────────────────────────────────
export function CardTitle({ children, as: Tag = 'h2', style }) {
  return (
    <Tag style={{ fontSize: 15, fontWeight: 600, margin: 0, ...style }}>{children}</Tag>
  );
}


// ── Tab bar ───────────────────────────────────────────────────────────────────
/**
 * The segmented control the consolidated pages share.
 *
 * Several pages that used to be their own nav entries are now tabs on one page,
 * so this stopped being forty lines Forecasting happened to own and became a
 * component the rest could reuse. Styling lives in `index.css` alongside
 * `.nav-item`, which it deliberately echoes — the same control, one level down.
 *
 * `tabs` is `[{ id, label, Icon }]`; `Icon` is optional.
 */
export function Tabs({ label, tabs, value, onChange }) {
  return (
    <div role="tablist" aria-label={label} className="tab-bar">
      {tabs.map(({ id, label: tabLabel, Icon }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={value === id}
          className={`tab-item ${value === id ? 'active' : ''}`}
          onClick={() => onChange(id)}
        >
          {Icon && <Icon size={15} aria-hidden="true" />}
          <span>{tabLabel}</span>
        </button>
      ))}
    </div>
  );
}
