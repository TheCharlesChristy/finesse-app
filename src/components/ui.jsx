import { createElement, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, MoreHorizontal, Search, X } from 'lucide-react';

import { useScrollLock } from './useScrollLock.js';

/**
 * The shared primitive set — identical in Finesse and Finesse Fit.
 *
 * Everything here renders the design system's semantic classes and nothing
 * here takes a colour, a size in pixels or a style object for its own chrome.
 * That is the whole contract: a component decides *structure and behaviour*,
 * `index.css` decides appearance, and the appearance settings decide the rest.
 * A prop like `color="#4fffb0"` would quietly opt one call site out of eleven
 * palettes, two modes, three surface finishes and the high-contrast setting.
 */

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/* Open dialogs, newest last. Only the top one answers Escape and Tab, so a
   confirmation stacked on a form closes one layer at a time rather than both. */
const modalStack = [];

const visible = (el) => !el.disabled && el.offsetParent !== null;

/**
 * Accessible dialog: focus trap, Escape, restore-focus-on-close, overlay
 * dismissal, and a body scroll lock. A sheet on a phone, a centred box on a
 * desktop — the same component, decided in CSS.
 *
 * `footer` is where the actions go. Putting them outside the scrolling body
 * rather than at the end of it is what keeps Save reachable on a form long
 * enough to scroll, which on a twenty-set workout or a forty-row import is most
 * of them.
 *
 * A footer outside the body is also outside the `<form>`, so `footer` may be a
 * function and is handed the form's id: a submit button carrying `form={formId}`
 * submits the form it is not inside, which is plain HTML and beats wiring an
 * onClick that then has to re-implement validation and Enter-to-save.
 */
