import { useMemo, useState } from 'react';
import { format } from 'date-fns';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CalendarRange, Receipt, TrendingDown, TrendingUp } from 'lucide-react';

import { buildReview, fmt } from '../utils';
import { CardTitle } from '../components/ui';

const WINDOWS = [
  [3, '3 months'],
  [6, '6 months'],
  [12, '12 months'],
  [24, '2 years'],
];

const Tip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: 'rgba(18,26,48,0.95)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 12, padding: '10px 14px', fontSize: 12 }}>
      <div style={{ color: 'var(--text-muted)', marginBottom: 6, fontWeight: 600 }}>{label}</div>
      {payload.map((entry, i) => (
        <div key={i} style={{ color: entry.color, marginBottom: 2 }}>
          {entry.name}: <strong>{fmt(Number(entry.value))}</strong>
        </div>
      ))}
    </div>
  );
};

function Stat({ label, value, hint, color }) {
  return (
    <div className="glass" style={{ borderRadius: 14, padding: '15px 16px' }}>
      <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 5 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {hint && <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 3, lineHeight: 1.5 }}>{hint}</div>}
    </div>
  );
}

/**
 * The long look back.
 *
 * Every other view in Finesse is about now or next: this cycle's allowance,
 * the next payday, the projected balance. This is the only one that asks what
 * actually happened over a year — which is a different question, and the one
 * worth answering before setting next year's budget.
 *
 * All of it comes from `buildReview`, so the view stays a renderer.
 */
