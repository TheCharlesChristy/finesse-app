import { useMemo, useState } from 'react';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, ReferenceLine,
  ComposedChart, LineChart, Line,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend
} from 'recharts';
import { Activity, AlertTriangle, Check, History, TrendingUp, Wallet } from 'lucide-react';
import { differenceInDays, format, startOfDay } from 'date-fns';
import {
  fmt,
  buildMonthlyHistory,
  daysUntilReset,
  projectedEndBalance,
  calcNextReset,
  getCategoryIncomeAllocationAmount,
  getNormalisedAllowanceTotal,
  getNormalisedCategoryAllowance,
  getNormalisedIncomeTotal,
  getMerchantBreakdown,
  buildBalanceHistory,
  buildCashFlowForecast,
  normalizeIncomeAllocations,
} from '../utils';
import { DEFAULT_HORIZON_DAYS, buildCycleProjection, buildSpendPrediction } from '../prediction';
import { CardTitle } from '../components/ui';

const COLORS = ['#4fffb0', '#5db8ff', '#c084fc', '#fbbf70', '#ff6b8a', '#67e8f9', '#a78bfa'];
const FREQ_LABEL = { weekly: 'Weekly', fortnightly: 'Fortnightly', '4weekly': 'Every 4 weeks', monthly: 'Monthly' };

// Three questions, three screens: what's coming, how the budget is set up, what
// already happened. The page used to answer all three in one ten-card scroll,
// which on a phone meant the forecast and the history were the same distance
// away — a very long way.
const TABS = [
  { id: 'outlook', label: 'Outlook', icon: TrendingUp },
  { id: 'budget',  label: 'Budget',  icon: Wallet },
  { id: 'history', label: 'History', icon: History },
];

const PREDICTION_HORIZONS = [7, 30, 90];
/** Beyond this many lines the per-category chart is spaghetti, not information. */
const MAX_LINES = 6;

const CONFIDENCE_LABEL = {
  ok:   { text: 'good history',   color: 'var(--good)' },
  low:  { text: 'thin history',   color: 'var(--warn)' },
  none: { text: 'scheduled only', color: 'var(--text-muted)' },
};

/**
 * Distinct colours, one per category.
 *
 * New categories all default to the same mint, so keying lines off
 * `category.color` alone paints every one of them identically. Honour a
 * category's own colour when it is actually distinctive and fall back to the
 * palette when it collides — past seven categories the palette wraps, which is
 * well beyond the point the chart shows only its top six anyway.
 */
function assignColors(rows = []) {
  const used = new Set();
  const map = new Map();
  let next = 0;
  rows.forEach((row, index) => {
    let color = row.color;
    if (!color || used.has(color)) {
      while (next < COLORS.length && used.has(COLORS[next])) next += 1;
      color = next < COLORS.length ? COLORS[next] : COLORS[index % COLORS.length];
    }
    used.add(color);
    map.set(row.id, color);
  });
  return map;
}

const riskColor = risk => (risk >= 0.6 ? 'var(--danger)' : risk >= 0.3 ? 'var(--warn)' : 'var(--good)');

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

