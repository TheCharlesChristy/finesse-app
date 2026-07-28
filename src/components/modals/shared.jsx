/* eslint-disable react-refresh/only-export-components -- this module deliberately shares helpers and constants alongside the components that use them */
import { useState, useMemo, useRef } from 'react';
import { Plus, Wand2, X } from 'lucide-react';
import { IconButton, Field } from '../ui';
import {
  evaluateFormula,
  fmt,
  getAllocationPercentTotal,
  getIncomeAllocationUsage,
  normalizeIncomeAllocations,
  roundMoney,
} from '../../utils';

// Shared building blocks for the modal family: funding allocation, formula
// entry with autocomplete, and the colour/frequency pickers.

// ── Shared ────────────────────────────────────────────────────────────────────
export const FREQ_OPTIONS = [
  { value: 'weekly',      label: 'Weekly' },
  { value: 'fortnightly', label: 'Fortnightly' },
  { value: '4weekly',     label: 'Every 4 Weeks' },
  { value: 'monthly',     label: 'Monthly' },
];

export function FrequencyFields({ resetFrequency, setResetFrequency, payDayOfMonth, setPayDayOfMonth }) {
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

export const PALETTE = ['#4fffb0','#5db8ff','#c084fc','#fbbf70','#ff6b8a','#67e8f9','#f9a8d4','#86efac'];

export function isFormulaInput(s) {
  return /[$\[{]/.test(s) || /[+\-*/]/.test(s.slice(1));
}

export function makeAutoIncomeAllocations(allowance, incomes = [], categories = [], excludeCategoryId = null) {
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

export function getAllocationValidation(allowance, allocations, incomes = [], categories = [], excludeCategoryId = null) {
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

export function IncomeAllocationEditor({
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

  // Falls back to the first available option at render rather than being
  // corrected by an effect — the selection is a pure function of what's left.
  const effectiveSourceToAdd = availableIncomeOptions.some(income => String(income.id) === sourceToAdd)
    ? sourceToAdd
    : (availableIncomeOptions[0] ? String(availableIncomeOptions[0].id) : '');

  const setPercent = (incomeId, rawValue) => {
    const parsed = rawValue === '' ? 0 : Number(rawValue);
    const percent = Math.min(100, Math.max(0, Number.isFinite(parsed) ? parsed : 0));
    const next = cleanAllocations
      .filter(allocation => allocation.incomeId !== Number(incomeId))
      .concat(percent > 0 ? [{ incomeId: Number(incomeId), percent }] : []);
    onChange(normalizeIncomeAllocations(next));
  };

  const addSource = () => {
    const incomeId = Number(effectiveSourceToAdd || availableIncomeOptions[0]?.id);
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
              <select className="glass-input" value={effectiveSourceToAdd} onChange={e => setSourceToAdd(e.target.value)}
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
export function getActiveToken(value) {
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
export function FormulaInput({ value, onChange, onKeyDown: externalKeyDown, placeholder, variables, categories, incomes }) {
  const [activeIdx, setActiveIdx] = useState(0);
  const [dismissed, setDismissed] = useState(false);
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

  // Derived, not synced: the dropdown is open whenever there's a token with
  // matches and the user hasn't explicitly dismissed it.
  const showDropdown = !dismissed && token !== null && suggestions.length > 0;
  const boundedIdx = Math.min(activeIdx, Math.max(0, suggestions.length - 1));

  const complete = (item) => {
    if (!token) return;
    const before = value.slice(0, token.triggerPos + 1);
    const suffix = token.type === 'var' ? item.name
      : token.type === 'cat' ? item.name + ']'
      : item.name + '}';
    onChange(before + suffix);
    setDismissed(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleKeyDown = (e) => {
    if (showDropdown && suggestions.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, suggestions.length - 1)); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); return; }
      if (e.key === 'Tab' || (e.key === 'Enter')) {
        if (suggestions[boundedIdx]) { e.preventDefault(); complete(suggestions[boundedIdx]); return; }
      }
      if (e.key === 'Escape') { e.preventDefault(); setDismissed(true); return; }
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
        onChange={e => { onChange(e.target.value); setActiveIdx(0); setDismissed(false); }}
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
                background: idx === boundedIdx ? 'rgba(255,255,255,0.07)' : 'transparent',
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

// Shared accessible colour picker
export function ColourPicker({ color, onChange }) {
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

export const INCOME_CYCLE_LABELS = {
  weekly: 'week',
  fortnightly: 'fortnight',
  '4weekly': '4-week cycle',
  monthly: 'month',
};

/**
 * Returns the single reset frequency shared by all linked incomes, or null if
 * the category has no allocations, missing incomes, or mixed frequencies.
 */
export function getLinkedCycleFreq(incomeAllocations, incomes) {
  const allocs = normalizeIncomeAllocations(incomeAllocations);
  if (!allocs.length) return null;
  const freqs = [...new Set(
    allocs.map(a => incomes.find(i => Number(i.id) === a.incomeId)?.resetFrequency).filter(Boolean)
  )];
  return freqs.length === 1 ? freqs[0] : null;
}
