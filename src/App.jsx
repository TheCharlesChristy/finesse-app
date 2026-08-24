import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
import { CalendarClock, CalendarDays, CalendarRange, CreditCard, LayoutDashboard, ListOrdered, Menu, PiggyBank, TrendingUp, ShoppingBag, Settings as SettingsIcon, Wallet } from 'lucide-react';

import { db, ensureDefaultAccount, addAccount, updateAccount, deleteAccount, transferMoney,
  getSettings, patchSettings, addCategory, updateCategory, deleteCategory,
  addTransaction, addTransactionsBulk, updateTransaction, deleteTransaction, restoreCategory,
  addWishlistItem, updateWishlistItem, deleteWishlistItem,
  addWishlistCategory, updateWishlistCategory, deleteWishlistCategory, exportData, importData,
  exportSnapshot, exportChatSummary, getExportableSchema,
  exportTransactionsCSV, clearAllData, resetBudget, resetCategory, resetCategoriesForIncome,
  addIncome, updateIncome, deleteIncome, recordIncomeReceived, deleteIncomeEvent,
  addSubscription, updateSubscription, deleteSubscription, processDueSubscriptions,
  addVariable, updateVariable, deleteVariable,
  topUpCategoryFromIncome, borrowBudgetBetweenCategories, resetCategoryTopUps,
  addSplitTransaction, addRule, updateRule, deleteRule,
  addTemplate, deleteTemplate, logTemplate,
  addGoal, updateGoal, deleteGoal, contributeToGoal, autoContributeGoals,
  recalculateSpendCounters,
  stageBudgetConfig, cancelStagedBudgetConfig, applyStagedBudgetConfig, reconcileStagedBudgetConfig,
  undoBudgetConfigApply, getBudgetConfigContext, initEncryption, lockDatabase } from './db';
import { useFinesseData } from './hooks/useFinesseData';
import { describeStagedConfig, isBudgetConfigUndoExpired } from './budgetConfig';
import { buildNudges, calcNextReset, evaluateFormula, filterDismissedNudges, fmt, getGoalCommitment, getIncomeCycleDays, getPacedAllowanceConfig, getPacedAllowanceMonthlyTotal, normalizeIncomeAllocations, encodeSnapshotForUrl, decodeSnapshotFromUrl } from './utils';

const Dashboard      = lazy(() => import('./views/Dashboard'));
const Accounts       = lazy(() => import('./views/Accounts'));
const Activity       = lazy(() => import('./views/Activity'));
const Insights       = lazy(() => import('./views/Insights'));
const GoalsWishlist  = lazy(() => import('./views/GoalsWishlist'));
const SettingsView   = lazy(() => import('./views/Settings'));
const CategoryDetail = lazy(() => import('./views/CategoryDetail'));
import { AddTransactionModal, AddWishlistItemModal, FastForwardModal, ImportModeModal,
  AddOneOffIncomeModal, AddSubscriptionModal, BulkAddExpensesModal,
  AddCategoryModal, AddIncomeModal, EditCategoryModal, EditWishlistListModal,
  AdjustBudgetModal, ExportChatSummaryOptionsModal, ImportStatementModal,
  AddGoalModal, SaveForItemModal, ImportBudgetConfigModal } from './components/modals';
import { Modal } from './components/ui';
import { useDialog } from './components/useDialog';
import { useToast } from './components/Toast';
import QuickAdd from './components/QuickAdd';
import CommandPalette from './components/CommandPalette';
import NudgeCenter from './components/NudgeCenter';
import { notifyNudges } from './notifications';
import { getPersistenceState, requestPersistence, STORAGE_PERSISTED } from './storage';
import { shareCsv, shareJson, SHARE_CANCELLED, SHARE_SHARED } from './share';
import { DEFAULT_LOCK_DELAY_MS, shouldRelock } from './lock';
import LockScreen from './components/LockScreen';

const NAV = [
  { id: 'dashboard', label: 'Dashboard',        Icon: LayoutDashboard },
  { id: 'accounts',  label: 'Accounts',         Icon: Wallet },
  { id: 'activity',  label: 'Activity',         Icon: ListOrdered },
  { id: 'insights',  label: 'Insights',         Icon: TrendingUp },
  { id: 'goals',     label: 'Goals & Wishlist', Icon: PiggyBank },
  { id: 'settings',  label: 'Settings',         Icon: SettingsIcon },
];

/**
 * The pages that became tabs, and where they went.
 *
 * Six nav entries replaced twelve, but the old ids are still the vocabulary the
 * rest of the app navigates in: `buildNudges` returns `view: 'subscriptions'`,
 * the goto keys are muscle memory, and a nudge should land on the tab that
 * answers it rather than the first tab of the page it happens to live on. So
 * `navigate` resolves through here instead of every caller being rewritten.
 */
const VIEW_ALIASES = {
  transactions:  ['activity', 'transactions'],
  calendar:      ['activity', 'calendar'],
  subscriptions: ['activity', 'subscriptions'],
  forecasting:   ['insights', 'outlook'],
  review:        ['insights', 'review'],
  wishlist:      ['goals',    'wishlist'],
  variables:     ['settings', null],
};

/** Which tab a consolidated page opens on when nothing has asked for one. */
const DEFAULT_TABS = {
  activity: 'transactions',
  insights: 'outlook',
  goals:    'goals',
};

/**
 * The tabs, as command-palette destinations.
 *
 * Folding six pages into three shouldn't cost the ability to type
 * "subscriptions" and land on them — the palette searches labels, and these are
 * the labels people know the app by.
 */
const TAB_TARGETS = [
  { id: 'transactions',  label: 'Transactions',  Icon: ListOrdered },
  { id: 'calendar',      label: 'Calendar',      Icon: CalendarDays },
  { id: 'subscriptions', label: 'Subscriptions', Icon: CreditCard },
  { id: 'forecasting',   label: 'Forecasting',   Icon: TrendingUp },
  { id: 'review',        label: 'Looking Back',  Icon: CalendarRange },
  { id: 'wishlist',      label: 'Wishlist',      Icon: ShoppingBag },
];

// "g then <key>" navigation targets. Written in the old vocabulary on purpose —
// VIEW_ALIASES turns "g then s" into the Subscriptions tab of Activity, which is
// what it always meant.
const GOTO_KEYS = {
  d: 'dashboard',
  a: 'accounts',
  t: 'transactions',
  c: 'calendar',
  s: 'subscriptions',
  f: 'forecasting',
  r: 'review',
  g: 'goals',
  w: 'wishlist',
  x: 'settings',
};

