import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { fmt } from '../utils';

export default function CategorySelect({
  categories = [],
  value,
  onChange,
  placeholder = 'Select category',
  includeAll = false,
  allLabel = 'All Categories',
  showAmounts = false,
  disabled = false,
  style = {},
  'aria-label': ariaLabel,
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const typeahead = useRef({ buffer: '', at: 0 });
  const [position, setPosition] = useState({ top: 0, left: 0, width: 260 });
  const listId = useId();

  const options = useMemo(() => {
    const base = includeAll ? [{ value: 'all', label: allLabel, color: 'rgba(255,255,255,0.35)' }] : [];
    return base.concat(categories.map(category => ({
      value: String(category.id),
      label: category.name,
      color: category.color || 'var(--accent-blue)',
      remaining: (Number(category.allowance) || 0) - (Number(category.spent) || 0),
    })));
  }, [categories, includeAll, allLabel]);

  const selectedIndex = options.findIndex(o => o.value === String(value));
  const selected = options[selectedIndex];

  const updatePosition = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(Math.max(rect.width, 220), window.innerWidth - 24);
    const left = Math.min(Math.max(12, rect.left), window.innerWidth - width - 12);
    const belowTop = rect.bottom + 6;
    const aboveTop = rect.top - 286;
    const top = belowTop + 286 > window.innerHeight && aboveTop > 12 ? aboveTop : belowTop;
    setPosition({ top, left, width });
  };

  useEffect(() => {
    const handleClick = (event) => {
      if (triggerRef.current?.contains(event.target) || menuRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  // Keep the active option scrolled into view.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const el = menuRef.current?.querySelector(`#${CSS.escape(`${listId}-opt-${activeIndex}`)}`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, listId]);

  const openMenu = () => {
    updatePosition();
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  };

  const choose = (nextValue) => {
    onChange(nextValue);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const moveActive = (delta) => {
    setActiveIndex(prev => {
      const next = prev + delta;
      if (next < 0) return 0;
      if (next > options.length - 1) return options.length - 1;
      return next;
    });
  };

  const handleKeyDown = (e) => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); moveActive(1); break;
      case 'ArrowUp': e.preventDefault(); moveActive(-1); break;
      case 'Home': e.preventDefault(); setActiveIndex(0); break;
      case 'End': e.preventDefault(); setActiveIndex(options.length - 1); break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (options[activeIndex]) choose(options[activeIndex].value);
        break;
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        break;
      case 'Tab':
        setOpen(false);
        break;
      default:
        if (e.key.length === 1 && /\S/.test(e.key)) {
          const now = Date.now();
          const ta = typeahead.current;
          ta.buffer = now - ta.at > 800 ? e.key : ta.buffer + e.key;
          ta.at = now;
          const match = options.findIndex(o => o.label.toLowerCase().startsWith(ta.buffer.toLowerCase()));
          if (match >= 0) setActiveIndex(match);
        }
    }
  };

  return (
    <div style={{ position: 'relative', width: '100%', ...style }}>
      <button
        ref={triggerRef}
        type="button"
        className="glass-input category-select-trigger"
        disabled={disabled}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? `${listId}-opt-${activeIndex}` : undefined}
        aria-label={ariaLabel}
        onKeyDown={handleKeyDown}
        onClick={() => (open ? setOpen(false) : openMenu())}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          textAlign: 'left',
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        <span style={{
          width: 9,
          height: 9,
          borderRadius: '50%',
          background: selected?.color || 'rgba(255,255,255,0.14)',
          flexShrink: 0,
        }} />
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selected?.label || placeholder}
        </span>
        <ChevronDown size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
      </button>

      {open && createPortal(
        <ul
          ref={menuRef}
          id={listId}
          role="listbox"
          aria-label={ariaLabel || placeholder}
          className="category-select-menu"
          style={{ position: 'fixed', top: position.top, left: position.left, width: position.width, right: 'auto', zIndex: 500, listStyle: 'none', margin: 0 }}
        >
          {options.map((option, index) => (
            <li key={option.value} role="presentation">
              <button
                id={`${listId}-opt-${index}`}
                type="button"
                role="option"
                aria-selected={option.value === String(value)}
                className="category-select-option"
                style={index === activeIndex ? { background: 'rgba(255,255,255,0.07)', color: 'var(--text-primary)' } : undefined}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(option.value)}
              >
                <span className="category-select-dot" style={{ background: option.color }} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {option.label}
                  </span>
                  {showAmounts && option.remaining != null && (
                    <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 11, marginTop: 1 }}>
                      {fmt(Math.max(0, option.remaining))} remaining
                    </span>
                  )}
                </span>
                {option.value === String(value) && <Check size={14} color="var(--accent-mint)" />}
              </button>
            </li>
          ))}
          {options.length === 0 && (
            <li role="presentation" style={{ padding: '10px 12px', color: 'var(--text-muted)', fontSize: 12 }}>
              No categories yet.
            </li>
          )}
        </ul>,
        document.body
      )}
    </div>
  );
}
