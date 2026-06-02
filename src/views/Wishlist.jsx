import { useState, useMemo } from 'react';
import { Pencil, Trash2, Check, Clock, ChevronDown, ChevronRight, ExternalLink, Plus, ShoppingBag, X } from 'lucide-react';
import { fmt, wishlistAffordability } from '../utils';

const LIST_COLORS = ['#4fffb0','#5db8ff','#c084fc','#fbbf70','#ff6b8a','#67e8f9','#a78bfa','#fb923c'];

function buildTree(lists, parentId = null) {
  return lists
    .filter(l => (l.parentId ?? null) === parentId)
    .map(l => ({ ...l, children: buildTree(lists, l.id) }));
}

function countAllItems(node, allItems) {
  const direct = allItems.filter(i => i.wishlistCategoryId === node.id).length;
  return direct + (node.children || []).reduce((s, c) => s + countAllItems(c, allItems), 0);
}

function AffordabilityBadge({ aff }) {
  if (!aff) return null;
  if (aff.canAffordNow) return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600,
      color: 'var(--good)', background: 'rgba(79,255,176,0.1)', padding: '2px 8px', borderRadius: 20, flexShrink: 0 }}>
      <Check size={10} /> Now
    </span>
  );
  if (aff.daysUntil !== null) return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11,
      color: 'var(--warn)', background: 'rgba(251,191,112,0.1)', padding: '2px 8px', borderRadius: 20, flexShrink: 0 }}>
      <Clock size={10} /> {aff.afterReset ? 'After reset' : `~${aff.daysUntil}d`}
    </span>
  );
  return null;
}

function ItemRow({ item, expenseCategories, settings, onEdit, onDelete }) {
  const aff = wishlistAffordability(item, expenseCategories, settings);
  const assignedCats = (item.categoryIds || []).map(id => expenseCategories.find(c => c.id === id)).filter(Boolean);

  return (
    <div className="mobile-list-row" style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
      background: aff?.canAffordNow ? 'rgba(79,255,176,0.05)' : 'rgba(255,255,255,0.03)',
      border: aff?.canAffordNow ? '1px solid rgba(79,255,176,0.18)' : '1px solid transparent',
      borderRadius: 10, flexWrap: 'wrap',
    }}>
      <div className="mobile-list-main" style={{ flex: 1, minWidth: 140 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{item.name}</span>
          {item.link && (
            <a href={item.link} target="_blank" rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              title={item.link}
              style={{ display: 'flex', alignItems: 'center', color: 'var(--accent-blue)', opacity: 0.75, lineHeight: 1 }}>
              <ExternalLink size={11} />
            </a>
          )}
        </div>
        {(item.note || assignedCats.length > 0) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 3, flexWrap: 'wrap' }}>
            {item.note && <span style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>{item.note}</span>}
            {assignedCats.map(c => (
              <span key={c.id} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 10,
                background: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)',
                display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: c.color || 'var(--accent-blue)', display: 'inline-block' }} />
                {c.name}
              </span>
            ))}
          </div>
        )}
      </div>
      <span className="font-display" style={{ fontSize: 15, letterSpacing: '-0.02em', flexShrink: 0 }}>{fmt(item.price || 0)}</span>
      <AffordabilityBadge aff={aff} />
      <button className="btn-icon" onClick={() => onEdit(item)} title="Edit item" style={{ width: 27, height: 27, opacity: 0.58, flexShrink: 0 }}>
        <Pencil size={12} />
      </button>
      <button className="btn-icon" onClick={() => onDelete(item.id)} title="Delete item" style={{ width: 27, height: 27, opacity: 0.4, flexShrink: 0 }}>
        <Trash2 size={12} />
      </button>
    </div>
  );
}

