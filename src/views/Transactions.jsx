import { useState, useMemo } from 'react';
import { Trash2, Search } from 'lucide-react';
import { fmt } from '../utils';
import { format } from 'date-fns';

export default function Transactions({ transactions, categories, onDelete, onAdd }) {
  const [search, setSearch] = useState('');
  const [filterCat, setFilterCat] = useState('all');

  const catMap = useMemo(() => Object.fromEntries(categories.map(c => [c.id, c])), [categories]);

  const filtered = useMemo(() => {
    return transactions.filter(tx => {
      const matchCat = filterCat === 'all' || tx.categoryId === Number(filterCat);
      const note = (tx.note || '').toLowerCase();
      const catName = (catMap[tx.categoryId]?.name || '').toLowerCase();
      const matchSearch = !search || note.includes(search.toLowerCase()) || catName.includes(search.toLowerCase());
      return matchCat && matchSearch;
    });
  }, [transactions, filterCat, search, catMap]);

  const totalFiltered = filtered.reduce((s, tx) => s + tx.amount, 0);

  // Group by date
  const grouped = useMemo(() => {
    const groups = {};
    for (const tx of filtered) {
      const key = format(new Date(tx.date), 'd MMM yyyy');
      if (!groups[key]) groups[key] = [];
      groups[key].push(tx);
    }
    return Object.entries(groups);
  }, [filtered]);

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Toolbar */}
      <div className="glass" style={{ borderRadius: 16, padding: '16px 20px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '1 1 200px' }}>
          <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
          <input className="glass-input" placeholder="Search transactions…" value={search}
            onChange={e => setSearch(e.target.value)} style={{ paddingLeft: 34 }} />
        </div>
        <select className="glass-input" value={filterCat} onChange={e => setFilterCat(e.target.value)}
          style={{ flex: '1 1 160px', maxWidth: 200 }}>
          <option value="all">All Categories</option>
          {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button className="btn-primary" onClick={onAdd} style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
          + Add Expense
        </button>
      </div>

      {/* Transaction list */}
      {grouped.length === 0 ? (
        <div className="glass" style={{ borderRadius: 16, padding: '40px 24px', textAlign: 'center' }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>
            {transactions.length === 0 ? 'No expenses logged yet. Add your first one!' : 'No transactions match your filter.'}
          </div>
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
                return (
                  <div key={tx.id} style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '13px 18px',
                    borderBottom: i < txs.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none',
                    transition: 'background 0.15s'
                  }}>
                    <div style={{ width: 10, height: 10, borderRadius: '50%', background: cat?.color || 'var(--accent-blue)', flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {tx.note || cat?.name || 'Expense'}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                        {cat?.name || 'Unknown'} · {format(new Date(tx.date), 'HH:mm')}
                      </div>
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--accent-warm)', flexShrink: 0 }}>
                      -{fmt(tx.amount)}
                    </div>
                    <button className="btn-icon" onClick={() => onDelete(tx.id)} style={{ opacity: 0.6 }}
                      title="Delete transaction">
                      <Trash2 size={13} />
                    </button>
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
