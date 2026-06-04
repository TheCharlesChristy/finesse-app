import { useMemo, useState } from 'react';
import { differenceInDays, format, getDaysInMonth, startOfDay } from 'date-fns';
import { CreditCard, ExternalLink, Pause, Pencil, Play, Plus, Search, Trash2 } from 'lucide-react';
import { fmt } from '../utils';
import { CardTitle, IconButton } from '../components/ui';

const sortOptions = [
  ['due-asc', 'Due soonest'],
  ['due-desc', 'Due latest'],
  ['amount-desc', 'Amount high to low'],
  ['amount-asc', 'Amount low to high'],
  ['name-asc', 'Name A to Z'],
  ['name-desc', 'Name Z to A'],
  ['category-asc', 'Category A to Z'],
  ['category-desc', 'Category Z to A'],
  ['status-asc', 'Status'],
];

function formatRecurrence(subscription) {
  const interval = Number(subscription.interval) || 1;
  const unit = subscription.intervalUnit || 'month';
  const label = interval === 1 ? unit : `${unit}s`;
  return `Every ${interval} ${label}`;
}

function monthlyEquivalent(subscription, date = new Date()) {
  const amount = Number(subscription.amount) || 0;
  const interval = Math.max(1, Number(subscription.interval) || 1);
  const unit = subscription.intervalUnit || 'month';

  if (unit === 'day') return amount * (getDaysInMonth(date) / interval);
  if (unit === 'week') return amount * (52 / 12) / interval;
  if (unit === 'year') return amount / (12 * interval);
  return amount / interval;
}

function displayLink(url = '') {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'Manage';
  }
}

function parseSubscriptionDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : startOfDay(date);
}

function getDueLabel(subscription, today) {
  if (subscription.active === false) return 'Paused';
  const dueDate = parseSubscriptionDate(subscription.nextDueAt);
  if (!dueDate) return 'No due date';

  const days = differenceInDays(dueDate, today);
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  return `Due in ${days}d`;
}

function compareText(a, b) {
  return String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base' });
}

