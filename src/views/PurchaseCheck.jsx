import { useMemo, useState } from 'react';
import { AlertCircle, Check, Plus, ShoppingCart } from 'lucide-react';
import { fmt } from '../utils';
import CategorySelect from '../components/CategorySelect';

const SOURCE_AUTO = 'auto';
const SOURCE_MULTI = 'multi';

function getRemaining(category) {
  return (Number(category.allowance) || 0) - (Number(category.spent) || 0);
}

function getPurchasePlan(categories, price, sourceMode, selectedIds) {
  const amount = Number(price) || 0;
  const categoryRows = categories
    .map(category => ({
      category,
      remaining: getRemaining(category),
      allowance: Number(category.allowance) || 0,
      spent: Number(category.spent) || 0,
    }))
    .sort((a, b) => b.remaining - a.remaining);

  if (amount <= 0) {
    return {
      status: 'idle',
      title: 'Enter a price',
      message: 'Ready when you are.',
      categories: categoryRows,
      selectedCategories: [],
      totalAvailable: 0,
    };
  }

  if (categories.length === 0) {
    return {
      status: 'empty',
      title: 'No categories yet',
      message: 'Create budget categories before checking a purchase.',
      categories: [],
      selectedCategories: [],
      totalAvailable: 0,
    };
  }

  if (sourceMode === SOURCE_MULTI) {
    const selectedCategories = categoryRows.filter(row => selectedIds.includes(row.category.id));
    const totalAvailable = selectedCategories.reduce((sum, row) => sum + Math.max(0, row.remaining), 0);

    if (selectedCategories.length === 0) {
      return {
        status: 'idle',
        title: 'Choose categories',
        message: 'Pick the budgets this purchase should come from.',
        categories: categoryRows,
        selectedCategories,
        totalAvailable,
      };
    }

    return {
      status: totalAvailable >= amount ? 'yes' : 'no',
      title: totalAvailable >= amount ? 'Yes, if you split it' : 'Not from those budgets',
      message: totalAvailable >= amount
        ? `${fmt(totalAvailable - amount)} would remain across selected categories.`
        : `You are short by ${fmt(amount - totalAvailable)} across selected categories.`,
      categories: categoryRows,
      selectedCategories,
      totalAvailable,
      logCategory: selectedCategories.length === 1 ? selectedCategories[0].category : null,
    };
  }

  if (sourceMode !== SOURCE_AUTO) {
    const selected = categoryRows.find(row => String(row.category.id) === String(sourceMode));
    if (!selected) {
      return {
        status: 'idle',
        title: 'Choose a category',
        message: 'Select where this purchase would be logged.',
        categories: categoryRows,
        selectedCategories: [],
        totalAvailable: 0,
      };
    }

    return {
      status: selected.remaining >= amount ? 'yes' : 'no',
      title: selected.remaining >= amount ? 'Yes, this fits' : 'Not from this category',
      message: selected.remaining >= amount
        ? `${fmt(selected.remaining - amount)} would remain in ${selected.category.name}.`
        : `${selected.category.name} is short by ${fmt(amount - selected.remaining)}.`,
      categories: categoryRows,
      selectedCategories: [selected],
      totalAvailable: Math.max(0, selected.remaining),
      logCategory: selected.category,
    };
  }

  const affordable = categoryRows
    .filter(row => row.remaining >= amount)
    .sort((a, b) => (a.remaining - amount) - (b.remaining - amount));
  const combinedAvailable = categoryRows.reduce((sum, row) => sum + Math.max(0, row.remaining), 0);

  if (affordable.length > 0) {
    const best = affordable[0];
    return {
      status: 'yes',
      title: 'Yes, you can buy it',
      message: `${best.category.name} is the cleanest fit, leaving ${fmt(best.remaining - amount)}.`,
      categories: categoryRows,
      selectedCategories: [best],
      totalAvailable: Math.max(0, best.remaining),
      logCategory: best.category,
    };
  }

  if (combinedAvailable >= amount) {
    return {
      status: 'maybe',
      title: 'Only if you split it',
      message: `No single category covers it, but your available category budget totals ${fmt(combinedAvailable)}.`,
      categories: categoryRows,
      selectedCategories: [],
      totalAvailable: combinedAvailable,
    };
  }

  const best = categoryRows[0];
  return {
    status: 'no',
    title: 'Not yet',
    message: best
      ? `Your closest category is ${best.category.name}, short by ${fmt(amount - best.remaining)}.`
      : 'There is not enough remaining budget for this purchase.',
    categories: categoryRows,
    selectedCategories: best ? [best] : [],
    totalAvailable: Math.max(0, best?.remaining || 0),
  };
}

