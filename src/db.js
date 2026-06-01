import Dexie from 'dexie';
import { normalizeIncomeAllocations, roundMoney } from './utils';

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
  return db.categories.add({ ...withAccountId(cat, accountId ?? cat.accountId), spent: 0, spentByIncome: {}, incomeResetAt: {} });
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
  await db.transaction('rw', db.categories, db.transactions, db.accounts, async () => {
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

  let id = 0;
  try {
    await db.transaction('rw', db.accounts, db.incomeEvents, async () => {
      const account = await db.accounts.get(targetAccountId);
      if (!account) return;

      id = await db.incomeEvents.add(event);
      await db.accounts.update(targetAccountId, {
        balance: roundMoney((account.balance || 0) + incomeAmount),
      });
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
  await db.transaction('rw', db.accounts, db.incomeEvents, async () => {
    const event = await db.incomeEvents.get(id);
    if (!event) return;

    const accountId = Number(event.accountId);
    const account = await db.accounts.get(accountId);
    if (account) {
      await db.accounts.update(accountId, {
        balance: roundMoney((account.balance || 0) - (Number(event.amount) || 0)),
      });
    }
    await db.incomeEvents.delete(id);
  });
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

// ── Budget reset ─────────────────────────────────────────────────────────────
export async function resetBudget(accountId = null) {
  const now = new Date().toISOString();
  const cats = accountId == null
    ? await db.categories.toArray()
    : await db.categories.where('accountId').equals(Number(accountId)).toArray();
  for (const cat of cats) {
    await db.categories.update(cat.id, { spent: 0, spentByIncome: {}, lastReset: now });
  }
}

export async function resetCategory(id) {
  await db.categories.update(id, { spent: 0, spentByIncome: {}, lastReset: new Date().toISOString() });
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
        ...(nextSpent === 0 ? { lastReset: resetAt } : {}),
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
      await db.variables.clear();
    }
  );
}

export async function exportData() {
  const [accounts, accountTransfers, incomeEvents, settings, categories, transactions, wishlist, wishlistCategories, incomes, variables] = await Promise.all([
    db.accounts.toArray(),
    db.accountTransfers.toArray(),
    db.incomeEvents.toArray(),
    db.settings.toArray(),
    db.categories.toArray(),
    db.transactions.toArray(),
    db.wishlist.toArray(),
    db.wishlistCategories.toArray(),
    db.incomes.toArray(),
    db.variables.toArray(),
  ]);
  return { accounts, accountTransfers, incomeEvents, settings, categories, transactions, wishlist, wishlistCategories, incomes, variables, exportedAt: new Date().toISOString(), version: 6 };
}

export async function importData(data, mode = 'replace') {
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
    await db.variables.clear();
  }

  const preserveIds = mode === 'replace';
  const rows = (items = []) => preserveIds ? items : items.map(stripId);

  if (data.accounts?.length) await db.accounts.bulkAdd(rows(data.accounts));
  const fallbackAccountId = await getDefaultAccountId();

  const accountRows = (items = []) => rows(items).map(item => ({
    ...item,
    accountId: item.accountId ?? fallbackAccountId,
  }));
  const incomeEventRows = (items = []) => accountRows(items).map(item => {
    const next = { ...item };
    if (!next.receiptKey) delete next.receiptKey;
    return next;
  });

  if (data.settings?.length) await db.settings.bulkAdd(accountRows(data.settings));
  if (data.categories?.length) await db.categories.bulkAdd(accountRows(data.categories));
  if (data.transactions?.length) await db.transactions.bulkAdd(accountRows(data.transactions));
  if (data.wishlist?.length) await db.wishlist.bulkAdd(accountRows(data.wishlist));
  if (data.wishlistCategories?.length) await db.wishlistCategories.bulkAdd(accountRows(data.wishlistCategories));
  if (data.incomes?.length) await db.incomes.bulkAdd(accountRows(data.incomes));
  if (data.variables?.length) await db.variables.bulkAdd(accountRows(data.variables));
  if (data.incomeEvents?.length) {
    for (const event of incomeEventRows(data.incomeEvents)) {
      try {
        await db.incomeEvents.add(event);
      } catch (error) {
        if (error?.name !== 'ConstraintError') throw error;
      }
    }
  }
  if (data.accountTransfers?.length) await db.accountTransfers.bulkAdd(rows(data.accountTransfers));
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