// The band is the whole point, so the tooltip leads with it. Showing the
// median alone would imply a precision this forecast does not have.
const ForecastTooltip = ({ active, payload, label }) => {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div style={{ background: 'rgba(18,26,48,0.95)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 12, padding: '10px 14px', fontSize: 12 }}>
      <div style={{ color: 'var(--text-muted)', marginBottom: 6, fontWeight: 600 }}>By {label}</div>
      <div style={{ color: 'var(--accent-mint)', marginBottom: 2 }}>
        Most likely: <strong>{fmt(point.p50)}</strong>
      </div>
      <div style={{ color: 'var(--text-secondary)' }}>
        Likely range: <strong>{fmt(point.p10)} – {fmt(point.p90)}</strong>
      </div>
      {point.subscriptions > 0 && (
        <div style={{ color: 'var(--text-muted)', marginTop: 4 }}>
          includes {fmt(point.subscriptions)} of scheduled bills
        </div>
      )}
    </div>
  );
};

/** Per-category tooltip, biggest first and zero-spend categories omitted. */
const CategoryLinesTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  const rows = payload
    .filter(entry => Number(entry.value) > 0.005)
    .sort((a, b) => Number(b.value) - Number(a.value));
  if (!rows.length) return null;
  return (
    <div style={{ background: 'rgba(18,26,48,0.95)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 12, padding: '10px 14px', fontSize: 12 }}>
      <div style={{ color: 'var(--text-muted)', marginBottom: 6, fontWeight: 600 }}>{label}</div>
      {rows.map(entry => (
        <div key={entry.dataKey} style={{ color: entry.color, marginBottom: 2, display: 'flex', gap: 12, justifyContent: 'space-between' }}>
          <span>{entry.name}</span><strong>{fmt(Number(entry.value))}</strong>
        </div>
      ))}
    </div>
  );
};

/**
 * Monte Carlo spend forecast.
 *
 * Deliberately reports a range rather than a number: personal spending is
 * dominated by noise no model can see coming, so a single figure would be
 * false precision. The simulation itself lives in `prediction.js` and arrives
 * here already computed — this only draws it.
 */
function SpendPrediction({ prediction, horizonDays, onHorizonChange }) {
  const [mode, setMode] = useState('daily');
  const [hidden, setHidden] = useState(() => new Set());
  const [showAll, setShowAll] = useState(false);

  const ranked = prediction.categories;
  const charted = showAll ? ranked : ranked.slice(0, MAX_LINES);
  const visible = charted.filter(row => !hidden.has(row.id));

  const toggle = id => setHidden(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // Recharts wants one object per x-value, so pivot the per-category arrays.
  // Keys are ids rather than names: two categories may share a name, and a name
  // may collide with a field the chart already uses.
  const perDay = useMemo(() => prediction.series.map((point, index) => {
    const row = { label: point.label, date: point.date };
    for (const category of ranked) {
      row[`cat-${category.id}`] = mode === 'daily'
        ? category.daily[index]
        : category.cumulative[index];
    }
    return row;
  }), [prediction, ranked, mode]);

  const widest = Math.max(1, ...ranked.map(row => row.p90));
  const palette = useMemo(() => assignColors(ranked), [ranked]);
  const colorFor = row => palette.get(row.id) || COLORS[0];

  return (
    <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '22px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <CardTitle as="h2" style={{ marginBottom: 6 }}>Predicted Spending</CardTitle>
          <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>
            Simulated from your own history — a likely range, not a single number
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {PREDICTION_HORIZONS.map(days => (
            <button key={days} type="button"
              onClick={() => onHorizonChange(days)}
              className={horizonDays === days ? 'btn-primary' : 'btn-secondary'}
              style={{ padding: '6px 12px', fontSize: 12 }}
              aria-pressed={horizonDays === days}>
              {days}d
            </button>
          ))}
        </div>
      </div>

      {!prediction.ready ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 18, lineHeight: 1.6 }}>
          {prediction.reason === 'no-categories'
            ? 'Add a category and log a few expenses to unlock a forecast.'
            : prediction.reason}
          <div style={{ marginTop: 6, fontSize: 12 }}>
            A forecast built on less history than this would look confident and be wrong.
          </div>
        </div>
      ) : (
        <>
          <div style={{ marginTop: 18, marginBottom: 6 }}>
            <div className="font-display" style={{ fontSize: 32, color: 'var(--accent-mint)' }}>
              {fmt(prediction.total.p10)} – {fmt(prediction.total.p90)}
            </div>
            <div style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 4 }}>
              over the next {prediction.horizonDays} days · most likely <strong>{fmt(prediction.total.p50)}</strong>
            </div>
            {prediction.subscriptions.total > 0 && (
              <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                includes {fmt(prediction.subscriptions.total)} of scheduled bills, which are known rather than predicted
              </div>
            )}
          </div>

          <div className="mobile-chart-scroll" style={{ marginTop: 16 }}>
            <ResponsiveContainer width="100%" height={200}>
              <ComposedChart data={prediction.series}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" interval={Math.max(0, Math.floor(prediction.series.length / 6) - 1)} />
                <YAxis tickFormatter={v => `£${Math.round(v)}`} />
                <Tooltip content={<ForecastTooltip />} />
                <Area type="monotone" dataKey="band" name="Likely range"
                  stroke="none" fill="#5db8ff" fillOpacity={0.18} activeDot={false} />
                <Line type="monotone" dataKey="p50" name="Most likely"
                  stroke="#4fffb0" strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* ── Per-category lines ── */}
          <div style={{ marginTop: 24, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 18 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
              <div>
                <CardTitle as="h3" style={{ fontSize: 14, marginBottom: 4 }}>By Category</CardTitle>
                <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                  {mode === 'daily'
                    ? 'Expected spend on each day — the weekly rhythm is the model’s, not a smoothing artefact'
                    : 'Running total per category across the horizon'}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                {[['daily', 'Per day'], ['cumulative', 'Cumulative']].map(([value, text]) => (
                  <button key={value} type="button"
                    onClick={() => setMode(value)}
                    className={mode === value ? 'btn-primary' : 'btn-secondary'}
                    style={{ padding: '6px 12px', fontSize: 12 }}
                    aria-pressed={mode === value}>
                    {text}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 12 }}>
              {charted.map(row => {
                const on = !hidden.has(row.id);
                const tint = colorFor(row);
                return (
                  <button key={row.id} type="button" onClick={() => toggle(row.id)} aria-pressed={on}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      padding: '4px 10px', borderRadius: 999, fontSize: 11, cursor: 'pointer',
                      background: on ? 'rgba(255,255,255,0.07)' : 'transparent',
                      border: `1px solid ${on ? tint : 'rgba(255,255,255,0.12)'}`,
                      color: on ? 'var(--text-primary)' : 'var(--text-muted)',
                    }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: on ? tint : 'rgba(255,255,255,0.25)' }} />
                    {row.name}
                  </button>
                );
              })}
              {ranked.length > MAX_LINES && (
                <button type="button" onClick={() => setShowAll(value => !value)}
                  style={{
                    padding: '4px 10px', borderRadius: 999, fontSize: 11, cursor: 'pointer',
                    background: 'transparent', border: '1px dashed rgba(255,255,255,0.2)', color: 'var(--text-muted)',
                  }}>
                  {showAll ? 'Show top 6' : `+${ranked.length - MAX_LINES} more`}
                </button>
              )}
            </div>

            <div className="mobile-chart-scroll">
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={perDay}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="label" interval={Math.max(0, Math.floor(perDay.length / 6) - 1)} />
                  <YAxis tickFormatter={v => `£${Math.round(v)}`} />
                  <Tooltip content={<CategoryLinesTooltip />} />
                  {visible.map(row => (
                    <Line key={row.id} type="monotone"
                      dataKey={`cat-${row.id}`}
                      name={row.name}
                      stroke={colorFor(row)}
                      strokeWidth={2} dot={false}
                      isAnimationActive={false} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
            {visible.length === 0 && (
              <div style={{ color: 'var(--text-muted)', fontSize: 12, textAlign: 'center', marginTop: -120, marginBottom: 100 }}>
                Turn a category back on to see its line.
              </div>
            )}
          </div>

          {/* ── Per-category totals ── */}
          <div style={{ marginTop: 22, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 6 }}>
            {ranked.map(row => {
              const confidence = CONFIDENCE_LABEL[row.confidence] || CONFIDENCE_LABEL.none;
              const left = (row.p10 / widest) * 100;
              const width = Math.max(1.5, ((row.p90 - row.p10) / widest) * 100);
              const marker = (row.p50 / widest) * 100;
              const tint = colorFor(row);
              return (
                <div key={row.id} style={{
                  display: 'grid', gridTemplateColumns: 'minmax(88px, 1.1fr) 2fr minmax(104px, auto)',
                  gap: 12, alignItems: 'center', padding: '9px 0', borderTop: '1px solid rgba(255,255,255,0.06)',
                }}>
                  <div>
                    <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>{row.name}</div>
                    <div style={{ fontSize: 10, color: confidence.color }}>{confidence.text}</div>
                  </div>
                  <div style={{ position: 'relative', height: 8, borderRadius: 999, background: 'rgba(255,255,255,0.06)' }}>
                    <div style={{ position: 'absolute', left: `${left}%`, width: `${width}%`, top: 0, bottom: 0, borderRadius: 999, background: tint, opacity: 0.35 }} />
                    <div style={{ position: 'absolute', left: `${marker}%`, top: -2, width: 2, height: 12, background: tint, borderRadius: 2 }} />
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 12, color: 'var(--text-primary)' }}>{fmt(row.p50)}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{fmt(row.p10)} – {fmt(row.p90)}</div>
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 14, lineHeight: 1.6 }}>
            {prediction.sims.toLocaleString()} simulated futures over {prediction.observedDays} days of history.
            The range covers the middle 80% — roughly one month in five should land outside it.
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Where each category ends its own cycle, against what it is allowed.
 *
 * Replaces a straight-line extrapolation of the current burn rate: that
 * answered "if today repeats forever" rather than "what usually happens", and
 * had no way to express how likely an overspend actually was.
 */
function CycleOutlook({ projection }) {
  if (!projection.ready || !projection.categories.length) return null;

  const palette = assignColors(projection.categories);
  const chartData = projection.categories.map(row => ({
    name: row.name,
    Allowance: row.allowance,
    Spent: row.spent,
    Projected: row.p50,
    color: palette.get(row.id),
  }));
  const atRisk = projection.categories.filter(row => row.overspendRisk >= 0.3);

  return (
    <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '22px 24px' }}>
      <CardTitle as="h2" style={{ marginBottom: 6 }}>Projected Spend vs Allowance</CardTitle>
      <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 18 }}>
        Simulated to the end of each category&rsquo;s own budget cycle, including what is already spent
      </div>

      {atRisk.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 16, padding: '11px 14px', borderRadius: 10, background: 'rgba(251,191,112,0.1)', color: 'var(--warn)', fontSize: 13 }}>
          <AlertTriangle size={15} aria-hidden="true" />
          <span>
            {atRisk.length} categor{atRisk.length === 1 ? 'y is' : 'ies are'} at real risk of going over:{' '}
            <strong>{atRisk.map(row => row.name).join(', ')}</strong>.
          </span>
        </div>
      )}

      <div style={{ marginBottom: 20 }}>
        {projection.categories.map(row => (
          <div key={row.id} style={{
            display: 'grid', gridTemplateColumns: 'minmax(88px, 1.2fr) minmax(120px, auto) 62px',
            gap: 12, alignItems: 'center', padding: '9px 0', borderTop: '1px solid rgba(255,255,255,0.06)',
          }}>
            <div>
              <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>{row.name}</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                {row.remainingDays}d left · {fmt(row.spent)} of {fmt(row.allowance)} spent
              </div>
            </div>
            <div style={{ textAlign: 'right', fontSize: 12 }}>
              <div style={{ color: row.p50 > row.allowance ? 'var(--danger)' : 'var(--text-primary)' }}>{fmt(row.p50)}</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{fmt(row.p10)} – {fmt(row.p90)}</div>
            </div>
            <div style={{ textAlign: 'right', fontSize: 13, fontWeight: 600, color: riskColor(row.overspendRisk) }}
              title="Share of simulated futures that end the cycle over budget">
              {Math.round(row.overspendRisk * 100)}%
            </div>
          </div>
        ))}
        <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 10, textAlign: 'right' }}>
          right-hand column: chance of ending the cycle over budget
        </div>
      </div>

      <div className="mobile-chart-scroll">
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={chartData} barGap={4} barCategoryGap="30%">
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
  );
}