export default function Review({ transactions = [], categories = [], incomeEvents = [], subscriptions = [] }) {
  const [months, setMonths] = useState(12);

  const review = useMemo(
    () => buildReview({ transactions, categories, incomeEvents, subscriptions, months }),
    [transactions, categories, incomeEvents, subscriptions, months],
  );

  const categoryMax = review.categories[0]?.total || 0;
  const merchantMax = review.merchants[0]?.total || 0;

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="glass mobile-card-pad mobile-row-stack" style={{ borderRadius: 18, padding: '18px 22px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <CalendarRange size={16} color="var(--accent-warm)" aria-hidden="true" />
            <CardTitle as="h2">
              {format(review.from, 'MMM yyyy')} to {format(review.to, 'MMM yyyy')}
            </CardTitle>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
            What actually happened, rather than what was budgeted
          </div>
        </div>
        <div role="group" aria-label="Review window" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {WINDOWS.map(([value, label]) => (
            <button key={value} type="button" aria-pressed={months === value}
              className={months === value ? 'btn-primary' : 'btn-secondary'}
              onClick={() => setMonths(value)} style={{ padding: '6px 11px', fontSize: 12 }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {!review.hasData ? (
        <div className="glass" style={{ borderRadius: 16, padding: '48px 24px', textAlign: 'center' }}>
          <Receipt size={32} style={{ color: 'var(--text-muted)', margin: '0 auto 12px', display: 'block' }} />
          <div style={{ color: 'var(--text-muted)', fontSize: 14, marginBottom: 6 }}>Nothing logged in this window</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, maxWidth: 420, margin: '0 auto', lineHeight: 1.6 }}>
            Once you have a few months of transactions, this page shows where the
            money actually went, which months were the expensive ones, and whether
            your subscriptions have crept up.
          </div>
        </div>
      ) : (
        <>
          <div className="mobile-stack" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
            <Stat label="Spent" value={fmt(review.totals.net)}
              hint={`${fmt(review.totals.monthlyAverage)} a month on average`} />
            <Stat label="Received" value={fmt(review.totals.income)} hint="income logged in this window" />
            <Stat label="Kept" value={fmt(review.totals.saved)}
              color={review.totals.saved >= 0 ? 'var(--good)' : 'var(--danger)'}
              hint={review.totals.saved >= 0 ? 'income minus spending' : 'you spent more than came in'} />
            <Stat label="Transactions" value={String(review.totals.transactionCount)}
              hint={review.totals.refunded > 0 ? `${fmt(review.totals.refunded)} came back as refunds` : 'logged in this window'} />
          </div>

          <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '22px 24px' }}>
            <CardTitle as="h2" style={{ marginBottom: 6 }}>Month by month</CardTitle>
            <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 20 }}>
              What came in against what went out
            </div>
            <div className="mobile-chart-scroll">
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={review.series}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="label" interval={Math.max(0, Math.floor(review.series.length / 8) - 1)} />
                  <YAxis tickFormatter={v => `£${Math.round(v)}`} />
                  <Tooltip content={<Tip />} />
                  <Legend wrapperStyle={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }} />
                  <Bar dataKey="income" name="In" fill="rgba(79,255,176,0.55)" radius={[6, 6, 0, 0]} />
                  <Bar dataKey="spent" name="Out" fill="#fbbf70" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {review.busiest && review.quietest && (
              <div style={{ display: 'flex', gap: 16, marginTop: 16, flexWrap: 'wrap', fontSize: 12 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--warn)' }}>
                  <TrendingUp size={13} aria-hidden="true" />
                  Dearest month: {review.busiest.label} at {fmt(review.busiest.spent)}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--good)' }}>
                  <TrendingDown size={13} aria-hidden="true" />
                  Cheapest: {review.quietest.label} at {fmt(review.quietest.spent)}
                </span>
              </div>
            )}
          </div>

          {review.categories.length > 0 && (
            <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '22px 24px' }}>
              <CardTitle as="h2" style={{ marginBottom: 6 }}>Where it went</CardTitle>
              <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 20 }}>
                By category, after refunds
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                {review.categories.map(row => (
                  <div key={row.id} className="mobile-row-stack" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ width: 110, flexShrink: 0, fontSize: 13, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.name}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="progress-track">
                        <div className="progress-fill" style={{
                          width: `${categoryMax > 0 ? Math.max(2, (row.total / categoryMax) * 100) : 0}%`,
                          background: row.color,
                        }} />
                      </div>
                    </div>
                    <div style={{ width: 150, flexShrink: 0, textAlign: 'right', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                      <strong>{fmt(row.total)}</strong>
                      <span style={{ color: 'var(--text-muted)' }}> · {row.share.toFixed(0)}% · {fmt(row.monthlyAverage)}/mo</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {review.merchants.length > 0 && (
            <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '22px 24px' }}>
              <CardTitle as="h2" style={{ marginBottom: 6 }}>Who got it</CardTitle>
              <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 20 }}>
                Categories say what kind of spending it was; this says what you actually bought
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                {review.merchants.map(entry => (
                  <div key={entry.label} className="mobile-row-stack" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ width: 130, flexShrink: 0, fontSize: 13, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {entry.label}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="progress-track">
                        <div className="progress-fill" style={{
                          width: `${merchantMax > 0 ? Math.max(2, (entry.total / merchantMax) * 100) : 0}%`,
                          background: 'var(--accent-blue)',
                        }} />
                      </div>
                    </div>
                    <div style={{ width: 120, flexShrink: 0, textAlign: 'right', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                      <strong>{fmt(entry.total)}</strong>
                      <span style={{ color: 'var(--text-muted)' }}> · {entry.count}×</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {review.subscriptionTrend && (
            <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '22px 24px' }}>
              <CardTitle as="h2" style={{ marginBottom: 6 }}>Subscription creep</CardTitle>
              <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 20 }}>
                Recurring charges add up quietly, which is rather the point of them
              </div>
              <div className="mobile-chart-scroll">
                <ResponsiveContainer width="100%" height={160}>
                  <AreaChart data={review.series}>
                    <defs>
                      <linearGradient id="grad-subs" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#fbbf70" stopOpacity={0.35} />
                        <stop offset="95%" stopColor="#fbbf70" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} />
                    <XAxis dataKey="label" interval={Math.max(0, Math.floor(review.series.length / 8) - 1)} />
                    <YAxis tickFormatter={v => `£${Math.round(v)}`} />
                    <Tooltip content={<Tip />} />
                    <Area type="monotone" dataKey="subscriptions" name="Subscriptions"
                      stroke="#fbbf70" strokeWidth={2} fill="url(#grad-subs)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 14, lineHeight: 1.6 }}>
                {fmt(review.subscriptionTrend.first)} in {review.subscriptionTrend.firstLabel} →{' '}
                {fmt(review.subscriptionTrend.last)} in {review.subscriptionTrend.lastLabel}
                {review.subscriptionTrend.change !== 0 && (
                  <span style={{ color: review.subscriptionTrend.change > 0 ? 'var(--warn)' : 'var(--good)' }}>
                    {' '}({review.subscriptionTrend.change > 0 ? '+' : '−'}{fmt(Math.abs(review.subscriptionTrend.change))}
                    {review.subscriptionTrend.changePct != null && `, ${review.subscriptionTrend.changePct > 0 ? '+' : ''}${review.subscriptionTrend.changePct.toFixed(0)}%`})
                  </span>
                )}
                . {fmt(review.subscriptionTrend.total)} in total over this window.
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
