import { useState, useMemo } from 'react';
import { Modal, Field } from '../ui';
import { ColourPicker, PALETTE } from './shared';

// ── Add Wishlist Item Modal ───────────────────────────────────────────────────
// Depth-first flat list of all wishlist categories, for the select dropdown
function flattenWishlistCategories(cats, parentId = null, depth = 0) {
  return cats
    .filter(c => (c.parentId ?? null) === parentId)
    .flatMap(c => [{ ...c, depth }, ...flattenWishlistCategories(cats, c.id, depth + 1)]);
}

export function AddWishlistItemModal({ expenseCategories, wishlistCategories, onAdd, onClose, defaultCategoryId = null, item = null, onSave }) {
  const [name, setName] = useState(item?.name || '');
  const [price, setPrice] = useState(item?.price != null ? String(item.price) : '');
  const [note, setNote] = useState(item?.note || '');
  const [link, setLink] = useState(item?.link || '');
  const [wishCatId, setWishCatId] = useState(
    item?.wishlistCategoryId != null ? String(item.wishlistCategoryId)
      : defaultCategoryId != null ? String(defaultCategoryId)
      : ''
  );
  const isEditing = Boolean(item);

  const flatLists = useMemo(() => flattenWishlistCategories(wishlistCategories), [wishlistCategories]);
  const [selectedExpCats, setSelectedExpCats] = useState(item?.categoryIds || []);

  const toggleExpCat = (id) => {
    setSelectedExpCats(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const handleSubmit = () => {
    if (!name.trim() || !price) return;
    const data = {
      name: name.trim(),
      price: parseFloat(price),
      note: note.trim(),
      link: link.trim() || null,
      wishlistCategoryId: wishCatId ? Number(wishCatId) : null,
      categoryIds: selectedExpCats,
    };
    if (isEditing && onSave) {
      onSave(item.id, data);
    } else {
      onAdd(data);
    }
    onClose();
  };

  return (
    <Modal title={isEditing ? 'Edit Wishlist Item' : 'Add to Wishlist'} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Item Name">
          {id => (
            <input id={id} className="glass-input" placeholder="e.g. New trainers" value={name}
              onChange={e => setName(e.target.value)} autoFocus />
          )}
        </Field>
        <Field label="Price (£)">
          {id => (
            <input id={id} className="glass-input" type="number" min="0" step="0.01" placeholder="0.00" value={price}
              onChange={e => setPrice(e.target.value)} />
          )}
        </Field>
        {wishlistCategories.length > 0 && (
          <Field label="Add to List">
            {id => (
              <select id={id} className="glass-input" value={wishCatId} onChange={e => setWishCatId(e.target.value)}>
                <option value="">No list (uncategorised)</option>
                {flatLists.map(l => (
                  <option key={l.id} value={l.id}>
                    {'—'.repeat(l.depth)}{l.depth > 0 ? ' ' : ''}{l.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        <div role="group" aria-label="Budget categories for affordability">
          <div className="field-label" style={{ marginBottom: 8 }}>Budget Categories for Affordability</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            {expenseCategories.map(cat => {
              const selected = selectedExpCats.includes(cat.id);
              return (
                <button key={cat.id} type="button" className="toggle-chip" onClick={() => toggleExpCat(cat.id)}
                  aria-pressed={selected} style={{
                  padding: '5px 12px', borderRadius: 20, fontSize: 12, cursor: 'pointer',
                  background: selected ? cat.color + '30' : 'rgba(255,255,255,0.06)',
                  border: `1px solid ${selected ? cat.color + '60' : 'rgba(255,255,255,0.1)'}`,
                  color: selected ? 'var(--text-primary)' : 'var(--text-secondary)',
                  transition: 'all 0.15s',
                  display: 'flex', alignItems: 'center', gap: 5
                }}>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: cat.color || 'var(--accent-blue)' }} />
                  {cat.name}
                </button>
              );
            })}
            {expenseCategories.length === 0 && (
              <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Add expense categories first.</div>
            )}
          </div>
        </div>
        <Field label="Link (optional)">
          {id => (
            <input id={id} className="glass-input" type="url" placeholder="https://…" value={link}
              onChange={e => setLink(e.target.value)} />
          )}
        </Field>
        <Field label="Note (optional)">
          {id => (
            <input id={id} className="glass-input" placeholder="Any details…" value={note}
              onChange={e => setNote(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSubmit()} />
          )}
        </Field>
        <div className="modal-actions" style={{ display: 'flex', gap: 10, marginTop: 6 }}>
          <button className="btn-secondary" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
          <button className="btn-primary" onClick={handleSubmit} style={{ flex: 2 }}
            disabled={!name.trim() || !price}>
            {isEditing ? 'Save Changes' : 'Add to Wishlist'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function collectDescendantIds(cats, id, acc = new Set()) {
  for (const child of cats.filter(c => c.parentId === id)) {
    acc.add(child.id);
    collectDescendantIds(cats, child.id, acc);
  }
  return acc;
}

export function EditWishlistListModal({ list, wishlistCategories, onSave, onClose }) {
  const [name, setName] = useState(list.name || '');
  const [color, setColor] = useState(list.color || PALETTE[0]);
  const [parentId, setParentId] = useState(list.parentId != null ? String(list.parentId) : '');

  const blockedIds = useMemo(() => collectDescendantIds(wishlistCategories, list.id).add(list.id), [wishlistCategories, list.id]);
  const parentOptions = useMemo(
    () => flattenWishlistCategories(wishlistCategories).filter(cat => !blockedIds.has(cat.id)),
    [wishlistCategories, blockedIds]
  );

  const handleSubmit = () => {
    if (!name.trim()) return;
    onSave(list.id, {
      name: name.trim(),
      color,
      parentId: parentId ? Number(parentId) : null,
    });
    onClose();
  };

  return (
    <Modal title="Edit List" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Name">
          {id => <input id={id} className="glass-input" value={name} onChange={e => setName(e.target.value)} autoFocus />}
        </Field>
        <Field label="Parent List">
          {id => (
            <select id={id} className="glass-input" value={parentId} onChange={e => setParentId(e.target.value)}>
              <option value="">Top level</option>
              {parentOptions.map(cat => (
                <option key={cat.id} value={cat.id}>
                  {'-'.repeat(cat.depth)}{cat.depth > 0 ? ' ' : ''}{cat.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <ColourPicker color={color} onChange={setColor} />
        <div className="modal-actions" style={{ display: 'flex', gap: 10, marginTop: 6 }}>
          <button className="btn-secondary" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
          <button className="btn-primary" onClick={handleSubmit} style={{ flex: 2 }} disabled={!name.trim()}>
            Save Changes
          </button>
        </div>
      </div>
    </Modal>
  );
}
