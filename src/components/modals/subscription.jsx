import { useState } from 'react';
import { format } from 'date-fns';
import CategorySelect from '../CategorySelect';
import DateInput from '../DateInput';
import { Modal, Field } from '../ui';
import { dateOnlyToISO } from '../../utils';

// ── Add Subscription Modal ───────────────────────────────────────────────────
export function AddSubscriptionModal({ categories = [], onAdd, onClose, subscription = null, onSave, defaultCategoryId = null }) {
  const fallbackCategoryId = categories.some(category => Number(category.id) === Number(defaultCategoryId))
    ? defaultCategoryId
    : categories[0]?.id;
  const [name, setName] = useState(subscription?.name || '');
  const [amount, setAmount] = useState(subscription?.amount != null ? String(subscription.amount) : '');
  const [catId, setCatId] = useState(subscription?.categoryId || fallbackCategoryId || '');
  const [nextDueAt, setNextDueAt] = useState(format(subscription?.nextDueAt ? new Date(subscription.nextDueAt) : new Date(), 'yyyy-MM-dd'));
  const [interval, setInterval] = useState(String(subscription?.interval || 1));
  const [intervalUnit, setIntervalUnit] = useState(subscription?.intervalUnit || 'month');
  const [manageUrl, setManageUrl] = useState(subscription?.manageUrl || '');
  const [note, setNote] = useState(subscription?.note || '');
  const [active, setActive] = useState(subscription?.active !== false);
  const isEditing = Boolean(subscription);

  const handleSubmit = () => {
    if (!name.trim() || !amount || !catId || !(Number(interval) > 0)) return;
    const data = {
      name: name.trim(),
      amount: parseFloat(amount),
      categoryId: Number(catId),
      nextDueAt: dateOnlyToISO(nextDueAt),
      interval: Math.max(1, parseInt(interval) || 1),
      intervalUnit,
      manageUrl: manageUrl.trim(),
      note: note.trim(),
      active,
    };
    if (isEditing && onSave) {
      onSave(subscription.id, data);
    } else {
      onAdd(data);
    }
    onClose();
  };

  return (
    <Modal title={isEditing ? 'Edit Subscription' : 'Add Subscription'} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Name">
          {id => (
            <input id={id} className="glass-input" placeholder="e.g. Netflix" value={name}
              onChange={e => setName(e.target.value)} autoFocus />
          )}
        </Field>
        <Field label="Category">
          <CategorySelect categories={categories} value={String(catId)} onChange={setCatId} showAmounts aria-label="Category" />
        </Field>
        <Field label="Amount (£)">
          {id => (
            <input id={id} className="glass-input" type="number" min="0" step="0.01" placeholder="0.00" value={amount}
              onChange={e => setAmount(e.target.value)} />
          )}
        </Field>
        <DateInput value={nextDueAt} onChange={setNextDueAt} label="Next due date" />
        <div>
          <div className="field-label">Repeats</div>
          <div className="mobile-stack" style={{ display: 'grid', gridTemplateColumns: '96px 1fr', gap: 8 }}>
            <input className="glass-input" type="number" min="1" step="1" value={interval}
              aria-label="Repeat interval" onChange={e => setInterval(e.target.value)} />
            <select className="glass-input" value={intervalUnit} aria-label="Repeat unit" onChange={e => setIntervalUnit(e.target.value)}>
              <option value="day">Day(s)</option>
              <option value="week">Week(s)</option>
              <option value="month">Month(s)</option>
              <option value="year">Year(s)</option>
            </select>
          </div>
        </div>
        <Field label="Management link">
          {id => (
            <input id={id} className="glass-input" type="url" placeholder="Optional, e.g. netflix.com/account" value={manageUrl}
              onChange={e => setManageUrl(e.target.value)} />
          )}
        </Field>
        <Field label="Note">
          {id => (
            <input id={id} className="glass-input" placeholder="Optional" value={note}
              onChange={e => setNote(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSubmit()} />
          )}
        </Field>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />
          Active
        </label>
        <div className="modal-actions" style={{ display: 'flex', gap: 10, marginTop: 6 }}>
          <button className="btn-secondary" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
          <button className="btn-primary" onClick={handleSubmit} style={{ flex: 2 }}
            disabled={!name.trim() || !amount || !catId || !(Number(interval) > 0)}>
            {isEditing ? 'Save Changes' : 'Add Subscription'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
