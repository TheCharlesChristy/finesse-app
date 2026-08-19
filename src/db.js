import Dexie from 'dexie';
import { startOfDay } from 'date-fns';
import { getNextRecurringDate, normalizeIncomeAllocations, roundMoney, getEffectiveAllowance,
  getCategorySpare, buildMonthlyHistory, projectedEndBalance, getUpcomingSubscriptionCost,
  getCategoryCycle, getNormalisedIncomeTotal, getSignedAmount, getRolloverForNextCycle,
  getIncomeCycleAverageDays,
  TX_EXPENSE, TX_REFUND,
  wishlistAffordability } from './utils';
import { buildBudgetConfigPlan, isStagedConfigDue, isBudgetConfigUndoExpired } from './budgetConfig';

export const db = new Dexie('FinanceApp');

db.version(1).stores({
  settings: '++id',
  categories: '++id, name',
  transactions: '++id, categoryId, date',
  wishlist: '++id, name',
  wishlistCategories: '++id, name',
});

db.version(2).stores({
  settings: '++id',
  categories: '++id, name',
  transactions: '++id, categoryId, date',
  wishlist: '++id, name',
  wishlistCategories: '++id, name',
  incomes: '++id, name',
});

db.version(3).stores({
  settings: '++id',
  categories: '++id, name',
  transactions: '++id, categoryId, date',
  wishlist: '++id, name',
  wishlistCategories: '++id, name',
  incomes: '++id, name',
  variables: '++id, name',
});

db.version(4).stores({
  settings: '++id',
  categories: '++id, name',
  transactions: '++id, categoryId, date',
  wishlist: '++id, name',
  wishlistCategories: '++id, name',
  incomes: '++id, name',
  variables: '++id, name',
}).upgrade(async tx => {
  const categories = await tx.table('categories').toArray();
  for (const cat of categories) {
    if (cat.spentByIncome) continue;
    await tx.table('categories').update(cat.id, {
      spentByIncome: allocateAmountByIncome(cat, cat.spent || 0),
      incomeResetAt: cat.incomeResetAt || {},
    });
  }
});

db.version(5).stores({
  accounts: '++id, name',
  accountTransfers: '++id, fromAccountId, toAccountId, date',
  settings: '++id, accountId',
  categories: '++id, accountId, name',
  transactions: '++id, accountId, categoryId, date',
  wishlist: '++id, accountId, name',
  wishlistCategories: '++id, accountId, name',
  incomes: '++id, accountId, name',
  variables: '++id, accountId, name',
}).upgrade(async tx => {
  const now = new Date().toISOString();
  const accountId = await tx.table('accounts').add({
    name: 'Main Account',
    balance: 0,
    color: '#4fffb0',
    createdAt: now,
  });

  for (const tableName of ['settings', 'categories', 'transactions', 'wishlist', 'wishlistCategories', 'incomes', 'variables']) {
    const table = tx.table(tableName);
    const records = await table.toArray();
    for (const record of records) {
      if (record.accountId == null) {
        await table.update(record.id, { accountId });
      }
    }
  }
});

db.version(6).stores({
  accounts: '++id, name',
  accountTransfers: '++id, fromAccountId, toAccountId, date',
  incomeEvents: '++id, accountId, incomeId, date, &receiptKey',
  settings: '++id, accountId',
  categories: '++id, accountId, name',
  transactions: '++id, accountId, categoryId, date',
  wishlist: '++id, accountId, name',
  wishlistCategories: '++id, accountId, name',
  incomes: '++id, accountId, name',
  variables: '++id, accountId, name',
});

db.version(7).stores({
  accounts: '++id, name',
  accountTransfers: '++id, fromAccountId, toAccountId, date',
  incomeEvents: '++id, accountId, incomeId, date, &receiptKey',
  settings: '++id, accountId',
  categories: '++id, accountId, name',
  transactions: '++id, accountId, categoryId, date, &subscriptionRunKey',
  wishlist: '++id, accountId, name',
  wishlistCategories: '++id, accountId, name',
  incomes: '++id, accountId, name',
  subscriptions: '++id, accountId, categoryId, nextDueAt, active',
  variables: '++id, accountId, name',
});

// v8 adds fast-capture tables and a multi-entry index on transaction tags.
// Purely additive — no upgrade function is needed, since Dexie stores arbitrary
// fields and every new column is optional on existing rows.
db.version(8).stores({
  accounts: '++id, name',
  accountTransfers: '++id, fromAccountId, toAccountId, date',
  incomeEvents: '++id, accountId, incomeId, date, &receiptKey',
  settings: '++id, accountId',
  categories: '++id, accountId, name',
  transactions: '++id, accountId, categoryId, date, &subscriptionRunKey, *tags',
  wishlist: '++id, accountId, name',
  wishlistCategories: '++id, accountId, name',
  incomes: '++id, accountId, name',
  subscriptions: '++id, accountId, categoryId, nextDueAt, active',
  variables: '++id, accountId, name',
  rules: '++id, accountId, priority',
  templates: '++id, accountId, name',
  goals: '++id, accountId, name',
});

const ACCOUNT_COLORS = ['#4fffb0', '#5db8ff', '#c084fc', '#fbbf70', '#ff6b8a', '#67e8f9'];


// ── Spend bucket helpers ────────────────────────────────────────────────────
function toSpendMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, amount]) => [String(key), roundMoney(amount)])
      .filter(([, amount]) => amount > 0)
  );
}

function sumSpendMap(map) {
  return roundMoney(Object.values(map).reduce((sum, amount) => sum + (Number(amount) || 0), 0));
}

function cleanupSpendMap(map) {
  return Object.fromEntries(
    Object.entries(map)
      .map(([key, amount]) => [String(key), roundMoney(amount)])
      .filter(([, amount]) => amount > 0.004)
  );
}

function allocateAmountByIncome(category, amount) {
  const totalAmount = roundMoney(amount);
  if (totalAmount <= 0) return {};

  const allocations = normalizeIncomeAllocations(category?.incomeAllocations);
  if (!allocations.length) return {};

  const buckets = {};
  let allocated = 0;

  for (const allocation of allocations) {
    const key = String(allocation.incomeId);
    buckets[key] = roundMoney(totalAmount * allocation.percent / 100);
    allocated = roundMoney(allocated + buckets[key]);
  }

  const percentTotal = roundMoney(allocations.reduce((sum, allocation) => sum + allocation.percent, 0));
  const remainder = roundMoney(totalAmount - allocated);
  if (Math.abs(percentTotal - 100) <= 0.01 && Math.abs(remainder) >= 0.01) {
    const target = allocations[allocations.length - 1];
    const key = String(target.incomeId);
    buckets[key] = roundMoney((buckets[key] || 0) + remainder);
  }

  return cleanupSpendMap(buckets);
}

function getCategorySpendBuckets(category) {
  const existing = toSpendMap(category?.spentByIncome);
  if (Object.keys(existing).length > 0) return existing;
  return allocateAmountByIncome(category, category?.spent || 0);
}

function addSpendToBuckets(category, amount) {
  const buckets = getCategorySpendBuckets(category);
  const additions = allocateAmountByIncome(category, amount);
  for (const [incomeId, value] of Object.entries(additions)) {
    buckets[incomeId] = roundMoney((buckets[incomeId] || 0) + value);
  }
  return cleanupSpendMap(buckets);
}

function subtractSpendFromBuckets(category, amount) {
  const buckets = getCategorySpendBuckets(category);
  const bucketTotal = sumSpendMap(buckets);
  const subtraction = roundMoney(amount);
  if (subtraction <= 0 || bucketTotal <= 0) return buckets;

  let removed = 0;
  const entries = Object.entries(buckets);
  const next = {};

  entries.forEach(([incomeId, value], index) => {
    const share = index === entries.length - 1
      ? roundMoney(subtraction - removed)
      : roundMoney(subtraction * value / bucketTotal);
    removed = roundMoney(removed + share);
    next[incomeId] = Math.max(0, roundMoney(value - share));
  });

  return cleanupSpendMap(next);
}

function applyCategorySpendDelta(category, delta) {
  const currentSpent = roundMoney(category?.spent || 0);
  const nextSpent = Math.max(0, roundMoney(currentSpent + delta));
  const spentByIncome = delta >= 0
    ? addSpendToBuckets(category, delta)
    : subtractSpendFromBuckets(category, Math.abs(delta));

  return {
    spent: nextSpent,
    spentByIncome: nextSpent === 0 ? {} : spentByIncome,
  };
}

function stripId(record) {
  const { id, ...rest } = record;
  return rest;
}

function withAccountId(data, accountId) {
  if (accountId == null) return data;
  return { ...data, accountId: Number(accountId) };
}

