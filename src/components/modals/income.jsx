import { useState } from 'react';
import { format } from 'date-fns';
import DateInput from '../DateInput';
import { Modal, Field } from '../ui';
import { useModalAction } from '../useModalAction';
import { dateOnlyToISO } from '../../utils';
import { FrequencyFields } from './shared';

// ── Add Income Modal ─────────────────────────────────────────────────────────
export function AddIncomeModal({ onAdd, onClose, income = null, onSave }) {
  const modalAction = useModalAction(onClose, 'Could not save this income. Your entries are still here; please try again.');
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
    return modalAction.run(() => (
      isEditing && onSave ? onSave(income.id, data) : onAdd(data)
    ));
  };

  return (
    <Modal title={isEditing ? 'Edit Income' : 'Add Income'} onClose={modalAction.dismiss}
      footer={<>
        <span className="spacer" />
<button className="btn-secondary" onClick={modalAction.dismiss} style={{ flex: 1 }} disabled={modalAction.isSubmitting}>Cancel</button>
          <button className="btn-primary" onClick={handleSubmit} style={{ flex: 2 }}
            disabled={modalAction.isSubmitting || !name.trim() || !amount}>
            {modalAction.isSubmitting ? 'Saving…' : isEditing ? 'Save Changes' : 'Add Income'}
          </button>
      </>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Name">
          {id => (
            <input id={id} className="input" placeholder="e.g. Salary" value={name}
              onChange={e => setName(e.target.value)} autoFocus />
          )}
        </Field>
        <Field label="Amount (£)">
          {id => (
            <input id={id} className="input" type="number" min="0" step="0.01" placeholder="0.00" value={amount}
              onChange={e => setAmount(e.target.value)} />
          )}
        </Field>
        <FrequencyFields
          resetFrequency={resetFrequency} setResetFrequency={setResetFrequency}
          payDayOfMonth={payDayOfMonth} setPayDayOfMonth={setPayDayOfMonth}
        />
        {modalAction.error && <div className="field-error" role="alert">{modalAction.error}</div>}
      </div>
    </Modal>
  );
}

// ── Add One-Off Income Modal ─────────────────────────────────────────────────
export function AddOneOffIncomeModal({ onAdd, onClose, categories = [] }) {
  const modalAction = useModalAction(onClose, 'Could not add this income. Your entries are still here; please try again.');
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [note, setNote] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const parsedAmount = parseFloat(amount) || 0;

  const handleSubmit = () => {
    if (!name.trim() || parsedAmount <= 0 || !date) return;
    const data = {
      name: name.trim(),
      amount: parsedAmount,
      date: dateOnlyToISO(date),
      note: note.trim(),
      categoryId: categoryId ? Number(categoryId) : null,
    };
    return modalAction.run(() => onAdd(data));
  };

  return (
    <Modal title="One-Off Income" onClose={modalAction.dismiss}
      footer={<>
        <span className="spacer" />
<button className="btn-secondary" onClick={modalAction.dismiss} style={{ flex: 1 }} disabled={modalAction.isSubmitting}>Cancel</button>
          <button className="btn-primary" onClick={handleSubmit} style={{ flex: 2 }}
            disabled={modalAction.isSubmitting || !name.trim() || parsedAmount <= 0 || !date}>
            {modalAction.isSubmitting ? 'Saving…' : 'Add to Account'}
          </button>
      </>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Source">
          {id => (
            <input id={id} className="input" placeholder="e.g. Gift or refund" value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSubmit()}
              autoFocus />
          )}
        </Field>
        <Field label="Amount (£)">
          {id => (
            <input id={id} className="input" type="number" min="0" step="0.01" placeholder="0.00" value={amount}
              onChange={e => setAmount(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSubmit()} />
          )}
        </Field>
        <DateInput value={date} onChange={setDate} label="Date received" />
        <Field label="Note">
          {id => (
            <input id={id} className="input" placeholder="Optional" value={note}
              onChange={e => setNote(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSubmit()} />
          )}
        </Field>
        {categories.length > 0 && (
          <Field label="Allocate to category (optional)">
            {id => (
              <select id={id} className="input" value={categoryId} onChange={e => setCategoryId(e.target.value)}>
                <option value="">None — just add to balance</option>
                {categories.map(cat => (
                  <option key={cat.id} value={cat.id}>{cat.name}</option>
                ))}
              </select>
            )}
          </Field>
        )}
        {modalAction.error && <div className="field-error" role="alert">{modalAction.error}</div>}
      </div>
    </Modal>
  );
}

// ── Fast Forward Modal ───────────────────────────────────────────────────────
export function FastForwardModal({ onConfirm, onClose }) {
  const modalAction = useModalAction(onClose, 'Could not record this pay date. Please try again.');
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'));

  return (
    <Modal title="Early Pay" onClose={modalAction.dismiss}
      footer={<>
        <span className="spacer" />
<button className="btn-secondary" onClick={modalAction.dismiss} style={{ flex: 1 }} disabled={modalAction.isSubmitting}>Cancel</button>
        <button className="btn-primary" onClick={() => modalAction.run(() => onConfirm(dateOnlyToISO(date)))} style={{ flex: 2 }} disabled={modalAction.isSubmitting}>
          {modalAction.isSubmitting ? 'Saving…' : 'Mark as Received'}
        </button>
      </>}
    >
      <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 18, lineHeight: 1.6 }}>
        Got paid early? Set the actual date you received this income. This credits the active account and updates the next expected pay date.
      </div>
      <div style={{ marginBottom: 18 }}>
        <DateInput value={date} onChange={setDate} label="Pay received date" />
      </div>
      {modalAction.error && <div className="field-error" role="alert">{modalAction.error}</div>}
    </Modal>
  );
}
