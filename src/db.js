import Dexie from 'dexie';

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

// ── Settings helpers ─────────────────────────────────────────────────────────
export async function getSettings() {
  const all = await db.settings.toArray();
  return all[0] || null;
}

export async function saveSettings(data) {
  const existing = await db.settings.toArray();
  if (existing.length > 0) {
    await db.settings.update(existing[0].id, data);
  } else {
    await db.settings.add(data);
  }
}

// ── Category helpers ─────────────────────────────────────────────────────────
export async function getCategories() {
  return db.categories.toArray();
}

export async function addCategory(cat) {
  return db.categories.add({ ...cat, spent: 0 });
}

export async function updateCategory(id, data) {
  return db.categories.update(id, data);
}

export async function deleteCategory(id) {
  // Also delete transactions for this category
  await db.transactions.where('categoryId').equals(id).delete();
  return db.categories.delete(id);
}

// ── Transaction helpers ──────────────────────────────────────────────────────
export async function getTransactions() {
  return db.transactions.orderBy('date').reverse().toArray();
}

export async function addTransaction(tx) {
  const id = await db.transactions.add({ ...tx, date: tx.date || new Date().toISOString() });
  // Update category spent
  const cat = await db.categories.get(tx.categoryId);
  if (cat) {
    await db.categories.update(tx.categoryId, { spent: (cat.spent || 0) + tx.amount });
  }
  return id;
}

export async function deleteTransaction(id) {
  const tx = await db.transactions.get(id);
  if (tx) {
    const cat = await db.categories.get(tx.categoryId);
    if (cat) {
      await db.categories.update(tx.categoryId, { spent: Math.max(0, (cat.spent || 0) - tx.amount) });
    }
  }
  return db.transactions.delete(id);
}

// ── Wishlist helpers ─────────────────────────────────────────────────────────
export async function getWishlistItems() {
  return db.wishlist.toArray();
}

export async function addWishlistItem(item) {
  return db.wishlist.add(item);
}

export async function updateWishlistItem(id, data) {
  return db.wishlist.update(id, data);
}

export async function deleteWishlistItem(id) {
  return db.wishlist.delete(id);
}

export async function getWishlistCategories() {
  return db.wishlistCategories.toArray();
}

export async function addWishlistCategory(cat) {
  return db.wishlistCategories.add(cat);
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
export async function addIncome(income) {
  return db.incomes.add(income);
}

export async function updateIncome(id, data) {
  return db.incomes.update(id, data);
}

export async function deleteIncome(id) {
  return db.incomes.delete(id);
}

// ── Variable helpers ──────────────────────────────────────────────────────────
export async function addVariable(variable) {
  return db.variables.add(variable);
}

export async function updateVariable(id, data) {
  return db.variables.update(id, data);
}

export async function deleteVariable(id) {
  return db.variables.delete(id);
}

// ── Budget reset ─────────────────────────────────────────────────────────────
export async function resetBudget() {
  const now = new Date().toISOString();
  const cats = await db.categories.toArray();
  for (const cat of cats) {
    await db.categories.update(cat.id, { spent: 0, lastReset: now });
  }
}

export async function resetCategory(id) {
  await db.categories.update(id, { spent: 0, lastReset: new Date().toISOString() });
}

export async function resetCategoriesForIncome(incomeId, resetAt = new Date().toISOString()) {
  const id = Number(incomeId);
  const cats = await db.categories.toArray();
  let resetCount = 0;

  for (const cat of cats) {
    const usesIncome = Array.isArray(cat.incomeAllocations)
      && cat.incomeAllocations.some(allocation => Number(allocation.incomeId) === id && Number(allocation.percent) > 0);

    if (usesIncome) {
      await db.categories.update(cat.id, { spent: 0, lastReset: resetAt });
      resetCount += 1;
    }
  }

  return resetCount;
}

// ── Export / Import ──────────────────────────────────────────────────────────
export async function exportData() {
  const [settings, categories, transactions, wishlist, wishlistCategories, incomes, variables] = await Promise.all([
    db.settings.toArray(),
    db.categories.toArray(),
    db.transactions.toArray(),
    db.wishlist.toArray(),
    db.wishlistCategories.toArray(),
    db.incomes.toArray(),
    db.variables.toArray(),
  ]);
  return { settings, categories, transactions, wishlist, wishlistCategories, incomes, variables, exportedAt: new Date().toISOString(), version: 4 };
}

export async function importData(data, mode = 'replace') {
  if (mode === 'replace') {
    await db.settings.clear();
    await db.categories.clear();
    await db.transactions.clear();
    await db.wishlist.clear();
    await db.wishlistCategories.clear();
    await db.incomes.clear();
    await db.variables.clear();
  }
  if (data.settings?.length) await db.settings.bulkAdd(data.settings.map(s => { const {id,...r}=s; return r; }));
  if (data.categories?.length) await db.categories.bulkAdd(data.categories.map(s => { const {id,...r}=s; return r; }));
  if (data.transactions?.length) await db.transactions.bulkAdd(data.transactions.map(s => { const {id,...r}=s; return r; }));
  if (data.wishlist?.length) await db.wishlist.bulkAdd(data.wishlist.map(s => { const {id,...r}=s; return r; }));
  if (data.wishlistCategories?.length) await db.wishlistCategories.bulkAdd(data.wishlistCategories.map(s => { const {id,...r}=s; return r; }));
  if (data.incomes?.length) await db.incomes.bulkAdd(data.incomes.map(s => { const {id,...r}=s; return r; }));
  if (data.variables?.length) await db.variables.bulkAdd(data.variables.map(s => { const {id,...r}=s; return r; }));
}

export async function exportTransactionsCSV() {
  const [transactions, categories] = await Promise.all([
    db.transactions.orderBy('date').reverse().toArray(),
    db.categories.toArray(),
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
