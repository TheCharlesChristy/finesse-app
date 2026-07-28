import { useState, useMemo, useEffect } from 'react';
import { Modal, Field } from '../ui';
import {
  evaluateFormula,
  formatPacedAllowancePeriod,
  fmt,
  getIncomeCycleDays,
  getPacedAllowanceMonthlyTotal,
  normalizeIncomeAllocations,
  roundMoney,
} from '../../utils';
import {
  ColourPicker,
  FormulaInput,
  INCOME_CYCLE_LABELS,
  IncomeAllocationEditor,
  PALETTE,
  getActiveToken,
  getAllocationValidation,
  getLinkedCycleFreq,
  isFormulaInput,
  makeAutoIncomeAllocations,
} from './shared';

// ── Add Category Modal ───────────────────────────────────────────────────────
export function AddCategoryModal({ onAdd, onClose, variables = [], categories = [], incomes = [] }) {
  const [name, setName] = useState('');
  const [allowanceInput, setAllowanceInput] = useState('');
  const [pacedAllowanceEnabled, setPacedAllowanceEnabled] = useState(false);
  const [pacedAllowanceAmount, setPacedAllowanceAmount] = useState('');
  const [pacedAllowanceInterval, setPacedAllowanceInterval] = useState('1');
  const [pacedAllowanceUnit, setPacedAllowanceUnit] = useState('day');
  const [color, setColor] = useState(PALETTE[0]);
  const [incomeAllocations, setIncomeAllocations] = useState(() => makeAutoIncomeAllocations(0, incomes, categories));
  const [allocTouched, setAllocTouched] = useState(false);

  const incomeCycleFreq = useMemo(
    () => getLinkedCycleFreq(incomeAllocations, incomes),
    [incomeAllocations, incomes],
  );
  const incomeCycleDays  = incomeCycleFreq ? getIncomeCycleDays(incomeCycleFreq) : null;
  const incomeCycleLabel = INCOME_CYCLE_LABELS[incomeCycleFreq] ?? 'month';

  const isFormula = !pacedAllowanceEnabled && isFormulaInput(allowanceInput);
  const pacedMonthlyAllowance = getPacedAllowanceMonthlyTotal(
    parseFloat(pacedAllowanceAmount) || 0,
    pacedAllowanceInterval,
    pacedAllowanceUnit,
    undefined,
    incomeCycleDays,
  );
  const pacedPeriodLabel = formatPacedAllowancePeriod(pacedAllowanceInterval, pacedAllowanceUnit);
  const formulaResult = useMemo(
    () => isFormula ? evaluateFormula(allowanceInput, variables, categories, incomes) : null,
    [allowanceInput, isFormula, variables, categories, incomes]
  );
  const allowanceValue = pacedAllowanceEnabled ? pacedMonthlyAllowance : isFormula ? (formulaResult ?? 0) : (parseFloat(allowanceInput) || 0);
  const allocationValidation = useMemo(
    () => getAllocationValidation(allowanceValue, incomeAllocations, incomes, categories),
    [allowanceValue, incomeAllocations, incomes, categories]
  );

  useEffect(() => {
    if (allocTouched) return;
    setIncomeAllocations(makeAutoIncomeAllocations(allowanceValue, incomes, categories));
  }, [allocTouched, allowanceValue, incomes, categories]);

  const handleAllocationChange = (next) => {
    setAllocTouched(true);
    setIncomeAllocations(next);
  };

  const handleAutoAllocate = () => {
    setAllocTouched(true);
    setIncomeAllocations(makeAutoIncomeAllocations(allowanceValue, incomes, categories));
  };

  const handleSubmit = () => {
    if (!name.trim()) return;
    if (pacedAllowanceEnabled && !(parseFloat(pacedAllowanceAmount) > 0)) return;
    if (!pacedAllowanceEnabled && !allowanceInput) return;
    if (isFormula && formulaResult === null) return;
    if (!allocationValidation.isValid) return;
    const numericValue = pacedAllowanceEnabled ? pacedMonthlyAllowance : isFormula ? formulaResult : (parseFloat(allowanceInput) || 0);
    onAdd({
      name: name.trim(),
      allowance: numericValue,
      allowanceFormula: pacedAllowanceEnabled ? null : isFormula ? allowanceInput : null,
      incomeAllocations: normalizeIncomeAllocations(incomeAllocations),
      pacedAllowanceEnabled,
      pacedAllowanceAmount: pacedAllowanceEnabled ? roundMoney(pacedAllowanceAmount) : null,
      pacedAllowanceInterval: pacedAllowanceEnabled ? Math.max(1, parseInt(pacedAllowanceInterval) || 1) : null,
      pacedAllowanceUnit: pacedAllowanceEnabled ? pacedAllowanceUnit : null,
      dailyAllowanceEnabled: false,
      dailyAllowanceAmount: null,
      resetFrequency: null,
      payDayOfMonth: null,
      lastReset: new Date().toISOString(),
      color,
    });
    onClose();
  };

  return (
    <Modal title="Add Category" onClose={onClose}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Field label="Name">
            {id => (
              <input id={id} className="glass-input" placeholder="e.g. Groceries" value={name}
                onChange={e => setName(e.target.value)} autoFocus />
            )}
          </Field>
          <div>
            <div className="field-label">Allowance Type</div>
            <div className="mobile-stack" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
              <button type="button" className={!pacedAllowanceEnabled ? 'btn-primary' : 'btn-secondary'}
                onClick={() => setPacedAllowanceEnabled(false)} style={{ padding: '8px 10px', fontSize: 12 }}>
                Monthly Total
              </button>
              <button type="button" className={pacedAllowanceEnabled ? 'btn-primary' : 'btn-secondary'}
                onClick={() => setPacedAllowanceEnabled(true)} style={{ padding: '8px 10px', fontSize: 12 }}>
                Repeating Amount
              </button>
            </div>
            {pacedAllowanceEnabled ? (
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>I can spend</label>
                <div className="mobile-stack" style={{ display: 'grid', gridTemplateColumns: '1fr 86px 1fr', gap: 8 }}>
                  <input className="glass-input" type="number" min="0" step="0.01" placeholder="15.00" value={pacedAllowanceAmount}
                    onChange={e => setPacedAllowanceAmount(e.target.value)} />
                  <input className="glass-input" type="number" min="1" step="1" value={pacedAllowanceInterval}
                    onChange={e => setPacedAllowanceInterval(e.target.value)} />
                  <select className="glass-input" value={pacedAllowanceUnit} onChange={e => setPacedAllowanceUnit(e.target.value)}>
                    <option value="day">Day(s)</option>
                    <option value="week">Week(s)</option>
                    <option value="month">Month(s)</option>
                  </select>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
                  {fmt(parseFloat(pacedAllowanceAmount) || 0)} every {pacedPeriodLabel}
                  {' · '}
                  per {incomeCycleLabel}: <span style={{ color: 'var(--text-secondary)', fontWeight: 700 }}>{fmt(pacedMonthlyAllowance)}</span>
                </div>
              </div>
            ) : (
              <>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Allowance (£) or Formula</label>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, lineHeight: 1.5 }}>
                  Plain number, or type{' '}
                  <span style={{ color: 'var(--accent-mint)', fontFamily: 'monospace' }}>$</span> for variables,{' '}
                  <span style={{ color: 'var(--accent-blue)', fontFamily: 'monospace' }}>[</span> for categories,{' '}
                  <span style={{ color: 'var(--accent-purple)', fontFamily: 'monospace' }}>{'{' }</span> for incomes — autocomplete will appear.
                </div>
                <FormulaInput
                  value={allowanceInput}
                  onChange={setAllowanceInput}
                  onKeyDown={e => { if (e.key === 'Enter' && !getActiveToken(allowanceInput)) handleSubmit(); }}
                  placeholder="e.g. 300  or  $salary * 0.2  or  {Salary} * 0.3  or  [Groceries] * 0.1"
                  variables={variables}
                  categories={categories}
                  incomes={incomes}
                />
                {allowanceInput && isFormula && (
                  <div style={{ fontSize: 12, marginTop: 5, color: formulaResult !== null ? 'var(--good)' : 'var(--danger)' }}>
                    {formulaResult !== null ? `= ${fmt(formulaResult)}` : 'Invalid formula'}
                  </div>
                )}
              </>
            )}
          </div>
          <IncomeAllocationEditor
            allowance={allowanceValue}
            allocations={incomeAllocations}
            onChange={handleAllocationChange}
            incomes={incomes}
            categories={categories}
            onAutoAllocate={handleAutoAllocate}
          />
          <ColourPicker color={color} onChange={setColor} />
          <div className="modal-actions" style={{ display: 'flex', gap: 10, marginTop: 6 }}>
            <button className="btn-secondary" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
            <button className="btn-primary" onClick={handleSubmit} style={{ flex: 2 }}
              disabled={!name.trim() || (pacedAllowanceEnabled ? !(parseFloat(pacedAllowanceAmount) > 0) : !allowanceInput) || (isFormula && formulaResult === null) || !allocationValidation.isValid}>
              Add Category
            </button>
          </div>
        </div>
    </Modal>
  );
}

