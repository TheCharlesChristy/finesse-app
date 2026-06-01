import { useState, useEffect, useCallback } from 'react';
import { LayoutDashboard, ListOrdered, TrendingUp, ShoppingBag, Settings as SettingsIcon, SlidersHorizontal, ShoppingCart, Wallet } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';

import { db, ensureDefaultAccount, addAccount, updateAccount, deleteAccount, transferMoney,
  getSettings, saveSettings, getCategories, addCategory, updateCategory, deleteCategory,
  getTransactions, addTransaction, updateTransaction, deleteTransaction,
  getWishlistItems, addWishlistItem, updateWishlistItem, deleteWishlistItem,
  getWishlistCategories,
  addWishlistCategory, updateWishlistCategory, deleteWishlistCategory, exportData, importData,
  exportTransactionsCSV, resetBudget, resetCategory, resetCategoriesForIncome,
  addIncome, updateIncome, deleteIncome, getIncomeEvents, recordIncomeReceived, deleteIncomeEvent,
  addVariable, updateVariable, deleteVariable } from './db';
import { calcNextReset, evaluateFormula, fmt } from './utils';

import Dashboard from './views/Dashboard';
import Transactions from './views/Transactions';
import Forecasting from './views/Forecasting';
import Wishlist from './views/Wishlist';
import PurchaseCheck from './views/PurchaseCheck';
import Accounts from './views/Accounts';
import SettingsView from './views/Settings';
import Variables from './views/Variables';
import { AddTransactionModal, AddWishlistItemModal, FastForwardModal, ImportModeModal,
  AddOneOffIncomeModal,
  AddCategoryModal, AddIncomeModal, EditCategoryModal, EditWishlistListModal } from './components/Modals';

