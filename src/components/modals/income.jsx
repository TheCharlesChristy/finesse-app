import { useState } from 'react';
import { format } from 'date-fns';
import DateInput from '../DateInput';
import { Modal, Field } from '../ui';
import { dateOnlyToISO } from '../../utils';
import { FrequencyFields } from './shared';

// ── Add Income Modal ─────────────────────────────────────────────────────────
export function AddIncomeModal({ onAdd, onClose, income = null, onSave }) {
  const [name, setName] = useState(income?.name || '');
  const [amount, setAmount] = useState(income?.amount != null ? String(income.amount) : '');
  const [resetFrequency, setResetFrequency] = useState(income?.resetFrequency || 'monthly');
  const [payDayOfMonth, setPayDayOfMonth] = useState(String(income?.payDayOfMonth || ''));
  const isEditing = Boolean(income);

  const handleSubmit = () => {
    if (!name.trim() || !amount) return;
    const data = {
      name: name.trim(),
      amount: parseFloat(amount),
      resetFrequency,
      payDayOfMonth: resetFrequency === 'monthly' ? (parseInt(payDayOfMonth) || null) : null,
      holdActive: income?.holdActive || false,
      lastPaid: income?.lastPaid || null,
    };
    if (isEditing && onSave) {
      onSave(income.id, data);
    } else {
      onAdd(data);
    }
    onClose();
  };

  return (
    <Modal title={isEditing ? 'Edit Income' : 'Add Income'} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Name">
          {id => (
            <input id={id} className="glass-input" placeholder="e.g. Salary" value={name}
              onChange={e => setName(e.target.value)} autoFocus />
          )}
        </Field>
        <Field label="Amount (£)">
          {id => (
            <input id={id} className="glass-input" type="number" min="0" step="0.01" placeholder="0.00" value={amount}
              onChange={e => setAmount(e.target.value)} />
          )}
        </Field>
        <FrequencyFields
          resetFrequency={resetFrequency} setResetFrequency={setResetFrequency}
          payDayOfMonth={payDayOfMonth} setPayDayOfMonth={setPayDayOfMonth}
        />
        <div className="modal-actions" style={{ display: 'flex', gap: 10, marginTop: 6 }}>
          <button className="btn-secondary" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
          <button className="btn-primary" onClick={handleSubmit} style={{ flex: 2 }}
            disabled={!name.trim() || !amount}>
            {isEditing ? 'Save Changes' : 'Add Income'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Add One-Off Income Modal ─────────────────────────────────────────────────
export function AddOneOffIncomeModal({ onAdd, onClose, categories = [] }) {
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [note, setNote] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const parsedAmount = parseFloat(amount) || 0;

  const handleSubmit = () => {
    if (!name.trim() || parsedAmount <= 0 || !date) return;
    onAdd({
      name: name.trim(),
      amount: parsedAmount,
      date: dateOnlyToISO(date),
      note: note.trim(),
      categoryId: categoryId ? Number(categoryId) : null,
    });
    onClose();
  };

  return (
    <Modal title="One-Off Income" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Source">
          {id => (
            <input id={id} className="glass-input" placeholder="e.g. Gift or refund" value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSubmit()}
              autoFocus />
          )}
        </Field>
        <Field label="Amount (£)">
          {id => (
            <input id={id} className="glass-input" type="number" min="0" step="0.01" placeholder="0.00" value={amount}
              onChange={e => setAmount(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSubmit()} />
          )}
        </Field>
        <DateInput value={date} onChange={setDate} label="Date received" />
        <Field label="Note">
          {id => (
            <input id={id} className="glass-input" placeholder="Optional" value={note}
              onChange={e => setNote(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSubmit()} />
          )}
        </Field>
        {categories.length > 0 && (
          <Field label="Allocate to category (optional)">
            {id => (
              <select id={id} className="glass-input" value={categoryId} onChange={e => setCategoryId(e.target.value)}>
                <option value="">None — just add to balance</option>
                {categories.map(cat => (
                  <option key={cat.id} value={cat.id}>{cat.name}</option>
                ))}
              </select>
            )}
          </Field>
        )}
        <div className="modal-actions" style={{ display: 'flex', gap: 10, marginTop: 6 }}>
          <button className="btn-secondary" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
          <button className="btn-primary" onClick={handleSubmit} style={{ flex: 2 }}
            disabled={!name.trim() || parsedAmount <= 0 || !date}>
            Add to Account
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Fast Forward Modal ───────────────────────────────────────────────────────
export function FastForwardModal({ onConfirm, onClose }) {
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'));

  return (
    <Modal title="Early Pay" onClose={onClose}>
      <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 18, lineHeight: 1.6 }}>
        Got paid early? Set the actual date you received this income. This credits the active account and updates the next expected pay date.
      </div>
      <div style={{ marginBottom: 18 }}>
        <DateInput value={date} onChange={setDate} label="Pay received date" />
      </div>
      <div className="modal-actions" style={{ display: 'flex', gap: 10 }}>
        <button className="btn-secondary" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
        <button className="btn-primary" onClick={() => { onConfirm(dateOnlyToISO(date)); onClose(); }} style={{ flex: 2 }}>
          Mark as Received
        </button>
      </div>
    </Modal>
  );
}
