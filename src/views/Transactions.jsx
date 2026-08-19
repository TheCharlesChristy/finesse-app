import { useState, useMemo } from 'react';
import { AlertTriangle, CopyPlus, CreditCard, FileUp, Layers3, Pencil, Trash2, Search, Undo2 } from 'lucide-react';
import { flagUnusualSpend, fmt, getAllTags, getSignedAmount, isRefund } from '../utils';
import { format, isSameDay, isSameMonth, startOfDay, subDays } from 'date-fns';
import CategorySelect from '../components/CategorySelect';
import { ReceiptThumb, ReceiptViewer } from '../components/ReceiptViewer';
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
  ['all', 'All types'],
  ['manual', 'Manual only'],
  ['subscription', 'Subscriptions'],
  ['refund', 'Refunds only'],
];

const sortOptions = [
  ['date-desc', 'Newest first'],
  ['date-asc', 'Oldest first'],
  ['amount-desc', 'Amount high to low'],
  ['amount-asc', 'Amount low to high'],
  ['category-asc', 'Category A to Z'],
  ['category-desc', 'Category Z to A'],
  ['name-asc', 'Name A to Z'],
  ['name-desc', 'Name Z to A'],
  ['type-asc', 'Type'],
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
  if (filter === 'manual') return !subscription && !isRefund(tx);
  if (filter === 'subscription') return subscription;
  if (filter === 'refund') return isRefund(tx);
  return true;
}

function compareText(a, b) {
  return String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base' });
}

