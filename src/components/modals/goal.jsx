import { useState } from 'react';
import { format } from 'date-fns';

import DateInput from '../DateInput';
import { Modal, Field } from '../ui';
import { fmt, getIncomeFrequency, roundMoney } from '../../utils';
import { ColourPicker, PALETTE } from './shared';

const FREQ_NOUN = {
  weekly: 'week',
  fortnightly: 'fortnight',
  '4weekly': '4 weeks',
  monthly: 'month',
};

export function AddGoalModal({ goal = null, incomes = [], onAdd, onSave, onClose }) {
  const isEditing = Boolean(goal);

  const [name, setName] = useState(goal?.name || '');
  const [kind, setKind] = useState(goal?.kind === 'debt' ? 'debt' : 'saving');
  const [target, setTarget] = useState(goal?.target != null ? String(goal.target) : '');
  const [saved, setSaved] = useState(goal?.saved != null ? String(goal.saved) : '');
  const [perCycle, setPerCycle] = useState(goal?.perCycleContribution ? String(goal.perCycleContribution) : '');
  const [incomeId, setIncomeId] = useState(goal?.incomeId != null ? String(goal.incomeId) : (incomes[0]?.id ? String(incomes[0].id) : ''));
  const [targetDate, setTargetDate] = useState(goal?.targetDate ? format(new Date(goal.targetDate), 'yyyy-MM-dd') : '');
  const [useTargetDate, setUseTargetDate] = useState(Boolean(goal?.targetDate));
  const [color, setColor] = useState(goal?.color || PALETTE[0]);

  const isDebt = kind === 'debt';
  const targetValue = parseFloat(target) || 0;
  const perCycleValue = parseFloat(perCycle) || 0;
  const savedValue = parseFloat(saved) || 0;
  const canSubmit = name.trim() && targetValue > 0;

  const linkedIncome = incomes.find(item => String(item.id) === String(incomeId));
  const cycleNoun = linkedIncome ? (FREQ_NOUN[getIncomeFrequency(linkedIncome)] || 'month') : 'month';
  const cyclesNeeded = perCycleValue > 0
    ? Math.ceil(Math.max(0, targetValue - savedValue) / perCycleValue)
    : null;

  const handleSubmit = () => {
    if (!canSubmit) return;
    const data = {
      name: name.trim(),
      kind,
      target: targetValue,
      saved: savedValue,
      perCycleContribution: perCycleValue,
      incomeId: perCycleValue > 0 && incomeId ? Number(incomeId) : null,
      targetDate: useTargetDate && targetDate ? new Date(`${targetDate}T00:00:00`).toISOString() : null,
      color,
    };
    if (isEditing && onSave) onSave(goal.id, data);
    else onAdd(data);
    onClose();
  };

  return (
    <Modal title={isEditing ? 'Edit Goal' : 'Add Goal'} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div role="group" aria-label="Goal type" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <button type="button" aria-pressed={!isDebt} className={!isDebt ? 'btn-primary' : 'btn-secondary'}
            onClick={() => setKind('saving')} style={{ padding: '8px 10px', fontSize: 12 }}>
            Saving for
          </button>
          <button type="button" aria-pressed={isDebt} className={isDebt ? 'btn-primary' : 'btn-secondary'}
            onClick={() => setKind('debt')} style={{ padding: '8px 10px', fontSize: 12 }}>
            Paying off
          </button>
        </div>

        <Field label="Name">
          {id => (
            <input id={id} className="glass-input" value={name} autoFocus
              placeholder={isDebt ? 'e.g. Credit card' : 'e.g. Holiday'}
              onChange={e => setName(e.target.value)} />
          )}
        </Field>

        <Field label={isDebt ? 'Total owed (£)' : 'Target amount (£)'}>
          {id => (
            <input id={id} className="glass-input" type="number" min="0" step="0.01" placeholder="0.00"
              value={target} onChange={e => setTarget(e.target.value)} />
          )}
        </Field>

        <Field label={isDebt ? 'Already paid off (£)' : 'Already saved (£)'}>
          {id => (
            <input id={id} className="glass-input" type="number" min="0" step="0.01" placeholder="0.00"
              value={saved} onChange={e => setSaved(e.target.value)} />
          )}
        </Field>

        {incomes.length > 0 && (
          <>
            <Field label="Set aside automatically (£)"
              hint="Taken each time the chosen income is paid. Leave blank to top it up by hand.">
              {id => (
                <input id={id} className="glass-input" type="number" min="0" step="0.01" placeholder="0.00"
                  value={perCycle} onChange={e => setPerCycle(e.target.value)} />
              )}
            </Field>

            {perCycleValue > 0 && (
              <Field label="From which income">
                {id => (
                  <select id={id} className="glass-input" value={incomeId} onChange={e => setIncomeId(e.target.value)}>
                    {incomes.map(income => (
                      <option key={income.id} value={income.id}>{income.name}</option>
                    ))}
                  </select>
                )}
              </Field>
            )}
          </>
        )}

        {cyclesNeeded != null && targetValue > 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', background: 'rgba(255,255,255,0.04)', borderRadius: 8, padding: '9px 12px', lineHeight: 1.6 }}>
            {fmt(perCycleValue)} every {cycleNoun} — {cyclesNeeded} {cyclesNeeded === 1 ? cycleNoun : `× ${cycleNoun}`} to reach {fmt(targetValue)}.
            <span style={{ display: 'block', marginTop: 3 }}>
              Pending contributions are held back from your safe-to-spend figure.
            </span>
          </div>
        )}

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={useTargetDate} onChange={e => setUseTargetDate(e.target.checked)} />
          Set a target date
        </label>
        {useTargetDate && (
          <DateInput value={targetDate || format(new Date(), 'yyyy-MM-dd')} onChange={setTargetDate} label="Target date" />
        )}

        <ColourPicker color={color} onChange={setColor} />

        <div className="modal-actions" style={{ display: 'flex', gap: 10, marginTop: 6 }}>
          <button className="btn-secondary" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
          <button className="btn-primary" onClick={handleSubmit} style={{ flex: 2 }} disabled={!canSubmit}>
            {isEditing ? 'Save Changes' : `Add ${isDebt ? 'Debt' : 'Goal'}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Turn a wishlist item into a funded goal, so saving for it is deliberate. */
export function SaveForItemModal({ item, incomes = [], onConfirm, onClose }) {
  const [perCycle, setPerCycle] = useState('');
  const [incomeId, setIncomeId] = useState(incomes[0]?.id ? String(incomes[0].id) : '');

  const price = roundMoney(item?.price);
  const perCycleValue = parseFloat(perCycle) || 0;
  const cycles = perCycleValue > 0 ? Math.ceil(price / perCycleValue) : null;
  const linkedIncome = incomes.find(entry => String(entry.id) === String(incomeId));
  const cycleNoun = linkedIncome ? (FREQ_NOUN[getIncomeFrequency(linkedIncome)] || 'month') : 'month';

  return (
    <Modal title={`Save for ${item?.name || 'this'}`} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.6 }}>
          Creates a goal for {fmt(price)}. The wishlist can only tell you when
          something becomes affordable; a goal actually sets the money aside.
        </p>

        <Field label="Set aside each payday (£)">
          {id => (
            <input id={id} className="glass-input" type="number" min="0" step="0.01" placeholder="0.00"
              value={perCycle} onChange={e => setPerCycle(e.target.value)} autoFocus />
          )}
        </Field>

        {incomes.length > 0 && perCycleValue > 0 && (
          <Field label="From which income">
            {id => (
              <select id={id} className="glass-input" value={incomeId} onChange={e => setIncomeId(e.target.value)}>
                {incomes.map(income => <option key={income.id} value={income.id}>{income.name}</option>)}
              </select>
            )}
          </Field>
        )}

        {cycles != null && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', background: 'rgba(255,255,255,0.04)', borderRadius: 8, padding: '9px 12px' }}>
            About {cycles} {cycles === 1 ? cycleNoun : `× ${cycleNoun}`} to save {fmt(price)}.
          </div>
        )}

        <div className="modal-actions" style={{ display: 'flex', gap: 10, marginTop: 6 }}>
          <button className="btn-secondary" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
          <button className="btn-primary" style={{ flex: 2 }}
            onClick={() => {
              onConfirm({
                name: item.name,
                kind: 'saving',
                target: price,
                perCycleContribution: perCycleValue,
                incomeId: perCycleValue > 0 && incomeId ? Number(incomeId) : null,
                wishlistItemId: item.id,
              });
              onClose();
            }}>
            Create Goal
          </button>
        </div>
      </div>
    </Modal>
  );
}
