import { useState, useMemo } from 'react';
import { CreditCard, Layers3, Pencil, Trash2, Search } from 'lucide-react';
import { fmt } from '../utils';
import { format, isSameDay, isSameMonth, startOfDay, subDays } from 'date-fns';
import CategorySelect from '../components/CategorySelect';
import { IconButton } from '../components/ui';

const dateFilterOptions = [
  ['all', 'Any date'],
  ['today', 'Today'],
  ['last-7', 'Last 7 days'],
  ['last-30', 'Last 30 days'],
  ['this-month', 'This month'],
];

const amountFilterOptions = [
  ['all', 'Any amount'],
  ['under-25', 'Under £25'],
  ['25-100', '£25 to £100'],
  ['over-100', 'Over £100'],
];

const typeFilterOptions = [
  ['all', 'All expenses'],
  ['manual', 'Manual only'],
  ['subscription', 'Subscriptions'],
];

const sortOptions = [
  ['date-desc', 'Newest first'],
  ['date-asc', 'Oldest first'],
  ['amount-desc', 'Amount high to low'],
  ['amount-asc', 'Amount low to high'],
  ['category-asc', 'Category A to Z'],
];

function getTransactionDate(tx) {
  const date = new Date(tx.date);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isSubscriptionTransaction(tx) {
  return Boolean(tx.subscriptionId || tx.subscriptionRunKey);
}

function matchesDateFilter(tx, filter) {
  if (filter === 'all') return true;
  const txDate = getTransactionDate(tx);
  if (!txDate) return false;

  const day = startOfDay(txDate);
  const today = startOfDay(new Date());

  switch (filter) {
    case 'today':
      return isSameDay(day, today);
    case 'last-7':
      return day >= subDays(today, 6);
    case 'last-30':
      return day >= subDays(today, 29);
    case 'this-month':
      return isSameMonth(day, today);
    default:
      return true;
  }
}

function matchesAmountFilter(tx, filter) {
  const amount = Number(tx.amount) || 0;
  switch (filter) {
    case 'under-25':
      return amount < 25;
    case '25-100':
      return amount >= 25 && amount <= 100;
    case 'over-100':
      return amount > 100;
    default:
      return true;
  }
}

function matchesTypeFilter(tx, filter) {
  const subscription = isSubscriptionTransaction(tx);
  if (filter === 'manual') return !subscription;
  if (filter === 'subscription') return subscription;
  return true;
}

export default function Transactions({ transactions, categories, onDelete, onEdit, onAdd, onBulkAdd, onAddSubscription }) {
  const [search, setSearch] = useState('');
  const [filterCat, setFilterCat] = useState('all');
  const [dateFilter, setDateFilter] = useState('all');
  const [amountFilter, setAmountFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [sortBy, setSortBy] = useState('date-desc');

  const catMap = useMemo(() => Object.fromEntries(categories.map(c => [c.id, c])), [categories]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    const visible = transactions.filter(tx => {
      const matchCat = filterCat === 'all' || tx.categoryId === Number(filterCat);
      if (!matchCat || !matchesDateFilter(tx, dateFilter) || !matchesAmountFilter(tx, amountFilter) || !matchesTypeFilter(tx, typeFilter)) return false;

      if (!query) return true;
      const txDate = getTransactionDate(tx);
      const searchable = [
        tx.note,
        catMap[tx.categoryId]?.name,
        tx.amount,
        txDate ? format(txDate, 'd MMM yyyy HH:mm') : '',
      ].filter(Boolean).join(' ').toLowerCase();
      return searchable.includes(query);
    });

    return visible.sort((a, b) => {
      const aDate = getTransactionDate(a)?.getTime() || 0;
      const bDate = getTransactionDate(b)?.getTime() || 0;
      const aAmount = Number(a.amount) || 0;
      const bAmount = Number(b.amount) || 0;
      const fallback = bDate - aDate || (Number(b.id) || 0) - (Number(a.id) || 0);

      switch (sortBy) {
        case 'date-asc':
          return aDate - bDate || (Number(a.id) || 0) - (Number(b.id) || 0);
        case 'amount-desc':
          return bAmount - aAmount || fallback;
        case 'amount-asc':
          return aAmount - bAmount || fallback;
        case 'category-asc': {
          const categoryCompare = (catMap[a.categoryId]?.name || 'Unknown').localeCompare(catMap[b.categoryId]?.name || 'Unknown', undefined, { sensitivity: 'base' });
          return categoryCompare || fallback;
        }
        case 'date-desc':
        default:
          return fallback;
      }
    });
  }, [transactions, filterCat, search, catMap, dateFilter, amountFilter, typeFilter, sortBy]);

  const totalFiltered = filtered.reduce((s, tx) => s + tx.amount, 0);
  const filtersActive = search.trim() || filterCat !== 'all' || dateFilter !== 'all' || amountFilter !== 'all' || typeFilter !== 'all' || sortBy !== 'date-desc';

  const resetFilters = () => {
    setSearch('');
    setFilterCat('all');
    setDateFilter('all');
    setAmountFilter('all');
    setTypeFilter('all');
    setSortBy('date-desc');
  };

  const grouped = useMemo(() => {
    if (!sortBy.startsWith('date')) return filtered.length ? [['Sorted results', filtered]] : [];

    const groups = {};
    for (const tx of filtered) {
      const txDate = getTransactionDate(tx);
      const key = txDate ? format(txDate, 'd MMM yyyy') : 'Undated';
      if (!groups[key]) groups[key] = [];
      groups[key].push(tx);
    }
    return Object.entries(groups);
  }, [filtered, sortBy]);

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Toolbar */}
      <div className="glass mobile-card-pad" style={{ borderRadius: 16, padding: '16px 20px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '1 1 200px' }}>
          <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
          <input className="glass-input" placeholder="Search transactions…" value={search}
            aria-label="Search transactions" onChange={e => setSearch(e.target.value)} style={{ paddingLeft: 34 }} />
        </div>
        <CategorySelect
          categories={categories}
          value={filterCat}
          onChange={setFilterCat}
          includeAll
          allLabel="All Categories"
          aria-label="Filter by category"
          style={{ flex: '1 1 180px' }}
        />
        <div className="transaction-filter-grid">
          <select className="glass-input" value={dateFilter} onChange={e => setDateFilter(e.target.value)} aria-label="Filter by date">
            {dateFilterOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select className="glass-input" value={amountFilter} onChange={e => setAmountFilter(e.target.value)} aria-label="Filter by amount">
            {amountFilterOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select className="glass-input" value={typeFilter} onChange={e => setTypeFilter(e.target.value)} aria-label="Filter by expense type">
            {typeFilterOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select className="glass-input" value={sortBy} onChange={e => setSortBy(e.target.value)} aria-label="Sort transactions">
            {sortOptions.map(([value, label]) => <option key={value} value={value}>Sort: {label}</option>)}
          </select>
          {filtersActive && (
            <button className="btn-secondary" type="button" onClick={resetFilters}>Reset</button>
          )}
        </div>
        <button className="btn-secondary mobile-full" onClick={onBulkAdd} disabled={categories.length === 0}
          style={{ flexShrink: 0, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 7 }}>
          <Layers3 size={14} /> Bulk Add
        </button>
        <button className="btn-secondary mobile-full" onClick={onAddSubscription} disabled={categories.length === 0}
          style={{ flexShrink: 0, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 7 }}>
          <CreditCard size={14} /> Subscription
        </button>
        <button className="btn-primary mobile-full" onClick={onAdd} style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
          + Add Expense
        </button>
        <div style={{
          fontSize: 12,
          color: 'var(--text-muted)',
          flexBasis: '100%',
          display: 'flex',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}>
          <span>{filtered.length} of {transactions.length} transaction{transactions.length === 1 ? '' : 's'}</span>
          <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>Filtered total: {fmt(totalFiltered)}</span>
        </div>
      </div>

      {/* Transaction list */}
      {grouped.length === 0 ? (
        <div className="glass" style={{ borderRadius: 16, padding: '40px 24px', textAlign: 'center' }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 14, marginBottom: transactions.length === 0 ? 14 : 0 }}>
            {transactions.length === 0 ? 'No expenses logged yet. Add your first one!' : 'No transactions match your filter.'}
          </div>
          {transactions.length === 0 && (
            <div className="mobile-actions mobile-actions-full" style={{ display: 'flex', justifyContent: 'center', gap: 10, flexWrap: 'wrap' }}>
              <button className="btn-secondary" onClick={onBulkAdd} disabled={categories.length === 0}
                style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <Layers3 size={14} /> Bulk Add Expenses
              </button>
              <button className="btn-secondary" onClick={onAddSubscription} disabled={categories.length === 0}
                style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <CreditCard size={14} /> Add Subscription
              </button>
              <button className="btn-primary" onClick={onAdd}>
                Add Expense
              </button>
            </div>
          )}
        </div>
      ) : (
        grouped.map(([date, txs]) => (
          <div key={date}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8, paddingLeft: 4 }}>
              {date}
            </div>
            <div className="glass" style={{ borderRadius: 16, overflow: 'hidden' }}>
              {txs.map((tx, i) => {
                const cat = catMap[tx.categoryId];
                const txDate = getTransactionDate(tx);
                return (
                  <div key={tx.id} className="mobile-list-row" style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '13px 18px',
                    borderBottom: i < txs.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none',
                    transition: 'background 0.15s'
                  }}>
                    <div style={{ width: 10, height: 10, borderRadius: '50%', background: cat?.color || 'var(--accent-blue)', flexShrink: 0 }} />
                    <div className="mobile-list-main" style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {tx.note || cat?.name || 'Expense'}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                        {cat?.name || 'Unknown'} · {txDate ? format(txDate, 'HH:mm') : 'No time'}
                      </div>
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--accent-warm)', flexShrink: 0 }}>
                      -{fmt(tx.amount)}
                    </div>
                    <IconButton onClick={() => onEdit(tx)} style={{ opacity: 0.68 }}
                      label={`Edit ${tx.note || cat?.name || 'expense'}`}>
                      <Pencil size={13} />
                    </IconButton>
                    <IconButton onClick={() => onDelete(tx)} style={{ opacity: 0.6 }}
                      label={`Delete ${tx.note || cat?.name || 'expense'}`}>
                      <Trash2 size={13} />
                    </IconButton>
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
