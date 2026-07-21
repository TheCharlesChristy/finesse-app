import Dexie from 'dexie';
import { getNextRecurringDate, normalizeIncomeAllocations, roundMoney, getEffectiveAllowance } from './utils';

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

export async function deleteCategory(id) {
  await db.transaction('rw', db.categories, db.transactions, db.accounts, db.subscriptions, async () => {
    const transactions = await db.transactions.where('categoryId').equals(id).toArray();
    const refundByAccount = transactions.reduce((acc, tx) => {
      if (tx.accountId == null) return acc;
      const key = Number(tx.accountId);
      acc[key] = roundMoney((acc[key] || 0) + (Number(tx.amount) || 0));
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
}

// ── Transaction helpers ──────────────────────────────────────────────────────
export async function getTransactions(accountId = null) {
  if (accountId == null) return db.transactions.orderBy('date').reverse().toArray();
  const rows = await db.transactions.where('accountId').equals(Number(accountId)).toArray();
  return rows.sort((a, b) => new Date(b.date) - new Date(a.date));
}

export async function addTransaction(tx) {
  const accountId = tx.accountId != null ? Number(tx.accountId) : await getDefaultAccountId();
  let id;
  await db.transaction('rw', db.transactions, db.categories, db.accounts, async () => {
    id = await db.transactions.add({ ...tx, accountId, date: tx.date || new Date().toISOString() });
    const cat = await db.categories.get(tx.categoryId);
    if (cat) {
      await db.categories.update(tx.categoryId, applyCategorySpendDelta(cat, tx.amount));
    }
    const account = await db.accounts.get(accountId);
    if (account) {
      await db.accounts.update(accountId, {
        balance: roundMoney((account.balance || 0) - (Number(tx.amount) || 0)),
      });
    }
  });
  return id;
}

export async function addTransactionsBulk({ categoryId, transactions = [], accountId = null } = {}) {
  const targetAccountId = accountId != null ? Number(accountId) : await getDefaultAccountId();
  const targetCategoryId = Number(categoryId);
  if (!targetAccountId || !targetCategoryId) return [];

  const rows = transactions
    .map(tx => ({
      accountId: targetAccountId,
      categoryId: targetCategoryId,
      amount: roundMoney(tx.amount),
      note: String(tx.note || '').trim(),
      date: tx.date || new Date().toISOString(),
    }))
    .filter(tx => tx.amount > 0);

  if (!rows.length) return [];

  const totalAmount = roundMoney(rows.reduce((sum, tx) => sum + tx.amount, 0));
  let ids = [];

  await db.transaction('rw', db.transactions, db.categories, db.accounts, async () => {
    ids = await db.transactions.bulkAdd(rows, { allKeys: true });

    const cat = await db.categories.get(targetCategoryId);
    if (cat) {
      await db.categories.update(targetCategoryId, applyCategorySpendDelta(cat, totalAmount));
    }

    const account = await db.accounts.get(targetAccountId);
    if (account) {
      await db.accounts.update(targetAccountId, {
        balance: roundMoney((account.balance || 0) - totalAmount),
      });
    }
  });

  return ids;
}

export async function updateTransaction(id, data) {
  const existing = await db.transactions.get(id);
  if (!existing) return 0;

  const nextCategoryId = Number(data.categoryId ?? existing.categoryId);
  const nextAmount = Number(data.amount ?? existing.amount) || 0;
  const previousCategoryId = Number(existing.categoryId);
  const previousAmount = Number(existing.amount) || 0;

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

    await db.transactions.update(id, {
      ...data,
      categoryId: nextCategoryId,
      amount: nextAmount,
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
      const cat = await db.categories.get(tx.categoryId);
      if (cat) {
        await db.categories.update(tx.categoryId, applyCategorySpendDelta(cat, -tx.amount));
      }
      const account = await db.accounts.get(tx.accountId);
      if (account) {
        await db.accounts.update(tx.accountId, {
          balance: roundMoney((account.balance || 0) + (Number(tx.amount) || 0)),
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

// ── Budget reset ─────────────────────────────────────────────────────────────
export async function resetBudget(accountId = null) {
  const now = new Date().toISOString();
  const cats = accountId == null
    ? await db.categories.toArray()
    : await db.categories.where('accountId').equals(Number(accountId)).toArray();
  for (const cat of cats) {
    await db.categories.update(cat.id, { spent: 0, spentByIncome: {}, temporaryBoost: 0, boostSources: [], lastReset: now });
  }
}

export async function resetCategory(id) {
  await db.categories.update(id, { spent: 0, spentByIncome: {}, temporaryBoost: 0, boostSources: [], lastReset: new Date().toISOString() });
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

      await db.categories.update(cat.id, {
        spent: nextSpent,
        spentByIncome: nextSpent === 0 ? {} : nextBuckets,
        incomeResetAt: nextIncomeResetAt,
        ...(nextSpent === 0 ? { lastReset: resetAt, temporaryBoost: 0, boostSources: [] } : {}),
      });
      resetCount += 1;
    }
  }

  return resetCount;
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
    }
  );
}

export async function exportData() {
  const [accounts, accountTransfers, incomeEvents, settings, categories, transactions, wishlist, wishlistCategories, incomes, subscriptions, variables] = await Promise.all([
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
  ]);
  return { accounts, accountTransfers, incomeEvents, settings, categories, transactions, wishlist, wishlistCategories, incomes, subscriptions, variables, exportedAt: new Date().toISOString(), version: 7 };
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
  const rows = [['Date','Category','Amount','Note']];
  for (const tx of transactions) {
    rows.push([
      new Date(tx.date).toLocaleDateString('en-GB'),
      catMap[tx.categoryId] || 'Unknown',
      tx.amount.toFixed(2),
      tx.note || ''
    ]);
  }
  return rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
}
