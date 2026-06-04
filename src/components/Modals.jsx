import { useState, useMemo, useRef, useEffect } from 'react';
import { Plus, Wand2, X } from 'lucide-react';
import { format } from 'date-fns';
import CategorySelect from './CategorySelect';
import DateInput from './DateInput';
import { Modal, IconButton, Field } from './ui';
import {
  dateOnlyToISO,
  evaluateFormula,
  formatPacedAllowancePeriod,
  fmt,
  getAllocationPercentTotal,
  getEffectiveAllowance,
  getIncomeCycleDays,
  getIncomeAllocationUsage,
  getPacedAllowanceMonthlyTotal,
  normalizeIncomeAllocations,
  roundMoney,
} from '../utils';

// ── Shared ────────────────────────────────────────────────────────────────────
const FREQ_OPTIONS = [
  { value: 'weekly',      label: 'Weekly' },
  { value: 'fortnightly', label: 'Fortnightly' },
  { value: '4weekly',     label: 'Every 4 Weeks' },
  { value: 'monthly',     label: 'Monthly' },
];

function FrequencyFields({ resetFrequency, setResetFrequency, payDayOfMonth, setPayDayOfMonth }) {
  return (
    <>
      <Field label="Reset Frequency">
        {id => (
          <select id={id} className="glass-input" value={resetFrequency} onChange={e => setResetFrequency(e.target.value)}>
            {FREQ_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )}
      </Field>
      {resetFrequency === 'monthly' && (
        <Field label="Pay Day of Month (1–31)">
          {id => (
            <input id={id} className="glass-input" type="number" min="1" max="31" placeholder="e.g. 25"
              value={payDayOfMonth} onChange={e => setPayDayOfMonth(e.target.value)} />
          )}
        </Field>
      )}
    </>
  );
}

const PALETTE = ['#4fffb0','#5db8ff','#c084fc','#fbbf70','#ff6b8a','#67e8f9','#f9a8d4','#86efac'];

function isFormulaInput(s) {
  return /[$\[{]/.test(s) || /[+\-*/]/.test(s.slice(1));
}

function makeAutoIncomeAllocations(allowance, incomes = [], categories = [], excludeCategoryId = null) {
  if (!incomes.length) return [];

  const budget = Number(allowance) || 0;
  if (budget <= 0) return [{ incomeId: Number(incomes[0].id), percent: 100 }];

  const usedByIncome = getIncomeAllocationUsage(incomes, categories, excludeCategoryId);
  const allocations = [];
  let remainingBudget = budget;

  for (const income of incomes) {
    const available = Math.max(0, (Number(income.amount) || 0) - (usedByIncome[String(income.id)] || 0));
    const amount = Math.min(available, remainingBudget);
    if (amount <= 0) continue;

    allocations.push({
      incomeId: Number(income.id),
      percent: roundMoney((amount / budget) * 100),
    });
    remainingBudget = roundMoney(remainingBudget - amount);
    if (remainingBudget <= 0.005) break;
  }

  if (!allocations.length) return [{ incomeId: Number(incomes[0].id), percent: 100 }];

  const total = getAllocationPercentTotal(allocations);
  allocations[allocations.length - 1].percent = roundMoney(allocations[allocations.length - 1].percent + (100 - total));
  return normalizeIncomeAllocations(allocations);
}

function getAllocationValidation(allowance, allocations, incomes = [], categories = [], excludeCategoryId = null) {
  const cleanAllocations = normalizeIncomeAllocations(allocations);
  const percentTotal = getAllocationPercentTotal(cleanAllocations);
  const incomeMap = new Map(incomes.map(income => [Number(income.id), income]));
  const usedByIncome = getIncomeAllocationUsage(incomes, categories, excludeCategoryId);
  const capacityIssues = [];

  for (const allocation of cleanAllocations) {
    const income = incomeMap.get(allocation.incomeId);
    if (!income) {
      capacityIssues.push({ name: 'Missing income', over: 0 });
      continue;
    }

    const allocatedAmount = roundMoney((Number(allowance) || 0) * allocation.percent / 100);
    const available = roundMoney((Number(income.amount) || 0) - (usedByIncome[String(income.id)] || 0));
    if (allocatedAmount > available + 0.005) {
      capacityIssues.push({ name: income.name, over: roundMoney(allocatedAmount - available) });
    }
  }

  return {
    percentTotal,
    capacityIssues,
    isFullyCovered: Math.abs(percentTotal - 100) <= 0.01,
    isValid: incomes.length > 0 && Math.abs(percentTotal - 100) <= 0.01 && capacityIssues.length === 0,
  };
}

function IncomeAllocationEditor({
  allowance,
  allocations,
  onChange,
  incomes,
  categories,
  excludeCategoryId = null,
  onAutoAllocate,
}) {
  const [sourceToAdd, setSourceToAdd] = useState('');

  const cleanAllocations = useMemo(() => normalizeIncomeAllocations(allocations), [allocations]);
  const incomeMap = useMemo(() => new Map(incomes.map(income => [Number(income.id), income])), [incomes]);
  const selectedIncomeIds = useMemo(
    () => new Set(cleanAllocations.map(allocation => allocation.incomeId)),
    [cleanAllocations]
  );
  const availableIncomeOptions = useMemo(
    () => incomes.filter(income => !selectedIncomeIds.has(Number(income.id))),
    [incomes, selectedIncomeIds]
  );
  const usedByIncome = useMemo(
    () => getIncomeAllocationUsage(incomes, categories, excludeCategoryId),
    [incomes, categories, excludeCategoryId]
  );
  const validation = useMemo(
    () => getAllocationValidation(allowance, cleanAllocations, incomes, categories, excludeCategoryId),
    [allowance, cleanAllocations, incomes, categories, excludeCategoryId]
  );

  useEffect(() => {
    if (!availableIncomeOptions.length) {
      setSourceToAdd('');
      return;
    }

    if (!sourceToAdd || !availableIncomeOptions.some(income => String(income.id) === sourceToAdd)) {
      setSourceToAdd(String(availableIncomeOptions[0].id));
    }
  }, [availableIncomeOptions, sourceToAdd]);

  const setPercent = (incomeId, rawValue) => {
    const parsed = rawValue === '' ? 0 : Number(rawValue);
    const percent = Math.min(100, Math.max(0, Number.isFinite(parsed) ? parsed : 0));
    const next = cleanAllocations
      .filter(allocation => allocation.incomeId !== Number(incomeId))
      .concat(percent > 0 ? [{ incomeId: Number(incomeId), percent }] : []);
    onChange(normalizeIncomeAllocations(next));
  };

  const addSource = () => {
    const incomeId = Number(sourceToAdd || availableIncomeOptions[0]?.id);
    if (!incomeId) return;
    const remaining = roundMoney(100 - validation.percentTotal);
    const percent = remaining > 0 ? Math.min(100, remaining) : 1;
    onChange(normalizeIncomeAllocations([...cleanAllocations, { incomeId, percent }]));
  };

  const removeSource = (incomeId) => {
    onChange(cleanAllocations.filter(allocation => allocation.incomeId !== Number(incomeId)));
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>Funded By</label>
        <button type="button" className="btn-secondary" onClick={onAutoAllocate}
          disabled={!incomes.length}
          style={{ padding: '5px 10px', fontSize: 11, borderRadius: 8, display: 'flex', alignItems: 'center', gap: 5 }}>
          <Wand2 size={12} /> Auto
        </button>
      </div>

      {incomes.length === 0 ? (
        <div className="status-danger" style={{ borderRadius: 10, padding: '10px 12px', fontSize: 12 }}>
          Add an income before creating categories.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div>
            <div className="progress-track" style={{ height: 7, display: 'flex' }}>
              {cleanAllocations.map((allocation, idx) => {
                const income = incomeMap.get(allocation.incomeId);
                return (
                  <div
                    key={allocation.incomeId}
                    title={`${income?.name || 'Missing income'}: ${allocation.percent}%`}
                    style={{
                      width: `${Math.min(100, Math.max(0, allocation.percent))}%`,
                      background: PALETTE[idx % PALETTE.length],
                      height: '100%',
                      minWidth: allocation.percent > 0 ? 2 : 0,
                    }}
                  />
                );
              })}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12, marginTop: 5 }}>
              <span style={{ color: validation.isFullyCovered ? 'var(--good)' : 'var(--danger)', fontWeight: 600 }}>
                {validation.percentTotal.toFixed(2).replace(/\.00$/, '')}% covered
              </span>
              <span style={{ color: 'var(--text-muted)' }}>
                {cleanAllocations.length} source{cleanAllocations.length === 1 ? '' : 's'}
              </span>
            </div>
          </div>

          {cleanAllocations.length === 0 ? (
            <div style={{
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 10,
              padding: '10px 12px',
              color: 'var(--text-muted)',
              fontSize: 12,
            }}>
              No funding sources selected.
            </div>
          ) : (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              maxHeight: cleanAllocations.length > 4 ? 228 : 'none',
              overflowY: cleanAllocations.length > 4 ? 'auto' : 'visible',
              paddingRight: cleanAllocations.length > 4 ? 4 : 0,
            }}>
              {cleanAllocations.map(allocation => {
                const income = incomeMap.get(allocation.incomeId);
                const percent = allocation.percent;
                const incomeAmount = Number(income?.amount) || 0;
                const incomeName = income?.name || 'Missing income';
                const alreadyUsed = usedByIncome[String(allocation.incomeId)] || 0;
                const thisAmount = roundMoney((Number(allowance) || 0) * percent / 100);
                const afterAllocation = roundMoney(alreadyUsed + thisAmount);
                const remainingAfter = roundMoney(incomeAmount - afterAllocation);
                const over = Math.max(0, roundMoney(afterAllocation - incomeAmount));
                const usedPct = incomeAmount > 0 ? Math.min(100, (afterAllocation / incomeAmount) * 100) : 0;

                return (
                  <div key={allocation.incomeId} style={{
                    background: 'rgba(255,255,255,0.04)',
                    border: `1px solid ${over > 0 || !income ? 'rgba(255,107,138,0.35)' : 'rgba(255,255,255,0.08)'}`,
                    borderRadius: 10,
                    padding: '10px 12px',
                  }}>
                    <div className="mobile-stack" style={{ display: 'grid', gridTemplateColumns: '1fr 82px 76px 30px', alignItems: 'center', gap: 10 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {incomeName}
                        </div>
                        <div style={{ fontSize: 11, color: over > 0 || !income ? 'var(--danger)' : 'var(--text-muted)', marginTop: 2 }}>
                          {!income ? 'No longer available' : over > 0 ? `${fmt(over)} over` : `${fmt(remainingAfter)} left`}
                        </div>
                      </div>
                      <div style={{ position: 'relative' }}>
                        <input
                          className="glass-input"
                          type="number"
                          min="0"
                          max="100"
                          step="0.01"
                          value={percent}
                          aria-label={`${incomeName} funding percentage`}
                          onChange={e => setPercent(allocation.incomeId, e.target.value)}
                          style={{ padding: '8px 24px 8px 10px', fontSize: 13 }}
                        />
                        <span style={{ position: 'absolute', right: 9, top: '50%', transform: 'translateY(-50%)', fontSize: 11, color: 'var(--text-muted)' }}>%</span>
                      </div>
                      <div className="mobile-center-left" style={{ fontSize: 12, textAlign: 'right', color: 'var(--text-secondary)', fontWeight: 600 }}>
                        {fmt(thisAmount)}
                      </div>
                      <IconButton onClick={() => removeSource(allocation.incomeId)}
                        label={`Remove ${incomeName} as a funding source`} size={28}>
                        <X size={12} />
                      </IconButton>
                    </div>
                    <div className="progress-track" style={{ height: 4, marginTop: 8 }}>
                      <div className="progress-fill" style={{ width: `${usedPct}%`, background: over > 0 ? 'var(--danger)' : 'var(--accent-mint)' }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {availableIncomeOptions.length > 0 && (
            <div className="mobile-stack" style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center' }}>
              <select className="glass-input" value={sourceToAdd} onChange={e => setSourceToAdd(e.target.value)}
                aria-label="Funding source to add"
                style={{ padding: '8px 10px', fontSize: 13 }}>
                {availableIncomeOptions.map(income => {
                  const available = roundMoney((Number(income.amount) || 0) - (usedByIncome[String(income.id)] || 0));
                  return (
                    <option key={income.id} value={income.id}>
                      {income.name} · {fmt(available)} free
                    </option>
                  );
                })}
              </select>
              <button type="button" className="btn-secondary" onClick={addSource}
                style={{ padding: '8px 12px', fontSize: 12, borderRadius: 9, display: 'flex', alignItems: 'center', gap: 5 }}>
                <Plus size={12} /> Add
              </button>
            </div>
          )}

          {validation.capacityIssues.length > 0 && (
            <div style={{ color: 'var(--danger)', fontSize: 12 }}>
              {validation.capacityIssues.map(issue => issue.over > 0 ? `${issue.name} +${fmt(issue.over)}` : issue.name).join(', ')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Returns the currently-being-typed token (variable, category, or income reference)
function getActiveToken(value) {
  const candidates = [];

  const lastBrace = value.lastIndexOf('{');
  if (lastBrace !== -1 && !value.slice(lastBrace + 1).includes('}')) {
    candidates.push({ type: 'income', partial: value.slice(lastBrace + 1), triggerPos: lastBrace });
  }

  const lastBracket = value.lastIndexOf('[');
  if (lastBracket !== -1 && !value.slice(lastBracket + 1).includes(']')) {
    candidates.push({ type: 'cat', partial: value.slice(lastBracket + 1), triggerPos: lastBracket });
  }

  const lastDollar = value.lastIndexOf('$');
  if (lastDollar !== -1) {
    const afterDollar = value.slice(lastDollar + 1);
    if (/^[a-zA-Z0-9_]*$/.test(afterDollar)) {
      candidates.push({ type: 'var', partial: afterDollar, triggerPos: lastDollar });
    }
  }

  if (!candidates.length) return null;
  return candidates.reduce((a, b) => (a.triggerPos > b.triggerPos ? a : b));
}

// Formula input with inline autocomplete dropdown
function FormulaInput({ value, onChange, onKeyDown: externalKeyDown, placeholder, variables, categories, incomes }) {
  const [activeIdx, setActiveIdx] = useState(0);
  const [showDropdown, setShowDropdown] = useState(false);
  const inputRef = useRef(null);

  const token = useMemo(() => getActiveToken(value), [value]);

  const suggestions = useMemo(() => {
    if (!token) return [];
    const p = token.partial.toLowerCase();
    if (token.type === 'var')    return variables.filter(v => v.name.toLowerCase().startsWith(p)).slice(0, 8);
    if (token.type === 'cat')    return categories.filter(c => !c.allowanceFormula && c.name.toLowerCase().startsWith(p)).slice(0, 8);
    if (token.type === 'income') return incomes.filter(i => i.name.toLowerCase().startsWith(p)).slice(0, 8);
    return [];
  }, [token, variables, categories, incomes]);

  useEffect(() => { setActiveIdx(0); }, [suggestions]);
  useEffect(() => { setShowDropdown(token !== null && suggestions.length > 0); }, [token, suggestions.length]);

  const complete = (item) => {
    if (!token) return;
    const before = value.slice(0, token.triggerPos + 1);
    const suffix = token.type === 'var' ? item.name
      : token.type === 'cat' ? item.name + ']'
      : item.name + '}';
    onChange(before + suffix);
    setShowDropdown(false);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleKeyDown = (e) => {
    if (showDropdown && suggestions.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, suggestions.length - 1)); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); return; }
      if (e.key === 'Tab' || (e.key === 'Enter')) {
        if (suggestions[activeIdx]) { e.preventDefault(); complete(suggestions[activeIdx]); return; }
      }
      if (e.key === 'Escape') { e.preventDefault(); setShowDropdown(false); return; }
    }
    externalKeyDown?.(e);
  };

  const typeColor = token?.type === 'var' ? 'var(--accent-mint)' : token?.type === 'cat' ? 'var(--accent-blue)' : 'var(--accent-purple)';
  const typeBg    = token?.type === 'var' ? 'rgba(79,255,176,0.12)' : token?.type === 'cat' ? 'rgba(93,184,255,0.12)' : 'rgba(192,132,252,0.12)';
  const typeLabel = token?.type === 'var' ? '$var' : token?.type === 'cat' ? '[cat]' : '{income}';

  return (
    <div style={{ position: 'relative' }}>
      <input
        ref={inputRef}
        className="glass-input"
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        autoComplete="off"
      />
      {showDropdown && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 200,
          background: 'rgba(8,12,28,0.97)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 10, backdropFilter: 'blur(24px)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          overflow: 'hidden',
        }}>
          {suggestions.map((item, idx) => (
            <div
              key={item.id ?? item.name}
              onMouseDown={e => { e.preventDefault(); complete(item); }}
              onMouseEnter={() => setActiveIdx(idx)}
              style={{
                padding: '9px 14px', cursor: 'pointer', fontSize: 13,
                background: idx === activeIdx ? 'rgba(255,255,255,0.07)' : 'transparent',
                display: 'flex', alignItems: 'center', gap: 8,
                borderBottom: idx < suggestions.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none',
              }}
            >
              <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 8, fontWeight: 600, fontFamily: 'monospace', background: typeBg, color: typeColor }}>
                {typeLabel}
              </span>
              <span style={{ flex: 1 }}>{item.name}</span>
              {token?.type !== 'var' && (
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {fmt(token?.type === 'cat' ? (item.allowance ?? 0) : (item.amount ?? 0))}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

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

// ── Add Wishlist Item Modal ───────────────────────────────────────────────────
// Depth-first flat list of all wishlist categories, for the select dropdown
function flattenWishlistCategories(cats, parentId = null, depth = 0) {
  return cats
    .filter(c => (c.parentId ?? null) === parentId)
    .flatMap(c => [{ ...c, depth }, ...flattenWishlistCategories(cats, c.id, depth + 1)]);
}

export function AddWishlistItemModal({ expenseCategories, wishlistCategories, onAdd, onClose, defaultCategoryId = null, item = null, onSave }) {
  const [name, setName] = useState(item?.name || '');
  const [price, setPrice] = useState(item?.price != null ? String(item.price) : '');
  const [note, setNote] = useState(item?.note || '');
  const [link, setLink] = useState(item?.link || '');
  const [wishCatId, setWishCatId] = useState(
    item?.wishlistCategoryId != null ? String(item.wishlistCategoryId)
      : defaultCategoryId != null ? String(defaultCategoryId)
      : ''
  );
  const isEditing = Boolean(item);

  const flatLists = useMemo(() => flattenWishlistCategories(wishlistCategories), [wishlistCategories]);
  const [selectedExpCats, setSelectedExpCats] = useState(item?.categoryIds || []);

  const toggleExpCat = (id) => {
    setSelectedExpCats(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const handleSubmit = () => {
    if (!name.trim() || !price) return;
    const data = {
      name: name.trim(),
      price: parseFloat(price),
      note: note.trim(),
      link: link.trim() || null,
      wishlistCategoryId: wishCatId ? Number(wishCatId) : null,
      categoryIds: selectedExpCats,
    };
    if (isEditing && onSave) {
      onSave(item.id, data);
    } else {
      onAdd(data);
    }
    onClose();
  };

  return (
    <Modal title={isEditing ? 'Edit Wishlist Item' : 'Add to Wishlist'} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Item Name">
          {id => (
            <input id={id} className="glass-input" placeholder="e.g. New trainers" value={name}
              onChange={e => setName(e.target.value)} autoFocus />
          )}
        </Field>
        <Field label="Price (£)">
          {id => (
            <input id={id} className="glass-input" type="number" min="0" step="0.01" placeholder="0.00" value={price}
              onChange={e => setPrice(e.target.value)} />
          )}
        </Field>
        {wishlistCategories.length > 0 && (
          <Field label="Add to List">
            {id => (
              <select id={id} className="glass-input" value={wishCatId} onChange={e => setWishCatId(e.target.value)}>
                <option value="">No list (uncategorised)</option>
                {flatLists.map(l => (
                  <option key={l.id} value={l.id}>
                    {'—'.repeat(l.depth)}{l.depth > 0 ? ' ' : ''}{l.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        <div role="group" aria-label="Budget categories for affordability">
          <div className="field-label" style={{ marginBottom: 8 }}>Budget Categories for Affordability</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            {expenseCategories.map(cat => {
              const selected = selectedExpCats.includes(cat.id);
              return (
                <button key={cat.id} type="button" className="toggle-chip" onClick={() => toggleExpCat(cat.id)}
                  aria-pressed={selected} style={{
                  padding: '5px 12px', borderRadius: 20, fontSize: 12, cursor: 'pointer',
                  background: selected ? cat.color + '30' : 'rgba(255,255,255,0.06)',
                  border: `1px solid ${selected ? cat.color + '60' : 'rgba(255,255,255,0.1)'}`,
                  color: selected ? 'var(--text-primary)' : 'var(--text-secondary)',
                  transition: 'all 0.15s',
                  display: 'flex', alignItems: 'center', gap: 5
                }}>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: cat.color || 'var(--accent-blue)' }} />
                  {cat.name}
                </button>
              );
            })}
            {expenseCategories.length === 0 && (
              <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Add expense categories first.</div>
            )}
          </div>
        </div>
        <Field label="Link (optional)">
          {id => (
            <input id={id} className="glass-input" type="url" placeholder="https://…" value={link}
              onChange={e => setLink(e.target.value)} />
          )}
        </Field>
        <Field label="Note (optional)">
          {id => (
            <input id={id} className="glass-input" placeholder="Any details…" value={note}
              onChange={e => setNote(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSubmit()} />
          )}
        </Field>
        <div className="modal-actions" style={{ display: 'flex', gap: 10, marginTop: 6 }}>
          <button className="btn-secondary" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
          <button className="btn-primary" onClick={handleSubmit} style={{ flex: 2 }}
            disabled={!name.trim() || !price}>
            {isEditing ? 'Save Changes' : 'Add to Wishlist'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function collectDescendantIds(cats, id, acc = new Set()) {
  for (const child of cats.filter(c => c.parentId === id)) {
    acc.add(child.id);
    collectDescendantIds(cats, child.id, acc);
  }
  return acc;
}

export function EditWishlistListModal({ list, wishlistCategories, onSave, onClose }) {
  const [name, setName] = useState(list.name || '');
  const [color, setColor] = useState(list.color || PALETTE[0]);
  const [parentId, setParentId] = useState(list.parentId != null ? String(list.parentId) : '');

  const blockedIds = useMemo(() => collectDescendantIds(wishlistCategories, list.id).add(list.id), [wishlistCategories, list.id]);
  const parentOptions = useMemo(
    () => flattenWishlistCategories(wishlistCategories).filter(cat => !blockedIds.has(cat.id)),
    [wishlistCategories, blockedIds]
  );

  const handleSubmit = () => {
    if (!name.trim()) return;
    onSave(list.id, {
      name: name.trim(),
      color,
      parentId: parentId ? Number(parentId) : null,
    });
    onClose();
  };

  return (
    <Modal title="Edit List" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Name">
          {id => <input id={id} className="glass-input" value={name} onChange={e => setName(e.target.value)} autoFocus />}
        </Field>
        <Field label="Parent List">
          {id => (
            <select id={id} className="glass-input" value={parentId} onChange={e => setParentId(e.target.value)}>
              <option value="">Top level</option>
              {parentOptions.map(cat => (
                <option key={cat.id} value={cat.id}>
                  {'-'.repeat(cat.depth)}{cat.depth > 0 ? ' ' : ''}{cat.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <ColourPicker color={color} onChange={setColor} />
        <div className="modal-actions" style={{ display: 'flex', gap: 10, marginTop: 6 }}>
          <button className="btn-secondary" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
          <button className="btn-primary" onClick={handleSubmit} style={{ flex: 2 }} disabled={!name.trim()}>
            Save Changes
          </button>
        </div>
      </div>
    </Modal>
  );
}

// Shared accessible colour picker
function ColourPicker({ color, onChange }) {
  return (
    <div role="group" aria-label="Colour">
      <div className="field-label">Colour</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {PALETTE.map(c => (
          <button key={c} type="button" className="color-swatch" onClick={() => onChange(c)}
            aria-label={`Colour ${c}`} aria-pressed={color === c} title={c}
            style={{ background: c }} />
        ))}
      </div>
    </div>
  );
}

// ── Paced-allowance cycle helpers ─────────────────────────────────────────────

const INCOME_CYCLE_LABELS = {
  weekly: 'week',
  fortnightly: 'fortnight',
  '4weekly': '4-week cycle',
  monthly: 'month',
};

/**
 * Returns the single reset frequency shared by all linked incomes, or null if
 * the category has no allocations, missing incomes, or mixed frequencies.
 */
function getLinkedCycleFreq(incomeAllocations, incomes) {
  const allocs = normalizeIncomeAllocations(incomeAllocations);
  if (!allocs.length) return null;
  const freqs = [...new Set(
    allocs.map(a => incomes.find(i => Number(i.id) === a.incomeId)?.resetFrequency).filter(Boolean)
  )];
  return freqs.length === 1 ? freqs[0] : null;
}

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
export function AddOneOffIncomeModal({ onAdd, onClose }) {
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [note, setNote] = useState('');
  const parsedAmount = parseFloat(amount) || 0;

  const handleSubmit = () => {
    if (!name.trim() || parsedAmount <= 0 || !date) return;
    onAdd({
      name: name.trim(),
      amount: parsedAmount,
      date: dateOnlyToISO(date),
      note: note.trim(),
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

// ── Import Mode Modal ────────────────────────────────────────────────────────
export function ImportModeModal({ onConfirm, onClose }) {
  return (
    <Modal title="Import Data" subtitle="How should the imported data be handled?" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <button className="btn-primary" onClick={() => onConfirm('replace')} style={{ textAlign: 'left', padding: '14px 16px' }}>
          <div style={{ fontWeight: 600, marginBottom: 3 }}>Replace everything</div>
          <div style={{ fontSize: 12, opacity: 0.7, fontWeight: 400 }}>Clears all current data and replaces with the backup. Best for syncing from another device.</div>
        </button>
        <button className="btn-secondary" onClick={() => onConfirm('merge')} style={{ textAlign: 'left', padding: '14px 16px' }}>
          <div style={{ fontWeight: 600, marginBottom: 3 }}>Merge</div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>Adds imported items alongside existing data. May create duplicates.</div>
        </button>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

// ── Adjust Budget Modal ──────────────────────────────────────────────────────
const REMEDIATE_TABS = [
  { id: 'move',       label: 'Move Spend' },
  { id: 'unassigned', label: 'Use Unallocated' },
];

export function RemediateModal({
  categories,
  totalIncome,
  defaultCategoryId,
  onMoveSpend,
  onAddTemporaryBoost,
  onRemoveTemporaryBoost,
  onClose,
}) {
  const [tab, setTab] = useState('move');

  // Unallocated = income not assigned to any category, counting temporary
  // top-ups as allocated so the pool can't be over-committed.
  const totalAllocated = roundMoney(
    categories.reduce((s, c) => s + (c.allowance || 0) + (c.temporaryBoost || 0), 0)
  );
  const unallocated = roundMoney(totalIncome - totalAllocated);

  const firstCatId = categories[0]?.id ? String(categories[0].id) : '';
  const defaultId = defaultCategoryId ? String(defaultCategoryId) : firstCatId;

  const overspendOf = (cat) =>
    cat ? Math.max(0, roundMoney((cat.spent || 0) - getEffectiveAllowance(cat))) : 0;

  const defaultOverspend = () => {
    if (!defaultCategoryId) return '';
    const cat = categories.find(c => c.id === Number(defaultCategoryId));
    const over = overspendOf(cat);
    return over > 0 ? String(over) : '';
  };

  // Move spend state
  const [fromCatId, setFromCatId] = useState(defaultId);
  const [toCatId, setToCatId] = useState('');
  const [moveAmount, setMoveAmount] = useState(defaultOverspend);

  // Unallocated (temporary top-up) state
  const [unassignedCatId, setUnassignedCatId] = useState(defaultId);
  const [unassignedAmount, setUnassignedAmount] = useState(defaultOverspend);

  // Derived values for move spend
  const fromCat = categories.find(c => String(c.id) === fromCatId);
  const toCat = categories.find(c => String(c.id) === toCatId);
  const parsedMoveAmount = parseFloat(moveAmount) || 0;
  const toAvailable = toCat ? roundMoney(getEffectiveAllowance(toCat) - (toCat.spent || 0)) : 0;
  const fromOverspend = overspendOf(fromCat);
  const toCatOptions = categories.filter(c => String(c.id) !== fromCatId);

  // Derived values for unallocated
  const parsedUnassignedAmount = parseFloat(unassignedAmount) || 0;
  const unassignedCat = categories.find(c => String(c.id) === unassignedCatId);
  const existingBoost = roundMoney(unassignedCat?.temporaryBoost || 0);

  const titleCat = defaultCategoryId
    ? categories.find(c => c.id === Number(defaultCategoryId))
    : null;

  const handleMoveSpend = async () => {
    if (!fromCatId || !toCatId || parsedMoveAmount <= 0) return;
    await onMoveSpend(Number(fromCatId), Number(toCatId), parsedMoveAmount);
    onClose();
  };

  const handleAddBoost = async () => {
    if (!unassignedCatId || parsedUnassignedAmount <= 0) return;
    await onAddTemporaryBoost(Number(unassignedCatId), parsedUnassignedAmount);
    onClose();
  };

  const handleRemoveBoost = async () => {
    if (!unassignedCatId || existingBoost <= 0) return;
    await onRemoveTemporaryBoost(Number(unassignedCatId));
    onClose();
  };

  // Keep toCatId in sync when fromCatId changes
  const handleFromCatChange = (id) => {
    setFromCatId(id);
    if (toCatId === id) setToCatId('');
  };

  const catOption = (c) => {
    const over = overspendOf(c);
    return (
      <option key={c.id} value={c.id}>
        {c.name}{over > 0 ? ` (overspent ${fmt(over)})` : ''}
      </option>
    );
  };

  return (
    <Modal title={titleCat ? `Adjust — ${titleCat.name}` : 'Adjust Budget'} onClose={onClose}>
      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, background: 'rgba(255,255,255,0.04)', borderRadius: 10, padding: 4 }}>
        {REMEDIATE_TABS.map(t => (
          <button key={t.id} type="button"
            onClick={() => setTab(t.id)}
            style={{
              flex: 1,
              padding: '7px 4px',
              fontSize: 12,
              fontWeight: 600,
              borderRadius: 7,
              border: 'none',
              cursor: 'pointer',
              transition: 'background 0.15s, color 0.15s',
              background: tab === t.id ? 'rgba(79,255,176,0.15)' : 'transparent',
              color: tab === t.id ? 'var(--accent-mint)' : 'var(--text-muted)',
            }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Move Spend ── */}
      {tab === 'move' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0, lineHeight: 1.6 }}>
            Reclassify spending from one category to another. The source category's spend decreases and the destination's increases.
          </p>
          <Field label="From category">
            {id => (
              <select id={id} className="glass-input" value={fromCatId} onChange={e => handleFromCatChange(e.target.value)}>
                {categories.map(catOption)}
              </select>
            )}
          </Field>
          {fromCat && fromOverspend > 0 && (
            <div style={{ fontSize: 12, color: 'var(--danger)', background: 'rgba(255,107,138,0.08)', borderRadius: 8, padding: '8px 12px' }}>
              Overspent by {fmt(fromOverspend)} · current spend {fmt(fromCat.spent || 0)} / {fmt(getEffectiveAllowance(fromCat))} allowance
            </div>
          )}
          <Field label="Amount (£)">
            {id => (
              <input id={id} className="glass-input" type="number" min="0" step="0.01" placeholder="0.00"
                value={moveAmount} onChange={e => setMoveAmount(e.target.value)} />
            )}
          </Field>
          <Field label="To category">
            {id => (
              <select id={id} className="glass-input" value={toCatId} onChange={e => setToCatId(e.target.value)}>
                <option value="">Select category…</option>
                {toCatOptions.map(c => {
                  const avail = roundMoney(getEffectiveAllowance(c) - (c.spent || 0));
                  return (
                    <option key={c.id} value={c.id}>
                      {c.name} · {avail >= 0 ? fmt(avail) + ' left' : fmt(Math.abs(avail)) + ' over'}
                    </option>
                  );
                })}
              </select>
            )}
          </Field>
          {toCat && parsedMoveAmount > 0 && (
            <div style={{ fontSize: 12, color: toAvailable - parsedMoveAmount < 0 ? 'var(--warn)' : 'var(--text-muted)', background: 'rgba(255,255,255,0.04)', borderRadius: 8, padding: '8px 12px' }}>
              {toCat.name} will have {fmt(Math.abs(toAvailable - parsedMoveAmount))} {toAvailable - parsedMoveAmount < 0 ? 'over budget' : 'remaining'}
            </div>
          )}
          <div className="modal-actions" style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            <button className="btn-secondary" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
            <button className="btn-primary" onClick={handleMoveSpend} style={{ flex: 2 }}
              disabled={!fromCatId || !toCatId || parsedMoveAmount <= 0}>
              Move Spend
            </button>
          </div>
        </div>
      )}

      {/* ── Use Unallocated (temporary top-up) ── */}
      {tab === 'unassigned' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0, lineHeight: 1.6 }}>
            Temporarily top up a category from your unallocated income for this cycle. The boost is separate from the recurring allowance and clears automatically at the next reset.
          </p>
          <div style={{ fontSize: 13, color: unallocated > 0 ? 'var(--accent-mint)' : 'var(--danger)', background: 'rgba(255,255,255,0.04)', borderRadius: 8, padding: '10px 14px', fontWeight: 600 }}>
            {fmt(Math.max(0, unallocated))} unallocated{unallocated <= 0 ? ' available (fully allocated)' : ' available'}
          </div>
          <Field label="Top up category">
            {id => (
              <select id={id} className="glass-input" value={unassignedCatId} onChange={e => setUnassignedCatId(e.target.value)}>
                {categories.map(catOption)}
              </select>
            )}
          </Field>
          {existingBoost > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, fontSize: 12, color: 'var(--accent-mint)', background: 'rgba(79,255,176,0.06)', borderRadius: 8, padding: '8px 12px' }}>
              <span>Current temporary top-up: {fmt(existingBoost)}</span>
              <button type="button" className="btn-secondary" onClick={handleRemoveBoost}
                style={{ padding: '5px 10px', fontSize: 11, flexShrink: 0 }}>
                Remove
              </button>
            </div>
          )}
          <Field label="Add amount (£)">
            {id => (
              <input id={id} className="glass-input" type="number" min="0" step="0.01" placeholder="0.00"
                max={unallocated > 0 ? unallocated : undefined}
                value={unassignedAmount} onChange={e => setUnassignedAmount(e.target.value)} />
            )}
          </Field>
          {parsedUnassignedAmount > 0 && unassignedCat && (() => {
            const newEffective = roundMoney(getEffectiveAllowance(unassignedCat) + parsedUnassignedAmount);
            const newLeft = roundMoney(newEffective - (unassignedCat.spent || 0));
            const newUnallocated = roundMoney(unallocated - parsedUnassignedAmount);
            return (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', background: 'rgba(255,255,255,0.04)', borderRadius: 8, padding: '8px 12px' }}>
                {unassignedCat.name}: {fmt(getEffectiveAllowance(unassignedCat))} → {fmt(newEffective)} available · {newLeft >= 0 ? fmt(newLeft) + ' remaining' : fmt(Math.abs(newLeft)) + ' still over'}
                {newUnallocated < 0 && <span style={{ color: 'var(--danger)', display: 'block', marginTop: 2 }}>⚠ Exceeds available unallocated by {fmt(Math.abs(newUnallocated))}</span>}
              </div>
            );
          })()}
          <div className="modal-actions" style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            <button className="btn-secondary" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
            <button className="btn-primary" onClick={handleAddBoost} style={{ flex: 2 }}
              disabled={!unassignedCatId || parsedUnassignedAmount <= 0}>
              Add Temporary Funds
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