/** Expected spend per day per category, straight from the simulation. */
function ExpectedDailySpend({ projection }) {
  const rows = projection.ready
    ? projection.categories.filter(row => row.dailyMean > 0).sort((a, b) => b.dailyMean - a.dailyMean)
    : [];
  if (!rows.length) return null;
  const peak = rows[0].dailyMean;
  const palette = assignColors(rows);

  return (
    <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '22px 24px' }}>
      <CardTitle as="h2" style={{ marginBottom: 6 }}>Expected Daily Spend</CardTitle>
      <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 20 }}>
        Simulated average per day for the rest of each category&rsquo;s cycle
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map(row => {
          const tint = palette.get(row.id);
          return (
            <div key={row.id} className="mobile-row-stack" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 120, fontSize: 13, color: 'var(--text-secondary)', flexShrink: 0 }}>{row.name}</div>
              <div style={{ flex: 1 }}>
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${Math.min(100, (row.dailyMean / peak) * 100)}%`, background: tint }} />
                </div>
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: tint, width: 60, textAlign: 'right', flexShrink: 0 }}>
                {fmt(row.dailyMean)}/d
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatCard({ label, value, hint, color }) {
  return (
    <div className="glass" style={{ borderRadius: 16, padding: '18px 20px' }}>
      <div style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
        {label}
      </div>
      <div className="font-display" style={{ fontSize: 28, color }}>{value}</div>
      <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>{hint}</div>
    </div>
  );
}

export default function Forecasting({ categories, settings, transactions, incomes = [], incomeEvents = [], transfers = [], subscriptions = [], account = null, netWorth = null, accountCount = 1 }) {
  const [tab, setTab] = useState('outlook');
  const [horizonDays, setHorizonDays] = useState(DEFAULT_HORIZON_DAYS);

  const prediction = useMemo(() => buildSpendPrediction({
    transactions, categories, incomes, subscriptions, settings, horizonDays,
  }), [transactions, categories, incomes, subscriptions, settings, horizonDays]);

  const projection = useMemo(() => buildCycleProjection({
    transactions, categories, incomes, subscriptions, settings,
  }), [transactions, categories, incomes, subscriptions, settings]);

  const monthlyHistory = useMemo(() => buildMonthlyHistory(transactions, categories), [transactions, categories]);
  const merchantSpend = useMemo(() => getMerchantBreakdown(transactions, { limit: 8 }), [transactions]);
  const cashFlow = useMemo(
    () => (account
      ? buildCashFlowForecast({ account, categories, incomes, subscriptions, settings, days: 45 })
      : null),
    [account, categories, incomes, subscriptions, settings],
  );
  const balanceHistory = useMemo(
    () => (account ? buildBalanceHistory(account, { transactions, incomeEvents, transfers, days: 60 }) : []),
    [account, transactions, incomeEvents, transfers],
  );
  const legacyDays = daysUntilReset(settings);
  const projBalance = projectedEndBalance(categories, settings, incomes);

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

  // Normalised so a mix of weekly and monthly incomes compares correctly
  // against the allowances they fund.
  const totalIncome     = incomes.length > 0 ? getNormalisedIncomeTotal(incomes, 'month') : (settings?.income || 0);
  const normalisedAllocated = incomes.length > 0
    ? getNormalisedAllowanceTotal(categories, incomes, 'month')
    : categories.reduce((s, c) => s + (c.allowance || 0), 0);
  const totalAllowances = categories.reduce((s, c) => s + (c.allowance || 0), 0);
  const totalSpent      = categories.reduce((s, c) => s + (c.spent || 0), 0);
  const spentPct        = totalAllowances > 0 ? (totalSpent / totalAllowances) * 100 : 0;
  const spentColor      = spentPct > 90 ? '#ff6b8a' : spentPct > 70 ? '#fbbf70' : '#4fffb0';

  const budgetDonutData = [
    { name: 'Spent',     value: totalSpent,                                   color: spentColor },
    { name: 'Remaining', value: Math.max(0, totalAllowances - totalSpent),    color: 'rgba(255,255,255,0.08)' },
  ];

  // Per-category allowance allocation, normalised to a monthly rate so
  // categories funded by different pay frequencies are comparable.
  const allocationData = useMemo(() => {
    const funded = categories.filter(c => (c.allowance || 0) > 0);
    const palette = assignColors(funded);
    return funded.map(c => ({
      name: c.name,
      value: incomes.length > 0 ? getNormalisedCategoryAllowance(c, incomes, 'month') : (c.allowance || 0),
      color: palette.get(c.id),
    }));
  }, [categories, incomes]);

  const dailyExpected = projection.ready
    ? projection.categories.reduce((sum, row) => sum + row.dailyMean, 0)
    : 0;
  const riskyCount = projection.ready
    ? projection.categories.filter(row => row.overspendRisk >= 0.5).length
    : 0;

  if (transactions.length === 0) {
    return (
      <div className="fade-in glass" style={{ borderRadius: 16, padding: '40px 24px', textAlign: 'center' }}>
        <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>
          Log some expenses to see forecasting data.
        </div>
      </div>
    );
  }

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      <div role="tablist" aria-label="Forecasting sections"
        style={{ display: 'flex', gap: 6, padding: 5, borderRadius: 14, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
        {TABS.map(({ id, label, icon: Icon }) => {
          const on = tab === id;
          return (
            <button key={id} type="button" role="tab" aria-selected={on}
              onClick={() => setTab(id)}
              style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                padding: '9px 12px', borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                border: '1px solid transparent',
                background: on ? 'rgba(255,255,255,0.09)' : 'transparent',
                borderColor: on ? 'rgba(255,255,255,0.14)' : 'transparent',
                color: on ? 'var(--text-primary)' : 'var(--text-muted)',
              }}>
              <Icon size={15} aria-hidden="true" />
              {label}
            </button>
          );
        })}
      </div>

      {tab === 'outlook' && (
        <>
          <div className="mobile-stack" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14 }}>
            <StatCard
              label="Expected Daily Spend"
              value={projection.ready ? fmt(dailyExpected) : '—'}
              hint={projection.ready ? 'simulated, across all categories' : 'needs more history'}
              color="var(--accent-warm)"
            />
            <StatCard
              label="Next Income Reset"
              value={nextIncomeReset ? `${nextIncomeReset.days}d` : (incomes.length > 0 ? '—' : (legacyDays ?? '—'))}
              hint={nextIncomeReset
                ? `${nextIncomeReset.income.name} · ${format(nextIncomeReset.next, 'd MMM')}`
                : incomes.length > 0 ? 'income resets are held or unscheduled' : 'legacy schedule'}
              color="var(--accent-blue)"
            />
            <StatCard
              label="Projected End Balance"
              value={`${projBalance >= 0 ? '+' : ''}${fmt(projBalance)}`}
              hint="at current burn rate"
              color={projBalance >= 0 ? 'var(--good)' : 'var(--danger)'}
            />
            <StatCard
              label="Categories At Risk"
              value={projection.ready ? String(riskyCount) : '—'}
              hint={projection.ready ? 'more likely than not to go over' : 'needs more history'}
              color={riskyCount > 0 ? 'var(--danger)' : 'var(--good)'}
            />
          </div>

          <SpendPrediction
            prediction={prediction}
            horizonDays={horizonDays}
            onHorizonChange={setHorizonDays}
          />

          {/* Category budgets answer "can I afford this out of Groceries?". This
              answers the different, more urgent question: will the money actually
              be there when the direct debit comes out? */}
          {cashFlow && cashFlow.series.length > 1 && (
            <div className="glass mobile-card-pad" style={{
              borderRadius: 18,
              padding: '22px 24px',
              borderColor: cashFlow.firstNegative ? 'rgba(255,107,138,0.3)' : undefined,
              background: cashFlow.firstNegative ? 'rgba(255,107,138,0.04)' : undefined,
            }}>
              <CardTitle as="h2" style={{ marginBottom: 6 }}>Cash Flow</CardTitle>
              <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 16 }}>
                Next 45 days, combining scheduled income, subscriptions and your current burn rate
              </div>

              {cashFlow.firstNegative ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 16, padding: '11px 14px', borderRadius: 10, background: 'rgba(255,107,138,0.1)', color: 'var(--danger)', fontSize: 13 }}>
                  <AlertTriangle size={15} aria-hidden="true" />
                  <span>
                    On current trends your balance goes negative on{' '}
                    <strong>{format(cashFlow.firstNegative, 'd MMM')}</strong>.
                  </span>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 16, padding: '11px 14px', borderRadius: 10, background: 'rgba(79,255,176,0.08)', color: 'var(--good)', fontSize: 13 }}>
                  <Check size={15} aria-hidden="true" />
                  <span>
                    You stay in the black. Lowest point is{' '}
                    <strong>{fmt(cashFlow.lowest.balance)}</strong>
                    {cashFlow.lowest.date ? ` on ${format(cashFlow.lowest.date, 'd MMM')}` : ''}.
                  </span>
                </div>
              )}

              <div className="mobile-chart-scroll">
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={cashFlow.series}>
                    <defs>
                      <linearGradient id="grad-cashflow" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={cashFlow.firstNegative ? '#ff6b8a' : '#5db8ff'} stopOpacity={0.35} />
                        <stop offset="95%" stopColor={cashFlow.firstNegative ? '#ff6b8a' : '#5db8ff'} stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} />
                    <XAxis dataKey="label" interval={Math.max(0, Math.floor(cashFlow.series.length / 6) - 1)} />
                    <YAxis tickFormatter={v => `£${Math.round(v)}`} />
                    <Tooltip content={<GlassTooltip />} />
                    <ReferenceLine y={0} stroke="rgba(255,107,138,0.5)" strokeDasharray="4 4" />
                    <Area type="monotone" dataKey="balance" name="Projected balance"
                      stroke={cashFlow.firstNegative ? '#ff6b8a' : '#5db8ff'} strokeWidth={2}
                      fill="url(#grad-cashflow)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {incomeResetSchedule.length > 0 && (
            <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '20px 22px' }}>
              <CardTitle as="h2" style={{ marginBottom: 6 }}>Income Reset Schedule</CardTitle>
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
        </>
      )}

      {tab === 'budget' && (
        <>
          <CycleOutlook projection={projection} />
          <ExpectedDailySpend projection={projection} />

          {(totalAllowances > 0 || allocationData.length > 0) && (
            <div className="mobile-stack" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>

              {totalAllowances > 0 && (
                <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '22px 24px' }}>
                  <CardTitle as="h2" style={{ fontSize: 14, marginBottom: 4 }}>Budget Usage</CardTitle>
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

              {allocationData.length > 0 && (
                <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '22px 24px' }}>
                  <CardTitle as="h2" style={{ fontSize: 14, marginBottom: 4 }}>Category Allocation</CardTitle>
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
                        const pct = normalisedAllocated > 0 ? ((entry.value / normalisedAllocated) * 100).toFixed(0) : 0;
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
                        {normalisedAllocated > totalIncome
                          ? <span style={{ color: 'var(--danger)' }}>⚠ {((normalisedAllocated / totalIncome) * 100).toFixed(0)}% — over-allocated</span>
                          : `${((normalisedAllocated / totalIncome) * 100).toFixed(0)}% of income allocated to categories`}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {!projection.ready && (
            <div className="glass" style={{ borderRadius: 16, padding: '28px 24px', textAlign: 'center' }}>
              <Activity size={18} color="var(--text-muted)" aria-hidden="true" />
              <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 8 }}>
                {prediction.reason === 'no-categories'
                  ? 'Add a category to see how your budget is tracking.'
                  : projection.reason}
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'history' && (
        <>
          {monthlyHistory.length > 1 && (
            <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '22px 24px' }}>
              <CardTitle as="h2" style={{ marginBottom: 6 }}>Spend History by Category</CardTitle>
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

          {/* Categories say how the budget is doing; this says whether the account
              behind it is actually growing or shrinking. */}
          {balanceHistory.length > 1 && (
            <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '22px 24px' }}>
              <CardTitle as="h2" style={{ marginBottom: 6 }}>Account Balance</CardTitle>
              <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 20 }}>
                Last 60 days, reconstructed from your transactions, income and transfers
              </div>
              <div className="mobile-chart-scroll">
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={balanceHistory}>
                    <defs>
                      <linearGradient id="grad-balance" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#4fffb0" stopOpacity={0.35} />
                        <stop offset="95%" stopColor="#4fffb0" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} />
                    <XAxis dataKey="label" interval={Math.max(0, Math.floor(balanceHistory.length / 6) - 1)} />
                    <YAxis tickFormatter={v => `£${Math.round(v)}`} />
                    <Tooltip content={<GlassTooltip />} />
                    <Area type="monotone" dataKey="balance" name="Balance"
                      stroke="#4fffb0" strokeWidth={2} fill="url(#grad-balance)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* The account chart above says how one account is doing. This says
              whether the whole estate is actually growing — the figure that
              answers "am I better off than I was?". */}
          {netWorth && netWorth.series.length > 1 && (
            <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '22px 24px' }}>
              <CardTitle as="h2" style={{ marginBottom: 6 }}>Net Worth</CardTitle>
              <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 16 }}>
                Everything across {accountCount === 1 ? 'your account' : `all ${accountCount} accounts`}, over the last 90 days
              </div>

              <div className="mobile-stack" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 12, marginBottom: 18 }}>
                {[
                  ['Net worth', fmt(netWorth.current.netWorth), netWorth.current.netWorth >= 0 ? 'var(--good)' : 'var(--danger)'],
                  ['Held', fmt(netWorth.current.assets), 'var(--text-primary)'],
                  ['Owed', fmt(netWorth.current.debt), netWorth.current.debt > 0 ? 'var(--danger)' : 'var(--text-muted)'],
                  ['90-day change', `${netWorth.change >= 0 ? '+' : '−'}${fmt(Math.abs(netWorth.change))}`,
                    netWorth.change >= 0 ? 'var(--good)' : 'var(--warn)'],
                ].map(([label, value, color]) => (
                  <div key={label}>
                    <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 4 }}>{label}</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
                  </div>
                ))}
              </div>

              <div className="mobile-chart-scroll">
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={netWorth.series}>
                    <defs>
                      <linearGradient id="grad-networth" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#c084fc" stopOpacity={0.35} />
                        <stop offset="95%" stopColor="#c084fc" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} />
                    <XAxis dataKey="label" interval={Math.max(0, Math.floor(netWorth.series.length / 6) - 1)} />
                    <YAxis tickFormatter={v => `£${Math.round(v)}`} />
                    <Tooltip content={<GlassTooltip />} />
                    <Area type="monotone" dataKey="assets" name="Held"
                      stroke="#c084fc" strokeWidth={2} fill="url(#grad-networth)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              {netWorth.current.debt > 0 && !netWorth.debtHasHistory && (
                <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 12, lineHeight: 1.6 }}>
                  The line tracks what you hold. Finesse records what&rsquo;s left on a debt,
                  not when each payment landed, so plotting {fmt(netWorth.current.debt)} of
                  debt across these 90 days would claim you owed it all along — the net
                  worth figure above is today&rsquo;s.
                </div>
              )}
            </div>
          )}

          {/* Categories tell you the kind of spending; merchants tell you what you
              actually bought, which is usually the more actionable of the two. */}
          {merchantSpend.length > 0 && (
            <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '22px 24px' }}>
              <CardTitle as="h2" style={{ marginBottom: 6 }}>Where Your Money Goes</CardTitle>
              <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 20 }}>Top merchants across all time</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {merchantSpend.map((entry, i) => (
                  <div key={entry.label} className="mobile-row-stack" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ width: 120, fontSize: 13, color: 'var(--text-secondary)', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {entry.label}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div className="progress-track">
                        <div className="progress-fill" style={{
                          width: `${Math.min(100, (entry.total / merchantSpend[0].total) * 100)}%`,
                          background: COLORS[i % COLORS.length],
                        }} />
                      </div>
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: COLORS[i % COLORS.length], width: 78, textAlign: 'right', flexShrink: 0 }}>
                      {fmt(entry.total)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {monthlyHistory.length <= 1 && balanceHistory.length <= 1 && merchantSpend.length === 0 && (
            <div className="glass" style={{ borderRadius: 16, padding: '28px 24px', textAlign: 'center' }}>
              <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                Not enough history yet — this fills in as you log expenses.
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
