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
  const [rolloverEnabled, setRolloverEnabled] = useState(false);
  const [rolloverCarryOverspend, setRolloverCarryOverspend] = useState(false);
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
  // Deliberate: allocations are derived from the allowance, but for a paced
  // category the allowance itself depends on the cycle length of the incomes
  // those allocations point at. That circle can't be resolved during a single
  // render, so this settles it after one — which is what the rule flags.
  // Converges because it only writes while the user hasn't touched the split.
  // eslint-disable-next-line react-hooks/set-state-in-effect
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
      rolloverEnabled,
      rolloverCarryOverspend,
      rolloverBalance: 0,
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
          {/* Rollover — opt-in, because most people want a clean slate each
              cycle and would be confused by a budget that quietly grows. */}
          <div style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 12, padding: '12px 14px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={rolloverEnabled} onChange={e => setRolloverEnabled(e.target.checked)} />
              Roll unspent budget into next cycle
            </label>
            {rolloverEnabled && (
              <>
                <label style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer', marginTop: 10, paddingLeft: 2 }}>
                  <input type="checkbox" checked={rolloverCarryOverspend} onChange={e => setRolloverCarryOverspend(e.target.checked)} />
                  Also carry overspend forward as a debt
                </label>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.6 }}>
                  Whatever is left when this category resets is added to the next
                  cycle&rsquo;s budget. Temporary top-ups are not carried — they
                  belong to one cycle only.
                </div>
              </>
            )}
          </div>
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
  const [rolloverEnabled, setRolloverEnabled] = useState(Boolean(category.rolloverEnabled));
  const [rolloverCarryOverspend, setRolloverCarryOverspend] = useState(Boolean(category.rolloverCarryOverspend));
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
  // Deliberate: allocations are derived from the allowance, but for a paced
  // category the allowance itself depends on the cycle length of the incomes
  // those allocations point at. That circle can't be resolved during a single
  // render, so this settles it after one — which is what the rule flags.
  // Converges because it only writes while the user hasn't touched the split.
  // eslint-disable-next-line react-hooks/set-state-in-effect
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
      rolloverEnabled,
      rolloverCarryOverspend,
      // Turning rollover off clears any balance it had built up, rather than
      // leaving invisible budget attached to the category.
      ...(rolloverEnabled ? {} : { rolloverBalance: 0 }),
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
          {/* Rollover — opt-in, because most people want a clean slate each
              cycle and would be confused by a budget that quietly grows. */}
          <div style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 12, padding: '12px 14px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={rolloverEnabled} onChange={e => setRolloverEnabled(e.target.checked)} />
              Roll unspent budget into next cycle
            </label>
            {rolloverEnabled && (
              <>
                <label style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer', marginTop: 10, paddingLeft: 2 }}>
                  <input type="checkbox" checked={rolloverCarryOverspend} onChange={e => setRolloverCarryOverspend(e.target.checked)} />
                  Also carry overspend forward as a debt
                </label>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.6 }}>
                  Whatever is left when this category resets is added to the next
                  cycle&rsquo;s budget. Temporary top-ups are not carried — they
                  belong to one cycle only.
                </div>
              </>
            )}
          </div>
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