export default function Subscriptions({
  subscriptions = [],
  categories = [],
  onAddSubscription,
  onEditSubscription,
  onDeleteSubscription,
  onToggleSubscription,
}) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('active');
  const [sortBy, setSortBy] = useState('due-asc');
  const categoryMap = useMemo(() => new Map(categories.map(category => [Number(category.id), category])), [categories]);
  const today = startOfDay(new Date());

  const activeSubscriptions = subscriptions.filter(subscription => subscription.active !== false);
  const pausedSubscriptions = subscriptions.filter(subscription => subscription.active === false);
  const monthlyTotal = activeSubscriptions.reduce((sum, subscription) => sum + monthlyEquivalent(subscription), 0);
  const next30Total = activeSubscriptions.reduce((sum, subscription) => {
    const dueDate = parseSubscriptionDate(subscription.nextDueAt);
    if (!dueDate) return sum;
    const days = differenceInDays(dueDate, today);
    return days >= 0 && days <= 30 ? sum + (Number(subscription.amount) || 0) : sum;
  }, 0);

  const visibleSubscriptions = useMemo(() => {
    const query = search.trim().toLowerCase();
    return subscriptions
      .filter(subscription => {
        if (filter === 'active' && subscription.active === false) return false;
        if (filter === 'paused' && subscription.active !== false) return false;
        return true;
      })
      .filter(subscription => {
        if (!query) return true;
        const category = categoryMap.get(Number(subscription.categoryId));
        return [
          subscription.name,
          subscription.note,
          subscription.manageUrl,
          category?.name,
        ].filter(Boolean).some(value => String(value).toLowerCase().includes(query));
      })
      .sort((a, b) => {
        const aDue = parseSubscriptionDate(a.nextDueAt)?.getTime() || 0;
        const bDue = parseSubscriptionDate(b.nextDueAt)?.getTime() || 0;
        const aAmount = Number(a.amount) || 0;
        const bAmount = Number(b.amount) || 0;
        const aCategory = categoryMap.get(Number(a.categoryId))?.name || 'Missing category';
        const bCategory = categoryMap.get(Number(b.categoryId))?.name || 'Missing category';
        const aName = a.name || '';
        const bName = b.name || '';
        const aStatus = a.active === false ? 'Paused' : 'Active';
        const bStatus = b.active === false ? 'Paused' : 'Active';
        const fallback = aDue - bDue || compareText(aName, bName) || (Number(a.id) || 0) - (Number(b.id) || 0);

        switch (sortBy) {
          case 'due-desc':
            return bDue - aDue || compareText(aName, bName) || (Number(b.id) || 0) - (Number(a.id) || 0);
          case 'amount-desc':
            return bAmount - aAmount || fallback;
          case 'amount-asc':
            return aAmount - bAmount || fallback;
          case 'name-asc':
            return compareText(aName, bName) || fallback;
          case 'name-desc':
            return compareText(bName, aName) || fallback;
          case 'category-asc':
            return compareText(aCategory, bCategory) || fallback;
          case 'category-desc':
            return compareText(bCategory, aCategory) || fallback;
          case 'status-asc':
            return compareText(aStatus, bStatus) || fallback;
          case 'due-asc':
          default:
            return fallback;
        }
      });
  }, [subscriptions, search, filter, categoryMap, sortBy]);

  const filtersActive = search.trim() || filter !== 'active' || sortBy !== 'due-asc';

  const resetFilters = () => {
    setSearch('');
    setFilter('active');
    setSortBy('due-asc');
  };

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '20px 22px' }}>
        <div className="mobile-row-stack" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <CreditCard size={18} color="var(--accent-warm)" aria-hidden="true" />
            <div>
              <CardTitle as="h2" style={{ fontSize: 17 }}>Subscriptions</CardTitle>
              <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>Recurring expenses and account management links</div>
            </div>
          </div>
          <button className="btn-primary mobile-full" onClick={onAddSubscription}
            disabled={categories.length === 0}
            title={categories.length === 0 ? 'Add a category before creating subscriptions' : 'Add subscription'}
            style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <Plus size={15} /> Add Subscription
          </button>
        </div>
      </div>

      <div className="mobile-stack" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        {[
          ['Monthly estimate', fmt(monthlyTotal), 'Active subscriptions'],
          ['Next 30 days', fmt(next30Total), 'Upcoming charges'],
          ['Active', activeSubscriptions.length, 'Currently scheduled'],
          ['Paused', pausedSubscriptions.length, 'Excluded from auto-log'],
        ].map(([label, value, hint]) => (
          <div key={label} className="glass" style={{ borderRadius: 14, padding: '15px 16px' }}>
            <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 5 }}>{label}</div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{value}</div>
            <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 3 }}>{hint}</div>
          </div>
        ))}
      </div>

      <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '16px' }}>
        <div className="subs-filter-bar">
          <div className="subs-filter-search">
            <Search size={15} aria-hidden="true" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            <input className="glass-input" placeholder="Search subscriptions, categories, or links" value={search}
              aria-label="Search subscriptions" onChange={e => setSearch(e.target.value)} style={{ paddingLeft: 36 }} />
          </div>
          <div role="group" aria-label="Filter subscriptions" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[
              ['all', 'All'],
              ['active', 'Active'],
              ['paused', 'Paused'],
            ].map(([id, label]) => (
              <button key={id} type="button" aria-pressed={filter === id} className={filter === id ? 'btn-primary' : 'btn-secondary'}
                onClick={() => setFilter(id)} style={{ padding: '9px 12px', fontSize: 12 }}>
                {label}
              </button>
            ))}
          </div>
          <select className="glass-input subs-filter-sort" value={sortBy} onChange={e => setSortBy(e.target.value)} aria-label="Sort subscriptions">
            {sortOptions.map(([value, label]) => <option key={value} value={value}>Sort: {label}</option>)}
          </select>
          {filtersActive && (
            <button className="btn-secondary" type="button" onClick={resetFilters} style={{ padding: '9px 12px', fontSize: 12 }}>
              Reset
            </button>
          )}
        </div>

        {subscriptions.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '34px 16px' }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 7 }}>No subscriptions yet</div>
            <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16 }}>
              Add rent, streaming, insurance, memberships, or anything else that repeats.
            </div>
            <button className="btn-primary" onClick={onAddSubscription} disabled={categories.length === 0}>
              Add Subscription
            </button>
          </div>
        ) : visibleSubscriptions.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: '28px 12px' }}>
            No subscriptions match this view.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {visibleSubscriptions.map(subscription => {
              const category = categoryMap.get(Number(subscription.categoryId));
              const active = subscription.active !== false;
              const manageUrl = subscription.manageUrl && /^https?:\/\//i.test(subscription.manageUrl)
                ? subscription.manageUrl
                : '';
              const dueDate = parseSubscriptionDate(subscription.nextDueAt);
              return (
                <div key={subscription.id} style={{
                  padding: '14px',
                  borderRadius: 14,
                  border: active ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(251,191,112,0.18)',
                  background: active ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.025)',
                }}>
                  <div className="mobile-stack" style={{ display: 'grid', gridTemplateColumns: 'minmax(190px, 1fr) auto', gap: 12, alignItems: 'start' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                        <span style={{ width: 9, height: 9, borderRadius: '50%', background: category?.color || 'var(--accent-warm)', flexShrink: 0 }} />
                        <div className="mobile-no-nowrap" style={{ fontSize: 15, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {subscription.name}
                        </div>
                      </div>
                      <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                        {category?.name || 'Missing category'} · {formatRecurrence(subscription)}
                        {dueDate ? ` · next ${format(dueDate, 'd MMM yyyy')}` : ''}
                      </div>
                      {subscription.note && (
                        <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 6, lineHeight: 1.45 }}>
                          {subscription.note}
                        </div>
                      )}
                      {manageUrl && (
                        <a href={manageUrl} target="_blank" rel="noreferrer"
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--accent-blue)', fontSize: 12, marginTop: 8, textDecoration: 'none' }}>
                          <ExternalLink size={12} /> {displayLink(manageUrl)}
                        </a>
                      )}
                    </div>
                    <div className="mobile-center-left" style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--accent-warm)' }}>
                        -{fmt(subscription.amount || 0)}
                      </div>
                      <div style={{
                        fontSize: 11,
                        color: active ? 'var(--text-muted)' : 'var(--warn)',
                        marginTop: 4,
                        whiteSpace: 'nowrap',
                      }}>
                        {getDueLabel(subscription, today)}
                      </div>
                    </div>
                  </div>

                  <div className="mobile-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                    {manageUrl && (
                      <a className="btn-secondary" href={manageUrl} target="_blank" rel="noreferrer"
                        style={{ padding: '7px 10px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}>
                        <ExternalLink size={13} /> Manage
                      </a>
                    )}
                    <button className="btn-secondary" onClick={() => onToggleSubscription(subscription)}
                      style={{ padding: '7px 10px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                      {active ? <Pause size={13} /> : <Play size={13} />}
                      {active ? 'Pause' : 'Resume'}
                    </button>
                    <button className="btn-secondary" onClick={() => onEditSubscription(subscription)}
                      style={{ padding: '7px 10px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Pencil size={13} /> Edit
                    </button>
                    <IconButton onClick={() => onDeleteSubscription(subscription)}
                      label={`Delete ${subscription.name}`} size={34} style={{ opacity: 0.68 }}>
                      <Trash2 size={13} />
                    </IconButton>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