// ── Edit Category Modal ───────────────────────────────────────────────────────
export function EditCategoryModal({ category, onSave, onClose, variables = [], categories = [], incomes = [] }) {
  const [name, setName] = useState(category.name || '');
  const [allowanceInput, setAllowanceInput] = useState(category.allowanceFormula || String(category.allowance ?? ''));
  const [pacedAllowanceEnabled, setPacedAllowanceEnabled] = useState(Boolean(category.pacedAllowanceEnabled || category.dailyAllowanceEnabled));
  const [pacedAllowanceAmount, setPacedAllowanceAmount] = useState(
    category.pacedAllowanceAmount != null ? String(category.pacedAllowanceAmount)
      : category.dailyAllowanceAmount != null ? String(category.dailyAllowanceAmount)
      : ''
  );
  const [pacedAllowanceInterval, setPacedAllowanceInterval] = useState(String(category.pacedAllowanceInterval || 1));
  const [pacedAllowanceUnit, setPacedAllowanceUnit] = useState(category.pacedAllowanceUnit || 'day');
  const [color, setColor] = useState(category.color || PALETTE[0]);
  const [incomeAllocations, setIncomeAllocations] = useState(() => (
    category.incomeAllocations?.length
      ? normalizeIncomeAllocations(category.incomeAllocations)
      : makeAutoIncomeAllocations(category.allowance || 0, incomes, categories, category.id)
  ));
  const [allocTouched, setAllocTouched] = useState(() => Boolean(category.incomeAllocations?.length));

  const incomeCycleFreq = useMemo(
    () => getLinkedCycleFreq(incomeAllocations, incomes),
    [incomeAllocations, incomes],
  );
  const incomeCycleDays  = incomeCycleFreq ? getIncomeCycleDays(incomeCycleFreq) : null;
  const incomeCycleLabel = INCOME_CYCLE_LABELS[incomeCycleFreq] ?? 'month';

  const isFormula = !pacedAllowanceEnabled && isFormulaInput(allowanceInput);
  const pacedMonthlyAllowance = getPacedAllowanceMonthlyTotal(
    parseFloat(pacedAllowanceAmount) || 0,
    pacedAllowanceInterval,
    pacedAllowanceUnit,
    undefined,
    incomeCycleDays,
  );
  const pacedPeriodLabel = formatPacedAllowancePeriod(pacedAllowanceInterval, pacedAllowanceUnit);
  const formulaResult = useMemo(
    () => isFormula ? evaluateFormula(allowanceInput, variables, categories, incomes) : null,
    [allowanceInput, isFormula, variables, categories, incomes]
  );
  const allowanceValue = pacedAllowanceEnabled ? pacedMonthlyAllowance : isFormula ? (formulaResult ?? 0) : (parseFloat(allowanceInput) || 0);
  const allocationValidation = useMemo(
    () => getAllocationValidation(allowanceValue, incomeAllocations, incomes, categories, category.id),
    [allowanceValue, incomeAllocations, incomes, categories, category.id]
  );

  useEffect(() => {
    if (allocTouched) return;
    setIncomeAllocations(makeAutoIncomeAllocations(allowanceValue, incomes, categories, category.id));
  }, [allocTouched, allowanceValue, incomes, categories, category.id]);

  const handleAllocationChange = (next) => {
    setAllocTouched(true);
    setIncomeAllocations(next);
  };

  const handleAutoAllocate = () => {
    setAllocTouched(true);
    setIncomeAllocations(makeAutoIncomeAllocations(allowanceValue, incomes, categories, category.id));
  };

  const handleSubmit = () => {
    if (!name.trim()) return;
    if (pacedAllowanceEnabled && !(parseFloat(pacedAllowanceAmount) > 0)) return;
    if (!pacedAllowanceEnabled && !allowanceInput) return;
    if (isFormula && formulaResult === null) return;
    if (!allocationValidation.isValid) return;
    const numericValue = pacedAllowanceEnabled ? pacedMonthlyAllowance : isFormula ? formulaResult : (parseFloat(allowanceInput) || 0);
    onSave(category.id, {
      name: name.trim(),
      allowance: numericValue,
      allowanceFormula: pacedAllowanceEnabled ? null : isFormula ? allowanceInput : null,
      incomeAllocations: normalizeIncomeAllocations(incomeAllocations),
      pacedAllowanceEnabled,
      pacedAllowanceAmount: pacedAllowanceEnabled ? roundMoney(pacedAllowanceAmount) : null,
      pacedAllowanceInterval: pacedAllowanceEnabled ? Math.max(1, parseInt(pacedAllowanceInterval) || 1) : null,
      pacedAllowanceUnit: pacedAllowanceEnabled ? pacedAllowanceUnit : null,
      dailyAllowanceEnabled: false,
      dailyAllowanceAmount: null,
      resetFrequency: null,
      payDayOfMonth: null,
      color,
    });
    onClose();
  };

  return (
    <Modal title="Edit Category" onClose={onClose}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Field label="Name">
            {id => <input id={id} className="glass-input" value={name} onChange={e => setName(e.target.value)} autoFocus />}
          </Field>
          <div>
            <div className="field-label">Allowance Type</div>
            <div className="mobile-stack" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
              <button type="button" className={!pacedAllowanceEnabled ? 'btn-primary' : 'btn-secondary'}
                onClick={() => setPacedAllowanceEnabled(false)} style={{ padding: '8px 10px', fontSize: 12 }}>
                Monthly Total
              </button>
              <button type="button" className={pacedAllowanceEnabled ? 'btn-primary' : 'btn-secondary'}
                onClick={() => setPacedAllowanceEnabled(true)} style={{ padding: '8px 10px', fontSize: 12 }}>
                Repeating Amount
              </button>
            </div>
            {pacedAllowanceEnabled ? (
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>I can spend</label>
                <div className="mobile-stack" style={{ display: 'grid', gridTemplateColumns: '1fr 86px 1fr', gap: 8 }}>
                  <input className="glass-input" type="number" min="0" step="0.01" placeholder="15.00" value={pacedAllowanceAmount}
                    onChange={e => setPacedAllowanceAmount(e.target.value)} />
                  <input className="glass-input" type="number" min="1" step="1" value={pacedAllowanceInterval}
                    onChange={e => setPacedAllowanceInterval(e.target.value)} />
                  <select className="glass-input" value={pacedAllowanceUnit} onChange={e => setPacedAllowanceUnit(e.target.value)}>
                    <option value="day">Day(s)</option>
                    <option value="week">Week(s)</option>
                    <option value="month">Month(s)</option>
                  </select>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
                  {fmt(parseFloat(pacedAllowanceAmount) || 0)} every {pacedPeriodLabel}
                  {' · '}
                  per {incomeCycleLabel}: <span style={{ color: 'var(--text-secondary)', fontWeight: 700 }}>{fmt(pacedMonthlyAllowance)}</span>
                </div>
              </div>
            ) : (
              <>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Allowance (£) or Formula</label>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, lineHeight: 1.5 }}>
                  Plain number, or type{' '}
                  <span style={{ color: 'var(--accent-mint)', fontFamily: 'monospace' }}>$</span> for variables,{' '}
                  <span style={{ color: 'var(--accent-blue)', fontFamily: 'monospace' }}>[</span> for categories,{' '}
                  <span style={{ color: 'var(--accent-purple)', fontFamily: 'monospace' }}>{'{' }</span> for incomes — autocomplete will appear.
                </div>
                <FormulaInput
                  value={allowanceInput}
                  onChange={setAllowanceInput}
                  onKeyDown={e => { if (e.key === 'Enter' && !getActiveToken(allowanceInput)) handleSubmit(); }}
                  placeholder="e.g. 300  or  $salary * 0.2  or  {Salary} * 0.3  or  [Groceries] * 0.1"
                  variables={variables}
                  categories={categories}
                  incomes={incomes}
                />
                {allowanceInput && isFormula && (
                  <div style={{ fontSize: 12, marginTop: 5, color: formulaResult !== null ? 'var(--good)' : 'var(--danger)' }}>
                    {formulaResult !== null ? `= ${fmt(formulaResult)}` : 'Invalid formula'}
                  </div>
                )}
              </>
            )}
          </div>
          <IncomeAllocationEditor
            allowance={allowanceValue}
            allocations={incomeAllocations}
            onChange={handleAllocationChange}
            incomes={incomes}
            categories={categories}
            excludeCategoryId={category.id}
            onAutoAllocate={handleAutoAllocate}
          />
          <ColourPicker color={color} onChange={setColor} />
          <div className="modal-actions" style={{ display: 'flex', gap: 10, marginTop: 6 }}>
            <button className="btn-secondary" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
            <button className="btn-primary" onClick={handleSubmit} style={{ flex: 2 }}
              disabled={!name.trim() || (pacedAllowanceEnabled ? !(parseFloat(pacedAllowanceAmount) > 0) : !allowanceInput) || (isFormula && formulaResult === null) || !allocationValidation.isValid}>
              Save Changes
            </button>
          </div>
        </div>
    </Modal>
  );
}