function normalizeUrl(value = '') {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

async function getDefaultAccountId() {
  const account = await ensureDefaultAccount();
  return account?.id ?? null;
}

// ── Account helpers ─────────────────────────────────────────────────────────
export async function ensureDefaultAccount() {
  const existing = await db.accounts.orderBy('id').first();
  if (existing) return existing;

  const id = await db.accounts.add({
    name: 'Main Account',
    balance: 0,
    color: ACCOUNT_COLORS[0],
    createdAt: new Date().toISOString(),
  });
  return db.accounts.get(id);
}

export async function addAccount(account) {
  const count = await db.accounts.count();
  return db.accounts.add({
    name: account.name?.trim() || `Account ${count + 1}`,
    balance: roundMoney(account.balance || 0),
    color: account.color || ACCOUNT_COLORS[count % ACCOUNT_COLORS.length],
    createdAt: new Date().toISOString(),
  });
}

export async function updateAccount(id, data) {
  const next = { ...data };
  if (Object.prototype.hasOwnProperty.call(next, 'balance')) {
    next.balance = roundMoney(next.balance);
  }
  return db.accounts.update(id, next);
}

export async function deleteAccount(id) {
  const accountCount = await db.accounts.count();
  if (accountCount <= 1) return 0;

  await db.transaction('rw',
    db.accounts,
    db.accountTransfers,
    db.incomeEvents,
    db.settings,
    db.categories,
    db.transactions,
    db.wishlist,
    db.wishlistCategories,
    db.incomes,
    db.subscriptions,
    db.variables,
    db.rules,
    db.templates,
    db.goals,
    async () => {
      await db.accountTransfers
        .where('fromAccountId').equals(id)
        .or('toAccountId').equals(id)
        .delete();
      await db.incomeEvents.where('accountId').equals(id).delete();
      await db.settings.where('accountId').equals(id).delete();
      await db.transactions.where('accountId').equals(id).delete();
      await db.categories.where('accountId').equals(id).delete();
      await db.wishlist.where('accountId').equals(id).delete();
      await db.wishlistCategories.where('accountId').equals(id).delete();
      await db.incomes.where('accountId').equals(id).delete();
      await db.subscriptions.where('accountId').equals(id).delete();
      await db.variables.where('accountId').equals(id).delete();
      await db.rules.where('accountId').equals(id).delete();
      await db.templates.where('accountId').equals(id).delete();
      await db.goals.where('accountId').equals(id).delete();
      await db.accounts.delete(id);
    }
  );

  return 1;
}

export async function transferMoney({ fromAccountId, toAccountId, amount, note = '', date = new Date().toISOString() }) {
  const fromId = Number(fromAccountId);
  const toId = Number(toAccountId);
  const transferAmount = roundMoney(amount);

  if (!fromId || !toId || fromId === toId || transferAmount <= 0) return 0;

  let id;
  await db.transaction('rw', db.accounts, db.accountTransfers, async () => {
    const [fromAccount, toAccount] = await Promise.all([
      db.accounts.get(fromId),
      db.accounts.get(toId),
    ]);
    if (!fromAccount || !toAccount) return;

    await db.accounts.update(fromId, {
      balance: roundMoney((fromAccount.balance || 0) - transferAmount),
    });
    await db.accounts.update(toId, {
      balance: roundMoney((toAccount.balance || 0) + transferAmount),
    });
    id = await db.accountTransfers.add({
      fromAccountId: fromId,
      toAccountId: toId,
      amount: transferAmount,
      note: note.trim(),
      date,
    });
  });

  return id || 0;
}

// ── Settings helpers ─────────────────────────────────────────────────────────
export async function getSettings(accountId = null) {
  const id = accountId ?? await getDefaultAccountId();
  if (id == null) return null;
  const all = await db.settings.where('accountId').equals(Number(id)).toArray();
  return all[0] || null;
}

export async function saveSettings(data, accountId = null) {
  const id = accountId ?? data.accountId ?? await getDefaultAccountId();
  if (id == null) return null;
  const payload = withAccountId(data, id);
  const existing = await db.settings.where('accountId').equals(Number(id)).toArray();
  if (existing.length > 0) {
    await db.settings.update(existing[0].id, payload);
    return existing[0].id;
  } else {
    return db.settings.add(payload);
  }
}

// ── Category helpers ─────────────────────────────────────────────────────────
export async function getCategories(accountId = null) {
  if (accountId == null) return db.categories.toArray();
  return db.categories.where('accountId').equals(Number(accountId)).toArray();
}

export async function addCategory(cat, accountId = null) {
  return db.categories.add({ ...withAccountId(cat, accountId ?? cat.accountId), spent: 0, spentByIncome: {}, incomeResetAt: {}, temporaryBoost: 0, boostSources: [] });
}

export async function updateCategory(id, data) {
  const existing = await db.categories.get(id);
  if (!existing) return 0;

  const nextData = { ...data };
  if (Object.prototype.hasOwnProperty.call(data, 'incomeAllocations')) {
    nextData.spentByIncome = allocateAmountByIncome(
      { ...existing, ...data },
      existing.spent || 0
    );
  }

  return db.categories.update(id, nextData);
}

/**
 * Delete a category, its transactions and its subscriptions.
 *
 * Returns everything it removed, with ids intact, so `restoreCategory` can put
 * it back exactly — this is the most destructive single action in the app, and
 * an undo that restores a lookalike copy would be worse than none at all.
 * Callers that don't want the snapshot can simply ignore the return value.
 */
export async function deleteCategory(id) {
  const snapshot = { category: null, transactions: [], subscriptions: [] };

  await db.transaction('rw', db.categories, db.transactions, db.accounts, db.subscriptions, async () => {
    const transactions = await db.transactions.where('categoryId').equals(id).toArray();
    snapshot.category = await db.categories.get(id);
    snapshot.transactions = transactions;
    snapshot.subscriptions = await db.subscriptions.where('categoryId').equals(id).toArray();
    // Signed, so deleting a category that contains refunds doesn't credit the
    // account for money that was never spent.
    const refundByAccount = transactions.reduce((acc, tx) => {
      if (tx.accountId == null) return acc;
      const key = Number(tx.accountId);
      acc[key] = roundMoney((acc[key] || 0) + getSignedAmount(tx));
      return acc;
    }, {});

    for (const [accountId, amount] of Object.entries(refundByAccount)) {
      const account = await db.accounts.get(Number(accountId));
      if (account) {
        await db.accounts.update(Number(accountId), {
          balance: roundMoney((account.balance || 0) + amount),
        });
      }
    }

    await db.transactions.where('categoryId').equals(id).delete();
    await db.subscriptions.where('categoryId').equals(id).delete();
    await db.categories.delete(id);
  });

  return snapshot;
}

/**
 * Put back what `deleteCategory` removed.
 *
 * The account correction is recomputed from the restored transactions rather
 * than stored alongside them, so it is always the exact inverse of what the
 * delete applied — one signed sum, one sign flip, no second source of truth to
 * drift. `spent` rides along on the category row untouched, since the
 * transactions going back are precisely the ones it already counted.
 *
 * Safe to call twice: `put` is idempotent on a fixed id, and the balance is
 * only adjusted when the category was actually missing.
 */
export async function restoreCategory(snapshot) {
  const { category, transactions = [], subscriptions = [] } = snapshot || {};
  if (!category?.id) return 0;

  await db.transaction('rw', db.categories, db.transactions, db.accounts, db.subscriptions, async () => {
    const alreadyPresent = await db.categories.get(category.id);

    await db.categories.put(category);
    if (transactions.length) await db.transactions.bulkPut(transactions);
    if (subscriptions.length) await db.subscriptions.bulkPut(subscriptions);
    if (alreadyPresent) return;

    const deltaByAccount = transactions.reduce((acc, tx) => {
      if (tx.accountId == null) return acc;
      const key = Number(tx.accountId);
      acc[key] = roundMoney((acc[key] || 0) + getSignedAmount(tx));
      return acc;
    }, {});

    for (const [accountId, amount] of Object.entries(deltaByAccount)) {
      const account = await db.accounts.get(Number(accountId));
      if (account) {
        await db.accounts.update(Number(accountId), {
          balance: roundMoney((account.balance || 0) - amount),
        });
      }
    }
  });

  return category.id;
}

// ── Transaction helpers ──────────────────────────────────────────────────────
export async function getTransactions(accountId = null) {
  if (accountId == null) return db.transactions.orderBy('date').reverse().toArray();
  const rows = await db.transactions.where('accountId').equals(Number(accountId)).toArray();
  return rows.sort((a, b) => new Date(b.date) - new Date(a.date));
}

export async function addTransaction(tx) {
  const accountId = tx.accountId != null ? Number(tx.accountId) : await getDefaultAccountId();
  const signed = getSignedAmount(tx);
  let id;
  await db.transaction('rw', db.transactions, db.categories, db.accounts, async () => {
    id = await db.transactions.add({ ...tx, accountId, date: tx.date || new Date().toISOString() });
    const cat = await db.categories.get(tx.categoryId);
    if (cat) {
      await db.categories.update(tx.categoryId, applyCategorySpendDelta(cat, signed));
    }
    const account = await db.accounts.get(accountId);
    if (account) {
      await db.accounts.update(accountId, {
        balance: roundMoney((account.balance || 0) - signed),
      });
    }
  });
  return id;
}

/**
 * One purchase split across several categories.
 *
 * Written as N ordinary transactions sharing a `splitGroupId`, rather than a
 * parent row with children: every existing query, filter, total and reset then
 * treats the parts correctly with no special-casing, and a single part can be
 * edited or deleted on its own.
 */
export async function addSplitTransaction({ accountId = null, parts = [], note = '', date = null, merchant = '', tags = [], type = TX_EXPENSE } = {}) {
  const targetAccountId = accountId != null ? Number(accountId) : await getDefaultAccountId();
  const cleanParts = parts
    .map(part => ({ categoryId: Number(part.categoryId), amount: roundMoney(part.amount), note: String(part.note || note || '').trim() }))
    .filter(part => part.categoryId && part.amount > 0);

  if (!targetAccountId || cleanParts.length === 0) return [];

  const splitGroupId = `split-${targetAccountId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const when = date || new Date().toISOString();
  const ids = [];

  for (const part of cleanParts) {
    ids.push(await addTransaction({
      accountId: targetAccountId,
      categoryId: part.categoryId,
      amount: part.amount,
      note: part.note,
      date: when,
      merchant: String(merchant || '').trim(),
      tags,
      type,
      splitGroupId,
    }));
  }

  return ids;
}

/**
 * Add many transactions at once, each with its own category.
 *
 * Accepts a plain array of rows. The legacy `{ categoryId, transactions }`
 * shape — one category for the whole batch — is still honoured, since pasting
 * a statement into one category remains a normal thing to do.
 *
 * Category and account totals are accumulated first and written once per
 * category, so a 200-row paste is a handful of writes rather than 400.
 */
export async function addTransactionsBulk(input = {}, maybeAccountId = null) {
  const isArray = Array.isArray(input);
  const accountId = isArray ? maybeAccountId : input.accountId;
  const targetAccountId = accountId != null ? Number(accountId) : await getDefaultAccountId();
  if (!targetAccountId) return [];

  const fallbackCategoryId = isArray ? null : Number(input.categoryId) || null;
  const source = isArray ? input : (input.transactions || []);

  const rows = source
    .map(tx => ({
      accountId: targetAccountId,
      categoryId: Number(tx.categoryId ?? fallbackCategoryId),
      amount: Math.abs(roundMoney(tx.amount)),
      note: String(tx.note || '').trim(),
      merchant: String(tx.merchant || tx.note || '').trim(),
      type: tx.type === TX_REFUND ? TX_REFUND : TX_EXPENSE,
      date: tx.date || new Date().toISOString(),
    }))
    .filter(tx => tx.amount > 0 && Number.isFinite(tx.categoryId) && tx.categoryId > 0);

  if (!rows.length) return [];

  const deltaByCategory = new Map();
  let accountDelta = 0;
  for (const row of rows) {
    const signed = getSignedAmount(row);
    deltaByCategory.set(row.categoryId, roundMoney((deltaByCategory.get(row.categoryId) || 0) + signed));
    accountDelta = roundMoney(accountDelta + signed);
  }

  let ids = [];
  await db.transaction('rw', db.transactions, db.categories, db.accounts, async () => {
    ids = await db.transactions.bulkAdd(rows, { allKeys: true });

    for (const [categoryId, delta] of deltaByCategory) {
      const cat = await db.categories.get(categoryId);
      if (cat) await db.categories.update(categoryId, applyCategorySpendDelta(cat, delta));
    }

    const account = await db.accounts.get(targetAccountId);
    if (account) {
      await db.accounts.update(targetAccountId, {
        balance: roundMoney((account.balance || 0) - accountDelta),
      });
    }
  });

  return ids;
}

export async function updateTransaction(id, data) {
  const existing = await db.transactions.get(id);
  if (!existing) return 0;

  const nextCategoryId = Number(data.categoryId ?? existing.categoryId);
  const previousCategoryId = Number(existing.categoryId);
  // Signed, so switching an expense to a refund (or back) reverses the effect
  // on both the spend counter and the account balance in one step.
  const nextAmount = getSignedAmount({ ...existing, ...data });
  const previousAmount = getSignedAmount(existing);

  await db.transaction('rw', db.transactions, db.categories, db.accounts, async () => {
    if (previousCategoryId === nextCategoryId) {
      const diff = nextAmount - previousAmount;
      if (diff !== 0) {
        const cat = await db.categories.get(previousCategoryId);
        if (cat) {
          await db.categories.update(previousCategoryId, applyCategorySpendDelta(cat, diff));
        }
      }
    } else {
      const oldCat = await db.categories.get(previousCategoryId);
      if (oldCat) {
        await db.categories.update(previousCategoryId, applyCategorySpendDelta(oldCat, -previousAmount));
      }

      const newCat = await db.categories.get(nextCategoryId);
      if (newCat) {
        await db.categories.update(nextCategoryId, applyCategorySpendDelta(newCat, nextAmount));
      }
    }

    // `amount` is always stored positive; `type` carries the direction. Only
    // the deltas above are signed.
    await db.transactions.update(id, {
      ...data,
      categoryId: nextCategoryId,
      amount: Math.abs(roundMoney(data.amount ?? existing.amount)),
    });

    const accountId = Number(existing.accountId);
    const account = await db.accounts.get(accountId);
    if (account) {
      await db.accounts.update(accountId, {
        balance: roundMoney((account.balance || 0) - (nextAmount - previousAmount)),
      });
    }
  });

  return 1;
}

export async function deleteTransaction(id) {
  await db.transaction('rw', db.transactions, db.categories, db.accounts, async () => {
    const tx = await db.transactions.get(id);
    if (tx) {
      const signed = getSignedAmount(tx);
      const cat = await db.categories.get(tx.categoryId);
      if (cat) {
        await db.categories.update(tx.categoryId, applyCategorySpendDelta(cat, -signed));
      }
      const account = await db.accounts.get(tx.accountId);
      if (account) {
        await db.accounts.update(tx.accountId, {
          balance: roundMoney((account.balance || 0) + signed),
        });
      }
    }
    await db.transactions.delete(id);
  });
}

// ── Wishlist helpers ─────────────────────────────────────────────────────────
export async function getWishlistItems(accountId = null) {
  if (accountId == null) return db.wishlist.toArray();
  return db.wishlist.where('accountId').equals(Number(accountId)).toArray();
}

export async function addWishlistItem(item, accountId = null) {
  return db.wishlist.add(withAccountId(item, accountId ?? item.accountId));
}

export async function updateWishlistItem(id, data) {
  return db.wishlist.update(id, data);
}

export async function deleteWishlistItem(id) {
  return db.wishlist.delete(id);
}

export async function getWishlistCategories(accountId = null) {
  if (accountId == null) return db.wishlistCategories.toArray();
  return db.wishlistCategories.where('accountId').equals(Number(accountId)).toArray();
}

export async function addWishlistCategory(cat, accountId = null) {
  return db.wishlistCategories.add(withAccountId(cat, accountId ?? cat.accountId));
}

export async function updateWishlistCategory(id, data) {
  return db.wishlistCategories.update(id, data);
}

export async function deleteWishlistCategory(id) {
  const target = await db.wishlistCategories.get(id);
  const promoteTo = target?.parentId ?? null;
  // Promote direct sub-lists to the deleted list's parent level
  const allCats = await db.wishlistCategories.toArray();
  for (const child of allCats.filter(c => c.parentId === id)) {
    await db.wishlistCategories.update(child.id, { parentId: promoteTo });
  }
  // Uncategorise items that were in this list
  const allItems = await db.wishlist.toArray();
  for (const item of allItems.filter(i => i.wishlistCategoryId === id)) {
    await db.wishlist.update(item.id, { wishlistCategoryId: null });
  }
  return db.wishlistCategories.delete(id);
}

// ── Income helpers ────────────────────────────────────────────────────────────
export async function addIncome(income, accountId = null) {
  return db.incomes.add(withAccountId(income, accountId ?? income.accountId));
}

export async function updateIncome(id, data) {
  return db.incomes.update(id, data);
}

export async function deleteIncome(id) {
  return db.incomes.delete(id);
}

export async function getIncomeEvents(accountId = null) {
  const rows = accountId == null
    ? await db.incomeEvents.toArray()
    : await db.incomeEvents.where('accountId').equals(Number(accountId)).toArray();
  return rows.sort((a, b) => new Date(b.date) - new Date(a.date));
}

export async function recordIncomeReceived({
  accountId = null,
  incomeId = null,
  name = '',
  amount = 0,
  note = '',
  date = new Date().toISOString(),
  type = 'recurring',
  receiptKey = null,
  categoryId = null,
}) {
  const targetAccountId = accountId != null ? Number(accountId) : await getDefaultAccountId();
  const incomeAmount = roundMoney(amount);
  if (!targetAccountId || incomeAmount <= 0) return 0;

  const eventDate = date || new Date().toISOString();
  const recurringIncomeId = incomeId == null ? null : Number(incomeId);
  const cleanName = String(name || '').trim();
  const cleanNote = String(note || '').trim();
  const dedupeKey = receiptKey || (
    type === 'recurring' && recurringIncomeId != null
      ? `${targetAccountId}:income:${recurringIncomeId}:${eventDate}`
      : null
  );
  const allocatedCategoryId = type === 'one-off' && categoryId != null ? Number(categoryId) : null;

  if (dedupeKey) {
    const existing = await db.incomeEvents.where('receiptKey').equals(dedupeKey).first();
    if (existing) return existing.id;
  }

  const event = {
    accountId: targetAccountId,
    incomeId: recurringIncomeId,
    name: cleanName || (type === 'one-off' ? 'One-off income' : 'Income'),
    amount: incomeAmount,
    note: cleanNote,
    date: eventDate,
    type,
    createdAt: new Date().toISOString(),
  };
  if (dedupeKey) event.receiptKey = dedupeKey;
  if (allocatedCategoryId != null) event.allocatedCategoryId = allocatedCategoryId;

  let id = 0;
  try {
    await db.transaction('rw', db.accounts, db.incomeEvents, db.categories, async () => {
      const account = await db.accounts.get(targetAccountId);
      if (!account) return;

      id = await db.incomeEvents.add(event);
      await db.accounts.update(targetAccountId, {
        balance: roundMoney((account.balance || 0) + incomeAmount),
      });

      if (allocatedCategoryId != null) {
        const cat = await db.categories.get(allocatedCategoryId);
        if (cat) {
          const sources = Array.isArray(cat.boostSources) ? cat.boostSources : [];
          await db.categories.update(allocatedCategoryId, {
            temporaryBoost: roundMoney((cat.temporaryBoost || 0) + incomeAmount),
            boostSources: [...sources, { from: 'income', amount: incomeAmount, incomeEventId: id }],
          });
        }
      }
    });
  } catch (error) {
    if (dedupeKey && error?.name === 'ConstraintError') {
      const existing = await db.incomeEvents.where('receiptKey').equals(dedupeKey).first();
      return existing?.id || 0;
    }
    throw error;
  }

  return id;
}

export async function deleteIncomeEvent(id) {
  await db.transaction('rw', db.accounts, db.incomeEvents, db.categories, async () => {
    const event = await db.incomeEvents.get(id);
    if (!event) return;

    const accountId = Number(event.accountId);
    const account = await db.accounts.get(accountId);
    if (account) {
      await db.accounts.update(accountId, {
        balance: roundMoney((account.balance || 0) - (Number(event.amount) || 0)),
      });
    }

    if (event.allocatedCategoryId != null) {
      const cat = await db.categories.get(Number(event.allocatedCategoryId));
      if (cat) {
        const sources = Array.isArray(cat.boostSources) ? cat.boostSources : [];
        const boostEntry = sources.find(entry => entry.incomeEventId === id);
        if (boostEntry) {
          await db.categories.update(cat.id, {
            temporaryBoost: Math.max(0, roundMoney((cat.temporaryBoost || 0) - (boostEntry.amount || 0))),
            boostSources: sources.filter(entry => entry.incomeEventId !== id),
          });
        }
      }
    }

    await db.incomeEvents.delete(id);
  });
}

// ── Subscription helpers ─────────────────────────────────────────────────────
function normalizeSubscription(subscription, accountId = null) {
  const interval = Math.max(1, Number(subscription.interval) || 1);
  const intervalUnit = subscription.intervalUnit || 'month';
  const nextDueAt = subscription.nextDueAt || subscription.startDate || new Date().toISOString();

  return {
    ...withAccountId(subscription, accountId ?? subscription.accountId),
    categoryId: Number(subscription.categoryId),
    amount: roundMoney(subscription.amount),
    name: String(subscription.name || '').trim(),
    note: String(subscription.note || '').trim(),
    manageUrl: normalizeUrl(subscription.manageUrl),
    interval,
    intervalUnit,
    nextDueAt,
    active: subscription.active !== false,
    updatedAt: new Date().toISOString(),
  };
}

export async function getSubscriptions(accountId = null) {
  const rows = accountId == null
    ? await db.subscriptions.toArray()
    : await db.subscriptions.where('accountId').equals(Number(accountId)).toArray();
  return rows.sort((a, b) => new Date(a.nextDueAt) - new Date(b.nextDueAt));
}

export async function addSubscription(subscription, accountId = null) {
  const data = normalizeSubscription(subscription, accountId);
  return db.subscriptions.add({
    ...data,
    createdAt: new Date().toISOString(),
  });
}

export async function updateSubscription(id, data) {
  const existing = await db.subscriptions.get(id);
  if (!existing) return 0;
  return db.subscriptions.update(id, normalizeSubscription({ ...existing, ...data }, existing.accountId));
}

export async function deleteSubscription(id) {
  return db.subscriptions.delete(id);
}

export async function processDueSubscriptions(accountId = null, now = new Date()) {
  const targetAccountId = accountId != null ? Number(accountId) : await getDefaultAccountId();
  if (!targetAccountId) return 0;

  const dueSubscriptions = (await db.subscriptions.where('accountId').equals(targetAccountId).toArray())
    .filter(subscription => subscription.active !== false && subscription.nextDueAt && new Date(subscription.nextDueAt) <= now);
  let created = 0;

  for (const subscription of dueSubscriptions) {
    let dueDate = new Date(subscription.nextDueAt);
    let lastProcessed = null;
    let guard = 0;

    while (dueDate <= now && guard < 48) {
      const dueIso = dueDate.toISOString();
      const runKey = `${targetAccountId}:subscription:${subscription.id}:${dueIso}`;

      try {
        await addTransaction({
          accountId: targetAccountId,
          categoryId: subscription.categoryId,
          amount: subscription.amount,
          note: subscription.note || subscription.name,
          date: dueIso,
          subscriptionId: subscription.id,
          subscriptionRunKey: runKey,
        });
        created += 1;
      } catch (error) {
        if (error?.name !== 'ConstraintError') throw error;
      }

      lastProcessed = dueIso;
      dueDate = getNextRecurringDate(
        dueDate,
        subscription.intervalUnit || 'month',
        subscription.interval || 1,
        dueDate
      );
      guard += 1;
    }

    await db.subscriptions.update(subscription.id, {
      lastChargedAt: lastProcessed || subscription.lastChargedAt || null,
      nextDueAt: dueDate.toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  return created;
}

// ── Auto-categorisation rules ────────────────────────────────────────────────
// A rule maps a text match on the note/merchant to a category, so recurring
// spend at the same place stops needing a category picked by hand every time.
// Lower `priority` wins; ties fall back to the more specific (longer) match.
export async function getRules(accountId = null) {
  const rows = accountId == null
    ? await db.rules.toArray()
    : await db.rules.where('accountId').equals(Number(accountId)).toArray();
  return rows.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0)
    || String(b.match || '').length - String(a.match || '').length);
}

export async function addRule(rule, accountId = null) {
  const count = await db.rules.count();
  return db.rules.add({
    ...withAccountId(rule, accountId ?? rule.accountId),
    match: String(rule.match || '').trim(),
    categoryId: Number(rule.categoryId),
    priority: rule.priority ?? count,
    createdAt: new Date().toISOString(),
  });
}

export async function updateRule(id, data) {
  const next = { ...data };
  if (next.match != null) next.match = String(next.match).trim();
  if (next.categoryId != null) next.categoryId = Number(next.categoryId);
  return db.rules.update(id, next);
}

export async function deleteRule(id) {
  return db.rules.delete(id);
}

// ── Expense templates ────────────────────────────────────────────────────────
// A saved amount + category + note for spend that repeats at the same price —
// a coffee, a bus fare — so logging it is one tap instead of a form.
export async function getTemplates(accountId = null) {
  const rows = accountId == null
    ? await db.templates.toArray()
    : await db.templates.where('accountId').equals(Number(accountId)).toArray();
  return rows.sort((a, b) => (b.useCount || 0) - (a.useCount || 0)
    || String(a.name || '').localeCompare(String(b.name || '')));
}

export async function addTemplate(template, accountId = null) {
  return db.templates.add({
    ...withAccountId(template, accountId ?? template.accountId),
    name: String(template.name || '').trim(),
    categoryId: Number(template.categoryId),
    amount: roundMoney(template.amount),
    note: String(template.note || '').trim(),
    useCount: 0,
    createdAt: new Date().toISOString(),
  });
}

export async function deleteTemplate(id) {
  return db.templates.delete(id);
}

/** Log a template as an expense and count the use, so the list self-sorts. */
export async function logTemplate(templateId, accountId = null) {
  const template = await db.templates.get(Number(templateId));
  if (!template) return 0;

  const id = await addTransaction({
    accountId: accountId ?? template.accountId,
    categoryId: template.categoryId,
    amount: template.amount,
    note: template.note || template.name,
    merchant: template.note || template.name,
    date: new Date().toISOString(),
  });

  await db.templates.update(template.id, { useCount: (template.useCount || 0) + 1 });
  return id;
}

// ── Savings goals & debts ────────────────────────────────────────────────────
// A goal is an *earmark*, not a transfer: contributing to it doesn't move money
// between accounts, it just marks some of what you already have as spoken for.
// That keeps goals from double-counting against transactions, and means the
// account balance stays the single truth about how much money exists.
//
// Debts are the same shape with `kind: 'debt'` — `target` is what you owed at
// the start and `saved` is how much of it you've cleared.
export const GOAL_SAVING = 'saving';
export const GOAL_DEBT = 'debt';

export async function getGoals(accountId = null) {
  const rows = accountId == null
    ? await db.goals.toArray()
    : await db.goals.where('accountId').equals(Number(accountId)).toArray();
  return rows.sort((a, b) => {
    const aDone = (a.saved || 0) >= (a.target || 0);
    const bDone = (b.saved || 0) >= (b.target || 0);
    if (aDone !== bDone) return aDone ? 1 : -1; // finished goals sink
    return new Date(a.targetDate || '9999') - new Date(b.targetDate || '9999');
  });
}

export async function addGoal(goal, accountId = null) {
  return db.goals.add({
    ...withAccountId(goal, accountId ?? goal.accountId),
    name: String(goal.name || '').trim(),
    kind: goal.kind === GOAL_DEBT ? GOAL_DEBT : GOAL_SAVING,
    target: Math.abs(roundMoney(goal.target)),
    saved: Math.max(0, roundMoney(goal.saved || 0)),
    targetDate: goal.targetDate || null,
    perCycleContribution: Math.max(0, roundMoney(goal.perCycleContribution || 0)),
    // Only meaningful on a debt, but stored uniformly so the shape doesn't
    // depend on `kind` — a saving goal simply leaves them at zero.
    apr: Math.max(0, Number(goal.apr) || 0),
    minimumPayment: Math.max(0, roundMoney(goal.minimumPayment || 0)),
    incomeId: goal.incomeId != null ? Number(goal.incomeId) : null,
    wishlistItemId: goal.wishlistItemId != null ? Number(goal.wishlistItemId) : null,
    color: goal.color || ACCOUNT_COLORS[0],
    createdAt: new Date().toISOString(),
  });
}

export async function updateGoal(id, data) {
  const next = { ...data };
  if (next.target != null) next.target = Math.abs(roundMoney(next.target));
  if (next.saved != null) next.saved = roundMoney(next.saved);
  if (next.perCycleContribution != null) next.perCycleContribution = Math.max(0, roundMoney(next.perCycleContribution));
  if (next.apr != null) next.apr = Math.max(0, Number(next.apr) || 0);
  if (next.minimumPayment != null) next.minimumPayment = Math.max(0, roundMoney(next.minimumPayment));
  if (next.incomeId != null) next.incomeId = Number(next.incomeId);
  return db.goals.update(id, next);
}

export async function deleteGoal(id) {
  return db.goals.delete(id);
}

/** Move money into a goal (or, with a negative amount, back out of it). */
export async function contributeToGoal(goalId, amount) {
  const goal = await db.goals.get(Number(goalId));
  if (!goal) return 0;

  const delta = roundMoney(amount);
  // Never past the target, never below zero: a goal can't be more than done.
  const saved = Math.min(
    Math.abs(roundMoney(goal.target)),
    Math.max(0, roundMoney((goal.saved || 0) + delta)),
  );

  await db.goals.update(goal.id, { saved, lastContributedAt: new Date().toISOString() });
  return saved;
}

/**
 * Take each linked goal's per-cycle contribution when its income lands.
 *
 * Idempotent per pay date: `lastAutoContributeAt` stops a re-run on the same
 * income event from contributing twice, which matters because the reset path
 * can fire more than once as live queries settle.
 */
export async function autoContributeGoals(incomeId, accountId = null, at = new Date().toISOString()) {
  const targetAccountId = accountId != null ? Number(accountId) : await getDefaultAccountId();
  if (!targetAccountId) return 0;

  const goals = (await db.goals.where('accountId').equals(targetAccountId).toArray())
    .filter(goal => Number(goal.incomeId) === Number(incomeId) && (goal.perCycleContribution || 0) > 0);

  let contributed = 0;
  for (const goal of goals) {
    if (goal.lastAutoContributeAt === at) continue;

    const target = Math.abs(roundMoney(goal.target));
    const saved = Math.min(target, Math.max(0, roundMoney((goal.saved || 0) + goal.perCycleContribution)));
    if (saved === goal.saved) continue;

    await db.goals.update(goal.id, { saved, lastAutoContributeAt: at, lastContributedAt: at });
    contributed += 1;
  }

  return contributed;
}

// ── Variable helpers ──────────────────────────────────────────────────────────
export async function addVariable(variable, accountId = null) {
  return db.variables.add(withAccountId(variable, accountId ?? variable.accountId));
}

export async function updateVariable(id, data) {
  return db.variables.update(id, data);
}

export async function deleteVariable(id) {
  return db.variables.delete(id);
}

// ── Budget top-ups (temporary, current-cycle only) ───────────────────────────
// A top-up gives a category more to spend for the current cycle without touching
// its recurring `allowance`. The extra lives in `temporaryBoost` (so it survives
// formula/paced recomputation) and is cleared on the next reset. Each top-up a
// category *receives* is recorded in `boostSources` so it can be undone exactly:
//   { from: 'income', amount }      → funded from unallocated income
//   { from: <categoryId>, amount }  → borrowed from another category's spare

// Top up a category from unallocated income.
export async function topUpCategoryFromIncome(categoryId, amount) {
  const catId = Number(categoryId);
  const addAmount = roundMoney(amount);
  if (!catId || addAmount <= 0) return;

  const cat = await db.categories.get(catId);
  if (!cat) return;
  const sources = Array.isArray(cat.boostSources) ? cat.boostSources : [];
  await db.categories.update(catId, {
    temporaryBoost: roundMoney((cat.temporaryBoost || 0) + addAmount),
    boostSources: [...sources, { from: 'income', amount: addAmount }],
  });
}

// Borrow spare budget from one category to top up another, for this cycle only.
// The lending category's effective allowance drops and the receiver's rises; the
// amount is clamped to the lender's spare so it can never be pushed over budget.
export async function borrowBudgetBetweenCategories(fromCategoryId, toCategoryId, amount) {
  const fromId = Number(fromCategoryId);
  const toId = Number(toCategoryId);
  if (!fromId || !toId || fromId === toId) return;

  await db.transaction('rw', db.categories, async () => {
    const [fromCat, toCat] = await Promise.all([
      db.categories.get(fromId),
      db.categories.get(toId),
    ]);
    if (!fromCat || !toCat) return;

    const fromSpare = Math.max(0, roundMoney(getEffectiveAllowance(fromCat) - (fromCat.spent || 0)));
    const borrowAmount = Math.min(roundMoney(amount), fromSpare);
    if (borrowAmount <= 0) return;

    const toSources = Array.isArray(toCat.boostSources) ? toCat.boostSources : [];
    await db.categories.update(fromId, {
      temporaryBoost: roundMoney((fromCat.temporaryBoost || 0) - borrowAmount),
    });
    await db.categories.update(toId, {
      temporaryBoost: roundMoney((toCat.temporaryBoost || 0) + borrowAmount),
      boostSources: [...toSources, { from: fromId, amount: borrowAmount }],
    });
  });
}

// Undo every top-up a category has received: remove the extra from this category
// and return any borrowed amounts to their source categories.
export async function resetCategoryTopUps(categoryId) {
  const catId = Number(categoryId);
  if (!catId) return;

  await db.transaction('rw', db.categories, async () => {
    const cat = await db.categories.get(catId);
    if (!cat) return;
    const sources = Array.isArray(cat.boostSources) ? cat.boostSources : [];
    if (sources.length === 0) return;

    const received = roundMoney(sources.reduce((s, e) => s + (e.amount || 0), 0));
    await db.categories.update(catId, {
      temporaryBoost: roundMoney((cat.temporaryBoost || 0) - received),
      boostSources: [],
    });

    for (const entry of sources) {
      if (entry.from === 'income') continue;
      const sourceId = Number(entry.from);
      const sourceCat = await db.categories.get(sourceId);
      if (sourceCat) {
        await db.categories.update(sourceId, {
          temporaryBoost: roundMoney((sourceCat.temporaryBoost || 0) + (entry.amount || 0)),
        });
      }
    }
  });
}

// ── Integrity repair ─────────────────────────────────────────────────────────
// `categories.spent` is a counter maintained incrementally by the transaction
// helpers, which makes it fast but means a failed write or an interrupted
// import can leave it out of step with the transaction log. This rebuilds it
// from the transactions themselves — the log is the source of truth.
//
// Only spend accrued since the category's last reset counts, since that is what
// the counter represents. Returns a per-category report of what changed.
export async function recalculateSpendCounters(accountId = null) {
  const targetAccountId = accountId != null ? Number(accountId) : await getDefaultAccountId();
  if (!targetAccountId) return { checked: 0, repaired: 0, categories: [] };

  const [categories, transactions] = await Promise.all([
    db.categories.where('accountId').equals(targetAccountId).toArray(),
    db.transactions.where('accountId').equals(targetAccountId).toArray(),
  ]);

  const report = [];

  for (const cat of categories) {
    // Compared at day granularity: transactions are stored at local midnight
    // (see dateOnlyToISO), while lastReset is a full timestamp. Comparing them
    // directly would treat everything logged earlier on the reset day as
    // belonging to the previous cycle, and wrongly zero the counter.
    const rawReset = cat.lastReset ? new Date(cat.lastReset) : null;
    const since = rawReset && !Number.isNaN(rawReset.getTime()) ? startOfDay(rawReset) : null;
    const actual = Math.max(0, roundMoney(
      transactions
        .filter(tx => Number(tx.categoryId) === Number(cat.id))
        .filter(tx => {
          if (!since) return true;
          const date = new Date(tx.date);
          return !Number.isNaN(date.getTime()) && date >= since;
        })
        .reduce((sum, tx) => sum + getSignedAmount(tx), 0)
    ));

    const stored = roundMoney(cat.spent || 0);
    const drift = roundMoney(actual - stored);

    if (Math.abs(drift) >= 0.01) {
      await db.categories.update(cat.id, {
        spent: actual,
        spentByIncome: actual === 0 ? {} : allocateAmountByIncome(cat, actual),
      });
    }

    report.push({ id: cat.id, name: cat.name, stored, actual, drift });
  }

  return {
    checked: report.length,
    repaired: report.filter(row => Math.abs(row.drift) >= 0.01).length,
    categories: report,
  };
}

// ── Budget reset ─────────────────────────────────────────────────────────────
export async function resetBudget(accountId = null) {
  const now = new Date().toISOString();
  const cats = accountId == null
    ? await db.categories.toArray()
    : await db.categories.where('accountId').equals(Number(accountId)).toArray();
  for (const cat of cats) {
    await db.categories.update(cat.id, {
      spent: 0,
      spentByIncome: {},
      temporaryBoost: 0,
      boostSources: [],
      rolloverBalance: getRolloverForNextCycle(cat, cat.cycleClearedSpend),
      cycleClearedSpend: 0,
      lastReset: now,
    });
  }
}

export async function resetCategory(id) {
  const cat = await db.categories.get(id);
  if (!cat) return;
  await db.categories.update(id, {
    spent: 0,
    spentByIncome: {},
    temporaryBoost: 0,
    boostSources: [],
    rolloverBalance: getRolloverForNextCycle(cat, cat.cycleClearedSpend),
    cycleClearedSpend: 0,
    lastReset: new Date().toISOString(),
  });
}

export async function resetCategoriesForIncome(incomeId, resetAt = new Date().toISOString(), accountId = null) {
  const id = Number(incomeId);
  const key = String(id);
  const cats = accountId == null
    ? await db.categories.toArray()
    : await db.categories.where('accountId').equals(Number(accountId)).toArray();
  let resetCount = 0;

  for (const cat of cats) {
    const usesIncome = normalizeIncomeAllocations(cat.incomeAllocations)
      .some(allocation => allocation.incomeId === id && allocation.percent > 0);

    if (usesIncome) {
      const currentSpent = roundMoney(cat.spent || 0);
      const buckets = getCategorySpendBuckets(cat);
      const resetAmount = Math.min(currentSpent, roundMoney(buckets[key] || 0));
      const nextBuckets = cleanupSpendMap({ ...buckets, [key]: 0 });
      const nextSpent = Math.max(0, roundMoney(currentSpent - resetAmount));
      const nextIncomeResetAt = { ...(cat.incomeResetAt || {}), [key]: resetAt };

      const alreadyCleared = roundMoney(cat.cycleClearedSpend || 0);

      await db.categories.update(cat.id, {
        spent: nextSpent,
        spentByIncome: nextSpent === 0 ? {} : nextBuckets,
        incomeResetAt: nextIncomeResetAt,
        // Rollover is settled only when the category fully resets — a partial
        // reset (one of several funding incomes) hasn't finished its cycle.
        // Until then, track what's been cleared so the final reset can still
        // see the whole cycle's spend.
        ...(nextSpent === 0
          ? {
              lastReset: resetAt,
              temporaryBoost: 0,
              boostSources: [],
              rolloverBalance: getRolloverForNextCycle(cat, alreadyCleared),
              cycleClearedSpend: 0,
            }
          : {
              cycleClearedSpend: roundMoney(alreadyCleared + resetAmount),
            }),
      });
      resetCount += 1;
    }
  }

  return resetCount;
}

// ── Budget config import ─────────────────────────────────────────────────────
//
// A config file redefines an account's categories and variables in one go.
// Editing a budget category by category, mid-cycle, corrupts that cycle's
// pacing and every comparison drawn from it, so an import is *staged*: it is
// validated and previewed immediately, held, and applied at the next reset.
//
// The staged record lives on the account's settings row rather than in a table
// of its own. It is one bounded object per account with the same lifecycle as
// `dismissedNudges` — and keeping it there means it travels through export and
// import for free, which a new table would not.

/**
 * Hold a validated config until the next reset.
 *
 * Deliberately refuses a plan that failed validation: staging a config that
 * cannot be applied only moves the failure to a moment when the user isn't
 * watching. Returns what it replaced, so the UI can say a previous config was
 * displaced rather than quietly overwriting it.
 */
export async function stageBudgetConfig(accountId, { config, plan, fileName = null } = {}) {
  const id = accountId != null ? Number(accountId) : await getDefaultAccountId();
  if (id == null) throw new Error('No account to stage a budget config against.');
  if (!plan?.ok) throw new Error('Refusing to stage a config that failed validation.');

  const settings = await getSettings(id);
  const replaced = settings?.stagedBudgetConfig || null;

  const staged = {
    stagedAt: new Date().toISOString(),
    fileName,
    config,
    plan,
    // Which reset this waits for. The formulas are written in terms of this
    // income, so applying them at a different income's reset would evaluate
    // them against a cycle they don't describe.
    applyIncomeId: plan.meta?.baselineIncomeId ?? null,
    applyNotBefore: plan.meta?.applyNotBefore ?? null,
    consumedAt: null,
  };

  await saveSettings({ ...(settings || {}), stagedBudgetConfig: staged }, id);
  return { staged, replaced };
}

/** Drop a staged config without applying it. */
export async function cancelStagedBudgetConfig(accountId) {
  const id = accountId != null ? Number(accountId) : await getDefaultAccountId();
  if (id == null) return null;
  const settings = await getSettings(id);
  if (!settings?.stagedBudgetConfig) return null;
  const cancelled = settings.stagedBudgetConfig;
  await saveSettings({ ...settings, stagedBudgetConfig: null }, id);
  return cancelled;
}

/** Everything the validator needs to judge a config against this account. */
export async function getBudgetConfigContext(accountId) {
  const id = accountId != null ? Number(accountId) : await getDefaultAccountId();
  if (id == null) return null;
  const [accounts, categories, variables, incomes, settings] = await Promise.all([
    db.accounts.toArray(),
    db.categories.where('accountId').equals(id).toArray(),
    db.variables.where('accountId').equals(id).toArray(),
    db.incomes.where('accountId').equals(id).toArray(),
    getSettings(id),
  ]);
  return {
    account: accounts.find(a => Number(a.id) === id) || null,
    accounts, categories, variables, incomes, settings,
  };
}

/**
 * Apply a staged config, atomically or not at all.
 *
 * Formulas are re-evaluated here rather than trusted from staging time: income
 * may have changed in between, and the formulas — not the numbers in the file —
 * are the source of truth. That means the plan is rebuilt and re-validated
 * against live data, and a config that no longer balances is left staged and
 * reported rather than applied at a worse number than the user approved.
 *
 * The write runs inside one Dexie transaction, so a failure part-way rolls the
 * whole thing back. A partially applied budget is worse than a failed one.
 */
export async function applyStagedBudgetConfig(accountId, { incomeId = null, resetAt = new Date() } = {}) {
  const id = accountId != null ? Number(accountId) : await getDefaultAccountId();
  if (id == null) return { applied: false, reason: 'no-account' };

  const settings = await getSettings(id);
  const staged = settings?.stagedBudgetConfig;
  if (!staged) return { applied: false, reason: 'nothing-staged' };
  if (!isStagedConfigDue(staged, { incomeId, resetAt })) {
    return { applied: false, reason: 'not-due' };
  }

  const context = await getBudgetConfigContext(id);
  const plan = buildBudgetConfigPlan(staged.config, context);

  if (!plan.ok) {
    // Nothing is written. The config stays staged with the failure recorded, so
    // the user gets a nudge explaining why their new budget did not land rather
    // than a budget that half did.
    const at = new Date().toISOString();
    await saveSettings({
      ...settings,
      stagedBudgetConfig: { ...staged, lastAttemptAt: at, lastAttemptErrors: plan.errors },
    }, id);
    return { applied: false, reason: 'validation-failed', errors: plan.errors, plan };
  }

  // Automatic backup, taken before anything is written and outside the write
  // transaction — `exportSnapshot` reads tables this transaction doesn't own.
  // It is the app's own share-link export: setup without transaction logs, so
  // it stays bounded however long the ledger gets.
  let backup = null;
  try {
    backup = await exportSnapshot();
  } catch (error) {
    console.error('Budget config: automatic backup failed', error);
    return { applied: false, reason: 'backup-failed', error: String(error) };
  }

  const appliedAt = (resetAt instanceof Date ? resetAt : new Date(resetAt)).toISOString();

  // Undo is offered for one cycle — long enough to notice a budget you didn't
  // want, short of restoring allowances that have since gone stale.
  const income = context.incomes.find(i => Number(i.id) === Number(plan.meta.baselineIncomeId));
  const cycleDays = getIncomeCycleAverageDays(income?.resetFrequency || 'monthly');
  const undoExpiresAt = new Date(
    new Date(appliedAt).getTime() + Math.round(cycleDays * 24 * 60 * 60 * 1000)
  ).toISOString();

  const undo = {
    appliedAt,
    undoExpiresAt,
    label: staged.fileName || 'budget config',
    // Exactly what apply can touch, captured whole. Undo restores these rows
    // rather than reversing a diff, so it cannot drift from what was changed.
    categories: context.categories.map(row => ({ ...row })),
    variables: context.variables.map(row => ({ ...row })),
    createdCategoryIds: [],
    createdVariableIds: [],
    backup,
  };

  await db.transaction('rw', db.categories, db.variables, db.settings, async () => {
    // ── Variables first: category formulas dereference them. ──
    const variableIdByName = new Map();
    for (const row of plan.variables) {
      if (row.action === 'create') {
        const newId = await db.variables.add({ accountId: id, name: row.name, value: row.value });
        undo.createdVariableIds.push(newId);
        variableIdByName.set(row.name, newId);
      } else if (row.action === 'update') {
        await db.variables.update(Number(row.id), { name: row.name, value: row.value });
        variableIdByName.set(row.name, Number(row.id));
      } else {
        variableIdByName.set(row.name, Number(row.id));
      }
    }

    // ── Then categories. ──
    for (const row of plan.categories) {
      if (row.action === 'create') {
        const newId = await db.categories.add({
          accountId: id,
          ...row.fields,
          // A new category starts its life with a clean counter. This is the
          // only place an import writes runtime state, and only because there
          // is no prior state to preserve.
          spent: 0,
          spentByIncome: {},
          incomeResetAt: {},
          temporaryBoost: 0,
          boostSources: [],
          rolloverBalance: 0,
          cycleClearedSpend: 0,
          lastReset: appliedAt,
        });
        undo.createdCategoryIds.push(newId);
        continue;
      }

      if (row.action === 'keep') continue;

      const existing = await db.categories.get(Number(row.id));
      if (!existing) {
        // Validated moments ago against the same data — if it is gone now,
        // something else is writing concurrently and this transaction must not
        // paper over it.
        throw new Error(`Category ${row.id} disappeared while the budget config was being applied.`);
      }

      const fields = { ...row.fields };

      // Turning rollover off releases the accumulated balance, matching what
      // the category editor does. Turning it on, or leaving it on, keeps every
      // penny already banked — that balance is the user's money, not config.
      if (fields.rolloverEnabled === false) fields.rolloverBalance = 0;

      // Funding split changed: the spend already counted has to be re-bucketed
      // against the new split, which is what `updateCategory` exists to do.
      if (Object.prototype.hasOwnProperty.call(fields, 'incomeAllocations')) {
        fields.spentByIncome = allocateAmountByIncome({ ...existing, ...fields }, existing.spent || 0);
      }

      await db.categories.update(Number(row.id), fields);
    }

    const current = await db.settings.where('accountId').equals(id).toArray();
    const row = current[0];
    if (row) {
      await db.settings.update(row.id, {
        stagedBudgetConfig: null,
        budgetConfigUndo: undo,
        lastBudgetConfigAppliedAt: appliedAt,
        lastAutoBackupAt: appliedAt,
      });
    }
  });

  return { applied: true, plan, undo, appliedAt };
}

/**
 * Put the budget back as it was before the last config apply.
 *
 * Restores the snapshotted rows verbatim and removes what the apply created.
 * A created category that has since been spent against is kept rather than
 * deleted: `deleteCategory` would take its transactions with it, and losing
 * real spending to undo a budget change is not a trade worth making.
 */
export async function undoBudgetConfigApply(accountId) {
  const id = accountId != null ? Number(accountId) : await getDefaultAccountId();
  if (id == null) return { undone: false, reason: 'no-account' };

  const settings = await getSettings(id);
  const undo = settings?.budgetConfigUndo;
  if (!undo) return { undone: false, reason: 'nothing-to-undo' };
  if (isBudgetConfigUndoExpired(undo)) return { undone: false, reason: 'expired' };

  const keptCategories = [];

  // Read outside the write transaction so the decision about which created
  // categories are safe to delete is made before anything changes.
  const spentAgainst = new Set();
  for (const createdId of undo.createdCategoryIds || []) {
    const count = await db.transactions.where('categoryId').equals(Number(createdId)).count();
    if (count > 0) spentAgainst.add(Number(createdId));
  }

  await db.transaction('rw', db.categories, db.variables, db.settings, async () => {
    for (const row of undo.categories || []) {
      await db.categories.put(row);
    }
    for (const row of undo.variables || []) {
      await db.variables.put(row);
    }

    for (const createdId of undo.createdCategoryIds || []) {
      if (spentAgainst.has(Number(createdId))) {
        const cat = await db.categories.get(Number(createdId));
        if (cat) keptCategories.push({ id: cat.id, name: cat.name });
        continue;
      }
      await db.categories.delete(Number(createdId));
    }

    for (const createdId of undo.createdVariableIds || []) {
      await db.variables.delete(Number(createdId));
    }

    const current = await db.settings.where('accountId').equals(id).toArray();
    const row = current[0];
    if (row) {
      await db.settings.update(row.id, {
        budgetConfigUndo: null,
        lastBudgetConfigUndoneAt: new Date().toISOString(),
      });
    }
  });

  return { undone: true, keptCategories, appliedAt: undo.appliedAt };
}

// ── Export / Import ──────────────────────────────────────────────────────────
export async function clearAllData() {
  await db.transaction('rw',
    db.accountTransfers,
    db.incomeEvents,
    db.accounts,
    db.settings,
    db.categories,
    db.transactions,
    db.wishlist,
    db.wishlistCategories,
    db.incomes,
    db.subscriptions,
    db.variables,
    db.rules,
    db.templates,
    db.goals,
    async () => {
      await db.accountTransfers.clear();
      await db.incomeEvents.clear();
      await db.accounts.clear();
      await db.settings.clear();
      await db.categories.clear();
      await db.transactions.clear();
      await db.wishlist.clear();
      await db.wishlistCategories.clear();
      await db.incomes.clear();
      await db.subscriptions.clear();
      await db.variables.clear();
      await db.rules.clear();
      await db.templates.clear();
      await db.goals.clear();
    }
  );
}

// Receipt photos are Blobs. JSON.stringify turns a Blob into `{}`, so leaving
// them in an export would write a field that looks present, imports as garbage,
// and tells the user nothing went wrong. They are dropped deliberately instead,
// and the export says how many it left behind.
const RECEIPT_FIELDS = ['receipt', 'receiptThumb', 'receiptMeta'];

function stripReceipts(transactions = []) {
  let receiptsOmitted = 0;
  const rows = transactions.map(tx => {
    if (!tx.receipt && !tx.receiptThumb) return tx;
    receiptsOmitted += 1;
    const copy = { ...tx };
    for (const field of RECEIPT_FIELDS) delete copy[field];
    return copy;
  });
  return { rows, receiptsOmitted };
}

export async function exportData() {
  const [accounts, accountTransfers, incomeEvents, settings, categories, transactions, wishlist, wishlistCategories, incomes, subscriptions, variables, rules, templates, goals] = await Promise.all([
    db.accounts.toArray(),
    db.accountTransfers.toArray(),
    db.incomeEvents.toArray(),
    db.settings.toArray(),
    db.categories.toArray(),
    db.transactions.toArray(),
    db.wishlist.toArray(),
    db.wishlistCategories.toArray(),
    db.incomes.toArray(),
    db.subscriptions.toArray(),
    db.variables.toArray(),
    db.rules.toArray(),
    db.templates.toArray(),
    db.goals.toArray(),
  ]);
  const { rows: transactionRows, receiptsOmitted } = stripReceipts(transactions);
  return {
    accounts, accountTransfers, incomeEvents, settings, categories,
    transactions: transactionRows,
    wishlist, wishlistCategories, incomes, subscriptions, variables, rules, templates, goals,
    receiptsOmitted,
    exportedAt: new Date().toISOString(),
    version: 8,
  };
}

// Lightweight snapshot for the "share URL" feature: high-level setup only,
// no transaction/event logs, so it stays small enough to embed in a URL.
export async function exportSnapshot() {
  const [accounts, settings, categories, incomes, subscriptions, wishlist, wishlistCategories, variables, rules, templates, goals] = await Promise.all([
    db.accounts.toArray(),
    db.settings.toArray(),
    db.categories.toArray(),
    db.incomes.toArray(),
    db.subscriptions.toArray(),
    db.wishlist.toArray(),
    db.wishlistCategories.toArray(),
    db.variables.toArray(),
    db.rules.toArray(),
    db.templates.toArray(),
    db.goals.toArray(),
  ]);
  return { accounts, settings, categories, incomes, subscriptions, wishlist, wishlistCategories, variables, rules, templates, goals, exportedAt: new Date().toISOString(), version: 8 };
}

// ── Chat Summary export: field picker support ───────────────────────────────
// The picker shown before export needs to know which fields actually exist on
// each table. Dexie only declares *indexed* columns in the schema, so the
// only accurate source for "every field that exists" is the data itself —
// this reads each table and unions the keys found across its rows.
const EXPORT_TABLE_NAMES = ['categories', 'transactions', 'incomes', 'incomeEvents',
  'subscriptions', 'wishlist', 'wishlistCategories', 'variables', 'accountTransfers',
  'rules', 'templates', 'goals'];
// Structural identifiers, always kept and never user-toggleable.
const EXPORT_ALWAYS_INCLUDED_KEYS = new Set(['id', 'accountId']);
// Pure linking/dedupe plumbing with no analytical meaning to a reader, plus the
// receipt blobs — binary, unreadable as JSON, and far larger than everything
// else in the file put together.
const EXPORT_NEVER_INCLUDED_KEYS = new Set([
  'subscriptionRunKey', 'receiptKey', ...RECEIPT_FIELDS,
]);
const EXPORT_SENSITIVE_FIELD_PATTERN = /note|memo|description|comment|url/i;

export async function getExportableSchema() {
  const tables = {};
  for (const name of EXPORT_TABLE_NAMES) {
    const rows = await db[name].toArray();
    const keys = new Set();
    for (const row of rows) Object.keys(row).forEach(k => keys.add(k));
    tables[name] = [...keys]
      .filter(k => !EXPORT_ALWAYS_INCLUDED_KEYS.has(k) && !EXPORT_NEVER_INCLUDED_KEYS.has(k))
      .map(key => ({ key, sensitive: EXPORT_SENSITIVE_FIELD_PATTERN.test(key) }));
  }
  return tables;
}

// Computed/derived summaries aren't raw table columns, so there's no live
// schema to read them off of — this list stays static.
export const EXPORT_COMPUTED_SECTIONS = [
  { key: 'categoryBreakdown', label: 'Category breakdown (allowance vs spent)' },
  { key: 'monthlyHistory', label: 'Monthly spend history' },
  { key: 'incomeVsSpending', label: 'Income vs. spending totals' },
  { key: 'subscriptionsSummary', label: 'Subscriptions summary' },
  { key: 'upcomingSubscriptionCostByCategory', label: 'Upcoming subscription costs' },
  { key: 'wishlistSummary', label: 'Wishlist affordability' },
];

export function buildDefaultExportSelection(schema) {
  const tables = {};
  for (const [table, fields] of Object.entries(schema || {})) {
    tables[table] = fields.filter(f => !f.sensitive).map(f => f.key);
  }
  return { tables, computed: EXPORT_COMPUTED_SECTIONS.map(s => s.key) };
}

function pickFields(row, fieldKeys = []) {
  const picked = {};
  for (const key of EXPORT_ALWAYS_INCLUDED_KEYS) {
    if (key in row) picked[key] = row[key];
  }
  for (const key of fieldKeys) {
    if (key in row) picked[key] = row[key];
  }
  return picked;
}

// Structured export for handing data to a financial expert / LLM for
// analysis: computed breakdowns plus raw data across every account, filtered
// down to whatever tables/fields/computed-sections `selection` includes.
export async function exportChatSummary(selection) {
  const [accounts, categories, transactions, incomes, incomeEvents, subscriptions, wishlist, wishlistCategories, variables, accountTransfers, settingsRows] = await Promise.all([
    db.accounts.toArray(),
    db.categories.toArray(),
    db.transactions.toArray(),
    db.incomes.toArray(),
    db.incomeEvents.toArray(),
    db.subscriptions.toArray(),
    db.wishlist.toArray(),
    db.wishlistCategories.toArray(),
    db.variables.toArray(),
    db.accountTransfers.toArray(),
    db.settings.toArray(),
  ]);

  const tableSelection = selection?.tables || {};
  const computedSelection = new Set(selection?.computed || EXPORT_COMPUTED_SECTIONS.map(s => s.key));
  const includeTable = (name) => Array.isArray(tableSelection[name]) && tableSelection[name].length > 0;
  const pickRows = (name, rows) => rows.map(row => pickFields(row, tableSelection[name]));

  const byAccount = (rows) => (accountId) => rows.filter(row => Number(row.accountId) === Number(accountId));
  const categoriesByAccount = byAccount(categories);
  const transactionsByAccount = byAccount(transactions);
  const incomesByAccount = byAccount(incomes);
  const incomeEventsByAccount = byAccount(incomeEvents);
  const subscriptionsByAccount = byAccount(subscriptions);
  const wishlistByAccount = byAccount(wishlist);
  const wishlistCategoriesByAccount = byAccount(wishlistCategories);
  const variablesByAccount = byAccount(variables);

  const accountSummaries = accounts.map(account => {
    const accCategories = categoriesByAccount(account.id);
    const accTransactions = transactionsByAccount(account.id);
    const accIncomes = incomesByAccount(account.id);
    const accSubscriptions = subscriptionsByAccount(account.id);
    const accWishlist = wishlistByAccount(account.id);
    const accSettings = settingsRows.find(s => Number(s.accountId) === Number(account.id)) || null;

    const summary = { account, settings: accSettings };

    if (computedSelection.has('categoryBreakdown')) {
      summary.categoryBreakdown = accCategories.map(cat => ({
        id: cat.id,
        name: cat.name,
        allowance: cat.allowance,
        effectiveAllowance: getEffectiveAllowance(cat),
        spent: cat.spent,
        spare: getCategorySpare(cat),
      }));
    }

    if (computedSelection.has('monthlyHistory')) {
      summary.monthlyHistory = buildMonthlyHistory(accTransactions, accCategories);
    }

    if (computedSelection.has('incomeVsSpending')) {
      // Normalised to a monthly rate so mixed pay frequencies don't inflate it.
      const totalIncome = getNormalisedIncomeTotal(accIncomes, 'month');
      const totalSpent = accCategories.reduce((sum, cat) => sum + (Number(cat.spent) || 0), 0);
      summary.incomeVsSpending = {
        totalIncome,
        totalSpent,
        projectedEndBalance: projectedEndBalance(accCategories, accSettings, accIncomes),
      };
    }

    if (computedSelection.has('subscriptionsSummary')) {
      summary.subscriptionsSummary = accSubscriptions.map(sub => ({
        id: sub.id,
        name: sub.name,
        amount: sub.amount,
        interval: sub.interval,
        intervalUnit: sub.intervalUnit,
        active: sub.active,
        nextDueAt: sub.nextDueAt,
        categoryId: sub.categoryId,
      }));
    }

    if (computedSelection.has('upcomingSubscriptionCostByCategory')) {
      const categoryIdsWithSubs = [...new Set(accSubscriptions.map(sub => sub.categoryId))];
      summary.upcomingSubscriptionCostByCategory = Object.fromEntries(
        categoryIdsWithSubs.map(categoryId => {
          const cat = accCategories.find(c => Number(c.id) === Number(categoryId));
          const cycleEnd = cat ? getCategoryCycle(cat, accIncomes, accSettings).end : null;
          return [categoryId, getUpcomingSubscriptionCost(accSubscriptions, categoryId, accSettings, undefined, cycleEnd)];
        })
      );
    }

    if (computedSelection.has('wishlistSummary')) {
      summary.wishlistSummary = accWishlist.map(item => ({
        id: item.id,
        name: item.name,
        price: item.price,
        affordability: wishlistAffordability(item, accCategories, accSettings, accIncomes),
      }));
    }

    const raw = {};
    if (includeTable('categories')) raw.categories = pickRows('categories', accCategories);
    if (includeTable('transactions')) raw.transactions = pickRows('transactions', accTransactions);
    if (includeTable('incomes')) raw.incomes = pickRows('incomes', accIncomes);
    if (includeTable('incomeEvents')) raw.incomeEvents = pickRows('incomeEvents', incomeEventsByAccount(account.id));
    if (includeTable('subscriptions')) raw.subscriptions = pickRows('subscriptions', accSubscriptions);
    if (includeTable('wishlist')) raw.wishlist = pickRows('wishlist', accWishlist);
    if (includeTable('wishlistCategories')) raw.wishlistCategories = pickRows('wishlistCategories', wishlistCategoriesByAccount(account.id));
    if (includeTable('variables')) raw.variables = pickRows('variables', variablesByAccount(account.id));
    summary.raw = raw;

    return summary;
  });

  const result = { generatedAt: new Date().toISOString(), version: 8, accounts: accountSummaries };
  if (includeTable('accountTransfers')) result.accountTransfers = pickRows('accountTransfers', accountTransfers);
  return result;
}

export async function importData(data, mode = 'replace') {
  if (!data || typeof data !== 'object') {
    return {
      mode,
      totals: { imported: 0, skipped: 0 },
      tables: {},
      createdDefaultAccount: false,
      preferredAccountId: null,
    };
  }

  const payload = (data.data && typeof data.data === 'object' && !Array.isArray(data.data))
    ? data.data
    : data;

  if (mode === 'replace') {
    await db.accountTransfers.clear();
    await db.incomeEvents.clear();
    await db.accounts.clear();
    await db.settings.clear();
    await db.categories.clear();
    await db.transactions.clear();
    await db.wishlist.clear();
    await db.wishlistCategories.clear();
    await db.incomes.clear();
    await db.subscriptions.clear();
    await db.variables.clear();
    await db.rules.clear();
    await db.templates.clear();
    await db.goals.clear();
  }

  const preserveIds = mode === 'replace';
  const rows = (items = []) => preserveIds ? items : items.map(stripId);

  const isConstraintError = (error) => error?.name === 'ConstraintError';
  const addRowsSafely = async (table, items = [], { ignoreConstraint = false } = {}) => {
    if (!items.length) return { imported: 0, skipped: 0 };
    try {
      await table.bulkAdd(items);
      return { imported: items.length, skipped: 0 };
    } catch (error) {
      if (!ignoreConstraint || !isConstraintError(error)) throw error;
      let imported = 0;
      let skipped = 0;
      for (const item of items) {
        try {
          await table.add(item);
          imported += 1;
        } catch (itemError) {
          if (!isConstraintError(itemError)) throw itemError;
          skipped += 1;
        }
      }
      return { imported, skipped };
    }
  };

  const summary = {
    mode,
    totals: { imported: 0, skipped: 0 },
    tables: {},
    createdDefaultAccount: false,
    preferredAccountId: null,
  };

  const setSummary = (tableName, result = { imported: 0, skipped: 0 }) => {
    const normalized = {
      imported: Number(result.imported) || 0,
      skipped: Number(result.skipped) || 0,
    };
    summary.tables[tableName] = normalized;
    summary.totals.imported += normalized.imported;
    summary.totals.skipped += normalized.skipped;
  };

  const toArray = (value) => {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') return [value];
    return [];
  };

  const dataTables = {
    accounts: toArray(payload.accounts),
    accountTransfers: toArray(payload.accountTransfers),
    incomeEvents: toArray(payload.incomeEvents),
    settings: toArray(payload.settings),
    categories: toArray(payload.categories),
    transactions: toArray(payload.transactions),
    wishlist: toArray(payload.wishlist),
    wishlistCategories: toArray(payload.wishlistCategories),
    incomes: toArray(payload.incomes),
    subscriptions: toArray(payload.subscriptions),
    variables: toArray(payload.variables),
    rules: toArray(payload.rules),
    templates: toArray(payload.templates),
    goals: toArray(payload.goals),
  };

  const toKey = (value) => String(value);
  const toPositiveNumber = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };

  const accountIdMap = new Map();
  let firstMappedAccountId = null;
  if (dataTables.accounts.length) {
    let imported = 0;
    let skipped = 0;

    for (const account of dataTables.accounts) {
      const sourceIdRaw = account?.id;
      const sourceKey = sourceIdRaw == null ? null : toKey(sourceIdRaw);
      const preferredId = preserveIds ? toPositiveNumber(sourceIdRaw) : null;
      const payloadAccount = stripId(account);

      let targetId = null;
      try {
        if (preferredId !== null) {
          targetId = await db.accounts.add({ ...payloadAccount, id: preferredId });
        } else {
          targetId = await db.accounts.add(payloadAccount);
        }
        imported += 1;
      } catch (error) {
        if (!isConstraintError(error)) throw error;
        skipped += 1;

        if (preferredId !== null) {
          const existing = await db.accounts.get(preferredId);
          if (existing) targetId = preferredId;
        }
      }

      if (sourceKey && targetId != null) {
        accountIdMap.set(sourceKey, Number(targetId));
        if (firstMappedAccountId == null) firstMappedAccountId = Number(targetId);
      }
      if (preferredId !== null && targetId != null) {
        accountIdMap.set(toKey(preferredId), Number(targetId));
        if (firstMappedAccountId == null) firstMappedAccountId = Number(targetId);
      }
    }

    setSummary('accounts', { imported, skipped });
  } else {
    setSummary('accounts', { imported: 0, skipped: 0 });
  }

  const fallbackAccountId = await getDefaultAccountId();
  summary.createdDefaultAccount = !dataTables.accounts.length;
  summary.preferredAccountId = firstMappedAccountId ?? Number(fallbackAccountId);
  const existingAccountIds = new Set(
    (await db.accounts.toArray())
      .map(account => toPositiveNumber(account?.id))
      .filter(Boolean)
  );
  const unresolvedAccountRefs = new Set();

  const resolveAccountId = (value) => {
    if (value != null) {
      const direct = accountIdMap.get(toKey(value));
      if (direct != null) return Number(direct);
    }

    const parsed = toPositiveNumber(value);
    if (parsed !== null) {
      const mapped = accountIdMap.get(toKey(parsed));
      if (mapped != null) return Number(mapped);
      if (existingAccountIds.has(parsed)) return Number(parsed);
    }

    if (value != null) unresolvedAccountRefs.add(toKey(value));
    return Number(fallbackAccountId);
  };

  const accountRows = (items = []) => rows(items).map(item => ({
    ...item,
    accountId: resolveAccountId(item.accountId),
  }));
  const incomeEventRows = (items = []) => accountRows(items).map(item => {
    const next = { ...item };
    if (!next.receiptKey) delete next.receiptKey;
    return next;
  });

  const transactionRows = accountRows(dataTables.transactions).map(item => {
    const next = { ...item };
    if (!next.subscriptionRunKey) delete next.subscriptionRunKey;
    return next;
  });

  setSummary('settings', await addRowsSafely(db.settings, accountRows(dataTables.settings)));
  setSummary('categories', await addRowsSafely(db.categories, accountRows(dataTables.categories)));
  setSummary('transactions', await addRowsSafely(db.transactions, transactionRows, { ignoreConstraint: true }));
  setSummary('wishlist', await addRowsSafely(db.wishlist, accountRows(dataTables.wishlist)));
  setSummary('wishlistCategories', await addRowsSafely(db.wishlistCategories, accountRows(dataTables.wishlistCategories)));
  setSummary('incomes', await addRowsSafely(db.incomes, accountRows(dataTables.incomes)));
  setSummary('subscriptions', await addRowsSafely(db.subscriptions, accountRows(dataTables.subscriptions)));
  setSummary('variables', await addRowsSafely(db.variables, accountRows(dataTables.variables)));
  setSummary('rules', await addRowsSafely(db.rules, accountRows(dataTables.rules)));
  setSummary('templates', await addRowsSafely(db.templates, accountRows(dataTables.templates)));
  setSummary('goals', await addRowsSafely(db.goals, accountRows(dataTables.goals)));

  let incomeEventsImported = 0;
  let incomeEventsSkipped = 0;
  for (const event of incomeEventRows(dataTables.incomeEvents)) {
    try {
      await db.incomeEvents.add(event);
      incomeEventsImported += 1;
    } catch (error) {
      if (!isConstraintError(error)) throw error;
      incomeEventsSkipped += 1;
    }
  }
  setSummary('incomeEvents', { imported: incomeEventsImported, skipped: incomeEventsSkipped });

  const transferRows = rows(dataTables.accountTransfers).map(transfer => ({
    ...transfer,
    fromAccountId: resolveAccountId(transfer.fromAccountId),
    toAccountId: resolveAccountId(transfer.toAccountId),
  }));
  setSummary('accountTransfers', await addRowsSafely(db.accountTransfers, transferRows));

  if (unresolvedAccountRefs.size > 0) {
    console.warn('Import used fallback account for unresolved account references', {
      unresolvedAccountIds: [...unresolvedAccountRefs],
      fallbackAccountId,
    });
  }

  console.info('Import summary', summary);

  return summary;
}

export async function exportTransactionsCSV(accountId = null) {
  const [transactions, categories] = await Promise.all([
    getTransactions(accountId),
    getCategories(accountId),
  ]);
  const catMap = Object.fromEntries(categories.map(c => [c.id, c.name]));
  const rows = [['Date','Category','Amount','Type','Tags','Note']];
  for (const tx of transactions) {
    rows.push([
      new Date(tx.date).toLocaleDateString('en-GB'),
      catMap[tx.categoryId] || 'Unknown',
      // Signed, so a spreadsheet totalling this column matches the app.
      getSignedAmount(tx).toFixed(2),
      tx.type === TX_REFUND ? 'Refund' : 'Expense',
      Array.isArray(tx.tags) ? tx.tags.join(' ') : '',
      tx.note || ''
    ]);
  }
  return rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
}
