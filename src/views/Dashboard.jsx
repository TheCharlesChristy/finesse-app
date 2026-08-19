import { useMemo, useState } from 'react';
import { AlertCircle, Zap, Clock, Pencil, Trash2, Gift, CreditCard, Sparkles, SlidersHorizontal } from 'lucide-react';
import {
  fmt,
  calcNextReset,
  getAllocationPercentTotal,
  getCategoryCycle,
  getEffectiveAllowance,
  getIncomeCycleDays,
  getIncomeAllocationUsage,
  getNormalisedAllowanceTotal,
  getNormalisedCategoryAllowance,
  getNormalisedIncomeTotal,
  getPacedAllowanceStatus,
  getUpcomingSubscriptionCost,
  hasMixedIncomeFrequencies,
  normalizeIncomeAllocations,
  roundMoney,
  getCumulativeOverspend,
  getCycleComparison,
  getSafeToSpend,
  isRefund,
} from '../utils';
import { format } from 'date-fns';
import { CardTitle, IconButton } from '../components/ui';
import Wizard from '../components/Wizard';

const INCOME_PERIOD_LABEL = { week: 'Weekly', month: 'Monthly', year: 'Yearly' };

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

export default function Dashboard({
  categories, settings, transactions, incomes = [], subscriptions = [], goalCommitment = 0,
  onAddTx, onAddCategory, onAddIncome, onAddOneOffIncome, onAddSubscription,
  onIncomeHoldToggle, onIncomeFastForward,
  onEditIncome, onDeleteIncome,
  onEditCategory, onDeleteCategory,
  onEditTransaction, onDeleteTransaction, onOpenCategory, onRunWizard,
  onAdjust,
}) {
  const [showAllIncomes, setShowAllIncomes] = useState(false);
  const [showAllCategories, setShowAllCategories] = useState(false);
  const [incomePeriod, setIncomePeriod] = useState('month');
  const [wizardDismissed, setWizardDismissed] = useState(false);

  // Derived totals.
  //
  // Two different denominations are in play and they must not be mixed:
  //   · per-cycle  — what's left to spend *right now*, across every category's
  //                  current cycle. Raw sums are correct here.
  //   · normalised — income vs budget comparisons, where a weekly wage and a
  //                  monthly salary have to be converted before being added.
  const mixedFrequencies = hasMixedIncomeFrequencies(incomes);
  const monthlyIncome = incomes.length > 0
    ? getNormalisedIncomeTotal(incomes, incomePeriod)
    : (settings?.income || 0);
  const monthlyAllocated = incomes.length > 0
    ? getNormalisedAllowanceTotal(categories, incomes, incomePeriod)
    : categories.reduce((s, c) => s + (c.allowance || 0), 0);
  const allocatedPct = monthlyIncome > 0 ? (monthlyAllocated / monthlyIncome) * 100 : 0;

  const totalAllowances = categories.reduce((s, c) => s + (c.allowance || 0), 0);
  const totalBoost      = categories.reduce((s, c) => s + (c.temporaryBoost || 0), 0);
  const totalAdded      = categories.reduce((s, c) => s + Math.max(0, c.temporaryBoost || 0), 0);
  const totalEffective  = totalAllowances + totalBoost;
  const totalSpent      = categories.reduce((s, c) => s + (c.spent || 0), 0);
  const totalLeft       = totalEffective - totalSpent;
  const overBudgetCats  = categories.filter(c => (c.spent || 0) > getEffectiveAllowance(c));
  const incomeUsage     = useMemo(() => getIncomeAllocationUsage(incomes, categories), [incomes, categories]);
  const incomeMap       = useMemo(() => new Map(incomes.map(income => [Number(income.id), income])), [incomes]);
  const fundingIssueCats = categories.filter(cat => {
    const allocations = normalizeIncomeAllocations(cat.incomeAllocations);
    const total = getAllocationPercentTotal(allocations);
    return incomes.length > 0 && (Math.abs(total - 100) > 0.01 || allocations.some(a => !incomeMap.has(a.incomeId)));
  });
  const overAllocatedIncomes = incomes.filter(income => (incomeUsage[String(income.id)] || 0) > (income.amount || 0) + 0.005);

  const safeToSpend = useMemo(
    () => getSafeToSpend({ categories, incomes, subscriptions, settings, goalCommitment }),
    [categories, incomes, subscriptions, settings, goalCommitment],
  );

  const comparison = useMemo(
    () => getCycleComparison(transactions, categories, incomes, settings),
    [transactions, categories, incomes, settings],
  );

  const recentTxs = useMemo(() => {
    const catMap = Object.fromEntries(categories.map(c => [c.id, c]));
    return transactions.slice(0, 10).map(tx => ({ ...tx, cat: catMap[tx.categoryId] }));
  }, [transactions, categories]);

  const visibleIncomes = showAllIncomes ? incomes : incomes.slice(0, 4);
  const visibleCategories = showAllCategories ? categories : categories.slice(0, 5);
  const hiddenIncomeCount = Math.max(0, incomes.length - visibleIncomes.length);
  const hiddenCategoryCount = Math.max(0, categories.length - visibleCategories.length);

  const spendPct   = totalEffective > 0 ? Math.min(100, (totalSpent / totalEffective) * 100) : 0;
  const spendColor = spendPct > 90 ? 'var(--danger)' : spendPct > 70 ? 'var(--warn)' : 'var(--good)';

  const isNewUser = incomes.length === 0 && categories.length === 0 && transactions.length === 0;

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* ── First-run onboarding ── */}
      {isNewUser && onRunWizard && !wizardDismissed && (
        <Wizard onComplete={onRunWizard} onSkip={() => setWizardDismissed(true)} />
      )}
      {isNewUser && (!onRunWizard || wizardDismissed) && (
        <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '24px', borderColor: 'rgba(79,255,176,0.28)', background: 'rgba(79,255,176,0.05)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <Sparkles size={18} color="var(--accent-mint)" aria-hidden="true" />
            <CardTitle as="h2">Welcome to Finesse</CardTitle>
          </div>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '0 0 16px', lineHeight: 1.6 }}>
            Set up your budget in three quick steps. Start by adding the income you want to budget from.
          </p>
          <ol style={{ margin: '0 0 18px', paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[
              ['1', 'Add an income source', 'Tell Finesse what you earn and how often.'],
              ['2', 'Create budget categories', 'Split your income into spending allowances.'],
              ['3', 'Log expenses', 'Track spending and see what is left in real time.'],
            ].map(([n, title, desc]) => (
              <li key={n} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <span style={{ flexShrink: 0, width: 24, height: 24, borderRadius: '50%', background: 'rgba(79,255,176,0.15)', color: 'var(--accent-mint)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700 }}>{n}</span>
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>{title}</span>
                  <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginTop: 1 }}>{desc}</span>
                </span>
              </li>
            ))}
          </ol>
          <button className="btn-primary mobile-full" onClick={onAddIncome}>
            Add your first income
          </button>
        </div>
      )}

      {/* ── Safe to spend ──
          The question the app is actually for. Everything else on this page is
          a component of this number; none of them answered it directly. */}
      {categories.length > 0 && (
        <div className="glass safe-to-spend" style={{ borderRadius: 18 }}>
          <div className="safe-to-spend-main">
            <div style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 5 }}>
              Safe to spend today
            </div>
            <div className="font-display" style={{ fontSize: 40, lineHeight: 1.05, color: safeToSpend.today > 0 ? 'var(--good)' : 'var(--danger)' }}>
              {fmt(safeToSpend.today)}
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 6, lineHeight: 1.6 }}>
              {fmt(safeToSpend.week)} this week · {fmt(safeToSpend.toReset)} until reset
              {safeToSpend.daysToReset != null && (
                <> · {safeToSpend.daysToReset} day{safeToSpend.daysToReset === 1 ? '' : 's'} left</>
              )}
            </div>
          </div>

          {(safeToSpend.committedSubscriptions > 0 || safeToSpend.committedGoals > 0) && (
            <div className="safe-to-spend-reserved">
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Already spoken for</div>
              {safeToSpend.committedSubscriptions > 0 && (
                <div style={{ fontSize: 12, color: 'var(--accent-purple)' }}>
                  {fmt(safeToSpend.committedSubscriptions)} subscriptions
                </div>
              )}
              {safeToSpend.committedGoals > 0 && (
                <div style={{ fontSize: 12, color: 'var(--accent-blue)' }}>
                  {fmt(safeToSpend.committedGoals)} savings
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Budget Summary ── */}
      <div className="glass dashboard-summary-card">
        <div className="dashboard-summary-grid">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 5, flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                {INCOME_PERIOD_LABEL[incomePeriod]} Income
              </span>
              <div role="group" aria-label="Income period" style={{ display: 'flex', gap: 4 }}>
                {['week', 'month', 'year'].map(period => (
                  <button key={period} type="button" aria-pressed={incomePeriod === period}
                    onClick={() => setIncomePeriod(period)}
                    style={{
                      padding: '2px 8px', fontSize: 10, borderRadius: 7, cursor: 'pointer',
                      fontFamily: 'DM Sans, sans-serif', textTransform: 'capitalize',
                      border: '1px solid ' + (incomePeriod === period ? 'rgba(79,255,176,0.4)' : 'transparent'),
                      background: incomePeriod === period ? 'rgba(79,255,176,0.12)' : 'rgba(255,255,255,0.05)',
                      color: incomePeriod === period ? 'var(--accent-mint)' : 'var(--text-muted)',
                    }}>
                    {period}
                  </button>
                ))}
              </div>
            </div>
            <div className="font-display dashboard-summary-value" style={{ color: 'var(--accent-mint)' }}>{fmt(monthlyIncome)}</div>
            <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>
              {fmt(monthlyAllocated)} allocated · {fmt(roundMoney(monthlyIncome - monthlyAllocated))} unallocated
              {totalAdded > 0 ? ` · ${fmt(totalAdded)} added` : ''}
            </div>
            {mixedFrequencies && (
              <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 3 }}>
                Converted to a monthly rate — your income sources pay on different schedules.
              </div>
            )}
          </div>

          <div>
            <div style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 700, marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Budget Remaining</div>
            <div className="font-display dashboard-summary-value" style={{ color: totalLeft < 0 ? 'var(--danger)' : 'var(--text-primary)' }}>{fmt(totalLeft)}</div>
            <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>
              {fmt(totalSpent)} spent · {spendPct.toFixed(0)}%
            </div>
          </div>
        </div>

        <div className="dashboard-summary-bars">
          {monthlyIncome > 0 && (
            <div>
              <div style={{ display: 'flex', height: 6, borderRadius: 99, overflow: 'hidden', background: 'rgba(255,255,255,0.06)', gap: 1 }}>
                {categories.filter(c => (c.allowance || 0) > 0).map(cat => {
                  const monthlyShare = getNormalisedCategoryAllowance(cat, incomes, incomePeriod);
                  return (
                    <div key={cat.id} title={`${cat.name}: ${fmt(monthlyShare)}/${incomePeriod}`}
                      style={{ width: `${Math.min(100, (monthlyShare / monthlyIncome) * 100)}%`, background: cat.color || 'var(--accent-blue)', height: '100%', minWidth: 2 }} />
                  );
                })}
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 4 }}>
                {monthlyAllocated > monthlyIncome
                  ? <span style={{ color: 'var(--danger)' }}>⚠ {allocatedPct.toFixed(0)}% over-allocated</span>
                  : `${allocatedPct.toFixed(0)}% of income allocated`}
              </div>
            </div>
          )}
          <div>
            <div className="progress-track" style={{ height: 6 }}>
              <div className="progress-fill" style={{ width: `${spendPct}%`, background: spendColor }} />
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 4 }}>Allowance spent</div>
          </div>
        </div>
      </div>

      {/* ── Over-budget alerts ── */}
      {overBudgetCats.length > 0 && (
        <div className="glass" style={{ borderRadius: 14, padding: '14px 18px', borderColor: 'rgba(255,107,138,0.3)', background: 'rgba(255,107,138,0.06)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--danger)', fontSize: 13, fontWeight: 600, marginBottom: overBudgetCats.length > 0 ? 10 : 0 }}>
            <AlertCircle size={15} aria-hidden="true" />
            Over budget
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {overBudgetCats.map(c => {
              const over = (c.spent || 0) - getEffectiveAllowance(c);
              return (
                <div key={c.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ minWidth: 0 }}>
                    <span style={{ fontSize: 13, fontWeight: 500 }}>{c.name}</span>
                    <span style={{ fontSize: 11, color: 'var(--danger)', marginLeft: 8 }}>
                      +{fmt(over)} over allowance
                    </span>
                  </div>
                  {onAdjust && (
                    <button
                      className="btn-secondary"
                      onClick={() => onAdjust(c.id)}
                      style={{ padding: '5px 12px', fontSize: 11, flexShrink: 0, borderColor: 'rgba(255,107,138,0.4)', color: 'var(--danger)' }}>
                      Fix
                    </button>
                  )}
                </div>
              );
            })}
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
      <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '22px 24px' }}>
        <div className="mobile-row-stack" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, gap: 12 }}>
          <CardTitle as="h2">Income Sources</CardTitle>
          <div className="mobile-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button className="btn-secondary" onClick={onAddOneOffIncome}
              style={{ padding: '7px 12px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Gift size={12} /> One-Off
            </button>
            <button className="btn-primary" onClick={onAddIncome} style={{ padding: '7px 14px', fontSize: 12 }}>
              + Add Income
            </button>
          </div>
        </div>
        {incomes.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 14, textAlign: 'center', padding: '20px 0' }}>
            No income sources yet — add one to track your earnings
          </div>
        ) : (
          <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {visibleIncomes.map(income => {
              const freq = income.resetFrequency || (income.payDayOfMonth ? 'monthly' : null);
              const nextPay = freq
                ? calcNextReset(freq, income.payDayOfMonth, income.lastPaid ? new Date(income.lastPaid) : new Date())
                : null;
              const used = incomeUsage[String(income.id)] || 0;
              const free = (income.amount || 0) - used;
              const usedPct = income.amount > 0 ? Math.min(100, (used / income.amount) * 100) : 0;
              return (
                <div key={income.id} className="dashboard-income-row">
                  <div className="dashboard-income-main">
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
                    <div className="progress-track dashboard-income-progress" style={{ height: 4, marginTop: 7 }}>
                      <div className="progress-fill" style={{ width: `${usedPct}%`, background: free < 0 ? 'var(--danger)' : 'var(--accent-mint)' }} />
                    </div>
                  </div>
                  <div className="dashboard-income-side">
                    <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--accent-mint)' }}>
                      {fmt(income.amount || 0)}
                    </span>
                    <div className="dashboard-income-actions">
                      <button className="btn-secondary dashboard-income-quick" onClick={() => onIncomeFastForward(income.id)}>
                        <Zap size={11} /> Early
                      </button>
                      <button className="btn-secondary dashboard-income-quick" onClick={() => onIncomeHoldToggle(income.id)}>
                        <Clock size={11} /> {income.holdActive ? 'Unhold' : 'Hold'}
                      </button>
                    </div>
                    <div className="dashboard-income-icon-actions">
                      <IconButton onClick={() => onEditIncome(income)} label={`Edit ${income.name}`}
                        size={28} style={{ opacity: 0.65 }}>
                        <Pencil size={12} />
                      </IconButton>
                      <IconButton onClick={() => onDeleteIncome(income)} label={`Delete ${income.name}`}
                        size={28} style={{ opacity: 0.5 }}>
                        <Trash2 size={12} />
                      </IconButton>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {hiddenIncomeCount > 0 || showAllIncomes ? (
            <button className="btn-secondary" onClick={() => setShowAllIncomes(v => !v)}
              style={{ marginTop: 12, width: '100%', padding: '8px 12px', fontSize: 12 }}>
              {showAllIncomes ? 'Show fewer incomes' : `Show ${hiddenIncomeCount} more income${hiddenIncomeCount === 1 ? '' : 's'}`}
            </button>
          ) : null}
          </>
        )}
      </div>

      {/* ── Category Breakdown ── */}
      <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '22px 24px' }}>
        <div className="mobile-row-stack" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, gap: 12 }}>
          <CardTitle as="h2">Category Breakdown</CardTitle>
          <div className="mobile-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn-secondary" onClick={onAddCategory} disabled={incomes.length === 0}
              title={incomes.length === 0 ? 'Add an income before creating categories' : 'Add category'}
              style={{ padding: '7px 14px', fontSize: 12 }}>
              + Category
            </button>
            <button className="btn-secondary" onClick={onAddSubscription} disabled={categories.length === 0}
              title={categories.length === 0 ? 'Add a category before creating subscriptions' : 'Add subscription'}
              style={{ padding: '7px 12px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
              <CreditCard size={12} /> Subscription
            </button>
            <button className="btn-primary" onClick={onAddTx} style={{ padding: '7px 14px', fontSize: 12 }}>
              + Log Expense
            </button>
          </div>
        </div>
        {categories.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 14, textAlign: 'center', padding: '20px 0' }}>
            {incomes.length === 0 ? 'Add an income first, then create funded categories.' : 'No categories yet — add one above'}
          </div>
        ) : (
          <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {visibleCategories.map(cat => {
              const effAllowance = getEffectiveAllowance(cat);
              const boost    = roundMoney(cat.temporaryBoost || 0);
              const pct      = effAllowance > 0 ? Math.min(100, ((cat.spent || 0) / effAllowance) * 100) : 0;
              const left     = effAllowance - (cat.spent || 0);
              // A rollover category doesn't zero at reset, so "spare this cycle"
              // is the wrong frame for it: what's left is an accumulating
              // balance, and the pacing tags that measure a cycle's progress
              // say nothing useful about a pot being saved into.
              const isRollover = Boolean(cat.rolloverEnabled);
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
              const catAllocFreqs = [...new Set(
                allocations.map(a => incomeMap.get(a.incomeId)?.resetFrequency).filter(Boolean)
              )];
              const catCycleDays = catAllocFreqs.length === 1 ? getIncomeCycleDays(catAllocFreqs[0]) : null;
              const pacedStatus = isRollover ? null : getPacedAllowanceStatus(cat, undefined, catCycleDays);
              // Both of these are cycle-bound, and this category's cycle follows
              // the income funding it — not the account-wide pay day.
              const catCycle = getCategoryCycle(cat, incomes, settings);
              const catSubCost = getUpcomingSubscriptionCost(subscriptions, cat.id, settings, undefined, catCycle.end);
              const projectedLeft = roundMoney(left - catSubCost);
              const cumulativeOverspend = isRollover ? 0 : getCumulativeOverspend(cat.id, cat.allowance, transactions, {
                freq: catCycle.freq,
                payDayOfMonth: settings?.payDayOfMonth,
                anchor: catCycle.start,
              });
              return (
                <div key={cat.id}>
                  <div className="mobile-row-stack" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: cat.color || 'var(--accent-blue)', flexShrink: 0 }} />
                      <div style={{ minWidth: 0 }}>
                        {onOpenCategory ? (
                          <button type="button" onClick={() => onOpenCategory(cat.id)}
                            title={`Open ${cat.name}`}
                            style={{
                              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                              fontSize: 13, fontWeight: 500, color: 'var(--text-primary)',
                              fontFamily: 'DM Sans, sans-serif', textAlign: 'left',
                            }}>
                            {cat.name}
                          </button>
                        ) : (
                          <span style={{ fontSize: 13, fontWeight: 500 }}>{cat.name}</span>
                        )}
                        {(allocations.length > 0 || cat.resetFrequency || cat.allowanceFormula || pacedStatus || boost !== 0 || !fundingOk || catSubCost > 0 || cumulativeOverspend !== 0) && (
                          <div style={{ display: 'flex', gap: 5, marginTop: 2, flexWrap: 'wrap' }}>
                            {boost > 0 && (
                              <span title="Extra budget added for this cycle — clears at next reset" style={{
                                fontSize: 10, color: 'var(--accent-mint)', background: 'rgba(79,255,176,0.12)',
                                padding: '1px 6px', borderRadius: 10,
                              }}>
                                +{fmt(boost)} added
                              </span>
                            )}
                            {roundMoney(cat.rolloverBalance || 0) !== 0 && (
                              <span title="Carried over from previous cycles" style={{
                                fontSize: 10,
                                color: (cat.rolloverBalance || 0) > 0 ? 'var(--accent-blue)' : 'var(--danger)',
                                background: (cat.rolloverBalance || 0) > 0 ? 'rgba(93,184,255,0.12)' : 'rgba(255,107,138,0.1)',
                                padding: '1px 6px', borderRadius: 10,
                              }}>
                                {(cat.rolloverBalance || 0) > 0 ? '+' : '−'}{fmt(Math.abs(cat.rolloverBalance))} rolled over
                              </span>
                            )}
                            {boost < 0 && (
                              <span title="Lent to another category this cycle — restored at next reset" style={{
                                fontSize: 10, color: 'var(--warn)', background: 'rgba(251,191,112,0.12)',
                                padding: '1px 6px', borderRadius: 10,
                              }}>
                                −{fmt(Math.abs(boost))} lent
                              </span>
                            )}
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
                            {pacedStatus && (
                              <span style={{
                                fontSize: 10,
                                color: pacedStatus.availablePerPeriod >= pacedStatus.amount ? 'var(--good)' : pacedStatus.availablePerPeriod > 0 ? 'var(--warn)' : 'var(--danger)',
                                background: 'rgba(255,255,255,0.06)',
                                padding: '1px 6px',
                                borderRadius: 10,
                              }}>
                                {fmt(Math.max(0, pacedStatus.availablePerPeriod))}/{pacedStatus.periodLabel}
                              </span>
                            )}
                            {pacedStatus && pacedStatus.paceBalance !== 0 && (
                              <span style={{
                                fontSize: 10,
                                color: pacedStatus.paceBalance > 0 ? 'var(--good)' : 'var(--danger)',
                                background: pacedStatus.paceBalance > 0 ? 'rgba(79,255,176,0.12)' : 'rgba(255,107,138,0.1)',
                                padding: '1px 6px',
                                borderRadius: 10,
                              }}>
                                {pacedStatus.paceBalance > 0 ? '+' : ''}{fmt(pacedStatus.paceBalance)} {pacedStatus.paceBalance > 0 ? 'ahead' : 'behind'}
                              </span>
                            )}
                            {catSubCost > 0 && (
                              <span title={`${fmt(catSubCost)} in upcoming subscriptions this period`} style={{
                                fontSize: 10,
                                color: projectedLeft >= 0 ? 'var(--accent-purple)' : 'var(--danger)',
                                background: projectedLeft >= 0 ? 'rgba(167,139,250,0.12)' : 'rgba(255,107,138,0.1)',
                                padding: '1px 6px',
                                borderRadius: 10,
                              }}>
                                {fmt(Math.abs(projectedLeft))} {projectedLeft >= 0 ? 'left after subs' : 'over after subs'}
                              </span>
                            )}
                            {cumulativeOverspend !== 0 && (
                              <span title="Running total of over/underspend vs allowance across all budget cycles" style={{
                                fontSize: 10,
                                color: cumulativeOverspend > 0 ? 'var(--danger)' : 'var(--good)',
                                background: cumulativeOverspend > 0 ? 'rgba(255,107,138,0.1)' : 'rgba(79,255,176,0.12)',
                                padding: '1px 6px',
                                borderRadius: 10,
                              }}>
                                {cumulativeOverspend > 0 ? '+' : '-'}{fmt(Math.abs(cumulativeOverspend))} all-time
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="mobile-actions" style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', gap: 10, fontSize: 12, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        <span style={{ color: 'var(--text-muted)' }}>{fmt(cat.spent || 0)} / {fmt(effAllowance)}</span>
                        <span title={isRollover
                          ? 'Accumulated balance — this category carries its money across cycles'
                          : 'Left to spend before the next reset'}
                          style={{ color: left < 0 ? 'var(--danger)' : 'var(--text-secondary)', fontWeight: 500, minWidth: 56, textAlign: 'right' }}>
                          {left < 0 ? '-' : ''}{fmt(Math.abs(left))} {isRollover ? 'balance' : 'left'}
                        </span>
                      </div>
                      {onAdjust && (
                        <IconButton onClick={() => onAdjust(cat.id)} label={`Adjust ${cat.name}`} size={28} style={{ opacity: 0.6 }}>
                          <SlidersHorizontal size={12} />
                        </IconButton>
                      )}
                      <IconButton onClick={() => onEditCategory(cat)} label={`Edit ${cat.name}`} size={28} style={{ opacity: 0.6 }}>
                        <Pencil size={12} />
                      </IconButton>
                      <IconButton onClick={() => onDeleteCategory(cat.id)} label={`Delete ${cat.name}`} size={28} style={{ opacity: 0.5 }}>
                        <Trash2 size={12} />
                      </IconButton>
                    </div>
                  </div>
                  <div className="progress-track">
                    <div className="progress-fill" style={{ width: `${pct}%`, background: barColor }} />
                  </div>
                </div>
              );
            })}
          </div>
          {hiddenCategoryCount > 0 || showAllCategories ? (
            <button className="btn-secondary" onClick={() => setShowAllCategories(v => !v)}
              style={{ marginTop: 12, width: '100%', padding: '8px 12px', fontSize: 12 }}>
              {showAllCategories ? 'Show fewer categories' : `Show ${hiddenCategoryCount} more categor${hiddenCategoryCount === 1 ? 'y' : 'ies'}`}
            </button>
          ) : null}
          </>
        )}
      </div>

      {/* ── This cycle vs last ──
           A total on its own says nothing about whether it's good or bad.
           Compared against the same point last cycle, it does. */}
      {comparison.previousTotal > 0 && (
        <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '22px 24px' }}>
          <div className="mobile-row-stack" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
            <CardTitle as="h2">This Cycle vs Last</CardTitle>
            <span style={{ fontSize: 13, fontWeight: 700, color: comparison.change > 0 ? 'var(--danger)' : 'var(--good)' }}>
              {comparison.change > 0 ? '+' : '−'}{fmt(Math.abs(comparison.change))}
              {comparison.changePct != null && ` (${comparison.change > 0 ? '+' : ''}${comparison.changePct.toFixed(0)}%)`}
            </span>
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 14 }}>
            {fmt(comparison.currentTotal)} so far · {fmt(comparison.previousTotal)} over the previous cycle
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {comparison.categories.filter(row => row.change !== 0).slice(0, 5).map(row => (
              <div key={row.id} className="cycle-compare-row">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: row.color || 'var(--accent-blue)', flexShrink: 0 }} />
                  <span style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name}</span>
                </div>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                  {fmt(row.previous)} → {fmt(row.current)}
                </span>
                <span style={{ fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', color: row.change > 0 ? 'var(--danger)' : 'var(--good)' }}>
                  {row.change > 0 ? '+' : '−'}{fmt(Math.abs(row.change))}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Recent Transactions ── */}
      {recentTxs.length > 0 && (
        <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '22px 24px' }}>
          <CardTitle as="h2" style={{ marginBottom: 14 }}>Recent Transactions</CardTitle>
          <div style={{ maxHeight: 400, overflowY: 'auto', paddingRight: 4, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {recentTxs.map(tx => {
              const refund = isRefund(tx);
              return (
                <div key={tx.id} className="mobile-list-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'rgba(255,255,255,0.04)', borderRadius: 10 }}>
                  <div className="mobile-list-main" style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: tx.cat?.color || 'var(--accent-blue)', flexShrink: 0 }} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tx.note || tx.cat?.name || 'Expense'}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{tx.cat?.name} · {format(new Date(tx.date), 'd MMM')}</div>
                    </div>
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: refund ? 'var(--good)' : 'var(--accent-warm)', flexShrink: 0 }}>
                    {refund ? '+' : '-'}{fmt(tx.amount)}
                  </div>
                  {/* Spotting a mistake here and having to go elsewhere to fix
                      it was the most common dead end on this page. */}
                  {onEditTransaction && (
                    <IconButton onClick={() => onEditTransaction(tx)} size={28} style={{ opacity: 0.6, flexShrink: 0 }}
                      label={`Edit ${tx.note || tx.cat?.name || 'expense'}`}>
                      <Pencil size={12} />
                    </IconButton>
                  )}
                  {onDeleteTransaction && (
                    <IconButton onClick={() => onDeleteTransaction(tx)} size={28} style={{ opacity: 0.5, flexShrink: 0 }}
                      label={`Delete ${tx.note || tx.cat?.name || 'expense'}`}>
                      <Trash2 size={12} />
                    </IconButton>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

    </div>
  );
}