function ListSection({ node, depth, allItems, expenseCategories, settings, onEditItem, onDeleteItem, onAddToList, onEditList, onDeleteList, onAddList, totalListCount, expanded, onToggle }) {
  const [showSubInput, setShowSubInput] = useState(false);
  const [subName, setSubName] = useState('');

  const directItems = allItems.filter(i => i.wishlistCategoryId === node.id);
  const isOpen = expanded.has(node.id);
  const totalItems = countAllItems(node, allItems);
  const canAffordDirect = directItems.filter(item => wishlistAffordability(item, expenseCategories, settings)?.canAffordNow).length;

  const handleCreateSub = () => {
    if (!subName.trim()) return;
    onAddList({ name: subName.trim(), color: LIST_COLORS[totalListCount % LIST_COLORS.length], parentId: node.id });
    setSubName('');
    setShowSubInput(false);
  };

  const header = (
    <div
      className="mobile-list-row"
      onClick={() => onToggle(node.id)}
      style={{
        display: 'flex', alignItems: 'center', gap: depth === 0 ? 10 : 8,
        padding: depth === 0 ? '14px 18px' : '9px 10px',
        cursor: 'pointer', userSelect: 'none', flexWrap: 'wrap',
        borderBottom: isOpen && (directItems.length > 0 || node.children.length > 0 || showSubInput)
          ? '1px solid rgba(255,255,255,0.05)' : 'none',
        borderRadius: depth > 0 ? 10 : 0,
        background: depth > 0 ? 'rgba(255,255,255,0.03)' : 'transparent',
      }}
    >
      <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>
        {isOpen ? <ChevronDown size={depth === 0 ? 14 : 12} /> : <ChevronRight size={depth === 0 ? 14 : 12} />}
      </span>
      <span style={{ width: depth === 0 ? 9 : 7, height: depth === 0 ? 9 : 7, borderRadius: '50%', background: node.color || 'var(--accent-blue)', flexShrink: 0 }} />
      <span className="mobile-list-main" style={{ fontWeight: 600, fontSize: depth === 0 ? 14 : 13, flex: 1, minWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>

      <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
        {totalItems} {totalItems === 1 ? 'item' : 'items'}
        {node.children.length > 0 && ` · ${node.children.length} sub-list${node.children.length !== 1 ? 's' : ''}`}
      </span>

      {canAffordDirect > 0 && (
        <span style={{ fontSize: 10, color: 'var(--good)', background: 'rgba(79,255,176,0.1)', padding: '2px 7px', borderRadius: 20, flexShrink: 0 }}>
          {canAffordDirect} affordable
        </span>
      )}

      <button onClick={e => { e.stopPropagation(); onAddToList(node.id); }} className="btn-secondary"
        style={{ padding: '3px 8px', fontSize: 11, borderRadius: 7, display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
        <Plus size={9} /> Item
      </button>
      <button onClick={e => { e.stopPropagation(); setShowSubInput(v => !v); setSubName(''); }} className="btn-secondary"
        style={{ padding: '3px 8px', fontSize: 11, borderRadius: 7, display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
        <Plus size={9} /> List
      </button>
      <button onClick={e => { e.stopPropagation(); onEditList(node); }} className="btn-icon"
        title="Edit list"
        style={{ width: 26, height: 26, opacity: 0.58, flexShrink: 0 }}>
        <Pencil size={11} />
      </button>
      <button onClick={e => { e.stopPropagation(); onDeleteList(node.id); }} className="btn-icon"
        title="Delete list"
        style={{ width: 26, height: 26, opacity: 0.38, flexShrink: 0 }}>
        <Trash2 size={11} />
      </button>
    </div>
  );

  const body = isOpen && (
    <div style={{ padding: depth === 0 ? '8px 14px 12px' : '6px 0 4px' }}>
      {/* Nested sub-lists */}
      {node.children.map(child => (
        <ListSection key={child.id} node={child} depth={depth + 1}
          allItems={allItems} expenseCategories={expenseCategories} settings={settings}
          onEditItem={onEditItem} onDeleteItem={onDeleteItem} onAddToList={onAddToList}
          onEditList={onEditList} onDeleteList={onDeleteList}
          onAddList={onAddList} totalListCount={totalListCount}
          expanded={expanded} onToggle={onToggle} />
      ))}

      {/* Inline sub-list creation */}
      {showSubInput && (
        <div className="mobile-row-stack" style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '6px 0', paddingLeft: depth > 0 ? 0 : 2 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--text-muted)', flexShrink: 0 }} />
          <input className="glass-input" placeholder="New sub-list name…" value={subName} autoFocus
            onChange={e => setSubName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleCreateSub(); if (e.key === 'Escape') { setShowSubInput(false); setSubName(''); } }}
            style={{ flex: 1 }} />
          <button className="btn-primary mobile-full" onClick={handleCreateSub} disabled={!subName.trim()}
            style={{ flexShrink: 0, padding: '6px 12px', fontSize: 11 }}>Create</button>
          <button className="btn-icon" onClick={() => { setShowSubInput(false); setSubName(''); }} title="Cancel list creation" style={{ width: 28, height: 28 }}>
            <X size={12} />
          </button>
        </div>
      )}

      {/* Items */}
      {directItems.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: node.children.length > 0 || showSubInput ? 6 : 0 }}>
          {directItems.map(item => (
            <ItemRow key={item.id} item={item} expenseCategories={expenseCategories} settings={settings} onEdit={onEditItem} onDelete={onDeleteItem} />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!showSubInput && node.children.length === 0 && directItems.length === 0 && (
        <div style={{ padding: '12px 4px', color: 'var(--text-muted)', fontSize: 12, textAlign: 'center' }}>
          Empty — use <strong>Item</strong> or <strong>List</strong> above to add something
        </div>
      )}
    </div>
  );

  // Depth 0: wrap in glass card
  if (depth === 0) {
    return (
      <div className="glass" style={{ borderRadius: 16, overflow: 'hidden' }}>
        {header}
        {body}
      </div>
    );
  }

  // Depth > 0: indent with coloured left-border accent
  return (
    <div style={{ borderLeft: `2px solid ${node.color || '#5db8ff'}35`, marginLeft: 10, paddingLeft: 10, marginTop: 6 }}>
      {header}
      {body}
    </div>
  );
}

export default function Wishlist({ items, wishlistCategories, expenseCategories, settings, onAddItem, onEditItem, onDeleteItem, onAddWishlistCat, onEditWishlistCat, onDeleteWishlistCat, onAddItemToFolder }) {
  const [expanded, setExpanded] = useState(() => new Set([...wishlistCategories.map(c => c.id), 'uncategorized']));
  const [showNewList, setShowNewList] = useState(false);
  const [newListName, setNewListName] = useState('');

  const toggleList = (id) => setExpanded(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const tree = useMemo(() => buildTree(wishlistCategories), [wishlistCategories]);

  const uncategorizedItems = useMemo(() => items.filter(i => !i.wishlistCategoryId), [items]);

  const canAffordTotal = useMemo(() => items.filter(item =>
    wishlistAffordability(item, expenseCategories, settings)?.canAffordNow
  ).length, [items, expenseCategories, settings]);

  const handleCreateList = () => {
    if (!newListName.trim()) return;
    onAddWishlistCat({ name: newListName.trim(), color: LIST_COLORS[wishlistCategories.length % LIST_COLORS.length], parentId: null });
    setNewListName('');
    setShowNewList(false);
  };

  const handleDeleteList = (id) => {
    const list = wishlistCategories.find(c => c.id === id);
    const hasChildren = wishlistCategories.some(c => c.parentId === id);
    const hasItems = items.some(i => i.wishlistCategoryId === id);
    const msg = [
      `Delete list "${list?.name}"?`,
      hasChildren && 'Sub-lists will be promoted up one level.',
      hasItems && 'Items in this list will become uncategorised.',
    ].filter(Boolean).join('\n');
    if (window.confirm(msg)) onDeleteWishlistCat(id);
  };

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* ── Header ── */}
      <div className="glass mobile-card-pad mobile-row-stack" style={{ borderRadius: 18, padding: '18px 22px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Wishlist</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
            {canAffordTotal > 0
              ? <span style={{ color: 'var(--good)' }}>{canAffordTotal} item{canAffordTotal !== 1 ? 's' : ''} you can afford now</span>
              : `${items.length} item${items.length !== 1 ? 's' : ''} · ${wishlistCategories.length} list${wishlistCategories.length !== 1 ? 's' : ''}`}
          </div>
        </div>
        <div className="mobile-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn-secondary"
            onClick={() => { setShowNewList(v => !v); setNewListName(''); }}
            style={{ padding: '7px 12px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}>
            <Plus size={12} /> New List
          </button>
          <button className="btn-primary" onClick={onAddItem} style={{ padding: '7px 14px', fontSize: 12 }}>
            + Add Item
          </button>
        </div>
      </div>

      {/* ── New top-level list input ── */}
      {showNewList && (
        <div className="glass mobile-card-pad mobile-row-stack" style={{ borderRadius: 14, padding: '12px 16px', display: 'flex', gap: 10, alignItems: 'center' }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: LIST_COLORS[wishlistCategories.length % LIST_COLORS.length], flexShrink: 0 }} />
          <input className="glass-input" placeholder="List name…" value={newListName} autoFocus
            onChange={e => setNewListName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleCreateList(); if (e.key === 'Escape') setShowNewList(false); }}
            style={{ flex: 1 }} />
          <button className="btn-primary mobile-full" onClick={handleCreateList} disabled={!newListName.trim()}
            style={{ flexShrink: 0, padding: '8px 14px', fontSize: 12 }}>Create</button>
          <button className="btn-secondary mobile-full" onClick={() => setShowNewList(false)}
            style={{ flexShrink: 0, padding: '8px 12px', fontSize: 12 }}>Cancel</button>
        </div>
      )}

      {/* ── Empty state ── */}
      {wishlistCategories.length === 0 && items.length === 0 && (
        <div className="glass" style={{ borderRadius: 16, padding: '48px 24px', textAlign: 'center' }}>
          <ShoppingBag size={32} style={{ color: 'var(--text-muted)', margin: '0 auto 12px', display: 'block' }} />
          <div style={{ color: 'var(--text-muted)', fontSize: 14, marginBottom: 6 }}>Your wishlist is empty</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Create a list to organise items, then add what you're saving for</div>
        </div>
      )}

      {/* ── Lists (recursive tree) ── */}
      {tree.map(node => (
        <ListSection key={node.id} node={node} depth={0}
          allItems={items} expenseCategories={expenseCategories} settings={settings}
          onEditItem={onEditItem} onDeleteItem={onDeleteItem} onAddToList={onAddItemToFolder}
          onEditList={onEditWishlistCat} onDeleteList={handleDeleteList} onAddList={onAddWishlistCat}
          totalListCount={wishlistCategories.length}
          expanded={expanded} onToggle={toggleList} />
      ))}

      {/* ── Uncategorised ── */}
      {uncategorizedItems.length > 0 && (
        <div className="glass" style={{ borderRadius: 16, overflow: 'hidden' }}>
          <div className="mobile-list-row" onClick={() => toggleList('uncategorized')}
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', cursor: 'pointer', userSelect: 'none',
              borderBottom: expanded.has('uncategorized') ? '1px solid rgba(255,255,255,0.05)' : 'none' }}>
            <span style={{ color: 'var(--text-muted)' }}>
              {expanded.has('uncategorized') ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>
            <span style={{ fontWeight: 600, fontSize: 14, flex: 1, color: 'var(--text-secondary)' }}>Uncategorised</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{uncategorizedItems.length} {uncategorizedItems.length === 1 ? 'item' : 'items'}</span>
          </div>
          {expanded.has('uncategorized') && (
            <div style={{ padding: '8px 14px 12px', display: 'flex', flexDirection: 'column', gap: 5 }}>
              {uncategorizedItems.map(item => (
                <ItemRow key={item.id} item={item} expenseCategories={expenseCategories} settings={settings} onEdit={onEditItem} onDelete={onDeleteItem} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
