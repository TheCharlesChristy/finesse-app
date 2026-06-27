import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { CalendarDays, CreditCard, LayoutDashboard, ListOrdered, Menu, TrendingUp, ShoppingBag, Settings as SettingsIcon, SlidersHorizontal, ShoppingCart, Wallet } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';

import { db, ensureDefaultAccount, addAccount, updateAccount, deleteAccount, transferMoney,
  getSettings, saveSettings, getCategories, addCategory, updateCategory, deleteCategory,
  getTransactions, addTransaction, addTransactionsBulk, updateTransaction, deleteTransaction,
  getWishlistItems, addWishlistItem, updateWishlistItem, deleteWishlistItem,
  getWishlistCategories,
  addWishlistCategory, updateWishlistCategory, deleteWishlistCategory, exportData, importData,
  exportTransactionsCSV, clearAllData, resetBudget, resetCategory, resetCategoriesForIncome,
  addIncome, updateIncome, deleteIncome, getIncomeEvents, recordIncomeReceived, deleteIncomeEvent,
  getSubscriptions, addSubscription, updateSubscription, deleteSubscription, processDueSubscriptions,
  addVariable, updateVariable, deleteVariable,
  topUpCategoryFromIncome, borrowBudgetBetweenCategories, resetCategoryTopUps } from './db';
import { calcNextReset, evaluateFormula, fmt, getIncomeCycleDays, getPacedAllowanceConfig, getPacedAllowanceMonthlyTotal, normalizeIncomeAllocations } from './utils';

const Dashboard     = lazy(() => import('./views/Dashboard'));
const Transactions  = lazy(() => import('./views/Transactions'));
const Forecasting   = lazy(() => import('./views/Forecasting'));
const Wishlist      = lazy(() => import('./views/Wishlist'));
const PurchaseCheck = lazy(() => import('./views/PurchaseCheck'));
const Accounts      = lazy(() => import('./views/Accounts'));
const Calendar      = lazy(() => import('./views/Calendar'));
const Subscriptions = lazy(() => import('./views/Subscriptions'));
const SettingsView  = lazy(() => import('./views/Settings'));
const Variables     = lazy(() => import('./views/Variables'));
import { AddTransactionModal, AddWishlistItemModal, FastForwardModal, ImportModeModal,
  AddOneOffIncomeModal, AddSubscriptionModal, BulkAddExpensesModal,
  AddCategoryModal, AddIncomeModal, EditCategoryModal, EditWishlistListModal,
  AdjustBudgetModal } from './components/Modals';
import { Modal } from './components/ui';
import { useDialog } from './components/useDialog';

