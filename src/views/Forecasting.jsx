import { useMemo } from 'react';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend
} from 'recharts';
import { differenceInDays, format, startOfDay } from 'date-fns';
import {
  fmt,
  buildMonthlyHistory,
  getProjectedSpend,
  getDailyBurnRate,
  daysUntilReset,
  projectedEndBalance,
  calcNextReset,
  getCategoryIncomeAllocationAmount,
  normalizeIncomeAllocations,
} from '../utils';

const COLORS = ['#4fffb0', '#5db8ff', '#c084fc', '#fbbf70', '#ff6b8a', '#67e8f9', '#a78bfa'];
const FREQ_LABEL = { weekly: 'Weekly', fortnightly: 'Fortnightly', '4weekly': 'Every 4 weeks', monthly: 'Monthly' };

function getNextIncomeReset(income, categories, now = new Date()) {
  const freq = income.resetFrequency || (income.payDayOfMonth ? 'monthly' : null);
  const linkedCategories = categories.filter(cat =>
    normalizeIncomeAllocations(cat.incomeAllocations)
      .some(allocation => allocation.incomeId === Number(income.id))
  );

  const allocated = linkedCategories.reduce(
    (sum, cat) => sum + getCategoryIncomeAllocationAmount(cat, income.id),
    0
  );

  if (!freq) {
    return { income, freq: null, linkedCategories, allocated, held: income.holdActive, next: null, days: null };
  }

  let next = calcNextReset(freq, income.payDayOfMonth, income.lastPaid ? new Date(income.lastPaid) : now);
  let guard = 0;
  while (next <= now && guard < 120) {
    next = calcNextReset(freq, income.payDayOfMonth, next);
    guard += 1;
  }

  return {
    income,
    freq,
    linkedCategories,
    allocated,
    held: income.holdActive,
    next,
    days: Math.max(0, differenceInDays(startOfDay(next), startOfDay(now))),
  };
}

const GlassTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: 'rgba(18,26,48,0.95)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 12, padding: '10px 14px', fontSize: 12 }}>
      <div style={{ color: 'var(--text-muted)', marginBottom: 6, fontWeight: 600 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color, marginBottom: 2 }}>
          {p.name}: <strong>{fmt(Number(p.value))}</strong>
        </div>
      ))}
    </div>
  );
};

const PieTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  return (
    <div style={{ background: 'rgba(18,26,48,0.95)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 10, padding: '8px 12px', fontSize: 12 }}>
      <span style={{ color: p.payload.color }}>{p.name}</span>
      <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>{fmt(p.value)}</span>
    </div>
  );
};

export default function Forecasting({ categories, settings, transactions, incomes = [] }) {
  const monthlyHistory = useMemo(() => buildMonthlyHistory(transactions, categories), [transactions, categories]);
  const projectedSpend = useMemo(() => getProjectedSpend(categories, settings), [categories, settings]);
  const dailyBurnRate  = useMemo(() => getDailyBurnRate(categories, settings), [categories, settings]);
  const legacyDays     = daysUntilReset(settings);
  const projBalance    = projectedEndBalance(categories, settings, incomes);

  const incomeResetSchedule = useMemo(() => (
    incomes
      .map(income => getNextIncomeReset(income, categories))
      .sort((a, b) => {
        if (a.held !== b.held) return a.held ? 1 : -1;
        if (!a.next && !b.next) return a.income.name.localeCompare(b.income.name);
        if (!a.next) return 1;
        if (!b.next) return -1;
        return a.next - b.next;
      })
  ), [incomes, categories]);
  const nextIncomeReset = incomeResetSchedule.find(entry => !entry.held && entry.next);

  const totalIncome     = incomes.length > 0 ? incomes.reduce((s, i) => s + (i.amount || 0), 0) : (settings?.income || 0);
  const totalAllowances = categories.reduce((s, c) => s + (c.allowance || 0), 0);
  const totalSpent      = categories.reduce((s, c) => s + (c.spent || 0), 0);
  const spentPct        = totalAllowances > 0 ? (totalSpent / totalAllowances) * 100 : 0;
  const spentColor      = spentPct > 90 ? '#ff6b8a' : spentPct > 70 ? '#fbbf70' : '#4fffb0';

  // Pie 1: budget used vs remaining
  const budgetDonutData = [
    { name: 'Spent',     value: totalSpent,                                   color: spentColor },
    { name: 'Remaining', value: Math.max(0, totalAllowances - totalSpent),    color: 'rgba(255,255,255,0.08)' },
  ];

  // Pie 2: per-category allowance allocation
  const allocationData = categories
    .filter(c => (c.allowance || 0) > 0)
    .map((c, i) => ({ name: c.name, value: c.allowance || 0, color: c.color || COLORS[i % COLORS.length] }));

  // Projected vs allowance bar chart data
  const projVsAllowance = categories.map((cat, i) => ({
    name: cat.name,
    Allowance: cat.allowance || 0,
    Spent: cat.spent || 0,
    Projected: Number((projectedSpend[cat.id] || 0).toFixed(2)),
    color: COLORS[i % COLORS.length],
  }));

  // Daily burn rate data
  const burnData = categories.map((cat, i) => ({
    name: cat.name,
    'Daily Rate': Number((dailyBurnRate[cat.id] || 0).toFixed(2)),
    color: COLORS[i % COLORS.length],
  })).filter(d => d['Daily Rate'] > 0);

  const totalDailyBurn = Object.values(dailyBurnRate).reduce((a, b) => a + b, 0);

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* ── Key projections ── */}
      <div className="mobile-stack" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14 }}>
        <div className="glass" style={{ borderRadius: 16, padding: '18px 20px' }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Daily Burn Rate</div>
          <div className="font-display" style={{ fontSize: 28, color: 'var(--accent-warm)' }}>{fmt(totalDailyBurn)}</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>across all categories</div>
        </div>
        <div className="glass" style={{ borderRadius: 16, padding: '18px 20px' }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Next Income Reset</div>
          <div className="font-display" style={{ fontSize: 28, color: 'var(--accent-blue)' }}>
            {nextIncomeReset ? `${nextIncomeReset.days}d` : (incomes.length > 0 ? '—' : (legacyDays ?? '—'))}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
            {nextIncomeReset
              ? `${nextIncomeReset.income.name} · ${format(nextIncomeReset.next, 'd MMM')}`
              : incomes.length > 0 ? 'income resets are held or unscheduled' : 'legacy schedule'}
          </div>
        </div>
        <div className="glass" style={{ borderRadius: 16, padding: '18px 20px' }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Projected End Balance</div>
          <div className="font-display" style={{ fontSize: 28, color: projBalance >= 0 ? 'var(--good)' : 'var(--danger)' }}>
            {projBalance >= 0 ? '+' : ''}{fmt(projBalance)}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>at current burn rate</div>
        </div>
      </div>

      {/* ── Income reset schedule ── */}
      {incomeResetSchedule.length > 0 && (
        <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '20px 22px' }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Income Reset Schedule</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 14 }}>
            Category spend resets follow the income source that funds each category.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {incomeResetSchedule.map((entry, i) => (
              <div key={entry.income.id} className="mobile-stack" style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                gap: 12,
                alignItems: 'center',
                padding: '10px 12px',
                borderRadius: 12,
                background: 'rgba(255,255,255,0.04)',
                border: entry.held ? '1px solid rgba(251,191,112,0.18)' : '1px solid transparent',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
                  <span style={{ width: 9, height: 9, borderRadius: '50%', background: COLORS[i % COLORS.length], flexShrink: 0 }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {entry.income.name}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {entry.freq ? FREQ_LABEL[entry.freq] : 'No schedule'}
                      {entry.held && <span style={{ color: 'var(--warn)' }}> · Held</span>}
                    </div>
                  </div>
                </div>
                <div style={{ fontSize: 12, color: entry.next && !entry.held ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
                  {entry.next && !entry.held
                    ? `${format(entry.next, 'd MMM yyyy')} · ${entry.days}d`
                    : entry.held ? 'Reset held' : 'Not scheduled'}
                </div>
                <div className="mobile-center-left" style={{ fontSize: 12, textAlign: 'right', color: 'var(--text-muted)' }}>
                  <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{fmt(entry.allocated)}</span>
                  {' '}across {entry.linkedCategories.length} categor{entry.linkedCategories.length === 1 ? 'y' : 'ies'}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Pie charts ── */}
      {(totalAllowances > 0 || allocationData.length > 0) && (
        <div className="mobile-stack" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>

          {/* Donut: budget used vs remaining */}
          {totalAllowances > 0 && (
            <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '22px 24px' }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Budget Usage</div>
              <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 16 }}>Spent vs remaining allowance</div>
              <div style={{ position: 'relative' }}>
                <ResponsiveContainer width="100%" height={190}>
                  <PieChart>
                    <Pie
                      data={budgetDonutData}
                      cx="50%" cy="50%"
                      innerRadius={62} outerRadius={82}
                      startAngle={90} endAngle={-270}
                      dataKey="value"
                      strokeWidth={0}
                    >
                      {budgetDonutData.map((entry, i) => (
                        <Cell key={i} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip content={<PieTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
                {/* Center label */}
                <div style={{
                  position: 'absolute', top: '50%', left: '50%',
                  transform: 'translate(-50%, -50%)',
                  textAlign: 'center', pointerEvents: 'none',
                }}>
                  <div className="font-display" style={{ fontSize: 22, color: spentColor, letterSpacing: '-0.02em' }}>
                    {spentPct.toFixed(0)}%
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>used</div>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'center', gap: 20, marginTop: 8, flexWrap: 'wrap' }}>
                {budgetDonutData.map(d => (
                  <div key={d.name} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: d.color, flexShrink: 0 }} />
                    <span style={{ color: 'var(--text-muted)' }}>{d.name}</span>
                    <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>{fmt(d.value)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Pie: category allocation */}
          {allocationData.length > 0 && (
            <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '22px 24px' }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Category Allocation</div>
              <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 16 }}>How allowance is split across categories</div>
              <div className="mobile-row-stack" style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                <div style={{ flexShrink: 0 }}>
                  <ResponsiveContainer width={150} height={150}>
                    <PieChart>
                      <Pie
                        data={allocationData}
                        cx="50%" cy="50%"
                        outerRadius={68}
                        dataKey="value"
                        strokeWidth={0}
                        paddingAngle={2}
                      >
                        {allocationData.map((entry, i) => (
                          <Cell key={i} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip content={<PieTooltip />} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                  {allocationData.map(entry => {
                    const pct = totalAllowances > 0 ? ((entry.value / totalAllowances) * 100).toFixed(0) : 0;
                    return (
                      <div key={entry.name} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12 }}>
                        <div style={{ width: 8, height: 8, borderRadius: '50%', background: entry.color, flexShrink: 0 }} />
                        <span style={{ color: 'var(--text-secondary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {entry.name}
                        </span>
                        <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{pct}%</span>
                        <span style={{ fontWeight: 600, color: 'var(--text-primary)', flexShrink: 0, minWidth: 48, textAlign: 'right' }}>
                          {fmt(entry.value)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
              {totalIncome > 0 && (
                <div style={{ marginTop: 18, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 14 }}>
                  <div style={{ display: 'flex', height: 7, borderRadius: 99, overflow: 'hidden', background: 'rgba(255,255,255,0.06)', gap: 1 }}>
                    {allocationData.map(entry => (
                      <div key={entry.name} title={`${entry.name}: ${fmt(entry.value)}`}
                        style={{ width: `${Math.min(100, (entry.value / totalIncome) * 100)}%`, background: entry.color, height: '100%', minWidth: 2 }} />
                    ))}
                  </div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 5 }}>
                    {totalAllowances > totalIncome
                      ? <span style={{ color: 'var(--danger)' }}>⚠ {((totalAllowances / totalIncome) * 100).toFixed(0)}% — over-allocated</span>
                      : `${((totalAllowances / totalIncome) * 100).toFixed(0)}% of income allocated to categories`}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Projected vs Allowance ── */}
      {projVsAllowance.length > 0 && (
        <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '22px 24px' }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Projected Spend vs Allowance</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 20 }}>Where you'll end up this period if spending continues at current rate</div>
          <div className="mobile-chart-scroll">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={projVsAllowance} barGap={4} barCategoryGap="30%">
                <CartesianGrid vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={v => `£${v}`} />
                <Tooltip content={<GlassTooltip />} />
                <Legend wrapperStyle={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }} />
                <Bar dataKey="Allowance" fill="rgba(255,255,255,0.1)" radius={[6,6,0,0]} />
                <Bar dataKey="Spent"     fill="#5db8ff"              radius={[6,6,0,0]} />
                <Bar dataKey="Projected" fill="#fbbf70" opacity={0.7} radius={[6,6,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* ── Monthly history ── */}
      {monthlyHistory.length > 1 && (
        <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '22px 24px' }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Spend History by Category</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 20 }}>Last 6 months</div>
          <div className="mobile-chart-scroll">
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={monthlyHistory}>
                <defs>
                  {categories.map((cat, i) => (
                    <linearGradient key={cat.id} id={`grad-${cat.id}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor={COLORS[i % COLORS.length]} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={COLORS[i % COLORS.length]} stopOpacity={0.02} />
                    </linearGradient>
                  ))}
                </defs>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="month" />
                <YAxis tickFormatter={v => `£${v}`} />
                <Tooltip content={<GlassTooltip />} />
                <Legend wrapperStyle={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }} />
                {categories.map((cat, i) => (
                  <Area key={cat.id} type="monotone" dataKey={cat.name}
                    stroke={COLORS[i % COLORS.length]} strokeWidth={2}
                    fill={`url(#grad-${cat.id})`} />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* ── Daily burn rate ── */}
      {burnData.length > 0 && (
        <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '22px 24px' }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Daily Burn Rate by Category</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 20 }}>Average spend per day this period</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {burnData.map(d => (
              <div key={d.name} className="mobile-row-stack" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 120, fontSize: 13, color: 'var(--text-secondary)', flexShrink: 0 }}>{d.name}</div>
                <div style={{ flex: 1 }}>
                  <div className="progress-track">
                    <div className="progress-fill" style={{
                      width: `${Math.min(100, (d['Daily Rate'] / Math.max(...burnData.map(x => x['Daily Rate']))) * 100)}%`,
                      background: d.color,
                    }} />
                  </div>
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: d.color, width: 60, textAlign: 'right', flexShrink: 0 }}>
                  {fmt(d['Daily Rate'])}/d
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {transactions.length === 0 && (
        <div className="glass" style={{ borderRadius: 16, padding: '40px 24px', textAlign: 'center' }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>
            Log some expenses to see forecasting data.
          </div>
        </div>
      )}
    </div>
  );
}
