import { useMemo, useState } from 'react';
import { addDays, addMonths, differenceInDays, eachDayOfInterval, format, isSameDay, isSameMonth, startOfDay, startOfMonth, startOfWeek, subMonths } from 'date-fns';
import { CalendarDays, ChevronLeft, ChevronRight, CreditCard, List, Pause, Pencil, Play, Plus, Receipt, Trash2, Wallet } from 'lucide-react';
import { addRecurringInterval, calcNextReset, fmt, getSignedAmount, isRefund, normalizeIncomeAllocations } from '../utils';
import { CardTitle, IconButton } from '../components/ui';

const FREQ_LABEL = {
  weekly: 'Weekly',
  fortnightly: 'Fortnightly',
  '4weekly': 'Every 4 weeks',
  monthly: 'Monthly',
};

function getIncomeOccurrences(incomes, categories, rangeStart, rangeEnd) {
  const events = [];

  for (const income of incomes) {
    const freq = income.resetFrequency || (income.payDayOfMonth ? 'monthly' : null);
    if (!freq || income.holdActive) continue;

    const linkedCategories = categories.filter(category =>
      normalizeIncomeAllocations(category.incomeAllocations)
        .some(allocation => allocation.incomeId === Number(income.id))
    );

    let next = calcNextReset(freq, income.payDayOfMonth, income.lastPaid ? new Date(income.lastPaid) : new Date());
    let guard = 0;
    while (next < rangeStart && guard < 240) {
      next = calcNextReset(freq, income.payDayOfMonth, next);
      guard += 1;
    }

    while (next <= rangeEnd && guard < 260) {
      events.push({
        id: `income-${income.id}-${next.toISOString()}`,
        type: 'income',
        date: next,
        title: income.name,
        amount: Number(income.amount) || 0,
        meta: linkedCategories.length
          ? `${linkedCategories.length} categor${linkedCategories.length === 1 ? 'y' : 'ies'} reset`
          : FREQ_LABEL[freq],
      });
      next = calcNextReset(freq, income.payDayOfMonth, next);
      guard += 1;
    }
  }

  return events;
}

function getSubscriptionOccurrences(subscriptions, categories, rangeStart, rangeEnd) {
  const categoryMap = new Map(categories.map(category => [Number(category.id), category]));
  const events = [];

  for (const subscription of subscriptions) {
    if (subscription.active === false || !subscription.nextDueAt) continue;

    let next = startOfDay(new Date(subscription.nextDueAt));
    let guard = 0;
    while (next < rangeStart && guard < 240) {
      next = addRecurringInterval(next, subscription.intervalUnit || 'month', subscription.interval || 1);
      guard += 1;
    }

    while (next <= rangeEnd && guard < 260) {
      const category = categoryMap.get(Number(subscription.categoryId));
      events.push({
        id: `subscription-${subscription.id}-${next.toISOString()}`,
        type: 'subscription',
        date: next,
        title: subscription.name,
        amount: Number(subscription.amount) || 0,
        color: category?.color,
        meta: category?.name || 'Subscription',
      });
      next = addRecurringInterval(next, subscription.intervalUnit || 'month', subscription.interval || 1);
      guard += 1;
    }
  }

  return events;
}

function getTransactionOccurrences(transactions, categories, rangeStart, rangeEnd) {
  const categoryMap = new Map(categories.map(category => [Number(category.id), category]));
  const events = [];

  for (const tx of transactions) {
    const date = new Date(tx.date);
    if (Number.isNaN(date.getTime())) continue;
    const day = startOfDay(date);
    if (day < rangeStart || day > rangeEnd) continue;

    const category = categoryMap.get(Number(tx.categoryId));
    events.push({
      id: `tx-${tx.id}`,
      type: isRefund(tx) ? 'refund' : 'expense',
      date: day,
      title: tx.note || category?.name || 'Expense',
      amount: Math.abs(Number(tx.amount) || 0),
      signed: getSignedAmount(tx),
      color: category?.color,
      meta: category?.name || 'Uncategorised',
      transaction: tx,
    });
  }

  return events;
}

