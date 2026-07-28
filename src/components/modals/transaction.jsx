import { useState, useMemo } from 'react';
import { Plus, Split, Undo2, X } from 'lucide-react';
import { format } from 'date-fns';
import CategorySelect from '../CategorySelect';
import DateInput from '../DateInput';
import { Modal, IconButton, Field } from '../ui';
import {
  dateOnlyToISO,
  fmt,
  getMerchantSuggestions,
  normaliseTags,
  suggestCategoryForNote,
  TX_EXPENSE,
  TX_REFUND,
} from '../../utils';

// ── Merchant autocomplete ────────────────────────────────────────────────────
// Most spending is repeat spending at the same handful of places. Remembering
// them turns the slowest part of logging — typing the note and picking the
// category — into one tap.
function MerchantInput({ value, onChange, onPick, suggestions, onSubmit, id }) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);

  const visible = open && suggestions.length > 0;

  const pick = (entry) => {
    onPick(entry);
    setOpen(false);
  };

  const handleKeyDown = (e) => {
    if (visible) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, suggestions.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); return; }
      if (e.key === 'Enter' && suggestions[activeIdx]) { e.preventDefault(); pick(suggestions[activeIdx]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setOpen(false); return; }
    }
    if (e.key === 'Enter') onSubmit?.();
  };

  return (
    <div style={{ position: 'relative' }}>
      <input
        id={id}
        className="glass-input"
        placeholder="Where? e.g. Tesco"
        value={value}
        autoComplete="off"
        onChange={e => { onChange(e.target.value); setOpen(true); setActiveIdx(0); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={handleKeyDown}
      />
      {visible && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 200,
          background: 'rgba(8,12,28,0.97)', border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 10, backdropFilter: 'blur(24px)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)', overflow: 'hidden',
        }}>
          {suggestions.map((entry, idx) => (
            <div key={entry.label}
              onMouseDown={e => { e.preventDefault(); pick(entry); }}
              onMouseEnter={() => setActiveIdx(idx)}
              style={{
                padding: '9px 13px', cursor: 'pointer', fontSize: 13,
                display: 'flex', alignItems: 'center', gap: 8,
                background: idx === activeIdx ? 'rgba(255,255,255,0.07)' : 'transparent',
              }}>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {entry.label}
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
                {fmt(entry.lastAmount)} · {entry.count}×
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Add Transaction Modal ────────────────────────────────────────────────────
export function AddTransactionModal({
  categories, onAdd, onClose, transaction = null, onSave, initial = null,
  defaultCategoryId = null, transactions = [], rules = [], onAddSplit,
}) {
  const fallbackCategoryId = categories.some(category => Number(category.id) === Number(defaultCategoryId))
    ? defaultCategoryId
    : categories[0]?.id;
  const [catId, setCatId] = useState(transaction?.categoryId || initial?.categoryId || fallbackCategoryId || '');
  const [amount, setAmount] = useState(transaction?.amount != null ? String(transaction.amount) : initial?.amount != null ? String(initial.amount) : '');
  const [note, setNote] = useState(transaction?.note || initial?.note || '');
  const [tagInput, setTagInput] = useState((transaction?.tags || initial?.tags || []).join(', '));
  const [type, setType] = useState(transaction?.type === TX_REFUND ? TX_REFUND : TX_EXPENSE);
  const [date, setDate] = useState(format(transaction?.date ? new Date(transaction.date) : new Date(), 'yyyy-MM-dd'));
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitParts, setSplitParts] = useState([{ categoryId: '', amount: '' }]);
  const [suggestion, setSuggestion] = useState(null);

  const isEditing = Boolean(transaction);
  const isRefundMode = type === TX_REFUND;

  const suggestions = useMemo(
    () => (isEditing ? [] : getMerchantSuggestions(transactions, note, 6)),
    [transactions, note, isEditing],
  );

  const amountValue = parseFloat(amount);
  const splitTotal = splitParts.reduce((sum, part) => sum + (parseFloat(part.amount) || 0), 0);
  const splitValid = splitOpen
    && splitParts.filter(p => p.categoryId && parseFloat(p.amount) > 0).length >= 2
    && Math.abs(splitTotal - amountValue) < 0.005;

  const canSubmit = amountValue > 0 && (splitOpen ? splitValid : Boolean(catId));

  // Applying a suggestion is what makes this fast — but never override a
  // category the user picked themselves, and never while editing.
  const applyNote = (text) => {
    setNote(text);
    if (isEditing) return;
    const hint = suggestCategoryForNote(text, { rules, transactions, categories });
    setSuggestion(hint);
    if (hint) setCatId(hint.categoryId);
  };

  const handlePickMerchant = (entry) => {
    setNote(entry.label);
    setSuggestion({ categoryId: entry.lastCategoryId, source: 'history', match: entry.label });
    if (categories.some(c => Number(c.id) === Number(entry.lastCategoryId))) setCatId(entry.lastCategoryId);
    if (!amount && entry.lastAmount > 0) setAmount(String(entry.lastAmount));
  };

  const updatePart = (index, patch) => {
    setSplitParts(current => current.map((part, i) => (i === index ? { ...part, ...patch } : part)));
  };

  const handleSubmit = () => {
    if (!canSubmit) return;
    const tags = normaliseTags(tagInput);
    const trimmedNote = note.trim();

    if (splitOpen && !isEditing) {
      onAddSplit?.({
        parts: splitParts
          .filter(p => p.categoryId && parseFloat(p.amount) > 0)
          .map(p => ({ categoryId: Number(p.categoryId), amount: parseFloat(p.amount) })),
        note: trimmedNote,
        merchant: trimmedNote,
        tags,
        type,
        date: dateOnlyToISO(date),
      });
      onClose();
      return;
    }

    const data = {
      categoryId: Number(catId),
      amount: amountValue,
      note: trimmedNote,
      merchant: trimmedNote,
      tags,
      type,
      date: dateOnlyToISO(date),
    };
    if (isEditing && onSave) onSave(transaction.id, data);
    else onAdd(data);
    onClose();
  };

  const suggestedCategory = suggestion && categories.find(c => Number(c.id) === Number(suggestion.categoryId));
  const title = isEditing ? 'Edit Transaction' : isRefundMode ? 'Log Refund' : 'Log Expense';

  return (
    <Modal title={title} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* A refund is money coming back, not a negative expense — logging it
            as one keeps the category's spend honest. */}
        <div role="group" aria-label="Transaction type" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <button type="button" aria-pressed={!isRefundMode}
            className={!isRefundMode ? 'btn-primary' : 'btn-secondary'}
            onClick={() => setType(TX_EXPENSE)} style={{ padding: '8px 10px', fontSize: 12 }}>
            Expense
          </button>
          <button type="button" aria-pressed={isRefundMode}
            className={isRefundMode ? 'btn-primary' : 'btn-secondary'}
            onClick={() => setType(TX_REFUND)} style={{ padding: '8px 10px', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <Undo2 size={13} /> Refund
          </button>
        </div>

        <Field label="Amount (£)">
          {id => (
            <input id={id} className="glass-input" type="number" min="0" step="0.01" placeholder="0.00" value={amount}
              onChange={e => setAmount(e.target.value)} autoFocus />
          )}
        </Field>

        <Field label={isEditing ? 'Note' : 'Note / merchant'}>
          {id => (
            <MerchantInput
              id={id}
              value={note}
              onChange={applyNote}
              onPick={handlePickMerchant}
              suggestions={suggestions}
              onSubmit={handleSubmit}
            />
          )}
        </Field>

        {!splitOpen && (
          <Field label="Category">
            <CategorySelect categories={categories} value={String(catId)} onChange={id => { setCatId(id); setSuggestion(null); }}
              showAmounts aria-label="Category" />
          </Field>
        )}

        {suggestedCategory && !splitOpen && (
          <div style={{ fontSize: 11, color: 'var(--accent-mint)', marginTop: -8 }}>
            {suggestion.source === 'rule'
              ? `Matched your rule "${suggestion.match}" → ${suggestedCategory.name}`
              : `You usually put "${suggestion.match}" in ${suggestedCategory.name}`}
          </div>
        )}

        {/* Split: one purchase, several budgets. Only offered on new entries —
            editing a split part in isolation already works. */}
        {!isEditing && categories.length > 1 && (
          <div>
            <button type="button" className="btn-secondary"
              onClick={() => setSplitOpen(open => !open)}
              style={{ padding: '7px 12px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Split size={13} /> {splitOpen ? 'Cancel split' : 'Split across categories'}
            </button>

            {splitOpen && (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {splitParts.map((part, index) => (
                  <div key={index} style={{ display: 'grid', gridTemplateColumns: '1fr 110px 34px', gap: 8, alignItems: 'center' }}>
                    <CategorySelect categories={categories} value={String(part.categoryId)}
                      onChange={id => updatePart(index, { categoryId: id })}
                      aria-label={`Split part ${index + 1} category`} />
                    <input className="glass-input" type="number" min="0" step="0.01" placeholder="0.00"
                      aria-label={`Split part ${index + 1} amount`}
                      value={part.amount} onChange={e => updatePart(index, { amount: e.target.value })}
                      style={{ padding: '8px 10px' }} />
                    <IconButton size={34} label={`Remove split part ${index + 1}`}
                      disabled={splitParts.length <= 1}
                      onClick={() => setSplitParts(current => current.filter((_, i) => i !== index))}>
                      <X size={13} />
                    </IconButton>
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <button type="button" className="btn-secondary" style={{ padding: '6px 10px', fontSize: 12 }}
                    onClick={() => setSplitParts(current => [...current, { categoryId: '', amount: '' }])}>
                    <Plus size={12} /> Add part
                  </button>
                  <span style={{ fontSize: 12, color: Math.abs(splitTotal - amountValue) < 0.005 ? 'var(--good)' : 'var(--warn)' }}>
                    {fmt(splitTotal)} of {fmt(amountValue || 0)}
                    {Math.abs(splitTotal - amountValue) >= 0.005 && amountValue > 0
                      ? ` · ${fmt(Math.abs(amountValue - splitTotal))} ${splitTotal > amountValue ? 'over' : 'left'}`
                      : ''}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

        <Field label="Tags (optional)" hint="Comma separated — e.g. holiday, work">
          {id => (
            <input id={id} className="glass-input" placeholder="holiday, work" value={tagInput}
              onChange={e => setTagInput(e.target.value)} />
          )}
        </Field>

        <DateInput value={date} onChange={setDate} />

        <div className="modal-actions" style={{ display: 'flex', gap: 10, marginTop: 6 }}>
          <button className="btn-secondary" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
          <button className="btn-primary" onClick={handleSubmit} style={{ flex: 2 }} disabled={!canSubmit}>
            {isEditing ? 'Save Changes' : splitOpen ? 'Add Split' : isRefundMode ? 'Add Refund' : 'Add Expense'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function blankBulkRow(date) {
  return { amount: '', note: '', date, categoryId: '' };
}

function parseLooseDate(value, fallbackDate) {
  if (!value) return fallbackDate;
  const clean = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) return clean;

  const match = clean.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (!match) return fallbackDate;

  const day = match[1].padStart(2, '0');
  const month = match[2].padStart(2, '0');
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${year}-${month}-${day}`;
}

function parseBulkExpenseLine(line, fallbackDate) {
  let text = line.trim();
  if (!text) return null;

  let date = fallbackDate;
  const dateMatch = text.match(/^(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})[\s,;\t]+/);
  if (dateMatch) {
    date = parseLooseDate(dateMatch[1], fallbackDate);
    text = text.slice(dateMatch[0].length).trim();
  }

  const amountMatches = [...text.matchAll(/£?\s*-?\d+(?:\.\d{1,2})?/g)];
  if (!amountMatches.length) return null;

  const amountMatch = amountMatches[amountMatches.length - 1];
  const amount = Math.abs(parseFloat(amountMatch[0].replace(/[£\s]/g, '')));
  if (!(amount > 0)) return null;

  const note = `${text.slice(0, amountMatch.index)} ${text.slice(amountMatch.index + amountMatch[0].length)}`
    .replace(/^[\s,;:-]+|[\s,;:-]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return {
    amount: String(amount),
    note,
    date,
  };
}

// ── Bulk Add Expenses Modal ──────────────────────────────────────────────────
export function BulkAddExpensesModal({ categories, onAdd, onClose, defaultCategoryId = null, rules = [], transactions = [] }) {
  const fallbackCategoryId = categories.some(category => Number(category.id) === Number(defaultCategoryId))
    ? defaultCategoryId
    : categories[0]?.id;
  const today = format(new Date(), 'yyyy-MM-dd');
  const [catId, setCatId] = useState(fallbackCategoryId || '');
  const [defaultDate, setDefaultDate] = useState(today);
  const [rows, setRows] = useState(() => Array.from({ length: 5 }, () => blankBulkRow(today)));
  const [pasteText, setPasteText] = useState('');

  const validRows = useMemo(() => (
    rows
      .map(row => ({
        amount: parseFloat(row.amount),
        note: row.note.trim(),
        date: row.date,
        categoryId: Number(row.categoryId || catId) || null,
      }))
      .filter(row => row.amount > 0 && row.categoryId)
  ), [rows, catId]);
  const totalAmount = validRows.reduce((sum, row) => sum + row.amount, 0);

  const updateRow = (index, patch) => {
    setRows(current => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  };

  const addRows = (count = 3) => {
    setRows(current => [...current, ...Array.from({ length: count }, () => blankBulkRow(defaultDate))]);
  };

  const removeRow = (index) => {
    setRows(current => current.length <= 1 ? current : current.filter((_, rowIndex) => rowIndex !== index));
  };

  const applyDefaultDate = (date) => {
    setDefaultDate(date);
    setRows(current => current.map(row => ({ ...row, date })));
  };

  const fillFromPaste = () => {
    const parsed = pasteText
      .split('\n')
      .map(line => parseBulkExpenseLine(line, defaultDate))
      .filter(Boolean)
      // Infer each line's category from rules and past spending, so a pasted
      // statement lands mostly sorted instead of all in one bucket.
      .map(row => {
        const hint = suggestCategoryForNote(row.note, { rules, transactions, categories });
        return { ...row, categoryId: hint ? String(hint.categoryId) : '' };
      });
    if (!parsed.length) return;
    setRows([...parsed, blankBulkRow(defaultDate), blankBulkRow(defaultDate)]);
    setPasteText('');
  };

  const handleSubmit = () => {
    if (validRows.length === 0) return;
    onAdd(validRows.map(row => ({
      categoryId: row.categoryId,
      amount: row.amount,
      note: row.note,
      merchant: row.note,
      date: dateOnlyToISO(row.date),
    })));
    onClose();
  };

  return (
    <Modal title="Bulk Add Expenses" subtitle="Add several expenses to one category in one pass." onClose={onClose} maxWidth={760}>
        <div className="mobile-stack" style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) minmax(170px, 220px)', gap: 12, marginBottom: 16 }}>
          <Field label="Default category" hint="Used for any row you leave unset">
            <CategorySelect categories={categories} value={String(catId)} onChange={setCatId} showAmounts aria-label="Default category" />
          </Field>
          <DateInput value={defaultDate} onChange={applyDefaultDate} label="Default date" />
        </div>

        <div style={{
          border: '1px solid rgba(255,255,255,0.08)',
          background: 'rgba(255,255,255,0.035)',
          borderRadius: 14,
          padding: 12,
          marginBottom: 14,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>Paste lines</div>
            <button className="btn-secondary" onClick={fillFromPaste} disabled={!pasteText.trim()}
              style={{ padding: '6px 10px', fontSize: 12 }}>
              Fill Rows
            </button>
          </div>
          <textarea
            className="glass-input"
            value={pasteText}
            onChange={e => setPasteText(e.target.value)}
            rows={3}
            placeholder={'Optional. Examples:\n12.50 Lunch\n2026-06-01 8.99 Coffee\nGroceries, 34.20'}
            style={{ resize: 'vertical', minHeight: 86 }}
          />
        </div>

        <div className="bulk-expense-header" style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 6, padding: '0 2px' }}>
          <div>Amount</div>
          <div>Note</div>
          <div>Category</div>
          <div>Date</div>
          <div />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 300, overflowY: 'auto', paddingRight: 4 }}>
          {rows.map((row, index) => (
            <div key={index} className="bulk-expense-row">
              <input className="glass-input" type="number" min="0" step="0.01" placeholder="0.00" value={row.amount}
                aria-label={`Row ${index + 1} amount`}
                onChange={e => updateRow(index, { amount: e.target.value })}
                onKeyDown={e => e.key === 'Enter' && addRows(1)}
                style={{ padding: '8px 10px' }}
                autoFocus={index === 0} />
              <input className="glass-input bulk-expense-note" placeholder="Optional note" value={row.note}
                aria-label={`Row ${index + 1} note`}
                onChange={e => updateRow(index, { note: e.target.value })}
                onKeyDown={e => e.key === 'Enter' && addRows(1)}
                style={{ padding: '8px 10px' }} />
              <div className="bulk-expense-category">
                <CategorySelect categories={categories} value={String(row.categoryId || catId)}
                  onChange={value => updateRow(index, { categoryId: value })}
                  aria-label={`Row ${index + 1} category`} />
              </div>
              <div className="bulk-expense-date">
                <DateInput value={row.date} onChange={date => updateRow(index, { date })} label={null} />
              </div>
              <IconButton onClick={() => removeRow(index)} disabled={rows.length <= 1}
                label={`Remove row ${index + 1}`} size={34}>
                <X size={13} />
              </IconButton>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 16 }}>
          <button className="btn-secondary" onClick={() => addRows(3)}
            style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <Plus size={14} /> Add Rows
          </button>
          <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>
            <span style={{ color: 'var(--text-secondary)', fontWeight: 700 }}>{validRows.length}</span> expense{validRows.length === 1 ? '' : 's'}
            {' · '}
            <span style={{ color: 'var(--accent-warm)', fontWeight: 700 }}>{fmt(totalAmount)}</span>
          </div>
        </div>

        <div className="modal-actions" style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button className="btn-secondary" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
          <button className="btn-primary" onClick={handleSubmit} disabled={validRows.length === 0}
            style={{ flex: 2 }}>
            Add {validRows.length || ''} Expense{validRows.length === 1 ? '' : 's'}
          </button>
        </div>
    </Modal>
  );
}
