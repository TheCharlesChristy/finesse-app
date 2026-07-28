import { useState, useMemo } from 'react';
import { Plus, X } from 'lucide-react';
import { format } from 'date-fns';
import CategorySelect from '../CategorySelect';
import DateInput from '../DateInput';
import { Modal, IconButton, Field } from '../ui';
import { dateOnlyToISO, fmt } from '../../utils';

// ── Add Transaction Modal ────────────────────────────────────────────────────
export function AddTransactionModal({ categories, onAdd, onClose, transaction = null, onSave, initial = null, defaultCategoryId = null }) {
  const fallbackCategoryId = categories.some(category => Number(category.id) === Number(defaultCategoryId))
    ? defaultCategoryId
    : categories[0]?.id;
  const [catId, setCatId] = useState(transaction?.categoryId || initial?.categoryId || fallbackCategoryId || '');
  const [amount, setAmount] = useState(transaction?.amount != null ? String(transaction.amount) : initial?.amount != null ? String(initial.amount) : '');
  const [note, setNote] = useState(transaction?.note || initial?.note || '');
  const [date, setDate] = useState(format(transaction?.date ? new Date(transaction.date) : new Date(), 'yyyy-MM-dd'));
  const isEditing = Boolean(transaction);

  const amountValue = parseFloat(amount);
  const canSubmit = Boolean(catId) && amountValue > 0;

  const handleSubmit = () => {
    if (!canSubmit) return;
    const data = {
      categoryId: Number(catId),
      amount: amountValue,
      note: note.trim(),
      date: dateOnlyToISO(date),
    };
    if (isEditing && onSave) {
      onSave(transaction.id, data);
    } else {
      onAdd(data);
    }
    onClose();
  };

  return (
    <Modal title={isEditing ? 'Edit Expense' : 'Log Expense'} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Category">
          <CategorySelect categories={categories} value={String(catId)} onChange={setCatId} showAmounts aria-label="Category" />
        </Field>
        <Field label="Amount (£)">
          {id => (
            <input id={id} className="glass-input" type="number" min="0" step="0.01" placeholder="0.00" value={amount}
              onChange={e => setAmount(e.target.value)} autoFocus />
          )}
        </Field>
        <Field label="Note (optional)">
          {id => (
            <input id={id} className="glass-input" placeholder="What was this for?" value={note}
              onChange={e => setNote(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSubmit()} />
          )}
        </Field>
        <DateInput value={date} onChange={setDate} />
        <div className="modal-actions" style={{ display: 'flex', gap: 10, marginTop: 6 }}>
          <button className="btn-secondary" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
          <button className="btn-primary" onClick={handleSubmit} style={{ flex: 2 }} disabled={!canSubmit}>
            {isEditing ? 'Save Changes' : 'Add Expense'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function blankBulkRow(date) {
  return { amount: '', note: '', date };
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
export function BulkAddExpensesModal({ categories, onAdd, onClose, defaultCategoryId = null }) {
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
      }))
      .filter(row => row.amount > 0)
  ), [rows]);
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
      .filter(Boolean);
    if (!parsed.length) return;
    setRows([...parsed, blankBulkRow(defaultDate), blankBulkRow(defaultDate)]);
    setPasteText('');
  };

  const handleSubmit = () => {
    if (!catId || validRows.length === 0) return;
    onAdd({
      categoryId: Number(catId),
      transactions: validRows.map(row => ({
        amount: row.amount,
        note: row.note,
        date: dateOnlyToISO(row.date),
      })),
    });
    onClose();
  };

  return (
    <Modal title="Bulk Add Expenses" subtitle="Add several expenses to one category in one pass." onClose={onClose} maxWidth={760}>
        <div className="mobile-stack" style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) minmax(170px, 220px)', gap: 12, marginBottom: 16 }}>
          <Field label="Category">
            <CategorySelect categories={categories} value={String(catId)} onChange={setCatId} showAmounts aria-label="Category" />
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
          <button className="btn-primary" onClick={handleSubmit} disabled={!catId || validRows.length === 0}
            style={{ flex: 2 }}>
            Add {validRows.length || ''} Expense{validRows.length === 1 ? '' : 's'}
          </button>
        </div>
    </Modal>
  );
}