const NAV = [
  { id: 'dashboard',   label: 'Dashboard',   Icon: LayoutDashboard },
  { id: 'accounts',    label: 'Accounts',    Icon: Wallet },
  { id: 'transactions',label: 'Transactions', Icon: ListOrdered },
  { id: 'purchase',    label: 'Can I Purchase It', Icon: ShoppingCart },
  { id: 'forecasting', label: 'Forecasting',  Icon: TrendingUp },
  { id: 'wishlist',    label: 'Wishlist',      Icon: ShoppingBag },
  { id: 'variables',   label: 'Variables',     Icon: SlidersHorizontal },
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
  const [editingIncome, setEditingIncome] = useState(null);
  const [editingTransaction, setEditingTransaction] = useState(null);
  const [editingWishlistItem, setEditingWishlistItem] = useState(null);
  const [editingWishlistList, setEditingWishlistList] = useState(null);
  const [wishlistDefaultCatId, setWishlistDefaultCatId] = useState(null);
  const [transactionDefaults, setTransactionDefaults] = useState(null);
  const [activeAccountId, setActiveAccountId] = useState(() => {
    const stored = Number(localStorage.getItem('finesse.activeAccountId'));
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  });

  const accountsQuery = useLiveQuery(() => db.accounts.toArray(), []);
  const accounts = accountsQuery || [];
  const activeAccount = accounts.find(account => Number(account.id) === Number(activeAccountId)) || null;

  useEffect(() => {
    if (!accountsQuery) return;
    if (accountsQuery.length === 0) ensureDefaultAccount();
  }, [accountsQuery]);

  useEffect(() => {
    if (!accounts.length) return;
    const currentExists = accounts.some(account => Number(account.id) === Number(activeAccountId));
    if (!activeAccountId || !currentExists) {
      setActiveAccountId(accounts[0].id);
    }
  }, [accounts, activeAccountId]);

  useEffect(() => {
    if (activeAccountId) localStorage.setItem('finesse.activeAccountId', String(activeAccountId));
  }, [activeAccountId]);

  const settings  = useLiveQuery(() => activeAccountId ? getSettings(activeAccountId) : null, [activeAccountId]);
  const categories = useLiveQuery(() => activeAccountId ? getCategories(activeAccountId) : [], [activeAccountId]) || [];
  const transactions = useLiveQuery(() => activeAccountId ? getTransactions(activeAccountId) : [], [activeAccountId]) || [];
  const wishlistItems = useLiveQuery(() => activeAccountId ? getWishlistItems(activeAccountId) : [], [activeAccountId]) || [];
  const wishlistCategories = useLiveQuery(() => activeAccountId ? getWishlistCategories(activeAccountId) : [], [activeAccountId]) || [];
  const accountTransfers = useLiveQuery(() => db.accountTransfers.toArray(), []) || [];
  const incomeEvents = useLiveQuery(() => activeAccountId ? getIncomeEvents(activeAccountId) : [], [activeAccountId]) || [];
  const incomes   = useLiveQuery(() => activeAccountId ? db.incomes.where('accountId').equals(Number(activeAccountId)).toArray() : [], [activeAccountId]) || [];
  const variables = useLiveQuery(() => activeAccountId ? db.variables.where('accountId').equals(Number(activeAccountId)).toArray() : [], [activeAccountId]) || [];

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
        await recordIncomeReceived({
          accountId: activeAccountId,
          incomeId: income.id,
          name: income.name,
          amount: income.amount,
          date: resetAt,
          type: 'recurring',
        });
        await resetCategoriesForIncome(income.id, resetAt, activeAccountId);
        await updateIncome(income.id, { lastPaid: resetAt, holdActive: false });
        if (!latestReset || due > latestReset) latestReset = due;
      }

      if (latestReset) {
        const current = await getSettings(activeAccountId);
        if (current) await saveSettings({ ...current, lastReset: latestReset.toISOString() }, activeAccountId);
      }
    })();
  }, [incomes, activeAccountId]);

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
    const csv = await exportTransactionsCSV(activeAccountId);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transactions-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [activeAccountId]);

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
    const income = await db.incomes.get(id);
    if (!income) return;
    await recordIncomeReceived({
      accountId: activeAccountId,
      incomeId: id,
      name: income.name,
      amount: income.amount,
      date: isoDate,
      type: 'recurring',
    });
    await updateIncome(id, { lastPaid: isoDate, holdActive: false });
    await resetCategoriesForIncome(id, isoDate, activeAccountId);
    // Keep settings.lastReset current so forecasting burn rates stay accurate
    const current = await getSettings(activeAccountId);
    if (current) await saveSettings({ ...current, lastReset: isoDate }, activeAccountId);
  }, [activeAccountId]);

  const handleAddOneOffIncome = useCallback(async (data) => {
    await recordIncomeReceived({
      ...data,
      accountId: activeAccountId,
      incomeId: null,
      type: 'one-off',
    });
  }, [activeAccountId]);

  const handleEditIncome = useCallback((income) => {
    setEditingIncome(income);
    setModal('editIncome');
  }, []);

  const handleDeleteIncome = useCallback(async (income) => {
    const linkedCategories = categories.filter(cat =>
      cat.incomeAllocations?.some(allocation => Number(allocation.incomeId) === Number(income.id))
    );
    if (linkedCategories.length > 0) {
      alert(`"${income.name}" funds ${linkedCategories.length} categor${linkedCategories.length === 1 ? 'y' : 'ies'}: ${linkedCategories.map(c => c.name).join(', ')}.\n\nReallocate those categories before deleting this income.`);
      return;
    }
    if (window.confirm(`Delete income "${income.name}"?`)) {
      await deleteIncome(income.id);
    }
  }, [categories]);

  // ── Category handlers ────────────────────────────────────────────────────
  const handleEditCategory = useCallback((cat) => {
    setEditingCategory(cat);
    setModal('editCategory');
  }, []);

  const handleEditTransaction = useCallback((transaction) => {
    setEditingTransaction(transaction);
    setModal('editTx');
  }, []);

  const handleEditWishlistItem = useCallback((item) => {
    setEditingWishlistItem(item);
    setModal('editWish');
  }, []);

  const handleEditWishlistList = useCallback((list) => {
    setEditingWishlistList(list);
    setModal('editWishList');
  }, []);

  const handleLogPurchase = useCallback((draft) => {
    setTransactionDefaults(draft);
    setModal('addTx');
  }, []);

  const handleAddAccount = useCallback((account) => addAccount(account), []);
  const handleUpdateAccount = useCallback((id, data) => updateAccount(id, data), []);
  const handleDeleteAccount = useCallback(async (account) => {
    if (accounts.length <= 1) {
      alert('Keep at least one account.');
      return;
    }
    if (!window.confirm(`Delete account "${account.name}" and all of its data?`)) return;
    await deleteAccount(account.id);
    if (Number(activeAccountId) === Number(account.id)) {
      const next = accounts.find(item => Number(item.id) !== Number(account.id));
      setActiveAccountId(next?.id || null);
    }
  }, [accounts, activeAccountId]);
  const handleTransferMoney = useCallback((transfer) => transferMoney(transfer), []);
  const handleDeleteIncomeEvent = useCallback(async (event) => {
    if (event.type !== 'one-off') return;
    if (!window.confirm(`Delete one-off income "${event.name || 'Income'}" and remove it from the account balance?`)) return;
    await deleteIncomeEvent(event.id);
  }, []);

  // ── Variable handlers ────────────────────────────────────────────────────
  const handleAddVariable    = useCallback(v    => addVariable(v, activeAccountId), [activeAccountId]);
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
          {accounts.length > 0 && (
            <div style={{ padding: '4px 4px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)', marginBottom: 8 }}>
              <label style={{ color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', display: 'block', margin: '0 10px 6px' }}>
                Account
              </label>
              <select className="glass-input" value={activeAccountId || ''} onChange={e => setActiveAccountId(Number(e.target.value))}
                style={{ padding: '8px 10px', fontSize: 12, borderRadius: 9 }}>
                {accounts.map(account => (
                  <option key={account.id} value={account.id}>{account.name}</option>
                ))}
              </select>
              {activeAccount && (
                <div style={{ color: 'var(--text-muted)', fontSize: 11, margin: '6px 10px 0' }}>
                  {fmt(activeAccount.balance || 0)}
                </div>
              )}
            </div>
          )}
          {NAV.map(({ id, label, Icon }) => (
            <button key={id} className={`nav-item ${view === id ? 'active' : ''}`} onClick={() => navigate(id)} type="button">
              <Icon size={16} /><span>{label}</span>
            </button>
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
              onAddOneOffIncome={() => setModal('addOneOffIncome')}
              onIncomeHoldToggle={handleIncomeHoldToggle}
              onIncomeFastForward={(id) => { setFastForwardIncomeId(id); setModal('fastForwardIncome'); }}
              onEditIncome={handleEditIncome}
              onDeleteIncome={handleDeleteIncome}
              onEditCategory={handleEditCategory}
              onDeleteCategory={deleteCategory}
            />
          )}
          {view === 'accounts' && (
            <Accounts
              accounts={accounts}
              activeAccountId={activeAccountId}
              transfers={accountTransfers}
              incomeEvents={incomeEvents}
              onSelectAccount={setActiveAccountId}
              onAddAccount={handleAddAccount}
              onUpdateAccount={handleUpdateAccount}
              onDeleteAccount={handleDeleteAccount}
              onTransfer={handleTransferMoney}
              onDeleteIncomeEvent={handleDeleteIncomeEvent}
            />
          )}
          {view === 'transactions' && (
            <Transactions transactions={transactions} categories={categories}
              onDelete={deleteTransaction} onEdit={handleEditTransaction} onAdd={() => setModal('addTx')} />
          )}
          {view === 'forecasting' && (
            <Forecasting categories={categories} settings={settings} transactions={transactions} incomes={incomes} />
          )}
          {view === 'purchase' && (
            <PurchaseCheck categories={categories} onLogPurchase={handleLogPurchase} />
          )}
          {view === 'wishlist' && (
            <Wishlist items={wishlistItems} wishlistCategories={wishlistCategories}
              expenseCategories={categories} settings={settings}
              onAddItem={() => { setWishlistDefaultCatId(null); setModal('addWish'); }}
              onEditItem={handleEditWishlistItem}
              onDeleteItem={deleteWishlistItem}
              onAddWishlistCat={(data) => addWishlistCategory(data, activeAccountId)}
              onEditWishlistCat={handleEditWishlistList}
              onDeleteWishlistCat={deleteWishlistCategory}
              onAddItemToFolder={(catId) => { setWishlistDefaultCatId(catId); setModal('addWish'); }} />
          )}
          {view === 'variables' && (
            <Variables
              variables={variables}
              onAddVariable={handleAddVariable}
              onUpdateVariable={handleUpdateVariable}
              onDeleteVariable={handleDeleteVariable}
            />
          )}
          {view === 'settings' && (
            <SettingsView onExport={handleExport} onExportCSV={handleExportCSV}
              onImport={handleImport} onResetBudget={() => resetBudget(activeAccountId)}
              incomes={incomes} onResetIncome={(incomeId) => resetCategoriesForIncome(incomeId, undefined, activeAccountId)} />
          )}
        </main>
      </div>

      {/* ── Modals ── */}
      {modal === 'addCategory' && (
        <AddCategoryModal onAdd={(data) => addCategory(data, activeAccountId)} onClose={() => setModal(null)}
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
        <AddIncomeModal onAdd={(data) => addIncome(data, activeAccountId)} onClose={() => setModal(null)} />
      )}
      {modal === 'addOneOffIncome' && (
        <AddOneOffIncomeModal onAdd={handleAddOneOffIncome} onClose={() => setModal(null)} />
      )}
      {modal === 'editIncome' && editingIncome && (
        <AddIncomeModal
          income={editingIncome}
          onSave={(id, data) => { updateIncome(id, data); setModal(null); setEditingIncome(null); }}
          onClose={() => { setModal(null); setEditingIncome(null); }}
        />
      )}
      {modal === 'fastForwardIncome' && fastForwardIncomeId !== null && (
        <FastForwardModal
          onConfirm={(isoDate) => handleIncomeFastForward(fastForwardIncomeId, isoDate)}
          onClose={() => { setModal(null); setFastForwardIncomeId(null); }}
        />
      )}
      {modal === 'addTx' && categories.length > 0 && (
        <AddTransactionModal
          categories={categories}
          onAdd={(data) => addTransaction({ ...data, accountId: activeAccountId })}
          initial={transactionDefaults}
          onClose={() => { setModal(null); setTransactionDefaults(null); }}
        />
      )}
      {modal === 'editTx' && editingTransaction && categories.length > 0 && (
        <AddTransactionModal
          categories={categories}
          transaction={editingTransaction}
          onSave={(id, data) => { updateTransaction(id, data); setModal(null); setEditingTransaction(null); }}
          onClose={() => { setModal(null); setEditingTransaction(null); }}
        />
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
          onAdd={(data) => addWishlistItem(data, activeAccountId)} onClose={() => setModal(null)}
          defaultCategoryId={wishlistDefaultCatId} />
      )}
      {modal === 'editWish' && editingWishlistItem && (
        <AddWishlistItemModal
          expenseCategories={categories}
          wishlistCategories={wishlistCategories}
          item={editingWishlistItem}
          onSave={(id, data) => { updateWishlistItem(id, data); setModal(null); setEditingWishlistItem(null); }}
          onClose={() => { setModal(null); setEditingWishlistItem(null); }}
        />
      )}
      {modal === 'editWishList' && editingWishlistList && (
        <EditWishlistListModal
          list={editingWishlistList}
          wishlistCategories={wishlistCategories}
          onSave={(id, data) => { updateWishlistCategory(id, data); setModal(null); setEditingWishlistList(null); }}
          onClose={() => { setModal(null); setEditingWishlistList(null); }}
        />
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