export default function Transactions({ transactions, categories, onDelete, onEdit, onAdd, onRepeat, onBulkAdd, onImportStatement, onAddSubscription }) {
  const [search, setSearch] = useState('');
  const [filterCat, setFilterCat] = useState('all');
  const [dateFilter, setDateFilter] = useState('all');
  const [amountFilter, setAmountFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [sortBy, setSortBy] = useState('date-desc');
  const [tagFilter, setTagFilter] = useState('all');
  const [viewingReceipt, setViewingReceipt] = useState(null);

  const catMap = useMemo(() => Object.fromEntries(categories.map(c => [c.id, c])), [categories]);
  const allTags = useMemo(() => getAllTags(transactions), [transactions]);
  // Flagged against each category's own median, so a £60 weekly shop isn't
  // "unusual" just because coffees are £3.
  const unusual = useMemo(() => flagUnusualSpend(transactions), [transactions]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    const visible = transactions.filter(tx => {
      const matchCat = filterCat === 'all' || tx.categoryId === Number(filterCat);
      const matchTag = tagFilter === 'all' || (Array.isArray(tx.tags) && tx.tags.includes(tagFilter));
      if (!matchCat || !matchTag || !matchesDateFilter(tx, dateFilter) || !matchesAmountFilter(tx, amountFilter) || !matchesTypeFilter(tx, typeFilter)) return false;

      if (!query) return true;
      const txDate = getTransactionDate(tx);
      const searchable = [
        tx.note,
        tx.merchant,
        catMap[tx.categoryId]?.name,
        tx.amount,
        ...(Array.isArray(tx.tags) ? tx.tags : []),
        txDate ? format(txDate, 'd MMM yyyy HH:mm') : '',
      ].filter(Boolean).join(' ').toLowerCase();
      return searchable.includes(query);
    });

    return visible.sort((a, b) => {
      const aDate = getTransactionDate(a)?.getTime() || 0;
      const bDate = getTransactionDate(b)?.getTime() || 0;
      const aAmount = Number(a.amount) || 0;
      const bAmount = Number(b.amount) || 0;
      const aCategory = catMap[a.categoryId]?.name || 'Unknown';
      const bCategory = catMap[b.categoryId]?.name || 'Unknown';
      const aName = a.note || aCategory || 'Expense';
      const bName = b.note || bCategory || 'Expense';
      const aType = isSubscriptionTransaction(a) ? 'Subscription' : 'Manual';
      const bType = isSubscriptionTransaction(b) ? 'Subscription' : 'Manual';
      const fallback = bDate - aDate || (Number(b.id) || 0) - (Number(a.id) || 0);

      switch (sortBy) {
        case 'date-asc':
          return aDate - bDate || (Number(a.id) || 0) - (Number(b.id) || 0);
        case 'amount-desc':
          return bAmount - aAmount || fallback;
        case 'amount-asc':
          return aAmount - bAmount || fallback;
        case 'category-asc':
          return compareText(aCategory, bCategory) || fallback;
        case 'category-desc':
          return compareText(bCategory, aCategory) || fallback;
        case 'name-asc':
          return compareText(aName, bName) || fallback;
        case 'name-desc':
          return compareText(bName, aName) || fallback;
        case 'type-asc':
          return compareText(aType, bType) || fallback;
        case 'date-desc':
        default:
          return fallback;
      }
    });
  }, [transactions, filterCat, search, catMap, dateFilter, amountFilter, typeFilter, tagFilter, sortBy]);

  const totalFiltered = filtered.reduce((s, tx) => s + getSignedAmount(tx), 0);
  const filtersActive = search.trim() || filterCat !== 'all' || dateFilter !== 'all' || amountFilter !== 'all' || typeFilter !== 'all' || tagFilter !== 'all' || sortBy !== 'date-desc';

  const resetFilters = () => {
    setSearch('');
    setFilterCat('all');
    setDateFilter('all');
    setAmountFilter('all');
    setTypeFilter('all');
    setTagFilter('all');
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
        <button className="btn-secondary mobile-full" onClick={onBulkAdd} disabled={categories.length === 0}
          style={{ flexShrink: 0, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 7 }}>
          <Layers3 size={14} /> Bulk Add
        </button>
        <button className="btn-secondary mobile-full" onClick={onImportStatement} disabled={categories.length === 0}
          style={{ flexShrink: 0, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 7 }}>
          <FileUp size={14} /> Import CSV
        </button>
        <button className="btn-secondary mobile-full" onClick={onAddSubscription} disabled={categories.length === 0}
          style={{ flexShrink: 0, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 7 }}>
          <CreditCard size={14} /> Subscription
        </button>
        <button className="btn-primary mobile-full" onClick={onAdd} style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
          + Add Expense
        </button>
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
          {allTags.length > 0 && (
            <select className="glass-input" value={tagFilter} onChange={e => setTagFilter(e.target.value)} aria-label="Filter by tag">
              <option value="all">Any tag</option>
              {allTags.map(tag => <option key={tag} value={tag}>#{tag}</option>)}
            </select>
          )}
          <select className="glass-input" value={sortBy} onChange={e => setSortBy(e.target.value)} aria-label="Sort transactions">
            {sortOptions.map(([value, label]) => <option key={value} value={value}>Sort: {label}</option>)}
          </select>
          {filtersActive && (
            <button className="btn-secondary" type="button" onClick={resetFilters}>Reset</button>
          )}
        </div>
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
              <button className="btn-secondary" onClick={onImportStatement} disabled={categories.length === 0}
                style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <FileUp size={14} /> Import a Statement
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
        grouped.map(([date, txs]) => {
          const dayTotal = txs.reduce((sum, tx) => sum + getSignedAmount(tx), 0);
          return (
          <div key={date}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, marginBottom: 8, padding: '0 4px' }}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                {date}
              </span>
              {/* Formatted directly rather than as an absolute value with a
                  flipped sign, so a net-refund day reads the same way as the
                  filtered total above it. */}
              <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600 }}>
                {fmt(dayTotal)}
              </span>
            </div>
            <div className="glass" style={{ borderRadius: 16, overflow: 'hidden' }}>
              {txs.map((tx, i) => {
                const cat = catMap[tx.categoryId];
                const txDate = getTransactionDate(tx);
                const refund = isRefund(tx);
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
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span>{cat?.name || 'Unknown'} · {txDate ? format(txDate, 'HH:mm') : 'No time'}</span>
                        {unusual.has(tx.id) && (
                          <span title="Much larger than usual for this category"
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--warn)', background: 'rgba(251,191,112,0.12)', padding: '1px 6px', borderRadius: 10 }}>
                            <AlertTriangle size={9} /> unusual
                          </span>
                        )}
                        {tx.splitGroupId && (
                          <span title="Part of a split purchase" style={{ background: 'rgba(255,255,255,0.06)', padding: '1px 6px', borderRadius: 10 }}>
                            split
                          </span>
                        )}
                        {(tx.tags || []).map(tag => (
                          <span key={tag} style={{ background: 'rgba(93,184,255,0.12)', color: 'var(--accent-blue)', padding: '1px 6px', borderRadius: 10 }}>
                            #{tag}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div style={{
                      fontSize: 14, fontWeight: 600, flexShrink: 0,
                      color: refund ? 'var(--good)' : 'var(--accent-warm)',
                      display: 'flex', alignItems: 'center', gap: 4,
                    }}>
                      {refund && <Undo2 size={12} aria-hidden="true" />}
                      {refund ? '+' : '-'}{fmt(tx.amount)}
                    </div>
                    <ReceiptThumb transaction={tx} onOpen={setViewingReceipt} />
                    {onRepeat && (
                      <IconButton onClick={() => onRepeat(tx)} style={{ opacity: 0.62 }}
                        label={`Log ${tx.note || cat?.name || 'this'} again`}>
                        <CopyPlus size={13} />
                      </IconButton>
                    )}
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
          );
        })
      )}

      {viewingReceipt && (
        <ReceiptViewer transaction={viewingReceipt} onClose={() => setViewingReceipt(null)} />
      )}
    </div>
  );
}