export default function PurchaseCheck({ categories = [], onLogPurchase }) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [sourceMode, setSourceMode] = useState(SOURCE_AUTO);
  const [selectedIds, setSelectedIds] = useState([]);
  const selectedCategoryMode = sourceMode !== SOURCE_AUTO && sourceMode !== SOURCE_MULTI
    ? String(sourceMode)
    : categories[0]?.id ? String(categories[0].id) : '';

  const amount = Number(price) || 0;
  const plan = useMemo(
    () => getPurchasePlan(categories, amount, sourceMode, selectedIds),
    [categories, amount, sourceMode, selectedIds]
  );

  const statusColor = {
    yes: 'var(--good)',
    maybe: 'var(--warn)',
    no: 'var(--danger)',
    idle: 'var(--accent-blue)',
    empty: 'var(--warn)',
  }[plan.status];

  const toggleCategory = (id) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const handleLogPurchase = () => {
    if (!plan.logCategory || amount <= 0) return;
    onLogPurchase({
      categoryId: plan.logCategory.id,
      amount,
      note: name.trim() || 'Purchase',
    });
  };

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '22px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
          <ShoppingCart size={18} color="var(--accent-mint)" />
          <div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>Can I Purchase It?</div>
            <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>
              Live budget check
            </div>
          </div>
        </div>

        <div className="mobile-stack" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Item</label>
            <input className="glass-input" placeholder="Optional name" value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Price (£)</label>
            <input className="glass-input" type="number" min="0" step="0.01" placeholder="0.00" value={price}
              onChange={e => setPrice(e.target.value)} autoFocus />
          </div>
        </div>

        <div style={{ marginTop: 14 }}>
          <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Budget Source</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: sourceMode !== SOURCE_AUTO && sourceMode !== SOURCE_MULTI ? 10 : 0 }}>
            <button className={sourceMode === SOURCE_AUTO ? 'btn-primary' : 'btn-secondary'} onClick={() => setSourceMode(SOURCE_AUTO)}
              style={{ padding: '7px 11px', fontSize: 12 }}>
              Best Fit
            </button>
            <button className={sourceMode !== SOURCE_AUTO && sourceMode !== SOURCE_MULTI ? 'btn-primary' : 'btn-secondary'}
              onClick={() => setSourceMode(selectedCategoryMode)}
              disabled={categories.length === 0}
              style={{ padding: '7px 11px', fontSize: 12 }}>
              Category
            </button>
            <button className={sourceMode === SOURCE_MULTI ? 'btn-primary' : 'btn-secondary'} onClick={() => setSourceMode(SOURCE_MULTI)}
              disabled={categories.length === 0}
              style={{ padding: '7px 11px', fontSize: 12 }}>
              Split
            </button>
          </div>
          {sourceMode !== SOURCE_AUTO && sourceMode !== SOURCE_MULTI && (
            <CategorySelect categories={categories} value={selectedCategoryMode} onChange={setSourceMode} showAmounts />
          )}
        </div>

        {sourceMode === SOURCE_MULTI && (
          <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {plan.categories.map(({ category, remaining }) => {
              const selected = selectedIds.includes(category.id);
              return (
                <button key={category.id} className={selected ? 'btn-primary' : 'btn-secondary'}
                  onClick={() => toggleCategory(category.id)}
                  style={{ padding: '7px 11px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: category.color || 'var(--accent-blue)' }} />
                  {category.name}
                  <span style={{ color: selected ? 'var(--text-primary)' : 'var(--text-muted)' }}>{fmt(Math.max(0, remaining))}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="glass mobile-card-pad" style={{
        borderRadius: 18,
        padding: '24px',
        borderColor: plan.status === 'yes' ? 'rgba(79,255,176,0.28)' : plan.status === 'no' ? 'rgba(255,107,138,0.28)' : 'rgba(251,191,112,0.24)',
        background: plan.status === 'yes' ? 'rgba(79,255,176,0.06)' : plan.status === 'no' ? 'rgba(255,107,138,0.06)' : 'rgba(251,191,112,0.05)',
      }}>
        <div className="mobile-row-stack" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flex: '1 1 260px' }}>
            <div style={{
              width: 34,
              height: 34,
              borderRadius: 12,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: `${statusColor}20`,
              color: statusColor,
              flexShrink: 0,
            }}>
              {plan.status === 'yes' ? <Check size={18} /> : <AlertCircle size={18} />}
            </div>
            <div>
              <div className="font-display" style={{ fontSize: 28, color: statusColor, lineHeight: 1.05 }}>
                {plan.title}
              </div>
              <div style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 7 }}>
                {plan.message}
              </div>
            </div>
          </div>

          {plan.logCategory && (
            <button className="btn-primary mobile-full" onClick={handleLogPurchase}
              style={{ display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0 }}>
              <Plus size={14} /> Log Purchase
            </button>
          )}
          {plan.status === 'maybe' && sourceMode === SOURCE_AUTO && (
            <button className="btn-secondary mobile-full" onClick={() => setSourceMode(SOURCE_MULTI)}
              style={{ flexShrink: 0 }}>
              Choose Categories
            </button>
          )}
        </div>

        {amount > 0 && plan.selectedCategories.length > 0 && (
          <div className="mobile-stack" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginTop: 20 }}>
            <div style={{ padding: '12px 14px', borderRadius: 12, background: 'rgba(255,255,255,0.05)' }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Purchase</div>
              <div className="font-display" style={{ fontSize: 22 }}>{fmt(amount)}</div>
            </div>
            <div style={{ padding: '12px 14px', borderRadius: 12, background: 'rgba(255,255,255,0.05)' }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Available</div>
              <div className="font-display" style={{ fontSize: 22 }}>{fmt(plan.totalAvailable)}</div>
            </div>
            <div style={{ padding: '12px 14px', borderRadius: 12, background: 'rgba(255,255,255,0.05)' }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>After Purchase</div>
              <div className="font-display" style={{ fontSize: 22, color: plan.totalAvailable - amount >= 0 ? 'var(--good)' : 'var(--danger)' }}>
                {fmt(plan.totalAvailable - amount)}
              </div>
            </div>
          </div>
        )}
      </div>

      {plan.categories.length > 0 && (
        <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '20px 22px' }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Category Fit</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 14 }}>
            Remaining budget
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            {plan.categories.map(({ category, remaining }) => {
              const canCover = amount > 0 && remaining >= amount;
              const pct = category.allowance > 0 ? Math.min(100, ((category.spent || 0) / category.allowance) * 100) : 0;
              return (
                <button key={category.id} className="glass mobile-stack" onClick={() => setSourceMode(String(category.id))}
                  style={{
                    borderRadius: 12,
                    padding: '11px 13px',
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                    gap: 12,
                    alignItems: 'center',
                    background: sourceMode === String(category.id) ? 'rgba(93,184,255,0.12)' : 'rgba(255,255,255,0.04)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    color: 'var(--text-primary)',
                    fontFamily: 'DM Sans, sans-serif',
                  }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: category.color || 'var(--accent-blue)', flexShrink: 0 }} />
                      <span style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {category.name}
                      </span>
                      {canCover && (
                        <span style={{ fontSize: 10, color: 'var(--good)', background: 'rgba(79,255,176,0.1)', padding: '1px 7px', borderRadius: 20 }}>
                          fits
                        </span>
                      )}
                    </div>
                    <div className="progress-track" style={{ height: 4, marginTop: 8 }}>
                      <div className="progress-fill" style={{
                        width: `${pct}%`,
                        background: pct > 90 ? 'var(--danger)' : pct > 70 ? 'var(--warn)' : 'var(--accent-mint)',
                      }} />
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', fontSize: 12, color: remaining < 0 ? 'var(--danger)' : 'var(--text-secondary)' }}>
                    <div style={{ fontWeight: 700 }}>{fmt(remaining)}</div>
                    <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>remaining</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