const NAV = [
  { id: 'dashboard',   label: 'Dashboard',   Icon: LayoutDashboard },
  { id: 'accounts',    label: 'Accounts',    Icon: Wallet },
  { id: 'transactions',label: 'Transactions', Icon: ListOrdered },
  { id: 'purchase',    label: 'Can I Purchase It', Icon: ShoppingCart },
  { id: 'calendar',    label: 'Calendar',     Icon: CalendarDays },
  { id: 'subscriptions', label: 'Subscriptions', Icon: CreditCard },
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
  const { dialogEl, showConfirm, showAlert, showPrompt } = useDialog();

  const [view, setView] = useState('dashboard');
  const [modal, setModal] = useState(null);
  const [pendingImport, setPendingImport] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [fastForwardIncomeId, setFastForwardIncomeId] = useState(null);
  const [editingCategory, setEditingCategory] = useState(null);
  const [editingIncome, setEditingIncome] = useState(null);
  const [editingSubscription, setEditingSubscription] = useState(null);
  const [editingTransaction, setEditingTransaction] = useState(null);
  const [editingWishlistItem, setEditingWishlistItem] = useState(null);
  const [editingWishlistList, setEditingWishlistList] = useState(null);
  const [wishlistDefaultCatId, setWishlistDefaultCatId] = useState(null);
  const [transactionDefaults, setTransactionDefaults] = useState(null);
  const [adjustCategoryId, setAdjustCategoryId] = useState(null);
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
  const subscriptions = useLiveQuery(() => activeAccountId ? getSubscriptions(activeAccountId) : [], [activeAccountId]) || [];
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

  // Paced allowance categories derive their period allowance from a repeating amount.
  // The period is the income reset cycle (weekly, fortnightly, etc.) rather than
  // the calendar month, so that the stored allowance is consistent with income.amount.
  useEffect(() => {
    if (!categories.length) return;
    (async () => {
      for (const cat of categories) {
        const pace = getPacedAllowanceConfig(cat);
        if (!pace) continue;
        const allocs = normalizeIncomeAllocations(cat.incomeAllocations);
        const linkedFreqs = [...new Set(
          allocs.map(a => incomes.find(i => Number(i.id) === a.incomeId)?.resetFrequency).filter(Boolean)
        )];
        const cycleDays = linkedFreqs.length === 1 ? getIncomeCycleDays(linkedFreqs[0]) : null;
        const expectedAllowance = getPacedAllowanceMonthlyTotal(pace.amount, pace.interval, pace.unit, undefined, cycleDays);
        if (Math.abs((Number(cat.allowance) || 0) - expectedAllowance) > 0.005) {
          await updateCategory(cat.id, { allowance: expectedAllowance });
        }
      }
    })();
  }, [categories, incomes]);

  // Subscriptions are logged automatically when their due date arrives.
  useEffect(() => {
    if (!activeAccountId || !subscriptions.length) return;
    processDueSubscriptions(activeAccountId).catch(error => {
      console.error('Failed to process due subscriptions', error);
    });
  }, [activeAccountId, subscriptions]);

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

  // ── Theme ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const mode = settings?.themeMode ?? 'dark';
    if (mode === 'dark') { document.documentElement.setAttribute('data-theme', 'dark'); return; }
    if (mode === 'light') { document.documentElement.setAttribute('data-theme', 'light'); return; }
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const apply = (e) => document.documentElement.setAttribute('data-theme', e.matches ? 'light' : 'dark');
    apply(mq);
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [settings?.themeMode]);

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
    if (!pendingImport) {
      setModal(null);
      return;
    }

    try {
      const summary = await importData(pendingImport, mode);
      if (summary?.preferredAccountId) {
        setActiveAccountId(Number(summary.preferredAccountId));
      }
      setPendingImport(null);
      setModal(null);
      console.info('Import completed in App', {
        mode,
        activeAccountId,
        summary,
      });

      const tableOrder = [
        'accounts',
        'settings',
        'categories',
        'transactions',
        'subscriptions',
        'incomes',
        'incomeEvents',
        'wishlist',
        'wishlistCategories',
        'variables',
        'accountTransfers',
      ];
      const labels = {
        accounts: 'Accounts',
        settings: 'Settings',
        categories: 'Categories',
        transactions: 'Transactions',
        subscriptions: 'Subscriptions',
        incomes: 'Incomes',
        incomeEvents: 'Income events',
        wishlist: 'Wishlist items',
        wishlistCategories: 'Wishlist lists',
        variables: 'Variables',
        accountTransfers: 'Transfers',
      };

      const lines = [
        `${mode === 'replace' ? 'Replace' : 'Merge'} import complete.`,
        '',
        `Imported: ${summary?.totals?.imported || 0}`,
      ];

      if ((summary?.totals?.skipped || 0) > 0) {
        lines.push(`Skipped duplicates: ${summary.totals.skipped}`);
      }

      lines.push('');
      lines.push('Details:');

      for (const key of tableOrder) {
        const row = summary?.tables?.[key];
        if (!row) continue;
        const imported = Number(row.imported) || 0;
        const skipped = Number(row.skipped) || 0;
        lines.push(`- ${labels[key]}: ${imported}${skipped > 0 ? ` (${skipped} skipped)` : ''}`);
      }

      if (summary?.createdDefaultAccount) {
        lines.push('');
        lines.push('Note: Backup had no accounts, so a Main Account was created automatically.');
      }

      await showAlert(lines.join('\n'), { title: 'Import complete' });
    } catch (error) {
      console.error('Import failed', error);
      await showAlert('Import failed. Make sure this is a valid Finesse backup file and try again.', { title: 'Import failed' });
    }
  }, [pendingImport, showAlert]);

  const handleSaveSettings = useCallback((data) => saveSettings(data, activeAccountId), [activeAccountId]);

  const handleFullReset = useCallback(async () => {
    await clearAllData();
    localStorage.removeItem('finesse.activeAccountId');
    const account = await ensureDefaultAccount();
    setActiveAccountId(account?.id || null);
    setModal(null);
  }, []);

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

  const handleTopUpFromIncome = useCallback((categoryId, amount) => (
    topUpCategoryFromIncome(categoryId, amount)
  ), []);

  const handleBorrowFromCategory = useCallback((fromCategoryId, toCategoryId, amount) => (
    borrowBudgetBetweenCategories(fromCategoryId, toCategoryId, amount)
  ), []);

  const handleResetTopUps = useCallback((categoryId) => (
    resetCategoryTopUps(categoryId)
  ), []);

  const handleOpenAdjust = useCallback((categoryId = null) => {
    setAdjustCategoryId(categoryId);
    setModal('adjust');
  }, []);

  const handleEditIncome = useCallback((income) => {
    setEditingIncome(income);
    setModal('editIncome');
  }, []);

  const handleDeleteIncome = useCallback(async (income) => {
    const linkedCategories = categories.filter(cat =>
      cat.incomeAllocations?.some(allocation => Number(allocation.incomeId) === Number(income.id))
    );
    if (linkedCategories.length > 0) {
      await showAlert(
        `"${income.name}" funds ${linkedCategories.length} categor${linkedCategories.length === 1 ? 'y' : 'ies'}: ${linkedCategories.map(c => c.name).join(', ')}.\n\nReallocate those categories before deleting this income.`,
        { title: 'Cannot delete income' },
      );
      return;
    }
    const ok = await showConfirm(`Delete income "${income.name}"?`, {
      title: 'Delete Income', confirmText: 'Delete', danger: true,
    });
    if (ok) await deleteIncome(income.id);
  }, [categories, showAlert, showConfirm]);

  const handleAddSubscription = useCallback((subscription) => addSubscription(subscription, activeAccountId), [activeAccountId]);
  const handleEditSubscription = useCallback((subscription) => {
    setEditingSubscription(subscription);
    setModal('editSubscription');
  }, []);
  const handleUpdateSubscription = useCallback((id, data) => updateSubscription(id, data), []);
  const handleDeleteSubscription = useCallback(async (subscription) => {
    const ok = await showConfirm(`Delete "${subscription.name}"? Past logged expenses will stay.`, {
      title: 'Delete Subscription', confirmText: 'Delete', danger: true,
    });
    if (!ok) return;
    await deleteSubscription(subscription.id);
  }, [showConfirm]);
  const handleToggleSubscription = useCallback((subscription) => {
    updateSubscription(subscription.id, { active: subscription.active === false });
  }, []);

  // ── Category handlers ────────────────────────────────────────────────────
  const handleEditCategory = useCallback((cat) => {
    setEditingCategory(cat);
    setModal('editCategory');
  }, []);

  const handleEditTransaction = useCallback((transaction) => {
    setEditingTransaction(transaction);
    setModal('editTx');
  }, []);

  const handleBulkAddExpenses = useCallback((data) => (
    addTransactionsBulk({ ...data, accountId: activeAccountId })
  ), [activeAccountId]);

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
      await showAlert('You need at least one account — add another before deleting this one.', {
        title: 'Cannot delete account',
      });
      return;
    }
    const ok = await showConfirm(`Delete account "${account.name}" and all of its data?`, {
      title: 'Delete Account', confirmText: 'Delete', danger: true,
    });
    if (!ok) return;
    await deleteAccount(account.id);
    if (Number(activeAccountId) === Number(account.id)) {
      const next = accounts.find(item => Number(item.id) !== Number(account.id));
      setActiveAccountId(next?.id || null);
    }
  }, [accounts, activeAccountId, showAlert, showConfirm]);
  const handleTransferMoney = useCallback((transfer) => transferMoney(transfer), []);
  const handleDeleteIncomeEvent = useCallback(async (event) => {
    if (event.type !== 'one-off') return;
    const ok = await showConfirm(`Delete "${event.name || 'Income'}" and remove it from the account balance?`, {
      title: 'Delete one-off income', confirmText: 'Delete', danger: true,
    });
    if (!ok) return;
    await deleteIncomeEvent(event.id);
  }, [showConfirm]);

  // ── Transaction / category delete (confirmation owned here) ─────────────────
  const handleDeleteTransaction = useCallback(async (tx) => {
    const cat = categories.find(c => c.id === tx.categoryId);
    const label = tx.note || cat?.name || 'Expense';
    const ok = await showConfirm(`Delete "${label}"?`, {
      title: 'Delete Transaction', confirmText: 'Delete', danger: true,
    });
    if (ok) deleteTransaction(tx.id);
  }, [categories, showConfirm]);

  const handleDeleteCategory = useCallback(async (catId) => {
    const cat = categories.find(c => c.id === catId);
    const ok = await showConfirm(`Delete "${cat?.name || 'category'}" and all its transactions?`, {
      title: 'Delete Category', confirmText: 'Delete', danger: true,
    });
    if (ok) deleteCategory(catId);
  }, [categories, showConfirm]);

  // ── Variable handlers ────────────────────────────────────────────────────
  const handleAddVariable    = useCallback(v    => addVariable(v, activeAccountId), [activeAccountId]);
  const handleUpdateVariable = useCallback((id, d) => updateVariable(id, d), []);
  const handleDeleteVariable = useCallback(id   => deleteVariable(id), []);

  const navigate = (id) => { setView(id); setSidebarOpen(false); };

  return (
    <div style={{ minHeight: '100vh', position: 'relative' }}>
      <div className="bg-mesh" />
      <div style={{ position: 'relative', zIndex: 1, display: 'flex', minHeight: '100vh' }}>
        <aside id="app-sidebar" className="sidebar" aria-label="Sidebar" style={{
          width: 220, flexShrink: 0,
          padding: 'calc(24px + env(safe-area-inset-top, 0px)) 12px calc(24px + env(safe-area-inset-bottom, 0px))',
          display: 'flex', flexDirection: 'column', gap: 4,
          borderRight: '1px solid rgba(255,255,255,0.07)',
          background: 'var(--sidebar-bg)',
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
              <label htmlFor="account-switcher" style={{ color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', display: 'block', margin: '0 10px 6px' }}>
                Account
              </label>
              <select id="account-switcher" className="glass-input" value={activeAccountId || ''} onChange={e => setActiveAccountId(Number(e.target.value))}
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
          <nav aria-label="Primary" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {NAV.map(({ id, label, Icon }) => (
              <button key={id} className={`nav-item ${view === id ? 'active' : ''}`} onClick={() => navigate(id)} type="button"
                aria-current={view === id ? 'page' : undefined}>
                <Icon size={16} aria-hidden="true" /><span>{label}</span>
              </button>
            ))}
          </nav>
        </aside>

        {sidebarOpen && (
          <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 19,
            backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)'
          }} />
        )}

        <main style={{
          flex: 1,
          padding: 'calc(24px + env(safe-area-inset-top, 0px)) calc(20px + env(safe-area-inset-right, 0px)) calc(24px + env(safe-area-inset-bottom, 0px)) calc(20px + env(safe-area-inset-left, 0px))',
          maxWidth: 900,
          minWidth: 0,
          marginLeft: 220,
        }} className="main-content">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }} className="page-header">
            <button type="button" className="mobile-menu-btn" onClick={() => setSidebarOpen(v => !v)}
              aria-label={sidebarOpen ? 'Close navigation' : 'Open navigation'}
              aria-expanded={sidebarOpen} aria-controls="app-sidebar" style={{
              background: 'var(--mobile-btn-bg)', border: '1px solid var(--mobile-btn-border)',
              borderRadius: 10, width: 38, height: 38, cursor: 'pointer', color: 'white',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
            }}><Menu size={18} aria-hidden="true" /></button>
            <h1 className="font-display" style={{ fontSize: 20, fontWeight: 400, margin: 0 }}>
              {NAV.find(n => n.id === view)?.label}
            </h1>
          </div>

          {!accountsQuery ? (
            <div className="glass" aria-busy="true" style={{ borderRadius: 16, padding: '64px 24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
              Loading your finances…
            </div>
          ) : (
          <Suspense fallback={
            <div className="glass" style={{ borderRadius: 16, padding: '48px 24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
              Loading…
            </div>
          }>
          {view === 'dashboard' && (
            <Dashboard
              categories={categories}
              settings={settings}
              transactions={transactions}
              incomes={incomes}
              subscriptions={subscriptions}
              variables={variables}
              onAddTx={() => setModal('addTx')}
              onAddCategory={() => setModal('addCategory')}
              onAddIncome={() => setModal('addIncome')}
              onAddOneOffIncome={() => setModal('addOneOffIncome')}
              onAddSubscription={() => setModal('addSubscription')}
              onIncomeHoldToggle={handleIncomeHoldToggle}
              onIncomeFastForward={(id) => { setFastForwardIncomeId(id); setModal('fastForwardIncome'); }}
              onEditIncome={handleEditIncome}
              onDeleteIncome={handleDeleteIncome}
              onEditCategory={handleEditCategory}
              onDeleteCategory={handleDeleteCategory}
              onAdjust={handleOpenAdjust}
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
              onDelete={handleDeleteTransaction} onEdit={handleEditTransaction} onAdd={() => setModal('addTx')}
              onBulkAdd={() => setModal('bulkAddTx')}
              onAddSubscription={() => setModal('addSubscription')} />
          )}
          {view === 'forecasting' && (
            <Forecasting categories={categories} settings={settings} transactions={transactions} incomes={incomes} />
          )}
          {view === 'purchase' && (
            <PurchaseCheck categories={categories} onLogPurchase={handleLogPurchase} />
          )}
          {view === 'calendar' && (
            <Calendar
              categories={categories}
              incomes={incomes}
              subscriptions={subscriptions}
              onAddSubscription={() => setModal('addSubscription')}
              onEditSubscription={handleEditSubscription}
              onDeleteSubscription={handleDeleteSubscription}
              onToggleSubscription={handleToggleSubscription}
            />
          )}
          {view === 'subscriptions' && (
            <Subscriptions
              categories={categories}
              subscriptions={subscriptions}
              onAddSubscription={() => setModal('addSubscription')}
              onEditSubscription={handleEditSubscription}
              onDeleteSubscription={handleDeleteSubscription}
              onToggleSubscription={handleToggleSubscription}
            />
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
              onAddItemToFolder={(catId) => { setWishlistDefaultCatId(catId); setModal('addWish'); }}
              showConfirm={showConfirm} />
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
              categories={categories} settings={settings} onSaveSettings={handleSaveSettings}
              incomes={incomes} onResetIncome={(incomeId) => resetCategoriesForIncome(incomeId, undefined, activeAccountId)}
              onFullReset={handleFullReset}
              showConfirm={showConfirm} showAlert={showAlert} showPrompt={showPrompt} />
          )}
          </Suspense>)}
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
      {modal === 'addSubscription' && (
        <AddSubscriptionModal
          categories={categories}
          defaultCategoryId={settings?.defaultCategoryId}
          onAdd={handleAddSubscription}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'editSubscription' && editingSubscription && (
        <AddSubscriptionModal
          categories={categories}
          subscription={editingSubscription}
          defaultCategoryId={settings?.defaultCategoryId}
          onSave={(id, data) => { handleUpdateSubscription(id, data); setModal(null); setEditingSubscription(null); }}
          onClose={() => { setModal(null); setEditingSubscription(null); }}
        />
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
          defaultCategoryId={settings?.defaultCategoryId}
          onClose={() => { setModal(null); setTransactionDefaults(null); }}
        />
      )}
      {modal === 'bulkAddTx' && categories.length > 0 && (
        <BulkAddExpensesModal
          categories={categories}
          defaultCategoryId={settings?.defaultCategoryId}
          onAdd={handleBulkAddExpenses}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'editTx' && editingTransaction && categories.length > 0 && (
        <AddTransactionModal
          categories={categories}
          transaction={editingTransaction}
          onSave={(id, data) => { updateTransaction(id, data); setModal(null); setEditingTransaction(null); }}
          defaultCategoryId={settings?.defaultCategoryId}
          onClose={() => { setModal(null); setEditingTransaction(null); }}
        />
      )}
      {(modal === 'addTx' || modal === 'bulkAddTx') && categories.length === 0 && (
        <Modal title="No categories yet" onClose={() => setModal(null)}>
          <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 18 }}>
            Add an expense category from the Dashboard first.
          </div>
          <button className="btn-primary" onClick={() => { setModal(null); setView('dashboard'); }}>
            Go to Dashboard
          </button>
        </Modal>
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
      {modal === 'adjust' && categories.length > 0 && (
        <AdjustBudgetModal
          categories={categories}
          totalIncome={incomes.length > 0 ? incomes.reduce((s, i) => s + (i.amount || 0), 0) : (settings?.income || 0)}
          defaultCategoryId={adjustCategoryId}
          onTopUpFromIncome={handleTopUpFromIncome}
          onBorrowFromCategory={handleBorrowFromCategory}
          onResetTopUps={handleResetTopUps}
          onClose={() => { setModal(null); setAdjustCategoryId(null); }}
        />
      )}
      {dialogEl}

      <style>{`
        @media (min-width: 768px) {
          .sidebar { left: 0 !important; }
          .mobile-menu-btn { display: none !important; }
          .sidebar-overlay { display: none !important; }
        }
        @media (max-width: 767px) {
          .sidebar { left: ${sidebarOpen ? '0' : '-220px'} !important; transition: left 0.25s ease; }
          .main-content { margin-left: 0 !important; }
        }
      `}</style>
    </div>
  );
}
