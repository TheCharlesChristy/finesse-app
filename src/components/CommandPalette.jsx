import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Search } from 'lucide-react';

import { fmt } from '../utils';

/**
 * Keyboard-first way to reach anything: jump to a view, start an action, or
 * find a transaction — without hunting through the sidebar.
 *
 * Opened with ⌘K / Ctrl+K (see the shortcut handler in App.jsx).
 */
export default function CommandPalette({ onClose, commands = [], transactions = [], categories = [], onPickTransaction }) {
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef(null);
  const restoreRef = useRef(null);

  const catMap = useMemo(
    () => new Map(categories.map(category => [Number(category.id), category])),
    [categories],
  );

  const results = useMemo(() => {
    const search = query.trim().toLowerCase();

    const matchedCommands = commands
      .filter(command => !search || command.label.toLowerCase().includes(search)
        || (command.keywords || '').toLowerCase().includes(search))
      .map(command => ({ kind: 'command', key: `cmd-${command.id}`, ...command }));

    // Only search transactions once there's something to search for —
    // otherwise the palette opens showing a wall of unrelated spending.
    const matchedTransactions = search.length < 2 ? [] : transactions
      .filter(tx => {
        const category = catMap.get(Number(tx.categoryId));
        return [tx.note, tx.merchant, category?.name, String(tx.amount)]
          .filter(Boolean)
          .some(value => String(value).toLowerCase().includes(search));
      })
      .slice(0, 6)
      .map(tx => ({
        kind: 'transaction',
        key: `tx-${tx.id}`,
        label: tx.note || catMap.get(Number(tx.categoryId))?.name || 'Expense',
        hint: `${catMap.get(Number(tx.categoryId))?.name || 'Unknown'} · ${fmt(tx.amount)}`,
        transaction: tx,
      }));

    return [...matchedCommands, ...matchedTransactions];
  }, [query, commands, transactions, catMap]);

  // Focus the input on mount and hand focus back on close. No setState here:
  // the component is mounted fresh each time it opens, so its initial state is
  // already the reset state.
  useEffect(() => {
    restoreRef.current = document.activeElement;
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      clearTimeout(timer);
      const el = restoreRef.current;
      if (el && typeof el.focus === 'function') el.focus();
    };
  }, []);

  const run = (item) => {
    if (!item) return;
    onClose();
    if (item.kind === 'transaction') onPickTransaction?.(item.transaction);
    else item.run?.();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, results.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); return; }
    if (e.key === 'Enter') { e.preventDefault(); run(results[activeIdx]); }
  };

  return createPortal(
    <div className="modal-overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}
      style={{ alignItems: 'flex-start', paddingTop: '12vh' }}>
      <div className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="command-palette-search">
          <Search size={15} aria-hidden="true" style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          <input
            ref={inputRef}
            className="command-palette-input"
            placeholder="Jump to a view, run an action, or search transactions…"
            aria-label="Command palette search"
            value={query}
            onChange={e => { setQuery(e.target.value); setActiveIdx(0); }}
            onKeyDown={handleKeyDown}
          />
          <kbd className="command-palette-kbd">esc</kbd>
        </div>

        <div className="command-palette-results" role="listbox" aria-label="Results">
          {results.length === 0 ? (
            <div style={{ padding: '18px 16px', color: 'var(--text-muted)', fontSize: 13 }}>
              Nothing matches “{query}”.
            </div>
          ) : results.map((item, idx) => (
            <button
              key={item.key}
              type="button"
              role="option"
              aria-selected={idx === activeIdx}
              className="command-palette-item"
              onMouseEnter={() => setActiveIdx(idx)}
              onClick={() => run(item)}
              style={idx === activeIdx ? { background: 'rgba(255,255,255,0.07)' } : undefined}
            >
              {item.Icon
                ? <item.Icon size={14} aria-hidden="true" style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                : <ArrowRight size={14} aria-hidden="true" style={{ color: 'var(--text-muted)', flexShrink: 0 }} />}
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.label}
              </span>
              {item.hint && (
                <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>{item.hint}</span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
