import { useMemo, useState } from 'react';
import { TrendingUp, TrendingDown, AlertCircle, Zap, Clock, Pencil, Trash2, Check, X } from 'lucide-react';
import {
  fmt,
  projectedEndBalance,
  fmtShort,
  calcNextReset,
  getAllocationPercentTotal,
  getIncomeAllocationUsage,
  normalizeIncomeAllocations,
} from '../utils';
import { format } from 'date-fns';

const FREQ_LABEL = {
  weekly: 'Weekly',
  fortnightly: 'Fortnightly',
  '4weekly': 'Every 4 weeks',
  monthly: 'Monthly',
};

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

const codeStyle = {
  fontFamily: 'monospace',
  background: 'rgba(79,255,176,0.1)',
  color: 'var(--accent-mint)',
  padding: '1px 5px',
  borderRadius: 4,
  fontSize: 11,
};

export default function Dashboard({
  categories, settings, transactions, incomes = [],
  variables = [], onAddVariable, onUpdateVariable, onDeleteVariable,
  onAddTx, onAddCategory, onAddIncome,
  onIncomeHoldToggle, onIncomeFastForward,
  onEditCategory, onDeleteCategory,
}) {
  // Variables section local state
  const [newVarName, setNewVarName]   = useState('');
  const [newVarValue, setNewVarValue] = useState('');
  const [editingVarId, setEditingVarId] = useState(null);
  const [editVarName, setEditVarName]   = useState('');
  const [editVarValue, setEditVarValue] = useState('');

  const handleAddVar = () => {
    if (!newVarName.trim() || newVarValue === '') return;
    onAddVariable({ name: newVarName.trim(), value: parseFloat(newVarValue) || 0 });
    setNewVarName('');
    setNewVarValue('');
  };

  const startVarEdit = (v) => {
    setEditingVarId(v.id);
    setEditVarName(v.name);
    setEditVarValue(String(v.value));
  };

  const commitVarEdit = () => {
    if (!editVarName.trim()) return;
    onUpdateVariable(editingVarId, { name: editVarName.trim(), value: parseFloat(editVarValue) || 0 });
    setEditingVarId(null);
  };

  // Derived totals
  const totalIncome = incomes.length > 0
    ? incomes.reduce((s, i) => s + (i.amount || 0), 0)
    : (settings?.income || 0);

  const totalAllowances = categories.reduce((s, c) => s + (c.allowance || 0), 0);
  const totalSpent      = categories.reduce((s, c) => s + (c.spent || 0), 0);
  const totalLeft       = totalAllowances - totalSpent;
  const projBalance     = projectedEndBalance(categories, settings, incomes);
  const overBudgetCats  = categories.filter(c => (c.spent || 0) > (c.allowance || 0));
  const incomeUsage     = useMemo(() => getIncomeAllocationUsage(incomes, categories), [incomes, categories]);
  const incomeMap       = useMemo(() => new Map(incomes.map(income => [Number(income.id), income])), [incomes]);
  const fundingIssueCats = categories.filter(cat => {
    const allocations = normalizeIncomeAllocations(cat.incomeAllocations);
    const total = getAllocationPercentTotal(allocations);
    return incomes.length > 0 && (Math.abs(total - 100) > 0.01 || allocations.some(a => !incomeMap.has(a.incomeId)));
  });
  const overAllocatedIncomes = incomes.filter(income => (incomeUsage[String(income.id)] || 0) > (income.amount || 0) + 0.005);

  const recentTxs = useMemo(() => {
    const catMap = Object.fromEntries(categories.map(c => [c.id, c]));
    return transactions.slice(0, 10).map(tx => ({ ...tx, cat: catMap[tx.categoryId] }));
  }, [transactions, categories]);

  const spendPct   = totalAllowances > 0 ? Math.min(100, (totalSpent / totalAllowances) * 100) : 0;
  const spendColor = spendPct > 90 ? 'var(--danger)' : spendPct > 70 ? 'var(--warn)' : 'var(--good)';

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* ── Header cards ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
        <div className="glass" style={{ borderRadius: 18, padding: '20px 22px' }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 500, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Monthly Income</div>
          <div className="font-display" style={{ fontSize: 32, letterSpacing: '-0.02em', color: 'var(--accent-mint)' }}>{fmt(totalIncome)}</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
            {fmt(totalAllowances)} allocated · {fmt(totalIncome - totalAllowances)} unallocated
          </div>
          {totalIncome > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', height: 7, borderRadius: 99, overflow: 'hidden', background: 'rgba(255,255,255,0.06)', gap: 1 }}>
                {categories.filter(c => (c.allowance || 0) > 0).map(cat => (
                  <div key={cat.id} title={`${cat.name}: ${fmt(cat.allowance)}`}
                    style={{ width: `${Math.min(100, (cat.allowance / totalIncome) * 100)}%`, background: cat.color || 'var(--accent-blue)', height: '100%', minWidth: 2 }} />
                ))}
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 5 }}>
                {totalAllowances > totalIncome
                  ? <span style={{ color: 'var(--danger)' }}>⚠ {((totalAllowances / totalIncome) * 100).toFixed(0)}% — over-allocated</span>
                  : `${((totalAllowances / totalIncome) * 100).toFixed(0)}% of income allocated`}
              </div>
            </div>
          )}
        </div>

        <div className="glass" style={{ borderRadius: 18, padding: '20px 22px' }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 500, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Budget Remaining</div>
          <div className="font-display" style={{ fontSize: 32, letterSpacing: '-0.02em', color: totalLeft < 0 ? 'var(--danger)' : 'var(--text-primary)' }}>
            {fmt(totalLeft)}
          </div>
          <div style={{ marginTop: 10 }}>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${spendPct}%`, background: spendColor }} />
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 5 }}>{spendPct.toFixed(0)}% spent</div>
          </div>
        </div>

        <div className="glass" style={{ borderRadius: 18, padding: '20px 22px' }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 500, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Projected End Balance</div>
          <div className="font-display" style={{ fontSize: 32, letterSpacing: '-0.02em', color: projBalance < 0 ? 'var(--danger)' : 'var(--accent-blue)' }}>
            {fmtShort(projBalance)}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
            {projBalance >= 0 ? <TrendingUp size={12} color="var(--good)" /> : <TrendingDown size={12} color="var(--danger)" />}
            Based on current burn rate
          </div>
        </div>
      </div>

      {/* ── Over-budget alerts ── */}
      {overBudgetCats.length > 0 && (
        <div className="glass" style={{ borderRadius: 14, padding: '14px 18px', borderColor: 'rgba(255,107,138,0.3)', background: 'rgba(255,107,138,0.06)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--danger)', fontSize: 13, fontWeight: 500 }}>
            <AlertCircle size={15} />
            Over budget: {overBudgetCats.map(c => c.name).join(', ')}
          </div>
        </div>
      )}

      {(fundingIssueCats.length > 0 || overAllocatedIncomes.length > 0) && (
        <div className="glass" style={{ borderRadius: 14, padding: '14px 18px', borderColor: 'rgba(251,191,112,0.3)', background: 'rgba(251,191,112,0.06)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--warn)', fontSize: 13, fontWeight: 500 }}>
            <AlertCircle size={15} />
            Funding check: {[...fundingIssueCats.map(c => c.name), ...overAllocatedIncomes.map(i => i.name)].join(', ')}
          </div>
        </div>
      )}

      {/* ── Income Sources ── */}
      <div className="glass" style={{ borderRadius: 18, padding: '22px 24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Income Sources</div>
          <button className="btn-primary" onClick={onAddIncome} style={{ padding: '7px 14px', fontSize: 12 }}>
            + Add Income
          </button>
        </div>
        {incomes.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 14, textAlign: 'center', padding: '20px 0' }}>
            No income sources yet — add one to track your earnings
          </div>
        ) : (
          <div style={{ maxHeight: 160, overflowY: 'auto', paddingRight: 4, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {incomes.map(income => {
              const freq = income.resetFrequency || (income.payDayOfMonth ? 'monthly' : null);
              const nextPay = freq
                ? calcNextReset(freq, income.payDayOfMonth, income.lastPaid ? new Date(income.lastPaid) : new Date())
                : null;
              const used = incomeUsage[String(income.id)] || 0;
              const free = (income.amount || 0) - used;
              const usedPct = income.amount > 0 ? Math.min(100, (used / income.amount) * 100) : 0;
              return (
                <div key={income.id} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '12px 14px', background: 'rgba(255,255,255,0.04)', borderRadius: 12,
                  flexWrap: 'wrap', gap: 10,
                }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{income.name}</span>
                      {income.holdActive && (
                        <span className="status-warn" style={{ fontSize: 10, padding: '2px 7px', borderRadius: 20 }}>HELD</span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {freq ? FREQ_LABEL[freq] : 'No schedule set'}
                      {freq === 'monthly' && income.payDayOfMonth ? ` · ${income.payDayOfMonth}${ordinal(income.payDayOfMonth)}` : ''}
                      {nextPay ? ` · Next: ${format(nextPay, 'd MMM yyyy')}` : ''}
                    </div>
                    <div style={{ fontSize: 11, color: free < 0 ? 'var(--danger)' : 'var(--text-muted)', marginTop: 3 }}>
                      {fmt(used)} allocated · {fmt(free)} free
                    </div>
                    <div className="progress-track" style={{ height: 4, marginTop: 7, maxWidth: 230 }}>
                      <div className="progress-fill" style={{ width: `${usedPct}%`, background: free < 0 ? 'var(--danger)' : 'var(--accent-mint)' }} />
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--accent-mint)' }}>
                      {fmt(income.amount || 0)}
                    </span>
                    <button className="btn-secondary" onClick={() => onIncomeFastForward(income.id)}
                      style={{ padding: '5px 10px', fontSize: 11, borderRadius: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <Zap size={11} /> Early
                    </button>
                    <button className="btn-secondary" onClick={() => onIncomeHoldToggle(income.id)}
                      style={{ padding: '5px 10px', fontSize: 11, borderRadius: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <Clock size={11} /> {income.holdActive ? 'Unhold' : 'Hold'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Category Breakdown ── */}
      <div className="glass" style={{ borderRadius: 18, padding: '22px 24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Category Breakdown</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-secondary" onClick={onAddCategory} style={{ padding: '7px 14px', fontSize: 12 }}>
              + Category
            </button>
            <button className="btn-primary" onClick={onAddTx} style={{ padding: '7px 14px', fontSize: 12 }}>
              + Log Expense
            </button>
          </div>
        </div>
        {categories.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 14, textAlign: 'center', padding: '20px 0' }}>
            No categories yet — add one above
          </div>
        ) : (
          <div style={{ maxHeight: 160, overflowY: 'auto', paddingRight: 4, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {categories.map(cat => {
              const pct      = cat.allowance > 0 ? Math.min(100, ((cat.spent || 0) / cat.allowance) * 100) : 0;
              const left     = (cat.allowance || 0) - (cat.spent || 0);
              const barColor = pct > 90 ? 'var(--danger)' : pct > 70 ? 'var(--warn)' : 'var(--accent-mint)';
              const allocations = normalizeIncomeAllocations(cat.incomeAllocations);
              const allocationTotal = getAllocationPercentTotal(allocations);
              const fundingLabel = allocations
                .map(allocation => {
                  const income = incomeMap.get(allocation.incomeId);
                  return income ? `${income.name} ${allocation.percent}%` : null;
                })
                .filter(Boolean)
                .join(' · ');
              const fundingOk = allocations.length > 0
                && Math.abs(allocationTotal - 100) <= 0.01
                && allocations.every(allocation => incomeMap.has(allocation.incomeId));
              return (
                <div key={cat.id}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: cat.color || 'var(--accent-blue)', flexShrink: 0 }} />
                      <div style={{ minWidth: 0 }}>
                        <span style={{ fontSize: 13, fontWeight: 500 }}>{cat.name}</span>
                        {(allocations.length > 0 || cat.resetFrequency || cat.allowanceFormula || !fundingOk) && (
                          <div style={{ display: 'flex', gap: 5, marginTop: 2 }}>
                            {allocations.length > 0 ? (
                              <span title={fundingLabel} style={{
                                fontSize: 10,
                                color: fundingOk ? 'var(--accent-blue)' : 'var(--danger)',
                                background: fundingOk ? 'rgba(93,184,255,0.08)' : 'rgba(255,107,138,0.1)',
                                padding: '1px 6px',
                                borderRadius: 10,
                                maxWidth: 230,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}>
                                {fundingLabel || 'Funding missing'}
                              </span>
                            ) : cat.resetFrequency ? (
                              <span style={{ fontSize: 10, color: 'var(--text-muted)', background: 'rgba(255,255,255,0.06)', padding: '1px 6px', borderRadius: 10 }}>
                                Legacy · {FREQ_LABEL[cat.resetFrequency]}
                              </span>
                            ) : (
                              <span style={{ fontSize: 10, color: 'var(--danger)', background: 'rgba(255,107,138,0.1)', padding: '1px 6px', borderRadius: 10 }}>
                                Funding missing
                              </span>
                            )}
                            {cat.allowanceFormula && (
                              <span style={{ fontSize: 10, color: 'var(--accent-mint)', background: 'rgba(79,255,176,0.08)', padding: '1px 6px', borderRadius: 10 }}>
                                ƒ formula
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                      <div style={{ display: 'flex', gap: 10, fontSize: 12 }}>
                        <span style={{ color: 'var(--text-muted)' }}>{fmt(cat.spent || 0)} / {fmt(cat.allowance || 0)}</span>
                        <span style={{ color: left < 0 ? 'var(--danger)' : 'var(--text-secondary)', fontWeight: 500, minWidth: 56, textAlign: 'right' }}>
                          {left < 0 ? '-' : ''}{fmt(Math.abs(left))} left
                        </span>
                      </div>
                      <button className="btn-icon" onClick={() => onEditCategory(cat)} style={{ width: 28, height: 28, opacity: 0.6 }}>
                        <Pencil size={12} />
                      </button>
                      <button className="btn-icon" onClick={() => {
                        if (window.confirm(`Delete "${cat.name}" and all its transactions?`)) onDeleteCategory(cat.id);
                      }} style={{ width: 28, height: 28, opacity: 0.5 }}>
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                  <div className="progress-track">
                    <div className="progress-fill" style={{ width: `${pct}%`, background: barColor }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Variables ── */}
      <div className="glass" style={{ borderRadius: 18, padding: '22px 24px' }}>
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Variables</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.5 }}>
            Named values for use in category allowance formulas — reference with <span style={codeStyle}>$varName</span>
          </div>
        </div>

        {variables.length > 0 && (
          <div style={{ maxHeight: 160, overflowY: 'auto', paddingRight: 4, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {variables.map(v => (
              editingVarId === v.id ? (
                <div key={v.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input className="glass-input"
                    value={editVarName}
                    onChange={e => setEditVarName(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
                    style={{ flex: 2 }}
                    onKeyDown={e => e.key === 'Enter' && commitVarEdit()} />
                  <input className="glass-input" type="number" step="0.01"
                    value={editVarValue}
                    onChange={e => setEditVarValue(e.target.value)}
                    style={{ flex: 1 }}
                    onKeyDown={e => e.key === 'Enter' && commitVarEdit()} />
                  <button className="btn-icon" onClick={commitVarEdit} title="Save" style={{ width: 28, height: 28 }}><Check size={13} /></button>
                  <button className="btn-icon" onClick={() => setEditingVarId(null)} title="Cancel" style={{ width: 28, height: 28 }}><X size={13} /></button>
                </div>
              ) : (
                <div key={v.id} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '9px 12px', background: 'rgba(255,255,255,0.04)', borderRadius: 10,
                }}>
                  <span style={{ ...codeStyle, flex: 1, fontSize: 12 }}>{v.name}</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>{fmt(v.value)}</span>
                  <button className="btn-icon" onClick={() => startVarEdit(v)} style={{ width: 28, height: 28, opacity: 0.6 }}><Pencil size={11} /></button>
                  <button className="btn-icon" onClick={() => onDeleteVariable(v.id)} style={{ width: 28, height: 28, opacity: 0.45 }}><Trash2 size={11} /></button>
                </div>
              )
            ))}
          </div>
        )}

        {/* Add variable form */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: '2 1 130px' }}>
            <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Name</label>
            <input className="glass-input" placeholder="e.g. salary"
              value={newVarName}
              onChange={e => setNewVarName(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
              onKeyDown={e => e.key === 'Enter' && handleAddVar()} />
          </div>
          <div style={{ flex: '1 1 100px' }}>
            <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Value (£)</label>
            <input className="glass-input" type="number" step="0.01" placeholder="0.00"
              value={newVarValue}
              onChange={e => setNewVarValue(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAddVar()} />
          </div>
          <button className="btn-primary" onClick={handleAddVar}
            disabled={!newVarName.trim() || newVarValue === ''}
            style={{ flexShrink: 0 }}>
            Add
          </button>
        </div>
      </div>

      {/* ── Recent Transactions ── */}
      {recentTxs.length > 0 && (
        <div className="glass" style={{ borderRadius: 18, padding: '22px 24px' }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>Recent Transactions</div>
          <div style={{ maxHeight: 400, overflowY: 'auto', paddingRight: 4, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {recentTxs.map(tx => (
              <div key={tx.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: 'rgba(255,255,255,0.04)', borderRadius: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: tx.cat?.color || 'var(--accent-blue)', flexShrink: 0 }} />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{tx.note || tx.cat?.name || 'Expense'}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{tx.cat?.name} · {format(new Date(tx.date), 'd MMM')}</div>
                  </div>
                </div>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--accent-warm)' }}>-{fmt(tx.amount)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}
