import { useState, useEffect, useCallback } from 'react';
import { LayoutDashboard, ListOrdered, TrendingUp, ShoppingBag, Settings as SettingsIcon } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';

import { db, getSettings, saveSettings, addCategory, updateCategory, deleteCategory,
  addTransaction, deleteTransaction, addWishlistItem, updateWishlistItem, deleteWishlistItem,
  addWishlistCategory, deleteWishlistCategory, exportData, importData,
  exportTransactionsCSV, resetBudget, resetCategory, resetCategoriesForIncome,
  addIncome, updateIncome, deleteIncome,
  addVariable, updateVariable, deleteVariable } from './db';
import { calcNextReset, evaluateFormula } from './utils';

import Dashboard from './views/Dashboard';
import Transactions from './views/Transactions';
import Forecasting from './views/Forecasting';
import Wishlist from './views/Wishlist';
import SettingsView from './views/Settings';
import { AddTransactionModal, AddWishlistItemModal, FastForwardModal, ImportModeModal,
  AddCategoryModal, AddIncomeModal, EditCategoryModal } from './components/Modals';

const NAV = [
  { id: 'dashboard',   label: 'Dashboard',   Icon: LayoutDashboard },
  { id: 'transactions',label: 'Transactions', Icon: ListOrdered },
  { id: 'forecasting', label: 'Forecasting',  Icon: TrendingUp },
  { id: 'wishlist',    label: 'Wishlist',      Icon: ShoppingBag },
  { id: 'settings',    label: 'Settings',     Icon: SettingsIcon },
];

function getLatestDueIncomeReset(income, now = new Date()) {
  const freq = income.resetFrequency || (income.payDayOfMonth ? 'monthly' : null);
  if (!freq || income.holdActive) return null;

  const base = income.lastPaid ? new Date(income.lastPaid) : now;
  let next = calcNextReset(freq, income.payDayOfMonth, base);
  let due = null;
  let guard = 0;

  while (next <= now && guard < 120) {
    due = next;
    next = calcNextReset(freq, income.payDayOfMonth, next);
    guard += 1;
  }

  return due;
}

