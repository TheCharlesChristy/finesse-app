import { useState } from 'react';
import { Modal, Field } from '../ui';
import {
  fmt,
  getCategorySpare,
  getEffectiveAllowance,
  getUnallocatedIncomeTotal,
  roundMoney,
} from '../../utils';

// ── Adjust Budget Modal ──────────────────────────────────────────────────────
// One screen: pick a category that needs more to spend, choose where the money
// comes from (spare income, or another category's spare budget), and confirm.
// Every top-up is temporary and clears automatically at the next budget reset.
export function AdjustBudgetModal({
  categories,
  incomes = [],
  defaultCategoryId,
  onTopUpFromIncome,
  onBorrowFromCategory,
  onResetTopUps,
  onClose,
}) {
  const firstCatId = categories[0]?.id ? String(categories[0].id) : '';
  const defaultId = defaultCategoryId ? String(defaultCategoryId) : firstCatId;

  const overspendOf = (c) =>
    c ? Math.max(0, roundMoney((c.spent || 0) - getEffectiveAllowance(c))) : 0;

  const initialAmount = () => {
    const c = categories.find(x => String(x.id) === defaultId);
    const over = overspendOf(c);
    return over > 0 ? String(over) : '';
  };

  const [catId, setCatId] = useState(defaultId);
  const [amount, setAmount] = useState(initialAmount);
  const [source, setSource] = useState('');

  // Unallocated income = income not assigned to any category, counting existing
  // top-ups as allocated so the pool can't be over-committed.
  //
  // Computed per income source rather than by subtracting one grand total from
  // another: with mixed pay frequencies those totals are in different units and
  // the difference between them is meaningless.
  const freeIncome = roundMoney(getUnallocatedIncomeTotal(incomes, categories));
  const boostsGranted = roundMoney(
    categories.reduce((s, c) => s + Math.max(0, c.temporaryBoost || 0), 0)
  );
  const unallocated = Math.max(0, roundMoney(freeIncome - boostsGranted));

  const cat = categories.find(c => String(c.id) === catId);
  const parsedAmount = parseFloat(amount) || 0;
  const overspend = overspendOf(cat);
  const receivedSources = Array.isArray(cat?.boostSources) ? cat.boostSources : [];
  const receivedTotal = roundMoney(receivedSources.reduce((s, e) => s + (e.amount || 0), 0));

  // Where the money can come from: spare income, or another category's spare.
  const sources = [];
  if (unallocated > 0) sources.push({ key: 'income', label: 'Spare income', available: unallocated });
  for (const c of categories) {
    if (String(c.id) === catId) continue;
    const spare = getCategorySpare(c);
    if (spare > 0) sources.push({ key: String(c.id), label: c.name, available: spare });
  }

  const effectiveSourceKey = source && sources.some(s => s.key === source)
    ? source
    : (sources[0]?.key || '');
  const selectedSource = sources.find(s => s.key === effectiveSourceKey) || null;
  const sourceAvailable = selectedSource ? selectedSource.available : 0;
  const exceeds = parsedAmount > sourceAvailable + 0.0001;
  const canSubmit = !!cat && !!selectedSource && parsedAmount > 0 && !exceeds;

  const handleCatChange = (id) => {
    setCatId(id);
    setSource('');
    const next = categories.find(c => String(c.id) === id);
    const over = overspendOf(next);
    setAmount(over > 0 ? String(over) : '');
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    if (effectiveSourceKey === 'income') {
      await onTopUpFromIncome(Number(catId), parsedAmount);
    } else {
      await onBorrowFromCategory(Number(effectiveSourceKey), Number(catId), parsedAmount);
    }
    onClose();
  };

  const handleUndo = async () => {
    if (!cat) return;
    await onResetTopUps(Number(catId));
    onClose();
  };

  // Live preview
  const newEffective = cat ? roundMoney(getEffectiveAllowance(cat) + parsedAmount) : 0;
  const newLeft = cat ? roundMoney(newEffective - (cat.spent || 0)) : 0;
  const sourceCat = selectedSource && effectiveSourceKey !== 'income'
    ? categories.find(c => String(c.id) === effectiveSourceKey)
    : null;
  const sourceNewSpare = sourceCat ? roundMoney(getCategorySpare(sourceCat) - parsedAmount) : 0;

  const primaryLabel = overspend > 0 && parsedAmount >= overspend
    ? 'Cover overspend'
    : `Add ${fmt(parsedAmount || 0)}`;

  return (
    <Modal title={cat ? `Adjust — ${cat.name}` : 'Adjust budget'} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0, lineHeight: 1.6 }}>
          Give a category more to spend for this cycle. The extra is temporary and clears automatically at your next reset.
        </p>

        <Field label="Category">
          {id => (
            <select id={id} className="glass-input" value={catId} onChange={e => handleCatChange(e.target.value)}>
              {categories.map(c => {
                const over = overspendOf(c);
                return (
                  <option key={c.id} value={c.id}>
                    {c.name}{over > 0 ? ` — ${fmt(over)} over` : ''}
                  </option>
                );
              })}
            </select>
          )}
        </Field>

        {cat && (overspend > 0 ? (
          <div style={{ fontSize: 12, color: 'var(--danger)', background: 'rgba(255,107,138,0.08)', borderRadius: 8, padding: '8px 12px' }}>
            {fmt(overspend)} over budget — spent {fmt(cat.spent || 0)} of {fmt(getEffectiveAllowance(cat))}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', background: 'rgba(255,255,255,0.04)', borderRadius: 8, padding: '8px 12px' }}>
            {fmt(getCategorySpare(cat))} left of {fmt(getEffectiveAllowance(cat))}
          </div>
        ))}

        {receivedTotal > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, fontSize: 12, color: 'var(--accent-mint)', background: 'rgba(79,255,176,0.06)', borderRadius: 8, padding: '8px 12px' }}>
            <span>Topped up by {fmt(receivedTotal)} this cycle</span>
            <button type="button" className="btn-secondary" onClick={handleUndo}
              style={{ padding: '5px 10px', fontSize: 11, flexShrink: 0 }}>
              Undo
            </button>
          </div>
        )}

        {sources.length === 0 ? (
          <>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', background: 'rgba(255,255,255,0.04)', borderRadius: 8, padding: '12px 14px', lineHeight: 1.6 }}>
              No spare budget available. Add a one-off income from the Income section, or edit a transaction to move it to another category.
            </div>
            <div className="modal-actions" style={{ display: 'flex', marginTop: 4 }}>
              <button className="btn-secondary" onClick={onClose} style={{ flex: 1 }}>Close</button>
            </div>
          </>
        ) : (
          <>
            <Field label="How much to add? (£)">
              {id => (
                <input id={id} className="glass-input" type="number" min="0" step="0.01" placeholder="0.00"
                  value={amount} onChange={e => setAmount(e.target.value)} autoFocus />
              )}
            </Field>

            <div>
              <div className="field-label">Take it from</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {sources.map(s => {
                  const active = s.key === effectiveSourceKey;
                  return (
                    <button key={s.key} type="button" onClick={() => setSource(s.key)}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                        textAlign: 'left', cursor: 'pointer', width: '100%',
                        padding: '10px 14px', borderRadius: 10, fontSize: 13,
                        border: `1px solid ${active ? 'var(--accent-mint)' : 'var(--glass-border)'}`,
                        background: active ? 'rgba(79,255,176,0.12)' : 'rgba(255,255,255,0.04)',
                        color: active ? 'var(--accent-mint)' : 'var(--text-secondary)',
                        transition: 'background 0.15s, border-color 0.15s, color 0.15s',
                      }}>
                      <span style={{ fontWeight: 500 }}>{s.key === 'income' ? 'Spare income' : s.label}</span>
                      <span style={{ fontSize: 12, opacity: 0.85 }}>{fmt(s.available)} available</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {cat && parsedAmount > 0 && selectedSource && (
              <div style={{ fontSize: 12, color: exceeds ? 'var(--danger)' : 'var(--text-muted)', background: 'rgba(255,255,255,0.04)', borderRadius: 8, padding: '8px 12px', lineHeight: 1.6 }}>
                {exceeds ? (
                  <>Only {fmt(sourceAvailable)} available from {selectedSource.key === 'income' ? 'spare income' : selectedSource.label}.</>
                ) : (
                  <>
                    {cat.name}: {fmt(getEffectiveAllowance(cat))} → {fmt(newEffective)}
                    {' · '}
                    {newLeft >= 0 ? `${fmt(newLeft)} left${overspend > 0 ? ' — covered ✓' : ''}` : `${fmt(Math.abs(newLeft))} still over`}
                    {sourceCat && (
                      <span style={{ display: 'block', marginTop: 2 }}>
                        {sourceCat.name} will have {fmt(Math.max(0, sourceNewSpare))} spare
                      </span>
                    )}
                  </>
                )}
              </div>
            )}

            <div className="modal-actions" style={{ display: 'flex', gap: 10, marginTop: 4 }}>
              <button className="btn-secondary" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
              <button className="btn-primary" onClick={handleSubmit} style={{ flex: 2 }} disabled={!canSubmit}>
                {primaryLabel}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