export function Modal({
  title, subtitle, children, footer, headerExtra, onClose, onSubmit,
  size = 'md', large = false, labelledBy,
}) {
  const boxRef = useRef(null);
  const closeRef = useRef(onClose);
  const pressedOverlay = useRef(false);
  const titleId = useId();
  const formId = useId();

  useEffect(() => { closeRef.current = onClose; });

  // Pins the body at its offset rather than only hiding overflow: on iOS a
  // touch that starts inside the sheet otherwise drags the page underneath.
  useScrollLock();

  useEffect(() => {
    const token = {};
    modalStack.push(token);
    const previous = document.activeElement;
    const box = boxRef.current;
    const body = box?.querySelector('.modal-body');
    const firstField = body?.querySelector('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]), select, textarea');
    const coarse = window.matchMedia?.('(pointer: coarse)').matches;
    // On a touch device, focusing a field pops the keyboard over the form
    // before the user has read it. Focus the dialog itself instead.
    if (firstField && !coarse) firstField.focus();
    else box?.focus();

    const onKey = (event) => {
      if (modalStack.at(-1) !== token) return;
      if (event.key === 'Escape') {
        // A nested popover gets the first Escape, so the form stays open.
        if (box?.querySelector('[data-popover-open="true"]')) return;
        event.preventDefault();
        closeRef.current?.();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = [...box.querySelectorAll(FOCUSABLE)].filter(visible);
      if (!items.length) return;
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === box)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      modalStack.splice(modalStack.indexOf(token), 1);
      if (previous?.isConnected) previous.focus?.();
    };
  }, []);

  const Body = onSubmit ? 'form' : 'div';
  const bodyProps = onSubmit
    ? { id: formId, onSubmit: (event) => { event.preventDefault(); onSubmit(); }, noValidate: true }
    : {};

  return (
    <div
      className="modal-overlay"
      role="presentation"
      onMouseDown={(event) => { pressedOverlay.current = event.target === event.currentTarget; }}
      onClick={(event) => {
        // Only dismiss when the whole click happened on the backdrop, so
        // dragging a selection out of an input does not close the form.
        if (pressedOverlay.current && event.target === event.currentTarget) onClose?.();
      }}
    >
      <section
        ref={boxRef}
        tabIndex={-1}
        className={`modal-box card-raised modal-${large ? 'lg' : size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? titleId}
      >
        <header className="modal-header">
          <div className="modal-heading">
            <h2 id={titleId} className="modal-title">{title}</h2>
            {subtitle && <p className="modal-subtitle">{subtitle}</p>}
          </div>
          <div className="modal-header-actions">
            {headerExtra}
            {onClose && <IconButton label="Close" className="btn-icon btn-icon-quiet" onClick={onClose}><X size={18} /></IconButton>}
          </div>
        </header>
        <Body className="modal-body" {...bodyProps}>{children}</Body>
        {footer && <footer className="modal-footer">{typeof footer === 'function' ? footer({ formId }) : footer}</footer>}
      </section>
    </div>
  );
}

/** Label, optional hint, control, optional error — in that order, always. */
export function Field({ label, hint, error, children, className = '' }) {
  const id = useId();
  return (
    <div className={`field ${className}`}>
      {label && <label htmlFor={id}>{label}</label>}
      {hint && <p className="field-hint">{hint}</p>}
      {typeof children === 'function' ? children(id) : children}
      {error && <p className="field-error" role="alert">{error}</p>}
    </div>
  );
}

export function IconButton({ label, children, className = 'btn-icon', ...props }) {
  return (
    <button className={className} type="button" aria-label={label} title={label} {...props}>
      {children}
    </button>
  );
}

/**
 * A card's heading. Tracked small-caps rather than a heading-sized word, with
 * the icon demoted to a corner mark — which is what lets a dozen cards share a
 * page without competing with the numbers inside them.
 */
export function CardTitle({ icon: Icon, children, action, as = 'h2' }) {
  return (
    <div className="card-header">
      {createElement(as, { className: 'card-title' }, Icon ? <Icon size={16} aria-hidden="true" /> : null, <span className="truncate">{children}</span>)}
      {action}
    </div>
  );
}

export function PageHeader({ eyebrow, title, subtitle, children }) {
  return (
    <header className="page-head">
      <div className="page-head-main">
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </header>
  );
}

/** A card, with its heading and body in one place so every card matches. */
export function Card({ title, icon, action, children, className = '', footer, as = 'section' }) {
  return createElement(
    as,
    { className: `card panel stack ${className}`.trim() },
    title ? <CardTitle icon={icon} action={action}>{title}</CardTitle> : null,
    children,
    footer ? <div className="card-footer">{footer}</div> : null,
  );
}

/** Label, number, note — one shape, so the eye finds the number in one place. */
export function Stat({ label, value, note, tone, children }) {
  return (
    <div className="stat">
      <span className="eyebrow">{label}</span>
      <span className={`stat-value ${tone ?? ''}`.trim()}>{value}</span>
      {note && <span className="stat-note">{note}</span>}
      {children}
    </div>
  );
}

export function StatGrid({ children, className = '' }) {
  return <div className={`stat-grid ${className}`.trim()}>{children}</div>;
}

/**
 * A bar. `value`/`max` rather than a percentage, because every caller that was
 * handed a percentage had to compute and clamp it first, and half of them
 * clamped it differently.
 */
export function Meter({ value, max, tone, label, thin = false, over = false }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div
      className={`progress-track ${thin ? 'thin' : ''}`.trim()}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div className={`progress-fill ${over ? 'over' : ''}`.trim()} style={{ '--value': `${pct}%`, ...(tone ? { '--bar': tone } : null) }} />
    </div>
  );
}

/**
 * An inline message attached to the thing it is about.
 *
 * `tone` names a meaning — info, good, warn, danger — and the stylesheet picks
 * the colour. Call sites never name one.
 */
export function Banner({ tone = 'info', icon: Icon, title, children, actions, compact = false, role = 'status' }) {
  return (
    <div className={`card panel banner ${tone} ${compact ? 'compact' : ''}`.trim()} role={role}>
      {Icon && <Icon size={compact ? 16 : 19} aria-hidden="true" />}
      <div className="banner-text">
        {title && <strong>{title}</strong>}
        {children && <span>{children}</span>}
      </div>
      {actions && <div className="banner-actions">{actions}</div>}
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder = 'Search', label = placeholder, onEnter, className = '' }) {
  return (
    <div className={`search-input ${className}`.trim()}>
      <Search size={17} aria-hidden="true" />
      <input
        className="input"
        type="search"
        enterKeyHint="search"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && onEnter) { event.preventDefault(); onEnter(); } }}
      />
    </div>
  );
}

/**
 * Never a bare "No data". A title saying what is missing and a line saying what
 * to do about it — for most features, the empty state is the first screen the
 * user ever sees, and it is the only chance to explain what the screen is for.
 */
export function EmptyState({ icon: Icon, title, children, action, center = false }) {
  return (
    <div className={`empty-state ${center ? 'center' : ''}`.trim()}>
      {Icon && <span className="empty-icon"><Icon size={20} aria-hidden="true" /></span>}
      <strong>{title}</strong>
      {children && <span>{children}</span>}
      {action}
    </div>
  );
}

/** Equal-width choice between mutually exclusive options. */
export function Segmented({ label, value, options, onChange, hideLabel = false, className = '' }) {
  return (
    <div className={`field ${className}`.trim()}>
      {!hideLabel && <span className="field-label">{label}</span>}
      <div className="segmented" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            className={value === option.value ? 'active' : ''}
            onClick={() => onChange(option.value)}
          >
            {option.icon}
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The tab strip on a consolidated page. A deliberately quieter echo of the
 * sidebar's nav item: the same control, one level down.
 */
export function Tabs({ label, tabs, value, onChange }) {
  return (
    <div role="tablist" aria-label={label} className="tab-bar">
      {tabs.map(({ id, label: tabLabel, Icon, icon }) => {
        const Glyph = Icon ?? icon;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={value === id}
            className={`tab-pill ${value === id ? 'active' : ''}`.trim()}
            onClick={() => onChange(id)}
          >
            {Glyph && <Glyph size={15} aria-hidden="true" />}
            <span>{tabLabel}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * "⋯" with a small action menu. Secondary actions on a row belong here rather
 * than as three more buttons competing with the row's own content.
 *
 * `items`: `[{ label, icon, onSelect, danger }]`.
 */
export function OverflowMenu({ label = 'More actions', items, className = 'btn-icon btn-icon-quiet' }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef(null);
  const menuRef = useRef(null);
  const buttonRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event) => { if (!rootRef.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', onPointer);
    menuRef.current?.querySelectorAll('[role="menuitem"]')[active]?.focus();
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open, active]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  const onKey = (event) => {
    if (event.key === 'ArrowDown') setActive((index) => (index + 1) % items.length);
    else if (event.key === 'ArrowUp') setActive((index) => (index - 1 + items.length) % items.length);
    else if (event.key === 'Escape') {
      // Do not let Escape close an enclosing dialog as well.
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') close(false);
    else return;
    if (event.key !== 'Tab') event.preventDefault();
  };

  return (
    <div className="menu-root" ref={rootRef} onClick={(event) => event.stopPropagation()}>
      <button
        ref={buttonRef}
        type="button"
        className={className}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => { setActive(0); setOpen(!open); }}
      >
        <MoreHorizontal size={18} />
      </button>
      {open && (
        <div ref={menuRef} role="menu" className="menu card-raised" onKeyDown={onKey}>
          {items.map((item, index) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              tabIndex={index === active ? 0 : -1}
              className={`menu-item ${item.danger ? 'danger' : ''}`.trim()}
              onClick={() => { close(false); item.onSelect(); }}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A listbox that shows more than a `<select>` can — a label, a description and
 * a preview per option.
 *
 * `renderPreview(option)` draws whatever sits at the head of the row; the
 * palette picker uses it to render a real swatch of the palette in question.
 */
export function Listbox({ label, options, value, onChange, renderPreview, triggerLabel, className = '' }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() => Math.max(0, options.findIndex((item) => item.id === value)));
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const listRef = useRef(null);
  const listId = useId();
  const current = options.find((item) => item.id === value) ?? options[0];

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event) => { if (!rootRef.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', onPointer);
    listRef.current?.focus();
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  useEffect(() => {
    if (open) listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const openList = () => {
    setActive(Math.max(0, options.findIndex((item) => item.id === value)));
    setOpen(true);
  };

  const choose = (index) => {
    onChange(options[index].id);
    setOpen(false);
    buttonRef.current?.focus();
  };

  const onKey = (event) => {
    if (event.key === 'ArrowDown') setActive((index) => Math.min(options.length - 1, index + 1));
    else if (event.key === 'ArrowUp') setActive((index) => Math.max(0, index - 1));
    else if (event.key === 'Home') setActive(0);
    else if (event.key === 'End') setActive(options.length - 1);
    else if (event.key === 'Enter' || event.key === ' ') choose(active);
    else if (event.key === 'Escape' || event.key === 'Tab') {
      // Keep Escape from also closing an enclosing dialog.
      event.stopPropagation();
      setOpen(false);
      if (event.key === 'Escape') buttonRef.current?.focus();
      return;
    } else return;
    event.preventDefault();
  };

  return (
    <div className={`select-menu ${className}`.trim()} ref={rootRef} data-popover-open={open ? 'true' : undefined}>
      <button
        ref={buttonRef}
        type="button"
        className="select-trigger input"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={`${label}: ${triggerLabel ?? current?.name ?? ''}`}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); openList(); }
        }}
      >
        {renderPreview?.(current)}
        <span className="select-trigger-label">{triggerLabel ?? current?.name}</span>
        <ChevronDown size={18} className={`select-chevron ${open ? 'open' : ''}`.trim()} aria-hidden="true" />
      </button>
      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          tabIndex={-1}
          aria-label={label}
          aria-activedescendant={`${listId}-${active}`}
          className="select-list card-raised"
          onKeyDown={onKey}
        >
          {options.map((item, index) => (
            <li
              key={item.id}
              id={`${listId}-${index}`}
              data-index={index}
              role="option"
              aria-selected={item.id === value}
              className={`select-option ${index === active ? 'active' : ''}`.trim()}
              onPointerEnter={() => setActive(index)}
              onClick={() => choose(index)}
            >
              {renderPreview?.(item)}
              <span className="select-option-text">
                <strong>{item.name}</strong>
                {item.description && <span>{item.description}</span>}
              </span>
              {item.id === value && <Check size={16} className="select-check" aria-hidden="true" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Renders into `document.body`.
 *
 * Under the Glass finish a card carries a `backdrop-filter`, and an element
 * with one becomes the containing block for `position: fixed` descendants — so
 * a popover positioned against the viewport from inside a card would be
 * anchored to the card instead, silently, and only under that one setting.
 * Anything positioned by script goes through here.
 */
export function Portal({ children }) {
  const [host] = useState(() => {
    if (typeof document === 'undefined') return null;
    const element = document.createElement('div');
    element.setAttribute('data-portal', 'true');
    return element;
  });
  useEffect(() => {
    if (!host) return undefined;
    document.body.appendChild(host);
    return () => host.remove();
  }, [host]);
  return host ? createPortal(children, host) : null;
}