export default function App() {
  const [view, setView] = useState('dashboard');
  const [modal, setModal] = useState(null);
  const [pendingImport, setPendingImport] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [fastForwardIncomeId, setFastForwardIncomeId] = useState(null);
  const [editingCategory, setEditingCategory] = useState(null);
  const [wishlistDefaultCatId, setWishlistDefaultCatId] = useState(null);

  const settings  = useLiveQuery(() => getSettings(), []);
  const categories = useLiveQuery(() => db.categories.toArray(), []) || [];
  const transactions = useLiveQuery(() => db.transactions.orderBy('date').reverse().toArray(), []) || [];
  const wishlistItems = useLiveQuery(() => db.wishlist.toArray(), []) || [];
  const wishlistCategories = useLiveQuery(() => db.wishlistCategories.toArray(), []) || [];
  const incomes   = useLiveQuery(() => db.incomes.toArray(), []) || [];
  const variables = useLiveQuery(() => db.variables.toArray(), []) || [];

  // Per-category auto-reset for legacy categories without income funding.
  useEffect(() => {
    if (!categories.length) return;
    (async () => {
      const now = new Date();
      for (const cat of categories) {
        if (cat.incomeAllocations?.length) continue;
        if (!cat.resetFrequency || !cat.lastReset) continue;
        const next = calcNextReset(cat.resetFrequency, cat.payDayOfMonth, new Date(cat.lastReset));
        if (next <= now) await resetCategory(cat.id);
      }
    })();
  }, [categories]);

  // Income auto-reset: funded categories reset when their associated income resets.
  useEffect(() => {
    if (!incomes.length) return;
    (async () => {
      const now = new Date();
      let latestReset = null;

      for (const income of incomes) {
        const due = getLatestDueIncomeReset(income, now);
        if (!due) continue;

        const resetAt = due.toISOString();
        await resetCategoriesForIncome(income.id, resetAt);
        await updateIncome(income.id, { lastPaid: resetAt, holdActive: false });
        if (!latestReset || due > latestReset) latestReset = due;
      }

      if (latestReset) {
        const current = await getSettings();
        if (current) await saveSettings({ ...current, lastReset: latestReset.toISOString() });
      }
    })();
  }, [incomes]);

  // Formula recomputation: runs whenever variables or categories change
  useEffect(() => {
    if (!categories.length) return;
    (async () => {
      for (const cat of categories) {
        if (!cat.allowanceFormula) continue;
        const computed = evaluateFormula(cat.allowanceFormula, variables, categories, incomes);
        if (computed !== null && computed !== cat.allowance) {
          await updateCategory(cat.id, { allowance: computed });
        }
      }
    })();
  }, [variables, categories, incomes]);

  // ── Settings / data handlers ─────────────────────────────────────────────
  const handleExport = useCallback(async () => {
    const data = await exportData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `finance-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const handleExportCSV = useCallback(async () => {
    const csv = await exportTransactionsCSV();
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transactions-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const handleImport = useCallback((data) => {
    setPendingImport(data);
    setModal('importMode');
  }, []);

  const handleImportConfirm = useCallback(async (mode) => {
    if (pendingImport) {
      await importData(pendingImport, mode);
      setPendingImport(null);
    }
    setModal(null);
  }, [pendingImport]);

  // ── Income handlers ──────────────────────────────────────────────────────
  const handleIncomeHoldToggle = useCallback(async (id) => {
    const income = await db.incomes.get(id);
    if (!income) return;
    await updateIncome(id, { holdActive: !income.holdActive });
  }, []);

  const handleIncomeFastForward = useCallback(async (id, isoDate) => {
    await updateIncome(id, { lastPaid: isoDate, holdActive: false });
    await resetCategoriesForIncome(id, isoDate);
    // Keep settings.lastReset current so forecasting burn rates stay accurate
    const current = await getSettings();
    if (current) await saveSettings({ ...current, lastReset: isoDate });
  }, []);

  // ── Category handlers ────────────────────────────────────────────────────
  const handleEditCategory = useCallback((cat) => {
    setEditingCategory(cat);
    setModal('editCategory');
  }, []);

  // ── Variable handlers ────────────────────────────────────────────────────
  const handleAddVariable    = useCallback(v    => addVariable(v), []);
  const handleUpdateVariable = useCallback((id, d) => updateVariable(id, d), []);
  const handleDeleteVariable = useCallback(id   => deleteVariable(id), []);

  const navigate = (id) => { setView(id); setSidebarOpen(false); };

  return (
    <div style={{ minHeight: '100vh', position: 'relative' }}>
      <div className="bg-mesh" />
      {sidebarOpen && (
        <div onClick={() => setSidebarOpen(false)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 19, backdropFilter: 'blur(2px)'
        }} />
      )}
      <div style={{ position: 'relative', zIndex: 1, display: 'flex', minHeight: '100vh' }}>
        <aside className="sidebar" style={{
          width: 220, flexShrink: 0, padding: '24px 12px',
          display: 'flex', flexDirection: 'column', gap: 4,
          borderRight: '1px solid rgba(255,255,255,0.07)',
          background: 'rgba(10,15,30,0.6)',
          backdropFilter: 'blur(20px)',
          position: 'fixed', top: 0, bottom: 0,
          zIndex: 20,
        }}>
          <div style={{ padding: '8px 14px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)', marginBottom: 8 }}>
            <div className="font-display" style={{ fontSize: 20, letterSpacing: '-0.02em' }}>Finesse</div>
            <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 2 }}>Personal finance</div>
          </div>
          {NAV.map(({ id, label, Icon }) => (
            <div key={id} className={`nav-item ${view === id ? 'active' : ''}`} onClick={() => navigate(id)}>
              <Icon size={16} /><span>{label}</span>
            </div>
          ))}
        </aside>

        <main style={{ flex: 1, padding: '24px 20px', maxWidth: 900, minWidth: 0, marginLeft: 220 }} className="main-content">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }} className="mobile-header">
            <button onClick={() => setSidebarOpen(v => !v)} style={{
              background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: 10, width: 38, height: 38, cursor: 'pointer', color: 'white',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 18
            }}>☰</button>
            <div className="font-display" style={{ fontSize: 18 }}>
              {NAV.find(n => n.id === view)?.label}
            </div>
          </div>

          {view === 'dashboard' && (
            <Dashboard
              categories={categories}
              settings={settings}
              transactions={transactions}
              incomes={incomes}
              variables={variables}
              onAddTx={() => setModal('addTx')}
              onAddCategory={() => setModal('addCategory')}
              onAddIncome={() => setModal('addIncome')}
              onIncomeHoldToggle={handleIncomeHoldToggle}
              onIncomeFastForward={(id) => { setFastForwardIncomeId(id); setModal('fastForwardIncome'); }}
              onEditCategory={handleEditCategory}
              onDeleteCategory={deleteCategory}
              onAddVariable={handleAddVariable}
              onUpdateVariable={handleUpdateVariable}
              onDeleteVariable={handleDeleteVariable}
            />
          )}
          {view === 'transactions' && (
            <Transactions transactions={transactions} categories={categories}
              onDelete={deleteTransaction} onAdd={() => setModal('addTx')} />
          )}
          {view === 'forecasting' && (
            <Forecasting categories={categories} settings={settings} transactions={transactions} incomes={incomes} />
          )}
          {view === 'wishlist' && (
            <Wishlist items={wishlistItems} wishlistCategories={wishlistCategories}
              expenseCategories={categories} settings={settings}
              onAddItem={() => { setWishlistDefaultCatId(null); setModal('addWish'); }}
              onDeleteItem={deleteWishlistItem}
              onAddWishlistCat={addWishlistCategory}
              onDeleteWishlistCat={deleteWishlistCategory}
              onAddItemToFolder={(catId) => { setWishlistDefaultCatId(catId); setModal('addWish'); }} />
          )}
          {view === 'settings' && (
            <SettingsView onExport={handleExport} onExportCSV={handleExportCSV}
              onImport={handleImport} onResetBudget={resetBudget} />
          )}
        </main>
      </div>

      {/* ── Modals ── */}
      {modal === 'addCategory' && (
        <AddCategoryModal onAdd={addCategory} onClose={() => setModal(null)}
          variables={variables} categories={categories} incomes={incomes} />
      )}
      {modal === 'editCategory' && editingCategory && (
        <EditCategoryModal
          category={editingCategory}
          variables={variables}
          categories={categories.filter(c => c.id !== editingCategory.id)}
          incomes={incomes}
          onSave={(id, data) => { updateCategory(id, data); setModal(null); setEditingCategory(null); }}
          onClose={() => { setModal(null); setEditingCategory(null); }}
        />
      )}
      {modal === 'addIncome' && (
        <AddIncomeModal onAdd={addIncome} onClose={() => setModal(null)} />
      )}
      {modal === 'fastForwardIncome' && fastForwardIncomeId !== null && (
        <FastForwardModal
          onConfirm={(isoDate) => handleIncomeFastForward(fastForwardIncomeId, isoDate)}
          onClose={() => { setModal(null); setFastForwardIncomeId(null); }}
        />
      )}
      {modal === 'addTx' && categories.length > 0 && (
        <AddTransactionModal categories={categories} onAdd={addTransaction} onClose={() => setModal(null)} />
      )}
      {modal === 'addTx' && categories.length === 0 && (
        <div className="modal-overlay" onClick={() => setModal(null)}>
          <div className="modal-box" style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 10 }}>No categories yet</div>
            <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 18 }}>
              Add an expense category from the Dashboard first.
            </div>
            <button className="btn-primary" onClick={() => { setModal(null); setView('dashboard'); }}>
              Go to Dashboard
            </button>
          </div>
        </div>
      )}
      {modal === 'addWish' && (
        <AddWishlistItemModal expenseCategories={categories} wishlistCategories={wishlistCategories}
          onAdd={addWishlistItem} onClose={() => setModal(null)}
          defaultCategoryId={wishlistDefaultCatId} />
      )}
      {modal === 'importMode' && (
        <ImportModeModal onConfirm={handleImportConfirm}
          onClose={() => { setPendingImport(null); setModal(null); }} />
      )}

      <style>{`
        @media (min-width: 768px) {
          .sidebar { left: 0 !important; }
          .mobile-header { display: none !important; }
        }
        @media (max-width: 767px) {
          .sidebar { left: ${sidebarOpen ? '0' : '-220px'} !important; transition: left 0.25s ease; }
          .main-content { margin-left: 0 !important; }
        }
      `}</style>
    </div>
  );
}
