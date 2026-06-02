import { useEffect, useMemo, useRef, useState } from 'react';
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
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 260 });
  const selected = useMemo(
    () => categories.find(category => String(category.id) === String(value)),
    [categories, value]
  );
  const selectedIsAll = includeAll && value === 'all';

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

  const choose = (nextValue) => {
    onChange(nextValue);
    setOpen(false);
  };

  return (
    <div style={{ position: 'relative', width: '100%', ...style }}>
      <button
        ref={triggerRef}
        type="button"
        className="glass-input category-select-trigger"
        disabled={disabled}
        onClick={() => {
          updatePosition();
          setOpen(current => !current);
        }}
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
          background: selected?.color || (selectedIsAll ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.14)'),
          flexShrink: 0,
        }} />
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selected?.name || (selectedIsAll ? allLabel : placeholder)}
        </span>
        <ChevronDown size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
      </button>

      {open && createPortal(
        <div
          ref={menuRef}
          className="category-select-menu"
          style={{ position: 'fixed', top: position.top, left: position.left, width: position.width, right: 'auto', zIndex: 500 }}
        >
          {includeAll && (
            <button
              type="button"
              className="category-select-option"
              onClick={() => choose('all')}
            >
              <span className="category-select-dot" style={{ background: 'rgba(255,255,255,0.35)' }} />
              <span style={{ flex: 1 }}>{allLabel}</span>
              {selectedIsAll && <Check size={14} color="var(--accent-mint)" />}
            </button>
          )}
          {categories.map(category => {
            const active = String(category.id) === String(value);
            const remaining = (Number(category.allowance) || 0) - (Number(category.spent) || 0);
            return (
              <button
                key={category.id}
                type="button"
                className="category-select-option"
                onClick={() => choose(String(category.id))}
              >
                <span className="category-select-dot" style={{ background: category.color || 'var(--accent-blue)' }} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {category.name}
                  </span>
                  {showAmounts && (
                    <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 11, marginTop: 1 }}>
                      {fmt(Math.max(0, remaining))} remaining
                    </span>
                  )}
                </span>
                {active && <Check size={14} color="var(--accent-mint)" />}
              </button>
            );
          })}
          {categories.length === 0 && !includeAll && (
            <div style={{ padding: '10px 12px', color: 'var(--text-muted)', fontSize: 12 }}>
              No categories yet.
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}