const SHORTCUTS = [
  ['A', 'Log an expense'],
  ['B', 'Bulk add expenses'],
  ['⌘K / Ctrl K', 'Command palette'],
  ['/', 'Search transactions'],
  ['G then D', 'Dashboard'],
  ['G then A', 'Accounts'],
  ['G then T', 'Transactions'],
  ['G then C', 'Calendar'],
  ['G then S', 'Subscriptions'],
  ['G then F', 'Forecasting'],
  ['G then R', 'Looking Back'],
  ['G then G', 'Goals'],
  ['G then W', 'Wishlist'],
  ['G then X', 'Settings'],
  ['Esc', 'Close a dialog'],
  ['?', 'This list'],
];

/** The `?action=` a home-screen shortcut launched us with, if any. */
function readLaunchAction() {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('action');
}

/** The snapshot embedded in a share link's hash, if any. */
function readSharedSnapshot() {
  if (typeof window === 'undefined') return null;
  const match = window.location.hash.match(/snapshot=([^&]+)/);
  return match ? decodeSnapshotFromUrl(match[1]) : null;
}

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

/**
 * When an income next resets, as a date rather than "is one overdue".
 * `getLatestDueIncomeReset` answers the auto-reset question; the banner needs
 * the forward-looking one — the day the staged budget actually lands.
 */
function getNextIncomeReset(income, now = new Date()) {
  const freq = income?.resetFrequency || (income?.payDayOfMonth ? 'monthly' : null);
  if (!freq || income.holdActive) return null;

  const base = income.lastPaid ? new Date(income.lastPaid) : now;
  let next = calcNextReset(freq, income.payDayOfMonth, base);
  let guard = 0;
  while (next <= now && guard < 240) {
    next = calcNextReset(freq, income.payDayOfMonth, next);
    guard += 1;
  }
  return next;
}

const RESET_DATE_FORMAT = { day: 'numeric', month: 'long' };

