import { useState, useMemo, useRef, useEffect } from 'react';
import { Plus, Wand2, X } from 'lucide-react';
import { format } from 'date-fns';
import CategorySelect from './CategorySelect';
import DateInput from './DateInput';
import {
  evaluateFormula,
  formatPacedAllowancePeriod,
  fmt,
  getAllocationPercentTotal,
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
      <div>
        <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Reset Frequency</label>
        <select className="glass-input" value={resetFrequency} onChange={e => setResetFrequency(e.target.value)}>
          {FREQ_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      {resetFrequency === 'monthly' && (
        <div>
          <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Pay Day of Month (1–31)</label>
          <input className="glass-input" type="number" min="1" max="31" placeholder="e.g. 25"
            value={payDayOfMonth} onChange={e => setPayDayOfMonth(e.target.value)} />
        </div>
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
                          onChange={e => setPercent(allocation.incomeId, e.target.value)}
                          style={{ padding: '8px 24px 8px 10px', fontSize: 13 }}
                        />
                        <span style={{ position: 'absolute', right: 9, top: '50%', transform: 'translateY(-50%)', fontSize: 11, color: 'var(--text-muted)' }}>%</span>
                      </div>
                      <div className="mobile-center-left" style={{ fontSize: 12, textAlign: 'right', color: 'var(--text-secondary)', fontWeight: 600 }}>
                        {fmt(thisAmount)}
                      </div>
                      <button className="btn-icon" onClick={() => removeSource(allocation.incomeId)}
                        title="Remove source"
                        style={{ width: 28, height: 28 }}>
                        <X size={12} />
                      </button>
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

  const handleSubmit = () => {
    if (!catId || !amount) return;
    const data = {
      categoryId: Number(catId),
      amount: parseFloat(amount),
      note: note.trim(),
      date: new Date(date).toISOString(),
    };
    if (isEditing && onSave) {
      onSave(transaction.id, data);
    } else {
      onAdd(data);
    }
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 }}>
          <div className="font-display" style={{ fontSize: 22 }}>{isEditing ? 'Edit Expense' : 'Log Expense'}</div>
          <button className="btn-icon" onClick={onClose} title="Close"><X size={15} /></button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Category</label>
            <CategorySelect categories={categories} value={String(catId)} onChange={setCatId} showAmounts />
          </div>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Amount (£)</label>
            <input className="glass-input" type="number" step="0.01" placeholder="0.00" value={amount}
              onChange={e => setAmount(e.target.value)} autoFocus />
          </div>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Note (optional)</label>
            <input className="glass-input" placeholder="What was this for?" value={note}
              onChange={e => setNote(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSubmit()} />
          </div>
          <DateInput value={date} onChange={setDate} />
          <div className="modal-actions" style={{ display: 'flex', gap: 10, marginTop: 6 }}>
            <button className="btn-secondary" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
            <button className="btn-primary" onClick={handleSubmit} style={{ flex: 2 }}
              disabled={!catId || !amount}>
              {isEditing ? 'Save Changes' : 'Add Expense'}
            </button>
          </div>
        </div>
      </div>
    </div>
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
        date: new Date(row.date).toISOString(),
      })),
    });
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box" style={{ maxWidth: 760 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 }}>
          <div>
            <div className="font-display" style={{ fontSize: 22 }}>Bulk Add Expenses</div>
            <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 3 }}>
              Add several expenses to one category in one pass.
            </div>
          </div>
          <button className="btn-icon" onClick={onClose} title="Close"><X size={15} /></button>
        </div>

        <div className="mobile-stack" style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) minmax(170px, 220px)', gap: 12, marginBottom: 16 }}>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Category</label>
            <CategorySelect categories={categories} value={String(catId)} onChange={setCatId} showAmounts />
          </div>
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
                onChange={e => updateRow(index, { amount: e.target.value })}
                onKeyDown={e => e.key === 'Enter' && addRows(1)}
                style={{ padding: '8px 10px' }}
                autoFocus={index === 0} />
              <input className="glass-input bulk-expense-note" placeholder="Optional note" value={row.note}
                onChange={e => updateRow(index, { note: e.target.value })}
                onKeyDown={e => e.key === 'Enter' && addRows(1)}
                style={{ padding: '8px 10px' }} />
              <div className="bulk-expense-date">
                <DateInput value={row.date} onChange={date => updateRow(index, { date })} label={null} />
              </div>
              <button className="btn-icon" onClick={() => removeRow(index)} disabled={rows.length <= 1}
                title="Remove row" style={{ width: 34, height: 34 }}>
                <X size={13} />
              </button>
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
            <span style={{ color: 'var(--accent-warm)', fontWeight: 800 }}>{fmt(totalAmount)}</span>
          </div>
        </div>

        <div className="modal-actions" style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button className="btn-secondary" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
          <button className="btn-primary" onClick={handleSubmit} disabled={!catId || validRows.length === 0}
            style={{ flex: 2 }}>
            Add {validRows.length || ''} Expense{validRows.length === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
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
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 }}>
          <div className="font-display" style={{ fontSize: 22 }}>{isEditing ? 'Edit Wishlist Item' : 'Add to Wishlist'}</div>
          <button className="btn-icon" onClick={onClose} title="Close"><X size={15} /></button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Item Name</label>
            <input className="glass-input" placeholder="e.g. New trainers" value={name}
              onChange={e => setName(e.target.value)} autoFocus />
          </div>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Price (£)</label>
            <input className="glass-input" type="number" step="0.01" placeholder="0.00" value={price}
              onChange={e => setPrice(e.target.value)} />
          </div>
          {wishlistCategories.length > 0 && (
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Add to List</label>
              <select className="glass-input" value={wishCatId} onChange={e => setWishCatId(e.target.value)}>
                <option value="">No list (uncategorised)</option>
                {flatLists.map(l => (
                  <option key={l.id} value={l.id}>
                    {'—'.repeat(l.depth)}{l.depth > 0 ? ' ' : ''}{l.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 8 }}>
              Budget Categories for Affordability
            </label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
              {expenseCategories.map(cat => {
                const selected = selectedExpCats.includes(cat.id);
                return (
                  <button key={cat.id} onClick={() => toggleExpCat(cat.id)} style={{
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
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Link (optional)</label>
            <input className="glass-input" type="url" placeholder="https://…" value={link}
              onChange={e => setLink(e.target.value)} />
          </div>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Note (optional)</label>
            <input className="glass-input" placeholder="Any details…" value={note}
              onChange={e => setNote(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSubmit()} />
          </div>
          <div className="modal-actions" style={{ display: 'flex', gap: 10, marginTop: 6 }}>
            <button className="btn-secondary" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
            <button className="btn-primary" onClick={handleSubmit} style={{ flex: 2 }}
              disabled={!name.trim() || !price}>
              {isEditing ? 'Save Changes' : 'Add to Wishlist'}
            </button>
          </div>
        </div>
      </div>
    </div>
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
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 }}>
          <div className="font-display" style={{ fontSize: 22 }}>Edit List</div>
          <button className="btn-icon" onClick={onClose} title="Close"><X size={15} /></button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Name</label>
            <input className="glass-input" value={name} onChange={e => setName(e.target.value)} autoFocus />
          </div>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Parent List</label>
            <select className="glass-input" value={parentId} onChange={e => setParentId(e.target.value)}>
              <option value="">Top level</option>
              {parentOptions.map(cat => (
                <option key={cat.id} value={cat.id}>
                  {'-'.repeat(cat.depth)}{cat.depth > 0 ? ' ' : ''}{cat.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Colour</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {PALETTE.map(c => (
                <button key={c} onClick={() => setColor(c)} title={c} style={{
                  width: 28, height: 28, borderRadius: '50%', background: c, cursor: 'pointer',
                  border: color === c ? '3px solid white' : '3px solid transparent', outline: 'none',
                }} />
              ))}
            </div>
          </div>
          <div className="modal-actions" style={{ display: 'flex', gap: 10, marginTop: 6 }}>
            <button className="btn-secondary" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
            <button className="btn-primary" onClick={handleSubmit} style={{ flex: 2 }} disabled={!name.trim()}>
              Save Changes
            </button>
          </div>
        </div>
      </div>
    </div>
  );
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

  const isFormula = !pacedAllowanceEnabled && isFormulaInput(allowanceInput);
  const pacedMonthlyAllowance = getPacedAllowanceMonthlyTotal(
    parseFloat(pacedAllowanceAmount) || 0,
    pacedAllowanceInterval,
    pacedAllowanceUnit
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
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 }}>
          <div className="font-display" style={{ fontSize: 22 }}>Add Category</div>
          <button className="btn-icon" onClick={onClose} title="Close"><X size={15} /></button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Name</label>
            <input className="glass-input" placeholder="e.g. Groceries" value={name}
              onChange={e => setName(e.target.value)} autoFocus />
          </div>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Allowance Type</label>
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
                  this month: <span style={{ color: 'var(--text-secondary)', fontWeight: 700 }}>{fmt(pacedMonthlyAllowance)}</span>
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
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Colour</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {PALETTE.map(c => (
                <button key={c} onClick={() => setColor(c)} style={{
                  width: 28, height: 28, borderRadius: '50%', background: c, cursor: 'pointer',
                  border: color === c ? '3px solid white' : '3px solid transparent', outline: 'none',
                }} />
              ))}
            </div>
          </div>
          <div className="modal-actions" style={{ display: 'flex', gap: 10, marginTop: 6 }}>
            <button className="btn-secondary" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
            <button className="btn-primary" onClick={handleSubmit} style={{ flex: 2 }}
              disabled={!name.trim() || (pacedAllowanceEnabled ? !(parseFloat(pacedAllowanceAmount) > 0) : !allowanceInput) || (isFormula && formulaResult === null) || !allocationValidation.isValid}>
              Add Category
            </button>
          </div>
        </div>
      </div>
    </div>
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

  const isFormula = !pacedAllowanceEnabled && isFormulaInput(allowanceInput);
  const pacedMonthlyAllowance = getPacedAllowanceMonthlyTotal(
    parseFloat(pacedAllowanceAmount) || 0,
    pacedAllowanceInterval,
    pacedAllowanceUnit
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
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 }}>
          <div className="font-display" style={{ fontSize: 22 }}>Edit Category</div>
          <button className="btn-icon" onClick={onClose} title="Close"><X size={15} /></button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Name</label>
            <input className="glass-input" value={name} onChange={e => setName(e.target.value)} autoFocus />
          </div>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Allowance Type</label>
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
                  this month: <span style={{ color: 'var(--text-secondary)', fontWeight: 700 }}>{fmt(pacedMonthlyAllowance)}</span>
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
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Colour</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {PALETTE.map(c => (
                <button key={c} onClick={() => setColor(c)} style={{
                  width: 28, height: 28, borderRadius: '50%', background: c, cursor: 'pointer',
                  border: color === c ? '3px solid white' : '3px solid transparent', outline: 'none',
                }} />
              ))}
            </div>
          </div>
          <div className="modal-actions" style={{ display: 'flex', gap: 10, marginTop: 6 }}>
            <button className="btn-secondary" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
            <button className="btn-primary" onClick={handleSubmit} style={{ flex: 2 }}
              disabled={!name.trim() || (pacedAllowanceEnabled ? !(parseFloat(pacedAllowanceAmount) > 0) : !allowanceInput) || (isFormula && formulaResult === null) || !allocationValidation.isValid}>
              Save Changes
            </button>
          </div>
        </div>
      </div>
    </div>
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
      nextDueAt: new Date(nextDueAt).toISOString(),
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
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 }}>
          <div className="font-display" style={{ fontSize: 22 }}>{isEditing ? 'Edit Subscription' : 'Add Subscription'}</div>
          <button className="btn-icon" onClick={onClose} title="Close"><X size={15} /></button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Name</label>
            <input className="glass-input" placeholder="e.g. Netflix" value={name}
              onChange={e => setName(e.target.value)} autoFocus />
          </div>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Category</label>
            <CategorySelect categories={categories} value={String(catId)} onChange={setCatId} showAmounts />
          </div>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Amount (£)</label>
            <input className="glass-input" type="number" min="0" step="0.01" placeholder="0.00" value={amount}
              onChange={e => setAmount(e.target.value)} />
          </div>
          <DateInput value={nextDueAt} onChange={setNextDueAt} label="Next due date" />
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Repeats</label>
            <div className="mobile-stack" style={{ display: 'grid', gridTemplateColumns: '96px 1fr', gap: 8 }}>
              <input className="glass-input" type="number" min="1" step="1" value={interval}
                onChange={e => setInterval(e.target.value)} />
              <select className="glass-input" value={intervalUnit} onChange={e => setIntervalUnit(e.target.value)}>
                <option value="day">Day(s)</option>
                <option value="week">Week(s)</option>
                <option value="month">Month(s)</option>
                <option value="year">Year(s)</option>
              </select>
            </div>
          </div>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Management link</label>
            <input className="glass-input" type="url" placeholder="Optional, e.g. netflix.com/account" value={manageUrl}
              onChange={e => setManageUrl(e.target.value)} />
          </div>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Note</label>
            <input className="glass-input" placeholder="Optional" value={note}
              onChange={e => setNote(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSubmit()} />
          </div>
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
      </div>
    </div>
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
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 }}>
          <div className="font-display" style={{ fontSize: 22 }}>{isEditing ? 'Edit Income' : 'Add Income'}</div>
          <button className="btn-icon" onClick={onClose} title="Close"><X size={15} /></button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Name</label>
            <input className="glass-input" placeholder="e.g. Salary" value={name}
              onChange={e => setName(e.target.value)} autoFocus />
          </div>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Amount (£)</label>
            <input className="glass-input" type="number" step="0.01" placeholder="0.00" value={amount}
              onChange={e => setAmount(e.target.value)} />
          </div>
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
      </div>
    </div>
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
      date: new Date(date).toISOString(),
      note: note.trim(),
    });
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 }}>
          <div className="font-display" style={{ fontSize: 22 }}>One-Off Income</div>
          <button className="btn-icon" onClick={onClose} title="Close"><X size={15} /></button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Source</label>
            <input className="glass-input" placeholder="e.g. Gift or refund" value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSubmit()}
              autoFocus />
          </div>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Amount (£)</label>
            <input className="glass-input" type="number" min="0" step="0.01" placeholder="0.00" value={amount}
              onChange={e => setAmount(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSubmit()} />
          </div>
          <DateInput value={date} onChange={setDate} label="Date received" />
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Note</label>
            <input className="glass-input" placeholder="Optional" value={note}
              onChange={e => setNote(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSubmit()} />
          </div>
          <div className="modal-actions" style={{ display: 'flex', gap: 10, marginTop: 6 }}>
            <button className="btn-secondary" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
            <button className="btn-primary" onClick={handleSubmit} style={{ flex: 2 }}
              disabled={!name.trim() || parsedAmount <= 0 || !date}>
              Add to Account
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Fast Forward Modal ───────────────────────────────────────────────────────
export function FastForwardModal({ onConfirm, onClose }) {
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'));

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div className="font-display" style={{ fontSize: 22 }}>Early Pay</div>
          <button className="btn-icon" onClick={onClose} title="Close"><X size={15} /></button>
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 18, lineHeight: 1.6 }}>
          Got paid early? Set the actual date you received this income. This credits the active account and updates the next expected pay date.
        </div>
        <div style={{ marginBottom: 18 }}>
          <DateInput value={date} onChange={setDate} label="Pay received date" />
        </div>
        <div className="modal-actions" style={{ display: 'flex', gap: 10 }}>
          <button className="btn-secondary" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
          <button className="btn-primary" onClick={() => { onConfirm(new Date(date).toISOString()); onClose(); }} style={{ flex: 2 }}>
            Mark as Received
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Import Mode Modal ────────────────────────────────────────────────────────
export function ImportModeModal({ onConfirm, onClose }) {
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box">
        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>Import Data</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 20, lineHeight: 1.6 }}>
          How should the imported data be handled?
        </div>
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
      </div>
    </div>
  );
}
