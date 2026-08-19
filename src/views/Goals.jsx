import { useMemo, useState } from 'react';
import { format } from 'date-fns';
import { AlertTriangle, Check, Landmark, Minus, Pencil, PiggyBank, Plus, Trash2 } from 'lucide-react';

import {
  compareDebtStrategies,
  fmt,
  getDebtPayoff,
  getGoalEta,
  getGoalProgress,
  isGoalOffTrack,
  roundMoney,
} from '../utils';
import { CardTitle, IconButton } from '../components/ui';

const GOAL_SAVING = 'saving';
const GOAL_DEBT = 'debt';

function GoalCard({ goal, incomes, onContribute, onEdit, onDelete }) {
  const [amount, setAmount] = useState('');
  const progress = getGoalProgress(goal);
  const eta = getGoalEta(goal, incomes);
  const offTrack = isGoalOffTrack(goal, incomes);
  const isDebt = goal.kind === GOAL_DEBT;
  const payoff = isDebt && Number(goal.apr) > 0 ? getDebtPayoff(goal, incomes) : null;
  const income = incomes.find(item => Number(item.id) === Number(goal.incomeId));

  const move = (sign) => {
    const value = parseFloat(amount);
    if (!(value > 0)) return;
    onContribute(goal.id, sign * value);
    setAmount('');
  };

  const barColor = progress.complete ? 'var(--good)'
    : offTrack ? 'var(--warn)'
    : isDebt ? 'var(--accent-purple)' : 'var(--accent-mint)';

  return (
    <div className="glass mobile-card-pad" style={{
      borderRadius: 18,
      padding: '20px 22px',
      borderColor: progress.complete ? 'rgba(79,255,176,0.28)' : undefined,
      background: progress.complete ? 'rgba(79,255,176,0.05)' : undefined,
    }}>
      <div className="mobile-row-stack" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 10, minWidth: 0 }}>
          <span style={{
            width: 34, height: 34, borderRadius: 11, flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: `${goal.color || '#4fffb0'}20`, color: goal.color || 'var(--accent-mint)',
          }}>
            {isDebt ? <Landmark size={17} /> : <PiggyBank size={17} />}
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
              <CardTitle as="h3" style={{ fontSize: 15 }}>{goal.name}</CardTitle>
              {progress.complete && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, color: 'var(--good)', background: 'rgba(79,255,176,0.12)', padding: '2px 7px', borderRadius: 20 }}>
                  <Check size={9} /> {isDebt ? 'Cleared' : 'Reached'}
                </span>
              )}
              {offTrack && !progress.complete && (
                <span title="Won't reach the target date at the current rate"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, color: 'var(--warn)', background: 'rgba(251,191,112,0.12)', padding: '2px 7px', borderRadius: 20 }}>
                  <AlertTriangle size={9} /> Off track
                </span>
              )}
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 3 }}>
              {isDebt ? 'Paid off' : 'Saved'} {fmt(progress.saved)} of {fmt(progress.target)}
              {goal.targetDate ? ` · by ${format(new Date(goal.targetDate), 'd MMM yyyy')}` : ''}
            </div>
          </div>
        </div>

        <div className="mobile-actions" style={{ display: 'flex', gap: 7, flexShrink: 0 }}>
          <IconButton onClick={() => onEdit(goal)} size={30} style={{ opacity: 0.65 }} label={`Edit ${goal.name}`}>
            <Pencil size={12} />
          </IconButton>
          <IconButton onClick={() => onDelete(goal)} size={30} style={{ opacity: 0.5 }} label={`Delete ${goal.name}`}>
            <Trash2 size={12} />
          </IconButton>
        </div>
      </div>

      <div className="progress-track" style={{ marginTop: 14, height: 8 }}>
        <div className="progress-fill" style={{ width: `${progress.pct}%`, background: barColor }} />
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginTop: 7, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-muted)' }}>
        <span>{progress.pct.toFixed(0)}% · {fmt(progress.remaining)} to go</span>
        <span>
          {goal.perCycleContribution > 0
            ? `${fmt(goal.perCycleContribution)} per ${income?.name || 'cycle'}`
            : 'No automatic contribution'}
          {eta.cycles != null && !eta.complete && eta.date
            ? ` · done ${format(eta.date, 'MMM yyyy')}`
            : ''}
        </span>
      </div>

      {/* What the interest actually costs. A debt with an APR and no payment
          big enough to cover it is the single most important thing this page
          can say, so it is stated outright rather than left to the ETA. */}
      {payoff && !progress.complete && (
        <div style={{
          marginTop: 9, fontSize: 11, lineHeight: 1.6, borderRadius: 8, padding: '7px 10px',
          background: payoff.neverClears ? 'rgba(255,107,138,0.1)' : 'rgba(255,255,255,0.04)',
          color: payoff.neverClears ? 'var(--danger)' : 'var(--text-muted)',
        }}>
          {payoff.neverClears
            ? `At ${fmt(goal.perCycleContribution || 0)} a cycle this never clears — interest alone is about ${fmt(payoff.interestPerCycle)} each time.`
            : `${goal.apr}% APR · ${fmt(payoff.totalInterest)} of interest before it's gone.`}
        </div>
      )}

      {!progress.complete && (
        <div className="mobile-row-stack" style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <input className="glass-input" type="number" min="0" step="0.01" placeholder="0.00"
            aria-label={`Amount to move for ${goal.name}`}
            value={amount} onChange={e => setAmount(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && move(1)}
            style={{ flex: '1 1 110px', maxWidth: 160, padding: '8px 10px' }} />
          <button className="btn-primary" onClick={() => move(1)} disabled={!(parseFloat(amount) > 0)}
            style={{ padding: '8px 12px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}>
            <Plus size={13} /> {isDebt ? 'Pay off' : 'Add'}
          </button>
          <button className="btn-secondary" onClick={() => move(-1)} disabled={!(parseFloat(amount) > 0)}
            style={{ padding: '8px 12px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}>
            <Minus size={13} /> Take out
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Savings goals, sinking funds and debts.
 *
 * Contributions are earmarks — they don't move money between accounts, they
 * mark some of what you already have as spoken for. That keeps goals from
 * double-counting against transactions and leaves the account balance as the
 * single truth about how much money exists.
 */
export default function Goals({
  goals = [],
  incomes = [],
  onAddGoal,
  onEditGoal,
  onDeleteGoal,
  onContribute,
}) {
  const totals = useMemo(() => {
    const saving = goals.filter(g => g.kind !== GOAL_DEBT);
    const debt = goals.filter(g => g.kind === GOAL_DEBT);
    return {
      saved: roundMoney(saving.reduce((sum, g) => sum + (g.saved || 0), 0)),
      savingTarget: roundMoney(saving.reduce((sum, g) => sum + (g.target || 0), 0)),
      debtRemaining: roundMoney(debt.reduce((sum, g) => sum + Math.max(0, (g.target || 0) - (g.saved || 0)), 0)),
      perCycle: roundMoney(goals.reduce((sum, g) => sum + (g.perCycleContribution || 0), 0)),
      offTrack: goals.filter(g => isGoalOffTrack(g, incomes)).length,
    };
  }, [goals, incomes]);

  // Only worth computing — and only worth showing — when there are at least two
  // debts to order. With one, the two strategies are the same plan.
  const strategies = useMemo(
    () => (goals.filter(g => g.kind === GOAL_DEBT && (g.target || 0) > (g.saved || 0)).length > 1
      ? compareDebtStrategies(goals, incomes)
      : null),
    [goals, incomes],
  );

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="glass mobile-card-pad mobile-row-stack" style={{ borderRadius: 18, padding: '18px 22px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <CardTitle as="h2">Goals</CardTitle>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
            Money set aside on purpose — saving pots and debts you're clearing
          </div>
        </div>
        <button className="btn-primary" onClick={onAddGoal} style={{ padding: '7px 14px', fontSize: 12 }}>
          + Add Goal
        </button>
      </div>

      {goals.length > 0 && (
        <div className="mobile-stack" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
          {[
            ['Saved', fmt(totals.saved), `of ${fmt(totals.savingTarget)} targeted`],
            ['Debt left', fmt(totals.debtRemaining), 'still to clear'],
            ['Per cycle', fmt(totals.perCycle), 'set aside automatically'],
            ['Off track', totals.offTrack, 'behind their target date'],
          ].map(([label, value, hint]) => (
            <div key={label} className="glass" style={{ borderRadius: 14, padding: '15px 16px' }}>
              <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 5 }}>{label}</div>
              <div style={{ fontSize: 20, fontWeight: 700 }}>{value}</div>
              <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 3 }}>{hint}</div>
            </div>
          ))}
        </div>
      )}

      {strategies?.differs && (
        <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '20px 22px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
            <Landmark size={16} color="var(--accent-purple)" aria-hidden="true" />
            <CardTitle as="h2">Which debt to clear first</CardTitle>
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 14, lineHeight: 1.6 }}>
            Both orders use the {fmt(totals.perCycle)} you already put aside each
            cycle — minimums on everything, then everything left over aimed at one
            debt, moving to the next as each clears.
          </div>

          <div className="mobile-stack" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
            {[
              ['Highest rate first', strategies.avalanche, 'Costs the least interest.'],
              ['Smallest balance first', strategies.snowball, 'Clears one sooner, for the momentum.'],
            ].map(([label, result, hint]) => (
              <div key={label} style={{
                borderRadius: 12, padding: '14px 15px',
                background: result === strategies.avalanche ? 'rgba(79,255,176,0.06)' : 'rgba(255,255,255,0.04)',
                border: `1px solid ${result === strategies.avalanche ? 'rgba(79,255,176,0.22)' : 'transparent'}`,
              }}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 5 }}>{label}</div>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{fmt(result.totalInterest)}</div>
                <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 3, lineHeight: 1.6 }}>
                  interest in total · debt-free {result.date ? format(result.date, 'MMM yyyy') : 'never'}
                  <span style={{ display: 'block', marginTop: 3 }}>{hint}</span>
                  <span style={{ display: 'block', marginTop: 3 }}>Order: {result.order.join(' → ')}</span>
                </div>
              </div>
            ))}
          </div>

          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 12, lineHeight: 1.6 }}>
            Paying the dearest debt first saves you <strong style={{ color: 'var(--good)' }}>{fmt(strategies.saving)}</strong>.
            {strategies.saving < 25 && ' That’s a small enough gap that whichever you’ll actually stick to is the better plan.'}
          </div>
        </div>
      )}

      {goals.length === 0 ? (
        <div className="glass" style={{ borderRadius: 16, padding: '48px 24px', textAlign: 'center' }}>
          <PiggyBank size={32} style={{ color: 'var(--text-muted)', margin: '0 auto 12px', display: 'block' }} />
          <div style={{ color: 'var(--text-muted)', fontSize: 14, marginBottom: 6 }}>No goals yet</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, maxWidth: 420, margin: '0 auto 16px', lineHeight: 1.6 }}>
            Set money aside for something specific — a holiday, a new laptop, an
            emergency fund — or track a debt you're paying down. Link a goal to an
            income and it tops itself up every payday.
          </div>
          <button className="btn-primary" onClick={onAddGoal}>Add your first goal</button>
        </div>
      ) : (
        goals.map(goal => (
          <GoalCard key={goal.id} goal={goal} incomes={incomes}
            onContribute={onContribute} onEdit={onEditGoal} onDelete={onDeleteGoal} />
        ))
      )}

      {goals.some(g => g.perCycleContribution > 0) && (
        <div style={{ color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.6, padding: '0 4px' }}>
          Contributions still to come out this cycle are deducted from your
          safe-to-spend figure, so money you've promised yourself isn't offered
          back as spending money.
        </div>
      )}
    </div>
  );
}
