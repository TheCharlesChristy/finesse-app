import { useMemo } from 'react';
import { format } from 'date-fns';
import { ArrowLeft, CreditCard, Pencil, SlidersHorizontal, Trash2 } from 'lucide-react';

import {
  fmt,
  getCategoryCycle,
  getCumulativeOverspend,
  getEffectiveAllowance,
  getMerchantBreakdown,
  getPacedPeriodStatus,
  getSignedAmount,
  getUpcomingSubscriptionCost,
  isRefund,
  roundMoney,
} from '../utils';
import { CardTitle, IconButton } from '../components/ui';

/**
 * Everything about one category on a single page.
 *
 * Previously a category was a progress bar and a row of chips with nowhere to
 * go — you couldn't see what actually made up the number. This is the answer to
 * "where did my Groceries budget go?".
 */
export default function CategoryDetail({
  category,
  transactions = [],
  subscriptions = [],
  incomes = [],
  settings,
  onBack,
  onEdit,
  onAdjust,
  onEditTransaction,
  onDeleteTransaction,
}) {
  const cycle = useMemo(
    () => (category ? getCategoryCycle(category, incomes, settings) : null),
    [category, incomes, settings],
  );

  const categoryTransactions = useMemo(() => (
    transactions
      .filter(tx => Number(tx.categoryId) === Number(category?.id))
      .sort((a, b) => new Date(b.date) - new Date(a.date))
  ), [transactions, category]);

  const thisCycle = useMemo(() => (
    cycle
      ? categoryTransactions.filter(tx => {
          const date = new Date(tx.date);
          return !Number.isNaN(date.getTime()) && date >= cycle.start && date < cycle.end;
        })
      : []
  ), [categoryTransactions, cycle]);

  const merchants = useMemo(
    () => getMerchantBreakdown(categoryTransactions, { since: cycle?.start, limit: 6 }),
    [categoryTransactions, cycle],
  );

  const categorySubs = useMemo(
    () => subscriptions.filter(sub => Number(sub.categoryId) === Number(category?.id)),
    [subscriptions, category],
  );

  if (!category) {
    return (
      <div className="glass" style={{ borderRadius: 16, padding: '40px 24px', textAlign: 'center', color: 'var(--text-muted)' }}>
        That category no longer exists.
        <div style={{ marginTop: 14 }}>
          <button className="btn-primary" onClick={onBack}>Back to Dashboard</button>
        </div>
      </div>
    );
  }

  const allowance = getEffectiveAllowance(category);
  const spent = roundMoney(category.spent || 0);
  const left = roundMoney(allowance - spent);
  const pct = allowance > 0 ? Math.min(100, (spent / allowance) * 100) : 0;
  const upcomingSubs = getUpcomingSubscriptionCost(subscriptions, category.id, settings, undefined, cycle?.end);
  const cumulative = getCumulativeOverspend(category.id, category.allowance, transactions, {
    freq: cycle?.freq,
    payDayOfMonth: settings?.payDayOfMonth,
    anchor: cycle?.start,
  });
  const perDay = cycle && cycle.remaining > 0 ? roundMoney(Math.max(0, left - upcomingSubs) / cycle.remaining) : 0;
  // A rollover category accumulates rather than resetting, so a pace measured
  // against one repeat says nothing useful about it — same call the Dashboard
  // tags make.
  const pacedPeriod = category.rolloverEnabled ? null : getPacedPeriodStatus(category, transactions, cycle);

  const stat = (label, value, hint, color) => (
    <div className="glass" style={{ borderRadius: 14, padding: '15px 16px' }}>
      <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 5 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color }}>{value}</div>
      <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 3 }}>{hint}</div>
    </div>
  );

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '20px 22px' }}>
        <div className="mobile-row-stack" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
            <IconButton onClick={onBack} label="Back to Dashboard"><ArrowLeft size={15} /></IconButton>
            <span style={{ width: 12, height: 12, borderRadius: '50%', background: category.color || 'var(--accent-blue)', flexShrink: 0 }} />
            <div style={{ minWidth: 0 }}>
              <CardTitle as="h2" style={{ fontSize: 17 }}>{category.name}</CardTitle>
              <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>
                {cycle
                  ? `${format(cycle.start, 'd MMM')} – ${format(cycle.end, 'd MMM')} · ${cycle.remaining} day${cycle.remaining === 1 ? '' : 's'} left`
                  : 'No cycle'}
              </div>
            </div>
          </div>
          <div className="mobile-actions" style={{ display: 'flex', gap: 8 }}>
            <button className="btn-secondary" onClick={() => onAdjust(category.id)}
              style={{ padding: '7px 12px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
              <SlidersHorizontal size={13} /> Adjust
            </button>
            <button className="btn-secondary" onClick={() => onEdit(category)}
              style={{ padding: '7px 12px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Pencil size={13} /> Edit
            </button>
          </div>
        </div>

        <div className="progress-track" style={{ marginTop: 16 }}>
          <div className="progress-fill" style={{
            width: `${pct}%`,
            background: pct > 90 ? 'var(--danger)' : pct > 70 ? 'var(--warn)' : 'var(--accent-mint)',
          }} />
        </div>
      </div>

      <div className="mobile-stack" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        {stat('Left this cycle', fmt(left), `of ${fmt(allowance)}`, left < 0 ? 'var(--danger)' : 'var(--text-primary)')}
        {pacedPeriod && stat(
          `Left ${pacedPeriod.scopeLabel}`,
          fmt(pacedPeriod.left),
          `of ${fmt(pacedPeriod.allowance)}${pacedPeriod.prorated ? ` — a part ${pacedPeriod.periodLabel}` : ` per ${pacedPeriod.periodLabel}`}`,
          pacedPeriod.left < 0 ? 'var(--danger)' : 'var(--good)',
        )}
        {stat('Spent', fmt(spent), `${thisCycle.length} transaction${thisCycle.length === 1 ? '' : 's'}`)}
        {stat('Safe per day', fmt(perDay), cycle ? `for ${cycle.remaining} more day${cycle.remaining === 1 ? '' : 's'}` : '—', 'var(--good)')}
        {upcomingSubs > 0 && stat('Subscriptions due', fmt(upcomingSubs), 'before the next reset', 'var(--accent-purple)')}
        {cumulative !== 0 && stat(
          cumulative > 0 ? 'Over, all time' : 'Under, all time',
          fmt(Math.abs(cumulative)),
          'across every cycle',
          cumulative > 0 ? 'var(--danger)' : 'var(--good)',
        )}
      </div>

      {merchants.length > 0 && (
        <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '20px 22px' }}>
          <CardTitle as="h2" style={{ marginBottom: 4 }}>Where It Went</CardTitle>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 14 }}>Top merchants this cycle</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            {merchants.map(entry => (
              <div key={entry.label} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 110, fontSize: 13, color: 'var(--text-secondary)', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {entry.label}
                </div>
                <div style={{ flex: 1 }}>
                  <div className="progress-track" style={{ height: 6 }}>
                    <div className="progress-fill" style={{
                      width: `${Math.min(100, (entry.total / merchants[0].total) * 100)}%`,
                      background: category.color || 'var(--accent-blue)',
                    }} />
                  </div>
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, width: 74, textAlign: 'right', flexShrink: 0 }}>
                  {fmt(entry.total)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {categorySubs.length > 0 && (
        <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '20px 22px' }}>
          <CardTitle as="h2" style={{ marginBottom: 12 }}>Subscriptions</CardTitle>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {categorySubs.map(sub => (
              <div key={sub.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'rgba(255,255,255,0.04)', borderRadius: 10 }}>
                <CreditCard size={14} style={{ color: 'var(--accent-warm)', flexShrink: 0 }} aria-hidden="true" />
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {sub.name}
                </span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {sub.active === false ? 'Paused' : sub.nextDueAt ? `next ${format(new Date(sub.nextDueAt), 'd MMM')}` : ''}
                </span>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--accent-warm)' }}>-{fmt(sub.amount || 0)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '20px 22px' }}>
        <CardTitle as="h2" style={{ marginBottom: 4 }}>Transactions</CardTitle>
        <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 14 }}>
          This cycle first, then earlier history
        </div>
        {categoryTransactions.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: '20px 0' }}>
            Nothing logged in this category yet.
          </div>
        ) : (
          <div className="scroll-region" style={{ display: 'flex', flexDirection: 'column', gap: 7, maxHeight: 420, overflowY: 'auto', paddingRight: 4 }}>
            {categoryTransactions.slice(0, 60).map(tx => {
              const inCycle = cycle && new Date(tx.date) >= cycle.start && new Date(tx.date) < cycle.end;
              const refund = isRefund(tx);
              return (
                <div key={tx.id} className="mobile-list-row" style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10,
                  background: inCycle ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.02)',
                  opacity: inCycle ? 1 : 0.7,
                }}>
                  <div className="mobile-list-main" style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {tx.note || category.name}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                      {format(new Date(tx.date), 'd MMM yyyy')}
                      {tx.subscriptionId ? ' · subscription' : ''}
                      {tx.splitGroupId ? ' · split' : ''}
                    </div>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600, flexShrink: 0, color: refund ? 'var(--good)' : 'var(--accent-warm)' }}>
                    {refund ? '+' : '-'}{fmt(tx.amount)}
                  </div>
                  <IconButton onClick={() => onEditTransaction(tx)} size={28} style={{ opacity: 0.6, flexShrink: 0 }}
                    label={`Edit ${tx.note || category.name}`}>
                    <Pencil size={12} />
                  </IconButton>
                  <IconButton onClick={() => onDeleteTransaction(tx)} size={28} style={{ opacity: 0.5, flexShrink: 0 }}
                    label={`Delete ${tx.note || category.name}`}>
                    <Trash2 size={12} />
                  </IconButton>
                </div>
              );
            })}
          </div>
        )}
        {categoryTransactions.length > 0 && (
          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)', textAlign: 'right' }}>
            Cycle total:{' '}
            <span style={{ color: 'var(--text-secondary)', fontWeight: 700 }}>
              {fmt(thisCycle.reduce((sum, tx) => sum + getSignedAmount(tx), 0))}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