export default function App() {
  const { dialogEl, showConfirm, showAlert, showPrompt } = useDialog();
  const { toastEl, showToast } = useToast();

  // Boot-time URL handling happens in the state initialisers rather than in an
  // effect: the URL is already known on the first render, so reading it there
  // avoids a second render pass and the cascading-render lint rule that flags it.
  const [view, setView] = useState('dashboard');
  // Which tab each consolidated page is showing. One object rather than a state
  // per page, so `navigate` can set any of them without knowing which it is.
  const [viewTabs, setViewTabs] = useState(DEFAULT_TABS);
  const [pendingImport, setPendingImport] = useState(readSharedSnapshot);
  const [budgetConfigContext, setBudgetConfigContext] = useState(null);
  const [modal, setModal] = useState(() => {
    if (readSharedSnapshot()) return 'importMode';
    return readLaunchAction() === 'log-expense' ? 'addTx' : null;
  });
  const [chatSummarySchema, setChatSummarySchema] = useState(null);
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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const pendingGoto = useRef(null);
  const [detailCategoryId, setDetailCategoryId] = useState(null);
  const [editingGoal, setEditingGoal] = useState(null);
  const [savingForItem, setSavingForItem] = useState(null);
  const [selectedAccountId, setActiveAccountId] = useState(() => {
    const stored = Number(localStorage.getItem('finesse.activeAccountId'));
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  });
  // Whether the browser has promised to keep the database. Async, so it can't
  // be derived during render — it starts null ("not yet known"), which the
  // nudge builder treats as "say nothing" rather than "not protected".
  const [storageState, setStorageState] = useState(null);
  const [unlocked, setUnlocked] = useState(false);
  const [obscured, setObscured] = useState(false);
  const hiddenSince = useRef(null);

  const {
    vault, lock, lockChecked, encryptionEnabled,
    accountsQuery, activeAccountId, accounts, accountTransfers, settings, categories, transactions,
    wishlistItems, wishlistCategories, incomeEvents, subscriptions, incomes, variables,
    rules, templates, goals, netWorth,
  } = useFinesseData(selectedAccountId, unlocked);

  // Tells the storage layer where it stands before anything tries to write.
  // Reads are already held back by the gate below, but a write that slipped
  // through ahead of the vault being noticed would land in the clear beside
  // sealed rows — so the middleware is told to refuse rather than trusting the
  // ordering to hold.
  useEffect(() => { initEncryption(); }, []);
  const activeAccount = accounts.find(account => Number(account.id) === Number(activeAccountId)) || null;

  useEffect(() => {
    if (!accountsQuery) return;
    if (accountsQuery.length === 0) ensureDefaultAccount();
  }, [accountsQuery]);

  useEffect(() => {
    if (activeAccountId) localStorage.setItem('finesse.activeAccountId', String(activeAccountId));
  }, [activeAccountId]);

  // Read-only on load. Requesting persistence can prompt in some browsers, so
  // that only ever happens from the button in Settings.
  useEffect(() => {
    let cancelled = false;
    getPersistenceState().then(state => { if (!cancelled) setStorageState(state); });
    return () => { cancelled = true; };
  }, []);

  const handleRequestPersistence = useCallback(async () => {
    const state = await requestPersistence();
    setStorageState(state);
    return state;
  }, []);

  // ── Privacy ──────────────────────────────────────────────────────────────
  // Nothing financial may render before the lock has had its say, or a
  // PIN-protected app flashes its balances for a frame on every launch. That
  // answer comes from `lock`, which is resolved on its own in useFinesseData
  // and stays unknown until it is genuinely known — `settings` cannot be asked,
  // because it reads as "no PIN" for the first few frames of every launch.
  //
  // Two gates that look the same and aren't. A PIN is a screen the app draws
  // over itself; a vault is the only thing that can read the database at all.
  const lockRequired = Boolean(lock?.required);
  const settingsLoaded = accountsQuery !== undefined && settings !== undefined;
  const privacyScreenOn = settings?.privacyScreenEnabled !== false;

  useEffect(() => {
    if (!privacyScreenOn && !lockRequired) return undefined;

    const hide = () => {
      hiddenSince.current = Date.now();
      if (privacyScreenOn) setObscured(true);
    };
    const show = () => {
      setObscured(false);
      // Re-lock only after enough time away: asking for the PIN again because
      // you glanced at a notification is how people turn this off.
      if (lockRequired && shouldRelock(hiddenSince.current, settings?.lockDelayMs ?? DEFAULT_LOCK_DELAY_MS)) {
        setUnlocked(false);
        // The key goes with it. Re-deriving costs a second at the next unlock,
        // which is the price of not leaving it in memory on a phone sitting on
        // a table — the case the timer exists for in the first place.
        if (encryptionEnabled) lockDatabase();
      }
      hiddenSince.current = null;
    };
    const onVisibilityChange = () => (document.visibilityState === 'hidden' ? hide() : show());

    document.addEventListener('visibilitychange', onVisibilityChange);
    // iOS fires pagehide where visibilitychange can be unreliable, and blur
    // catches the app switcher being summoned without a full background.
    window.addEventListener('pagehide', hide);
    window.addEventListener('blur', hide);
    window.addEventListener('focus', show);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('blur', hide);
      window.removeEventListener('focus', show);
    };
  }, [privacyScreenOn, lockRequired, encryptionEnabled, settings?.lockDelayMs]);

  // The action and snapshot have been consumed into state above; scrub them
  // from the URL so a refresh doesn't replay them.
  useEffect(() => {
    if (window.location.search || window.location.hash) {
      history.replaceState(null, '', window.location.pathname);
    }
  }, []);

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

  // Subscriptions are logged automatically when their due date arrives. Say so:
  // money leaving a budget without the user doing anything should never be
  // silent, or a subscription charge looks like a discrepancy.
  useEffect(() => {
    if (!activeAccountId || !subscriptions.length) return;
    processDueSubscriptions(activeAccountId)
      .then(created => {
        if (created > 0) {
          showToast(`Logged ${created} due subscription${created === 1 ? '' : 's'}`, {
            detail: 'Charged automatically to their categories.',
          });
        }
      })
      .catch(error => {
        console.error('Failed to process due subscriptions', error);
      });
  }, [activeAccountId, subscriptions, showToast]);

  // Everything that acts on a reset runs through one queue, in the order it was
  // queued. Two of them touch the staged budget config — the reconcile below
  // clears one already applied, the reset applies one that is due — and running
  // those concurrently would let a reset apply the very config the reconcile is
  // about to establish was already applied.
  const incomeResetQueue = useRef(Promise.resolve());
  const enqueueResetWork = useCallback((run) => {
    incomeResetQueue.current = incomeResetQueue.current
      .catch(() => {})
      .then(run)
      .catch(error => console.error('Reset work failed', error));
    return incomeResetQueue.current;
  }, []);

  // A config that was applied but left sitting in the staged slot would apply a
  // second time at the next reset and duplicate every category it creates. The
  // write that stranded it there is fixed; this clears the ones already
  // stranded. Queued first, so a reset landing on this same load finds the
  // slot already empty rather than applying the ghost.
  useEffect(() => {
    if (!activeAccountId) return;
    enqueueResetWork(async () => {
      const result = await reconcileStagedBudgetConfig(activeAccountId);
      if (!result.cleared) return;
      console.warn('Cleared a staged budget config that had already been applied', result);
      showToast('Removed a duplicate copy of your new budget', {
        detail: 'It had already been applied — it would have applied again at your next reset.',
        severity: 'warn',
      });
    });
  }, [activeAccountId, enqueueResetWork, showToast]);

  /**
   * Land a staged budget config at a reset, and say what happened.
   *
   * Shared by both paths that reset an income — the scheduled one below and
   * the fast-forward handler — because a config that lands on one but not the
   * other is a config that silently never lands at all: fast-forward writes
   * `lastPaid`, so the scheduled path then sees nothing due for that cycle.
   */
  const applyStagedConfigAtReset = useCallback(async (incomeId, due) => {
    const configResult = await applyStagedBudgetConfig(activeAccountId, { incomeId, resetAt: due });

    if (configResult.applied) {
      const count = configResult.plan.categories.length;
      showToast(`New budget applied to ${count} categor${count === 1 ? 'y' : 'ies'}`, {
        detail: 'It can be undone from Settings for the next cycle.',
      });
    } else if (configResult.reason === 'validation-failed' || configResult.reason === 'backup-failed') {
      // Nothing was written. The nudge built from the recorded failure is
      // the durable channel — this toast only catches the user who is
      // looking at the app when it happens.
      console.error('Budget config could not be applied', configResult);
      showToast('Your new budget could not be applied', {
        detail: 'Nothing changed. See Settings for what went wrong.',
      });
    }
    return configResult;
  }, [activeAccountId, showToast]);

  /**
   * Run every income reset that has fallen due.
   *
   * Incomes are re-read here rather than taken from the `incomes` prop, and
   * that is the whole point of the function existing separately from the effect
   * below. Runs are queued rather than allowed to overlap, so a queued run
   * starts after the one before it has written `lastPaid` — and only a fresh
   * read shows it that. Handed the render's array instead, it would see the
   * same incomes still due and reset them a second time.
   */
  const runDueIncomeResets = useCallback(async (accountId) => {
    if (!accountId) return;
    const dueIncomes = await db.incomes.where('accountId').equals(Number(accountId)).toArray();
    const now = new Date();
    let latestReset = null;

    for (const income of dueIncomes) {
      const due = getLatestDueIncomeReset(income, now);
      if (!due) continue;

      const resetAt = due.toISOString();
      await recordIncomeReceived({
        accountId,
        incomeId: income.id,
        name: income.name,
        amount: income.amount,
        date: resetAt,
        type: 'recurring',
      });
      await resetCategoriesForIncome(income.id, resetAt, accountId);

      // A staged budget config lands here and nowhere else: after the old
      // cycle's rollover has settled against the *old* allowances, and before
      // goals draw from the new ones. Applying it any earlier would rewrite
      // the budget the closing cycle was measured against.
      await applyStagedConfigAtReset(income.id, due);

      // After the reset, so a cycle's savings come out of the fresh budget.
      await autoContributeGoals(income.id, accountId, resetAt);
      await updateIncome(income.id, { lastPaid: resetAt, holdActive: false });
      if (!latestReset || due > latestReset) latestReset = due;
    }

    // Patched, not written whole. A read-modify-write of the settings row
    // here would carry a copy of `stagedBudgetConfig` taken before the apply
    // above cleared it, putting the config back — live budget and queued
    // config at the same time, applying again at the next reset.
    if (latestReset) {
      await patchSettings(accountId, { lastReset: latestReset.toISOString() });
    }
  }, [applyStagedConfigAtReset]);

  // Income auto-reset: funded categories reset when their associated income resets.
  //
  // Queued rather than fired straight off, because this effect re-runs on every
  // write to the incomes table — including its own `updateIncome` calls, which
  // land mid-loop when more than one income is due. Overlapping runs used to
  // reach the same reset twice from two directions at once; the run above is
  // written to be safely repeatable, and this keeps the repeats in single file.
  useEffect(() => {
    if (!activeAccountId || !incomes.length) return;
    enqueueResetWork(() => runDueIncomeResets(activeAccountId));
  }, [incomes, activeAccountId, enqueueResetWork, runDueIncomeResets]);

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
    const result = await shareJson({
      data,
      filename: `finance-backup-${new Date().toISOString().slice(0, 10)}.json`,
      title: 'Finesse backup',
      text: 'Finesse backup — keep this somewhere off-device.',
    });

    // A dismissed share sheet means no backup was taken. Recording one anyway
    // would silence the "no backup for N days" nudge on the strength of
    // something the user actively cancelled.
    if (result === SHARE_CANCELLED) return result;

    // Remember it, so "no backup for N days" can be honest about N.
    await patchSettings(activeAccountId, { lastBackupAt: new Date().toISOString() });
    // Receipt photos can't travel in a JSON backup. Saying so is the whole
    // point — a backup you believe is complete is worse than one you know isn't.
    const omitted = data.receiptsOmitted || 0;
    showToast(result === SHARE_SHARED ? 'Backup shared' : 'Backup downloaded', {
      detail: omitted > 0
        ? `${omitted} receipt photo${omitted === 1 ? '' : 's'} not included — images can’t travel in a JSON backup.`
        : result === SHARE_SHARED
          ? 'Keep a copy somewhere other than this device.'
          : 'Saved to your downloads.',
      severity: omitted > 0 ? 'warn' : undefined,
    });
    return result;
  }, [activeAccountId, showToast]);

  const handleExportCSV = useCallback(async () => {
    const csv = await exportTransactionsCSV(activeAccountId);
    return shareCsv({
      csv,
      filename: `transactions-${new Date().toISOString().slice(0, 10)}.csv`,
      title: 'Finesse transactions',
    });
  }, [activeAccountId]);

  const handleOpenExportChatSummary = useCallback(async () => {
    const schema = await getExportableSchema();
    setChatSummarySchema(schema);
    setModal('exportChatSummaryOptions');
  }, []);

  const handleExportChatSummary = useCallback(async (selection) => {
    const data = await exportChatSummary(selection);
    await shareJson({
      data,
      filename: `finesse-chat-summary-${new Date().toISOString().slice(0, 10)}.json`,
      title: 'Finesse summary',
    });
    setModal(null);
  }, []);

  const handleGenerateShareUrl = useCallback(async () => {
    const snapshot = await exportSnapshot();
    const encoded = encodeSnapshotForUrl(snapshot);
    const url = `${window.location.origin}${window.location.pathname}#snapshot=${encoded}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // clipboard access may be unavailable; the prompt below still lets the user copy manually
    }
    await showPrompt(
      'Share this link to load your accounts, categories, incomes, subscriptions and wishlist on another device. It does not include transaction history.\n\nThe link has been copied to your clipboard.',
      { title: 'Share Link', defaultValue: url, confirmText: 'Copy' },
    );
  }, [showPrompt]);

  const handleImport = useCallback((data) => {
    setPendingImport(data);
    setModal('importMode');
  }, []);

  // ── Budget config import ──
  // The modal validates against a snapshot of the account rather than the
  // live props, because the validator needs the whole account (its other
  // accounts included, to check `targetAccountId`) and the views only ever
  // see the active one.
  const handleOpenImportBudgetConfig = useCallback(async () => {
    const context = await getBudgetConfigContext(activeAccountId);
    setBudgetConfigContext(context);
    setModal('importBudgetConfig');
  }, [activeAccountId]);

  const handleStageBudgetConfig = useCallback(async ({ config, plan, fileName }) => {
    const { replaced } = await stageBudgetConfig(activeAccountId, { config, plan, fileName });
    setModal(null);
    setBudgetConfigContext(null);
    const count = plan.categories.length;
    showToast(
      replaced ? 'Staged — this replaces the config you imported earlier' : 'Budget config staged',
      { detail: `${count} categor${count === 1 ? 'y' : 'ies'} will be redefined at your next reset. Nothing has changed yet.` },
    );
  }, [activeAccountId, showToast]);

  const handleCancelStagedBudgetConfig = useCallback(async () => {
    const ok = await showConfirm(
      'Discard the budget config waiting to be applied? Your current budget carries on unchanged.',
      { title: 'Cancel staged budget', confirmText: 'Discard' },
    );
    if (!ok) return;
    await cancelStagedBudgetConfig(activeAccountId);
    showToast('Staged budget discarded');
  }, [activeAccountId, showConfirm, showToast]);

  const handleUndoBudgetConfig = useCallback(async () => {
    const ok = await showConfirm(
      'Put your categories and variables back as they were before the new budget was applied?',
      { title: 'Undo budget config', confirmText: 'Undo' },
    );
    if (!ok) return;

    const result = await undoBudgetConfigApply(activeAccountId);
    if (!result.undone) {
      showToast(result.reason === 'expired'
        ? 'That budget change is more than a cycle old and can no longer be undone'
        : 'There is nothing to undo');
      return;
    }
    showToast('Budget restored', {
      detail: result.keptCategories?.length
        ? `${result.keptCategories.map(c => c.name).join(', ')} kept — ${result.keptCategories.length === 1 ? 'it has' : 'they have'} transactions logged against ${result.keptCategories.length === 1 ? 'it' : 'them'}.`
        : undefined,
    });
  }, [activeAccountId, showConfirm, showToast]);

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

  // Settings sends the fields it changed, not a copy of the row. The row also
  // holds machine-managed state the reset path rewrites on its own schedule —
  // `stagedBudgetConfig`, `lastReset` — and a toggle that wrote back a React
  // snapshot of all of it would undo whatever landed since that render.
  const handleSaveSettings = useCallback(
    (changes) => patchSettings(activeAccountId, changes), [activeAccountId]);

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

  // On the reset queue like the scheduled path, not alongside it: writing
  // `lastPaid` below re-fires the auto-reset effect mid-handler, and the two
  // resetting the same income from either side is exactly what the queue is for.
  const handleIncomeFastForward = useCallback((id, isoDate) => enqueueResetWork(async () => {
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

    // Getting paid early is still getting paid: this is that income's reset for
    // the cycle, so a config staged against it lands here, in the same place in
    // the order as the scheduled path. Without this the fast-forward marks the
    // income paid, the scheduled path then finds nothing due, and the new budget
    // sits staged through the whole cycle it was written for.
    //
    // A config carrying an `applyNotBefore` earlier than this date is refused by
    // `isStagedConfigDue` and stays staged, which is the right answer — the user
    // has fast-forwarded past the date its formulas were written against.
    await applyStagedConfigAtReset(id, new Date(isoDate));

    await autoContributeGoals(id, activeAccountId, isoDate);
    // Keep settings.lastReset current so forecasting burn rates stay accurate
    await patchSettings(activeAccountId, { lastReset: isoDate });
  }), [activeAccountId, applyStagedConfigAtReset, enqueueResetWork]);

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

  const handleBulkAddExpenses = useCallback((rows) => (
    addTransactionsBulk(rows, activeAccountId)
  ), [activeAccountId]);

  const handleImportStatement = useCallback(async (rows, { fileName, reconciliation } = {}) => {
    const ids = await addTransactionsBulk(rows, activeAccountId);
    // The reconciliation result is worth repeating here: the review screen is
    // gone by now, and a balance that disagrees with the statement is the whole
    // reason to have imported one.
    const drift = reconciliation && !reconciliation.matches
      ? ` Account balance is ${fmt(Math.abs(reconciliation.difference))} off your statement.`
      : '';
    showToast(`Imported ${ids.length} transaction${ids.length === 1 ? '' : 's'}`, {
      detail: `${fileName || 'Statement'}.${drift}`,
      severity: drift ? 'warn' : undefined,
    });
    return ids;
  }, [activeAccountId, showToast]);

  const handleDeleteWishlistItem = useCallback(async (id) => {
    const item = wishlistItems.find(entry => Number(entry.id) === Number(id));
    if (!item) return;
    await deleteWishlistItem(id);
    showToast(`Removed ${item.name}`, {
      action: { label: 'Undo', onClick: () => addWishlistItem(item, activeAccountId) },
    });
  }, [wishlistItems, activeAccountId, showToast]);

  const handleEditWishlistItem = useCallback((item) => {
    setEditingWishlistItem(item);
    setModal('editWish');
  }, []);

  const handleEditWishlistList = useCallback((list) => {
    setEditingWishlistList(list);
    setModal('editWishList');
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
  // Reversible deletes get an undo toast instead of a confirm dialog. A modal
  // that interrupts every single delete is worse than one that never appears
  // and an undo that always works — the transaction is restored with its
  // original id, so it's a true restore rather than a lookalike copy.
  const handleDeleteTransaction = useCallback(async (tx) => {
    const cat = categories.find(c => c.id === tx.categoryId);
    const label = tx.note || cat?.name || 'Expense';

    await deleteTransaction(tx.id);
    showToast(`Deleted ${label}`, {
      detail: fmt(tx.amount || 0),
      action: { label: 'Undo', onClick: () => addTransaction(tx) },
    });
  }, [categories, showToast]);

  // A category takes its transactions and subscriptions with it, so this used
  // to be the one delete guarded by a confirm dialog. The snapshot makes it
  // properly reversible instead, which is a better answer than a dialog: the
  // undo restores every row with its original id, and the account balance with
  // it. The count goes in the toast so "and all its transactions" is a number
  // rather than a warning to skim past.
  const handleDeleteCategory = useCallback(async (catId) => {
    const cat = categories.find(c => c.id === catId);
    const snapshot = await deleteCategory(catId);
    if (!snapshot?.category) return;

    const removed = snapshot.transactions.length;
    const subs = snapshot.subscriptions.length;
    const parts = [
      removed > 0 ? `${removed} transaction${removed === 1 ? '' : 's'}` : null,
      subs > 0 ? `${subs} subscription${subs === 1 ? '' : 's'}` : null,
    ].filter(Boolean);

    showToast(`Deleted ${cat?.name || 'category'}`, {
      detail: parts.length ? `${parts.join(' and ')} removed with it.` : 'No transactions were attached.',
      severity: 'warn',
      action: { label: 'Undo', onClick: () => restoreCategory(snapshot) },
    });
  }, [categories, showToast]);

  // ── Variable handlers ────────────────────────────────────────────────────
  const handleAddVariable    = useCallback(v    => addVariable(v, activeAccountId), [activeAccountId]);
  const handleUpdateVariable = useCallback((id, d) => updateVariable(id, d), []);
  const handleDeleteVariable = useCallback(id   => deleteVariable(id), []);

  // Takes either a nav id or one of the old page ids, and lands on the right
  // tab of the right page for both.
  const navigate = useCallback((id, tab) => {
    const [target, aliasTab] = VIEW_ALIASES[id] || [id, null];
    const nextTab = tab || aliasTab;
    setView(target);
    if (nextTab) setViewTabs(current => ({ ...current, [target]: nextTab }));
    setSidebarOpen(false);
  }, []);

  const selectTab = useCallback((viewId, tab) => (
    setViewTabs(current => ({ ...current, [viewId]: tab }))
  ), []);

  // ── Fast capture handlers ────────────────────────────────────────────────
  const handleAddSplit = useCallback((data) => (
    addSplitTransaction({ ...data, accountId: activeAccountId })
  ), [activeAccountId]);

  // ── Goal handlers ────────────────────────────────────────────────────────
  const handleAddGoal = useCallback((goal) => addGoal(goal, activeAccountId), [activeAccountId]);
  const handleEditGoal = useCallback((goal) => { setEditingGoal(goal); setModal('editGoal'); }, []);
  const handleContributeToGoal = useCallback((goalId, amount) => contributeToGoal(goalId, amount), []);

  const handleDeleteGoal = useCallback(async (goal) => {
    const ok = await showConfirm(
      `Delete "${goal.name}"? Money set aside for it goes back to being ordinary spendable budget.`,
      { title: 'Delete Goal', confirmText: 'Delete', danger: true },
    );
    if (ok) await deleteGoal(goal.id);
  }, [showConfirm]);

  const handleSaveForItem = useCallback(async (goal) => {
    await addGoal(goal, activeAccountId);
    showToast(`Saving for ${goal.name}`, { detail: 'Added to Goals.' });
  }, [activeAccountId, showToast]);

  const handleRunWizard = useCallback(async ({ income, categories: packCategories }) => {
    const incomeId = await addIncome(income, activeAccountId);

    // Allocated 100% to the new income, so each category is properly funded and
    // resets with it — the thing a new user would otherwise have to discover.
    for (const category of packCategories) {
      await addCategory({
        name: category.name,
        allowance: category.allowance,
        color: category.color,
        incomeAllocations: [{ incomeId: Number(incomeId), percent: 100 }],
        allowanceFormula: null,
        lastReset: new Date().toISOString(),
      }, activeAccountId);
    }

    showToast('Budget ready', {
      detail: packCategories.length
        ? `${packCategories.length} categories funded from ${income.name}.`
        : `${income.name} added.`,
    });
  }, [activeAccountId, showToast]);

  const handleRecalculateCounters = useCallback(async () => {
    const report = await recalculateSpendCounters(activeAccountId);
    if (report.repaired > 0) {
      showToast(`Repaired ${report.repaired} spend counter${report.repaired === 1 ? '' : 's'}`, { severity: 'warn' });
    }
    return report;
  }, [activeAccountId, showToast]);

  const handleAddRule = useCallback((rule) => addRule(rule, activeAccountId), [activeAccountId]);
  const handleUpdateRule = useCallback((id, data) => updateRule(id, data), []);
  const handleDeleteRule = useCallback((id) => deleteRule(id), []);
  const handleAddTemplate = useCallback((template) => addTemplate(template, activeAccountId), [activeAccountId]);
  const handleDeleteTemplate = useCallback((id) => deleteTemplate(id), []);

  const handleLogTemplate = useCallback(async (templateId) => {
    const template = templates.find(item => Number(item.id) === Number(templateId));
    await logTemplate(templateId, activeAccountId);
    if (template) {
      showToast(`Logged ${template.name}`, { detail: fmt(template.amount) });
    }
  }, [templates, activeAccountId, showToast]);

  const handleAddExpenseOnDate = useCallback((date) => {
    setTransactionDefaults({ date: date instanceof Date ? date.toISOString() : date });
    setModal('addTx');
  }, []);

  const handleRepeatTransaction = useCallback((tx) => {
    // Prefill rather than log outright: the amount is usually right but not
    // always, and a silent duplicate is hard to notice and easy to resent.
    setTransactionDefaults({
      categoryId: tx.categoryId,
      amount: tx.amount,
      note: tx.note,
      tags: tx.tags || [],
    });
    setModal('addTx');
  }, []);

  // ── Keyboard shortcuts ───────────────────────────────────────────────────
  useEffect(() => {
    const isTyping = (target) => (
      target instanceof HTMLElement
      && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
    );

    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(open => !open);
        return;
      }
      // Single-letter shortcuts must never fire while the user is typing, or
      // "a" becomes unusable in every text field in the app.
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (modal) return;

      const key = e.key.toLowerCase();

      // "g then <letter>" jumps to a view, the convention most keyboard-driven
      // apps use. The pending "g" expires so a stray press doesn't linger.
      if (pendingGoto.current) {
        clearTimeout(pendingGoto.current.timer);
        pendingGoto.current = null;
        const target = GOTO_KEYS[key];
        if (target) {
          e.preventDefault();
          navigate(target);
          return;
        }
      }

      if (key === 'g') {
        e.preventDefault();
        pendingGoto.current = { timer: setTimeout(() => { pendingGoto.current = null; }, 1500) };
        return;
      }

      if (key === 'a') { e.preventDefault(); setModal('addTx'); return; }
      if (key === 'b') { e.preventDefault(); setModal('bulkAddTx'); return; }
      if (key === '?') { e.preventDefault(); setModal('shortcuts'); return; }
      if (key === '/') { e.preventDefault(); navigate('transactions'); }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [modal, navigate]);

  // ── Nudges ───────────────────────────────────────────────────────────────
  // ── Staged budget config ──
  const stagedBudgetConfig = settings?.stagedBudgetConfig?.consumedAt
    ? null
    : (settings?.stagedBudgetConfig || null);

  const stagedBudgetSummary = useMemo(
    () => describeStagedConfig(stagedBudgetConfig) || { categoryCount: 0, variableCount: 0, summary: '' },
    [stagedBudgetConfig]);

  // The day the staged budget lands: the next reset of the income its formulas
  // are written against, falling back to the soonest reset of any income.
  const nextBudgetResetLabel = useMemo(() => {
    if (!incomes.length) return null;
    const wantedId = stagedBudgetConfig?.applyIncomeId;
    const target = incomes.find(i => Number(i.id) === Number(wantedId));
    const dates = (target ? [target] : incomes)
      .map(income => getNextIncomeReset(income))
      .filter(Boolean)
      .sort((a, b) => a - b);
    return dates.length ? dates[0].toLocaleDateString('en-GB', RESET_DATE_FORMAT) : null;
  }, [incomes, stagedBudgetConfig?.applyIncomeId]);

  const stagedBudgetLabel = stagedBudgetConfig ? nextBudgetResetLabel : null;

  // An expired undo is not offered at all, rather than offered and refused.
  const budgetConfigUndo = settings?.budgetConfigUndo && !isBudgetConfigUndoExpired(settings.budgetConfigUndo)
    ? settings.budgetConfigUndo
    : null;

  const nudges = useMemo(() => filterDismissedNudges(
    buildNudges({ categories, incomes, subscriptions, goals, transactions, settings, storageState }),
    settings?.dismissedNudges,
  ), [categories, incomes, subscriptions, goals, transactions, settings, storageState]);

  const handleDismissNudge = useCallback(async (nudge) => {
    const current = await getSettings(activeAccountId);
    await patchSettings(activeAccountId, {
      dismissedNudges: { ...(current?.dismissedNudges || {}), [nudge.id]: new Date().toISOString() },
    });
  }, [activeAccountId]);

  const handleNudgeNavigate = useCallback((nudge) => {
    if (nudge.view) navigate(nudge.view);
  }, [navigate]);

  // OS notifications can't wake the app up without a backend, so they fire when
  // it opens or regains focus. The in-app centre remains the primary channel.
  useEffect(() => {
    if (!settings?.notificationsEnabled || nudges.length === 0) return undefined;

    const deliver = async () => {
      if (document.visibilityState !== 'visible') return;
      const result = notifyNudges(nudges, {
        enabled: true,
        alreadyNotified: settings?.notifiedNudges || [],
      });
      // Only written when something was actually sent, so this doesn't churn
      // the settings row on every visibility change.
      if (!result) return;
      await patchSettings(activeAccountId, { notifiedNudges: result.notifiedIds });
    };

    deliver();
    document.addEventListener('visibilitychange', deliver);
    return () => document.removeEventListener('visibilitychange', deliver);
  }, [nudges, settings?.notificationsEnabled, settings?.notifiedNudges, activeAccountId]);

  const paletteCommands = useMemo(() => [
    { id: 'log-expense', label: 'Log an expense', keywords: 'add spend transaction new', run: () => setModal('addTx') },
    { id: 'log-refund', label: 'Log a refund', keywords: 'return money back credit', run: () => setModal('addTx') },
    { id: 'bulk-add', label: 'Bulk add expenses', keywords: 'many multiple paste import', run: () => setModal('bulkAddTx') },
    { id: 'import-statement', label: 'Import a bank statement', keywords: 'csv statement bank import reconcile', run: () => setModal('importStatement') },
    { id: 'one-off-income', label: 'Add one-off income', keywords: 'gift refund bonus paid', run: () => setModal('addOneOffIncome') },
    { id: 'add-income', label: 'Add an income source', keywords: 'salary wage pay', run: () => setModal('addIncome') },
    { id: 'add-category', label: 'Add a budget category', keywords: 'budget allowance', run: () => setModal('addCategory') },
    { id: 'shortcuts', label: 'Show keyboard shortcuts', keywords: 'help keys hotkeys', run: () => setModal('shortcuts') },
    { id: 'add-goal', label: 'Add a savings goal', keywords: 'save sinking fund debt', run: () => setModal('addGoal') },
    { id: 'add-subscription', label: 'Add a subscription', keywords: 'recurring bill netflix', run: () => setModal('addSubscription') },
    { id: 'adjust-budget', label: 'Adjust a budget', keywords: 'top up borrow move money', run: () => handleOpenAdjust(null) },
    ...[...NAV, ...TAB_TARGETS].map(item => ({
      id: `go-${item.id}`,
      label: `Go to ${item.label}`,
      keywords: `view navigate ${item.label}`,
      Icon: item.Icon,
      run: () => navigate(item.id),
    })),
    ...templates.map(template => ({
      id: `template-${template.id}`,
      label: `Log ${template.name}`,
      hint: fmt(template.amount),
      keywords: 'template quick repeat',
      run: () => handleLogTemplate(template.id),
    })),
  ], [navigate, templates, handleLogTemplate, handleOpenAdjust]);

  // All three gates sit below every hook, so the hook order never changes
  // between renders — they swap what is rendered, not what runs.
  //
  // The lock comes before the loading gate deliberately. On an encrypted device
  // nothing can be read until the key is unwrapped, so `settings` stays
  // undefined until the user is through this screen — waiting for it first
  // would spin for ever on the one device that most needs to show a prompt.
  //
  // And the bare background comes before both. Until `lock` has resolved the
  // app does not yet know whether it is allowed to draw anything, so it draws
  // nothing: a spinner here would be honest, but the frame after it is the one
  // that used to leak the dashboard.
  if (!lockChecked) {
    return (
      <div style={{ minHeight: '100vh', position: 'relative' }}>
        <div className="bg-mesh" />
      </div>
    );
  }

  if (lockRequired && !unlocked) {
    return (
      <LockScreen
        settings={lock.pinSettings}
        vault={vault}
        onUnlock={() => setUnlocked(true)}
      />
    );
  }

  if (!settingsLoaded) {
    return (
      <div style={{ minHeight: '100vh', position: 'relative' }}>
        <div className="bg-mesh" />
        <div style={{
          position: 'relative', zIndex: 1, minHeight: '100vh',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
          color: 'var(--text-muted)', fontSize: 14,
        }} aria-busy="true">
          Loading your finances…
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', position: 'relative' }}>
      <div className="bg-mesh" />
      {obscured && <div className="privacy-veil" aria-hidden="true" />}
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
          {/* Scrolls once the list outgrows the viewport. Without this the last
              few items are simply unreachable on a short window — the sidebar is
              fixed to the full height, so overflow has nowhere to go. */}
          <nav aria-label="Primary" style={{
            display: 'flex', flexDirection: 'column', gap: 4,
            flex: 1, minHeight: 0, overflowY: 'auto',
          }}>
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
            <h1 className="font-display" style={{ fontSize: 20, fontWeight: 400, margin: 0, flex: 1, minWidth: 0 }}>
              {view === 'categoryDetail'
                ? (categories.find(c => Number(c.id) === Number(detailCategoryId))?.name || 'Category')
                : NAV.find(n => n.id === view)?.label}
            </h1>
            <NudgeCenter nudges={nudges} onDismiss={handleDismissNudge} onNavigate={handleNudgeNavigate} />
          </div>

          {/* A staged budget changes every allowance on a date the user chose
              days ago. It stays visible on every view until it lands. */}
          {stagedBudgetConfig && (
            <div className="glass" style={{
              borderRadius: 14, padding: '12px 16px', marginBottom: 16,
              display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
              borderLeft: '3px solid var(--accent-blue)',
            }}>
              <CalendarClock size={16} style={{ color: 'var(--accent-blue)', flexShrink: 0 }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  New budget applies on {stagedBudgetLabel}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                  {stagedBudgetSummary.categoryCount} categories, {stagedBudgetSummary.variableCount} variables
                  {stagedBudgetSummary.summary ? ` — ${stagedBudgetSummary.summary}` : ''}.
                  Nothing has changed yet.
                </div>
              </div>
              <button className="btn-secondary" onClick={handleCancelStagedBudgetConfig}
                style={{ fontSize: 12, flexShrink: 0 }}>
                Cancel
              </button>
            </div>
          )}

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
              goalCommitment={getGoalCommitment(goals, incomes, settings)}
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
              onEditTransaction={handleEditTransaction}
              onDeleteTransaction={handleDeleteTransaction}
              onOpenCategory={(id) => { setDetailCategoryId(id); setView('categoryDetail'); }}
              onAdjust={handleOpenAdjust}
              onRunWizard={handleRunWizard}
            />
          )}
          {view === 'categoryDetail' && (
            <CategoryDetail
              category={categories.find(c => Number(c.id) === Number(detailCategoryId)) || null}
              transactions={transactions}
              subscriptions={subscriptions}
              incomes={incomes}
              settings={settings}
              onBack={() => { setView('dashboard'); setDetailCategoryId(null); }}
              onEdit={handleEditCategory}
              onAdjust={handleOpenAdjust}
              onEditTransaction={handleEditTransaction}
              onDeleteTransaction={handleDeleteTransaction}
            />
          )}
          {view === 'goals' && (
            <GoalsWishlist
              tab={viewTabs.goals}
              onTabChange={(tab) => selectTab('goals', tab)}
              goals={goals}
              incomes={incomes}
              onAddGoal={() => setModal('addGoal')}
              onEditGoal={handleEditGoal}
              onDeleteGoal={handleDeleteGoal}
              onContribute={handleContributeToGoal}
              wishlistItems={wishlistItems}
              wishlistCategories={wishlistCategories}
              categories={categories}
              settings={settings}
              onAddItem={() => { setWishlistDefaultCatId(null); setModal('addWish'); }}
              onEditItem={handleEditWishlistItem}
              onDeleteItem={handleDeleteWishlistItem}
              onAddWishlistCat={(data) => addWishlistCategory(data, activeAccountId)}
              onEditWishlistCat={handleEditWishlistList}
              onDeleteWishlistCat={deleteWishlistCategory}
              onAddItemToFolder={(catId) => { setWishlistDefaultCatId(catId); setModal('addWish'); }}
              onSaveForItem={(item) => { setSavingForItem(item); setModal('saveForItem'); }}
              showConfirm={showConfirm}
            />
          )}
          {view === 'accounts' && (
            <Accounts
              accounts={accounts}
              activeAccountId={activeAccountId}
              transfers={accountTransfers}
              incomeEvents={incomeEvents}
              categories={categories}
              onSelectAccount={setActiveAccountId}
              onAddAccount={handleAddAccount}
              onUpdateAccount={handleUpdateAccount}
              onDeleteAccount={handleDeleteAccount}
              onTransfer={handleTransferMoney}
              onDeleteIncomeEvent={handleDeleteIncomeEvent}
            />
          )}
          {view === 'activity' && (
            <Activity
              tab={viewTabs.activity}
              onTabChange={(tab) => selectTab('activity', tab)}
              categories={categories}
              transactions={transactions}
              subscriptions={subscriptions}
              incomes={incomes}
              onDeleteTransaction={handleDeleteTransaction}
              onEditTransaction={handleEditTransaction}
              onAddTransaction={() => setModal('addTx')}
              onRepeatTransaction={handleRepeatTransaction}
              onBulkAdd={() => setModal('bulkAddTx')}
              onImportStatement={() => setModal('importStatement')}
              onAddSubscription={() => setModal('addSubscription')}
              onEditSubscription={handleEditSubscription}
              onDeleteSubscription={handleDeleteSubscription}
              onToggleSubscription={handleToggleSubscription}
              onAddExpenseOn={handleAddExpenseOnDate}
            />
          )}
          {view === 'insights' && (
            <Insights
              tab={viewTabs.insights}
              onTabChange={(tab) => selectTab('insights', tab)}
              categories={categories}
              settings={settings}
              transactions={transactions}
              incomes={incomes}
              incomeEvents={incomeEvents}
              transfers={accountTransfers}
              subscriptions={subscriptions}
              account={activeAccount}
              netWorth={netWorth}
              accountCount={accounts.length}
            />
          )}
          {view === 'settings' && (
            <SettingsView onExport={handleExport} onExportCSV={handleExportCSV}
              onImport={handleImport} onResetBudget={() => resetBudget(activeAccountId)}
              onGenerateShareUrl={handleGenerateShareUrl} onOpenExportChatSummary={handleOpenExportChatSummary}
              categories={categories} settings={settings} onSaveSettings={handleSaveSettings}
              incomes={incomes} onResetIncome={(incomeId) => resetCategoriesForIncome(incomeId, undefined, activeAccountId)}
              onFullReset={handleFullReset}
              variables={variables} onAddVariable={handleAddVariable}
              onUpdateVariable={handleUpdateVariable} onDeleteVariable={handleDeleteVariable}
              rules={rules} onAddRule={handleAddRule} onUpdateRule={handleUpdateRule} onDeleteRule={handleDeleteRule}
              templates={templates} onAddTemplate={handleAddTemplate} onDeleteTemplate={handleDeleteTemplate}
              nudgeCount={nudges.length}
              onRecalculate={handleRecalculateCounters}
              storageState={storageState}
              onRequestPersistence={handleRequestPersistence}
              onImportStatement={() => setModal('importStatement')}
              onImportBudgetConfig={handleOpenImportBudgetConfig}
              stagedBudgetConfig={stagedBudgetConfig}
              stagedBudgetLabel={stagedBudgetLabel}
              budgetConfigUndo={budgetConfigUndo}
              onCancelStagedBudgetConfig={handleCancelStagedBudgetConfig}
              onUndoBudgetConfig={handleUndoBudgetConfig}
              onVaultUnlocked={() => setUnlocked(true)}
              onPinSet={() => setUnlocked(true)}
              encryptionEnabled={encryptionEnabled}
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
        <AddOneOffIncomeModal onAdd={handleAddOneOffIncome} onClose={() => setModal(null)} categories={categories} />
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
          transactions={transactions}
          rules={rules}
          onAdd={(data) => addTransaction({ ...data, accountId: activeAccountId })}
          onAddSplit={handleAddSplit}
          initial={transactionDefaults}
          defaultCategoryId={settings?.defaultCategoryId}
          onClose={() => { setModal(null); setTransactionDefaults(null); }}
        />
      )}
      {modal === 'bulkAddTx' && categories.length > 0 && (
        <BulkAddExpensesModal
          categories={categories}
          transactions={transactions}
          rules={rules}
          defaultCategoryId={settings?.defaultCategoryId}
          onAdd={handleBulkAddExpenses}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'editTx' && editingTransaction && categories.length > 0 && (
        <AddTransactionModal
          categories={categories}
          transactions={transactions}
          rules={rules}
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
      {modal === 'importStatement' && (
        <ImportStatementModal
          categories={categories}
          transactions={transactions}
          rules={rules}
          account={activeAccount}
          defaultCategoryId={settings?.defaultCategoryId}
          onImport={handleImportStatement}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'importBudgetConfig' && budgetConfigContext && (
        <ImportBudgetConfigModal
          context={budgetConfigContext}
          stagedConfig={stagedBudgetConfig}
          nextResetLabel={stagedBudgetLabel || nextBudgetResetLabel}
          onStage={handleStageBudgetConfig}
          onClose={() => { setModal(null); setBudgetConfigContext(null); }}
        />
      )}
      {modal === 'importMode' && (
        <ImportModeModal onConfirm={handleImportConfirm}
          onClose={() => { setPendingImport(null); setModal(null); }} />
      )}
      {modal === 'exportChatSummaryOptions' && chatSummarySchema && (
        <ExportChatSummaryOptionsModal schema={chatSummarySchema} onConfirm={handleExportChatSummary}
          onClose={() => setModal(null)} />
      )}
      {modal === 'shortcuts' && (
        <Modal title="Keyboard shortcuts" onClose={() => setModal(null)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {SHORTCUTS.map(([keys, description]) => (
              <div key={keys} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 12px', borderRadius: 9, background: 'rgba(255,255,255,0.04)' }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{description}</span>
                <kbd style={{ fontSize: 11, padding: '3px 8px', borderRadius: 6, background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
                  {keys}
                </kbd>
              </div>
            ))}
          </div>
          <div className="modal-actions" style={{ display: 'flex', marginTop: 18 }}>
            <button className="btn-primary" onClick={() => setModal(null)} style={{ flex: 1 }}>Got it</button>
          </div>
        </Modal>
      )}
      {modal === 'addGoal' && (
        <AddGoalModal incomes={incomes} onAdd={handleAddGoal} onClose={() => setModal(null)} />
      )}
      {modal === 'editGoal' && editingGoal && (
        <AddGoalModal
          goal={editingGoal}
          incomes={incomes}
          onSave={(id, data) => { updateGoal(id, data); setModal(null); setEditingGoal(null); }}
          onClose={() => { setModal(null); setEditingGoal(null); }}
        />
      )}
      {modal === 'saveForItem' && savingForItem && (
        <SaveForItemModal
          item={savingForItem}
          incomes={incomes}
          onConfirm={handleSaveForItem}
          onClose={() => { setModal(null); setSavingForItem(null); }}
        />
      )}
      {modal === 'adjust' && categories.length > 0 && (
        <AdjustBudgetModal
          categories={categories}
          incomes={incomes}
          defaultCategoryId={adjustCategoryId}
          onTopUpFromIncome={handleTopUpFromIncome}
          onBorrowFromCategory={handleBorrowFromCategory}
          onResetTopUps={handleResetTopUps}
          onClose={() => { setModal(null); setAdjustCategoryId(null); }}
        />
      )}
      {categories.length > 0 && (
        <QuickAdd
          onClick={() => setModal('addTx')}
          templates={templates}
          onLogTemplate={handleLogTemplate}
        />
      )}

      {paletteOpen && (
      <CommandPalette
        onClose={() => setPaletteOpen(false)}
        commands={paletteCommands}
        transactions={transactions}
        categories={categories}
        onPickTransaction={handleEditTransaction}
      />
      )}

      {dialogEl}
      {toastEl}

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