function formatRecurrence(subscription) {
  const interval = Number(subscription.interval) || 1;
  const unit = subscription.intervalUnit || 'month';
  const label = interval === 1 ? unit : `${unit}s`;
  return `Every ${interval} ${label}`;
}

export default function Calendar({
  categories = [],
  incomes = [],
  subscriptions = [],
  transactions = [],
  onAddSubscription,
  onEditSubscription,
  onDeleteSubscription,
  onToggleSubscription,
  onAddExpenseOn,
  onEditTransaction,
}) {
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [selectedDay, setSelectedDay] = useState(null);
  const [showActuals, setShowActuals] = useState(true);
  const rangeStart = startOfWeek(startOfMonth(month), { weekStartsOn: 1 });
  const rangeEnd = addDays(rangeStart, 34); // always 7×5 = 35 cells
  const days = useMemo(() => eachDayOfInterval({ start: rangeStart, end: rangeEnd }), [rangeStart, rangeEnd]);
  const categoryMap = useMemo(() => new Map(categories.map(category => [Number(category.id), category])), [categories]);
  const today = startOfDay(new Date());

  const events = useMemo(() => (
    [
      ...getIncomeOccurrences(incomes, categories, rangeStart, rangeEnd),
      ...getSubscriptionOccurrences(subscriptions, categories, rangeStart, rangeEnd),
      ...(showActuals ? getTransactionOccurrences(transactions, categories, rangeStart, rangeEnd) : []),
    ].sort((a, b) => a.date - b.date)
  ), [incomes, categories, subscriptions, transactions, showActuals, rangeStart, rangeEnd]);

  const eventMap = useMemo(() => {
    const map = {};
    for (const event of events) {
      const key = format(event.date, 'yyyy-MM-dd');
      if (!map[key]) map[key] = [];
      map[key].push(event);
    }
    return map;
  }, [events]);

  // Only scheduled things are "upcoming" — a transaction logged today is
  // history, not a plan.
  const upcoming = useMemo(() => (
    events.filter(event => event.date >= today && (event.type === 'income' || event.type === 'subscription')).slice(0, 8)
  ), [events, today]);

  const selectedKey = selectedDay ? format(selectedDay, 'yyyy-MM-dd') : null;
  const selectedEvents = selectedKey ? (eventMap[selectedKey] || []) : [];

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '20px 22px' }}>
        <div className="mobile-row-stack" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <CalendarDays size={18} color="var(--accent-blue)" aria-hidden="true" />
            <div>
              <CardTitle as="h2" style={{ fontSize: 16 }}>Financial Calendar</CardTitle>
              <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>Paydays, resets, and subscriptions</div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button type="button" className={showActuals ? 'btn-primary' : 'btn-secondary'}
              onClick={() => setShowActuals(value => !value)} aria-pressed={showActuals}
              title="Show what you actually spent, alongside what's scheduled"
              style={{ padding: '6px 10px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 5 }}>
              <Receipt size={12} /> Spend
            </button>
            <IconButton onClick={() => setMonth(current => subMonths(current, 1))} label="Previous month">
              <ChevronLeft size={15} />
            </IconButton>
            <div aria-live="polite" style={{ minWidth: 130, textAlign: 'center', fontSize: 14, fontWeight: 700 }}>{format(month, 'MMMM yyyy')}</div>
            <IconButton onClick={() => setMonth(current => addMonths(current, 1))} label="Next month">
              <ChevronRight size={15} />
            </IconButton>
          </div>
        </div>

        <div className="finance-calendar">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => (
            <div key={day} className="finance-calendar-weekday">{day}</div>
          ))}
          {days.map(day => {
            const key = format(day, 'yyyy-MM-dd');
            const dayEvents = eventMap[key] || [];
            const inMonth = isSameMonth(day, month);
            const isToday = isSameDay(day, today);

            const isSelected = selectedKey === key;
            const dayNet = dayEvents.reduce((sum, event) => (
              event.type === 'income' ? sum + event.amount
                : event.type === 'refund' ? sum + event.amount
                : sum - event.amount
            ), 0);

            return (
              <button
                key={key}
                type="button"
                onClick={() => setSelectedDay(day)}
                aria-label={`${format(day, 'd MMMM yyyy')}, ${dayEvents.length} event${dayEvents.length === 1 ? '' : 's'}`}
                aria-pressed={isSelected}
                className={`finance-calendar-day${inMonth ? '' : ' muted'}${isToday ? ' today' : ''}${isSelected ? ' selected' : ''}`}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: isToday ? 800 : 600 }}>{format(day, 'd')}</span>
                  {dayEvents.length > 2 && <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>+{dayEvents.length - 2}</span>}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {dayEvents.slice(0, 2).map(event => (
                    <div key={event.id} className={`finance-calendar-event ${event.type}`}>
                      <span style={{
                        width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                        background: event.type === 'income' ? 'var(--accent-mint)'
                          : event.type === 'refund' ? 'var(--good)'
                          : event.color || 'var(--accent-warm)',
                      }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{event.title}</span>
                    </div>
                  ))}
                </div>
                {dayEvents.length > 0 && dayNet !== 0 && (
                  <div style={{ marginTop: 'auto', paddingTop: 4, fontSize: 9, color: dayNet > 0 ? 'var(--accent-mint)' : 'var(--text-muted)' }}>
                    {dayNet > 0 ? '+' : '−'}{fmt(Math.abs(dayNet))}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {selectedDay && (
        <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '20px 22px' }}>
          <div className="mobile-row-stack" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
            <div>
              <CardTitle as="h2">{format(selectedDay, 'EEEE d MMMM')}</CardTitle>
              <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>
                {selectedEvents.length === 0
                  ? 'Nothing on this day'
                  : `${selectedEvents.length} item${selectedEvents.length === 1 ? '' : 's'}`}
              </div>
            </div>
            <div className="mobile-actions" style={{ display: 'flex', gap: 8 }}>
              {onAddExpenseOn && (
                <button className="btn-primary" onClick={() => onAddExpenseOn(selectedDay)}
                  style={{ padding: '7px 12px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Plus size={13} /> Add expense here
                </button>
              )}
              <button className="btn-secondary" onClick={() => setSelectedDay(null)}
                style={{ padding: '7px 12px', fontSize: 12 }}>
                Close
              </button>
            </div>
          </div>

          {selectedEvents.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {selectedEvents.map(event => (
                <div key={event.id} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '10px 12px', borderRadius: 10, background: 'rgba(255,255,255,0.04)',
                }}>
                  {event.type === 'income' ? <Wallet size={13} color="var(--accent-mint)" />
                    : event.type === 'subscription' ? <CreditCard size={13} color={event.color || 'var(--accent-warm)'} />
                    : <Receipt size={13} color={event.color || 'var(--text-muted)'} />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {event.title}
                    </div>
                    <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 2 }}>
                      {event.type === 'expense' || event.type === 'refund' ? 'Logged' : 'Scheduled'} · {event.meta}
                    </div>
                  </div>
                  <div style={{
                    fontSize: 13, fontWeight: 700, flexShrink: 0,
                    color: event.type === 'income' || event.type === 'refund' ? 'var(--accent-mint)' : 'var(--accent-warm)',
                  }}>
                    {event.type === 'income' || event.type === 'refund' ? '+' : '-'}{fmt(event.amount)}
                  </div>
                  {event.transaction && onEditTransaction && (
                    <IconButton onClick={() => onEditTransaction(event.transaction)} size={28}
                      style={{ opacity: 0.6, flexShrink: 0 }} label={`Edit ${event.title}`}>
                      <Pencil size={12} />
                    </IconButton>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="mobile-stack" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
        <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '20px 22px' }}>
          <CardTitle as="h2" style={{ marginBottom: 12 }}>Upcoming</CardTitle>
          {upcoming.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Nothing scheduled in this calendar view.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {upcoming.map(event => (
                <div key={event.id} className="mobile-stack" style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(150px, 1fr) auto',
                  gap: 12,
                  padding: '10px 12px',
                  borderRadius: 12,
                  background: 'rgba(255,255,255,0.04)',
                  alignItems: 'center',
                }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {event.type === 'income' ? <Wallet size={13} color="var(--accent-mint)" /> : <CreditCard size={13} color={event.color || 'var(--accent-warm)'} />}
                      <span style={{ fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{event.title}</span>
                    </div>
                    <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 2 }}>
                      {format(event.date, 'd MMM yyyy')} · {event.meta}
                      {event.date >= today ? ` · ${differenceInDays(event.date, today)}d` : ''}
                    </div>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: event.type === 'income' ? 'var(--accent-mint)' : 'var(--accent-warm)' }}>
                    {event.type === 'income' ? '+' : '-'}{fmt(event.amount)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '20px 22px' }}>
          <div className="mobile-row-stack" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
            <CardTitle as="h2">Subscriptions</CardTitle>
            <button className="btn-primary mobile-full" onClick={onAddSubscription}
              disabled={categories.length === 0}
              title={categories.length === 0 ? 'Add categories before creating subscriptions' : 'Add subscription'}
              style={{ padding: '7px 11px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Plus size={13} /> Add
            </button>
          </div>

          {subscriptions.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              Add recurring expenses like streaming, rent, insurance, or memberships.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[...subscriptions].sort((a, b) => new Date(a.nextDueAt) - new Date(b.nextDueAt)).map(subscription => {
                const category = categoryMap.get(Number(subscription.categoryId));
                return (
                  <div key={subscription.id} style={{
                    padding: '10px 12px',
                    borderRadius: 12,
                    background: subscription.active === false ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.04)',
                    border: subscription.active === false ? '1px solid rgba(251,191,112,0.16)' : '1px solid transparent',
                  }}>
                    <div className="mobile-stack" style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 1fr) auto', gap: 10, alignItems: 'center' }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: category?.color || 'var(--accent-warm)', flexShrink: 0 }} />
                          <span style={{ fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {subscription.name}
                          </span>
                        </div>
                        <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 3 }}>
                          {category?.name || 'Missing category'} · {formatRecurrence(subscription)}
                          {subscription.active === false ? ' · Paused' : ` · next ${format(new Date(subscription.nextDueAt), 'd MMM')}`}
                        </div>
                      </div>
                      <div className="mobile-center-left" style={{ fontSize: 13, fontWeight: 700, color: 'var(--accent-warm)', textAlign: 'right' }}>-{fmt(subscription.amount || 0)}</div>
                    </div>
                    <div className="mobile-actions" style={{ display: 'flex', gap: 7, justifyContent: 'flex-end', marginTop: 8, flexWrap: 'wrap' }}>
                      <IconButton onClick={() => onToggleSubscription(subscription)}
                        label={`${subscription.active === false ? 'Resume' : 'Pause'} ${subscription.name}`}
                        size={28} style={{ opacity: 0.72 }}>
                        {subscription.active === false ? <Play size={12} /> : <Pause size={12} />}
                      </IconButton>
                      <IconButton onClick={() => onEditSubscription(subscription)}
                        label={`Edit ${subscription.name}`} size={28} style={{ opacity: 0.72 }}>
                        <Pencil size={12} />
                      </IconButton>
                      <IconButton onClick={() => onDeleteSubscription(subscription)}
                        label={`Delete ${subscription.name}`} size={28} style={{ opacity: 0.58 }}>
                        <Trash2 size={12} />
                      </IconButton>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
