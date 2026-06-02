import { useMemo, useState } from 'react';
import { addMonths, differenceInDays, eachDayOfInterval, endOfMonth, endOfWeek, format, isSameDay, isSameMonth, startOfDay, startOfMonth, startOfWeek, subMonths } from 'date-fns';
import { CalendarDays, ChevronLeft, ChevronRight, CreditCard, Pause, Pencil, Play, Plus, Trash2, Wallet } from 'lucide-react';
import { addRecurringInterval, calcNextReset, fmt, normalizeIncomeAllocations } from '../utils';

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
  onAddSubscription,
  onEditSubscription,
  onDeleteSubscription,
  onToggleSubscription,
}) {
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const rangeStart = startOfWeek(startOfMonth(month), { weekStartsOn: 1 });
  const rangeEnd = endOfWeek(endOfMonth(month), { weekStartsOn: 1 });
  const days = useMemo(() => eachDayOfInterval({ start: rangeStart, end: rangeEnd }), [rangeStart, rangeEnd]);
  const categoryMap = useMemo(() => new Map(categories.map(category => [Number(category.id), category])), [categories]);
  const today = startOfDay(new Date());

  const events = useMemo(() => (
    [
      ...getIncomeOccurrences(incomes, categories, rangeStart, rangeEnd),
      ...getSubscriptionOccurrences(subscriptions, categories, rangeStart, rangeEnd),
    ].sort((a, b) => a.date - b.date)
  ), [incomes, categories, subscriptions, rangeStart, rangeEnd]);

  const eventMap = useMemo(() => {
    const map = {};
    for (const event of events) {
      const key = format(event.date, 'yyyy-MM-dd');
      if (!map[key]) map[key] = [];
      map[key].push(event);
    }
    return map;
  }, [events]);

  const upcoming = useMemo(() => (
    events.filter(event => event.date >= today).slice(0, 8)
  ), [events, today]);

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '20px 22px' }}>
        <div className="mobile-row-stack" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <CalendarDays size={18} color="var(--accent-blue)" />
            <div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>Financial Calendar</div>
              <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>Paydays, resets, and subscriptions</div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className="btn-icon" onClick={() => setMonth(current => subMonths(current, 1))} title="Previous month">
              <ChevronLeft size={15} />
            </button>
            <div style={{ minWidth: 130, textAlign: 'center', fontSize: 14, fontWeight: 700 }}>{format(month, 'MMMM yyyy')}</div>
            <button className="btn-icon" onClick={() => setMonth(current => addMonths(current, 1))} title="Next month">
              <ChevronRight size={15} />
            </button>
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

            return (
              <div key={key} className={`finance-calendar-day${inMonth ? '' : ' muted'}${isToday ? ' today' : ''}`}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: isToday ? 800 : 600 }}>{format(day, 'd')}</span>
                  {dayEvents.length > 2 && <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>+{dayEvents.length - 2}</span>}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {dayEvents.slice(0, 2).map(event => (
                    <div key={event.id} className={`finance-calendar-event ${event.type}`}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: event.type === 'income' ? 'var(--accent-mint)' : event.color || 'var(--accent-warm)', flexShrink: 0 }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{event.title}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="mobile-stack" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
        <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '20px 22px' }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>Upcoming</div>
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
                  <div style={{ fontSize: 13, fontWeight: 800, color: event.type === 'income' ? 'var(--accent-mint)' : 'var(--accent-warm)' }}>
                    {event.type === 'income' ? '+' : '-'}{fmt(event.amount)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '20px 22px' }}>
          <div className="mobile-row-stack" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>Subscriptions</div>
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
                      <div className="mobile-center-left" style={{ fontSize: 13, fontWeight: 800, color: 'var(--accent-warm)', textAlign: 'right' }}>-{fmt(subscription.amount || 0)}</div>
                    </div>
                    <div className="mobile-actions" style={{ display: 'flex', gap: 7, justifyContent: 'flex-end', marginTop: 8, flexWrap: 'wrap' }}>
                      <button className="btn-icon" onClick={() => onToggleSubscription(subscription)}
                        title={subscription.active === false ? 'Resume subscription' : 'Pause subscription'}
                        style={{ width: 28, height: 28, opacity: 0.72 }}>
                        {subscription.active === false ? <Play size={12} /> : <Pause size={12} />}
                      </button>
                      <button className="btn-icon" onClick={() => onEditSubscription(subscription)}
                        title="Edit subscription" style={{ width: 28, height: 28, opacity: 0.72 }}>
                        <Pencil size={12} />
                      </button>
                      <button className="btn-icon" onClick={() => onDeleteSubscription(subscription)}
                        title="Delete subscription" style={{ width: 28, height: 28, opacity: 0.58 }}>
                        <Trash2 size={12} />
                      </button>
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
