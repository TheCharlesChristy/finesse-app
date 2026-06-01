import { useState, useMemo, useRef, useEffect } from 'react';
import { Plus, Wand2, X } from 'lucide-react';
import { format } from 'date-fns';
import {
  evaluateFormula,
  fmt,
  getAllocationPercentTotal,
  getIncomeAllocationUsage,
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
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 82px 76px 30px', alignItems: 'center', gap: 10 }}>
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
                      <div style={{ fontSize: 12, textAlign: 'right', color: 'var(--text-secondary)', fontWeight: 600 }}>
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
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center' }}>
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
export function AddTransactionModal({ categories, onAdd, onClose }) {
  const [catId, setCatId] = useState(categories[0]?.id || '');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'));

  const handleSubmit = () => {
    if (!catId || !amount) return;
    onAdd({
      categoryId: Number(catId),
      amount: parseFloat(amount),
      note: note.trim(),
      date: new Date(date).toISOString(),
    });
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 }}>
          <div className="font-display" style={{ fontSize: 22 }}>Log Expense</div>
          <button className="btn-icon" onClick={onClose}><X size={15} /></button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Category</label>
            <select className="glass-input" value={catId} onChange={e => setCatId(e.target.value)}>
              {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
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
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Date</label>
            <input className="glass-input" type="date" value={date} onChange={e => setDate(e.target.value)} />
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
            <button className="btn-secondary" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
            <button className="btn-primary" onClick={handleSubmit} style={{ flex: 2 }}
              disabled={!catId || !amount}>
              Add Expense
            </button>
          </div>
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

export function AddWishlistItemModal({ expenseCategories, wishlistCategories, onAdd, onClose, defaultCategoryId = null }) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [note, setNote] = useState('');
  const [link, setLink] = useState('');
  const [wishCatId, setWishCatId] = useState(
    defaultCategoryId != null ? String(defaultCategoryId) : ''
  );

  const flatLists = useMemo(() => flattenWishlistCategories(wishlistCategories), [wishlistCategories]);
  const [selectedExpCats, setSelectedExpCats] = useState([]);

  const toggleExpCat = (id) => {
    setSelectedExpCats(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const handleSubmit = () => {
    if (!name.trim() || !price) return;
    onAdd({
      name: name.trim(),
      price: parseFloat(price),
      note: note.trim(),
      link: link.trim() || null,
      wishlistCategoryId: wishCatId ? Number(wishCatId) : null,
      categoryIds: selectedExpCats,
    });
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 }}>
          <div className="font-display" style={{ fontSize: 22 }}>Add to Wishlist</div>
          <button className="btn-icon" onClick={onClose}><X size={15} /></button>
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
          <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
            <button className="btn-secondary" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
            <button className="btn-primary" onClick={handleSubmit} style={{ flex: 2 }}
              disabled={!name.trim() || !price}>
              Add to Wishlist
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
  const [color, setColor] = useState(PALETTE[0]);
  const [incomeAllocations, setIncomeAllocations] = useState(() => makeAutoIncomeAllocations(0, incomes, categories));
  const [allocTouched, setAllocTouched] = useState(false);

  const isFormula = isFormulaInput(allowanceInput);
  const formulaResult = useMemo(
    () => isFormula ? evaluateFormula(allowanceInput, variables, categories, incomes) : null,
    [allowanceInput, isFormula, variables, categories, incomes]
  );
  const allowanceValue = isFormula ? (formulaResult ?? 0) : (parseFloat(allowanceInput) || 0);
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
    if (!name.trim() || !allowanceInput) return;
    if (isFormula && formulaResult === null) return;
    if (!allocationValidation.isValid) return;
    const numericValue = isFormula ? formulaResult : (parseFloat(allowanceInput) || 0);
    onAdd({
      name: name.trim(),
      allowance: numericValue,
      allowanceFormula: isFormula ? allowanceInput : null,
      incomeAllocations: normalizeIncomeAllocations(incomeAllocations),
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
          <button className="btn-icon" onClick={onClose}><X size={15} /></button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Name</label>
            <input className="glass-input" placeholder="e.g. Groceries" value={name}
              onChange={e => setName(e.target.value)} autoFocus />
          </div>
          <div>
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
          <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
            <button className="btn-secondary" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
            <button className="btn-primary" onClick={handleSubmit} style={{ flex: 2 }}
              disabled={!name.trim() || !allowanceInput || (isFormula && formulaResult === null) || !allocationValidation.isValid}>
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
  const [color, setColor] = useState(category.color || PALETTE[0]);
  const [incomeAllocations, setIncomeAllocations] = useState(() => (
    category.incomeAllocations?.length
      ? normalizeIncomeAllocations(category.incomeAllocations)
      : makeAutoIncomeAllocations(category.allowance || 0, incomes, categories, category.id)
  ));
  const [allocTouched, setAllocTouched] = useState(() => Boolean(category.incomeAllocations?.length));

  const isFormula = isFormulaInput(allowanceInput);
  const formulaResult = useMemo(
    () => isFormula ? evaluateFormula(allowanceInput, variables, categories, incomes) : null,
    [allowanceInput, isFormula, variables, categories, incomes]
  );
  const allowanceValue = isFormula ? (formulaResult ?? 0) : (parseFloat(allowanceInput) || 0);
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
    if (!name.trim() || !allowanceInput) return;
    if (isFormula && formulaResult === null) return;
    if (!allocationValidation.isValid) return;
    const numericValue = isFormula ? formulaResult : (parseFloat(allowanceInput) || 0);
    onSave(category.id, {
      name: name.trim(),
      allowance: numericValue,
      allowanceFormula: isFormula ? allowanceInput : null,
      incomeAllocations: normalizeIncomeAllocations(incomeAllocations),
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
          <button className="btn-icon" onClick={onClose}><X size={15} /></button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Name</label>
            <input className="glass-input" value={name} onChange={e => setName(e.target.value)} autoFocus />
          </div>
          <div>
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
          <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
            <button className="btn-secondary" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
            <button className="btn-primary" onClick={handleSubmit} style={{ flex: 2 }}
              disabled={!name.trim() || !allowanceInput || (isFormula && formulaResult === null) || !allocationValidation.isValid}>
              Save Changes
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Add Income Modal ─────────────────────────────────────────────────────────
export function AddIncomeModal({ onAdd, onClose }) {
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [resetFrequency, setResetFrequency] = useState('monthly');
  const [payDayOfMonth, setPayDayOfMonth] = useState('');

  const handleSubmit = () => {
    if (!name.trim() || !amount) return;
    onAdd({
      name: name.trim(),
      amount: parseFloat(amount),
      resetFrequency,
      payDayOfMonth: resetFrequency === 'monthly' ? (parseInt(payDayOfMonth) || null) : null,
      holdActive: false,
      lastPaid: null,
    });
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 }}>
          <div className="font-display" style={{ fontSize: 22 }}>Add Income</div>
          <button className="btn-icon" onClick={onClose}><X size={15} /></button>
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
          <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
            <button className="btn-secondary" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
            <button className="btn-primary" onClick={handleSubmit} style={{ flex: 2 }}
              disabled={!name.trim() || !amount}>
              Add Income
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
          <button className="btn-icon" onClick={onClose}><X size={15} /></button>
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 18, lineHeight: 1.6 }}>
          Got paid early? Set the actual date you received this income. This updates the next expected pay date.
        </div>
        <div style={{ marginBottom: 18 }}>
          <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Pay received date</label>
          <input className="glass-input" type="date" value={date} onChange={e => setDate(e.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
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
