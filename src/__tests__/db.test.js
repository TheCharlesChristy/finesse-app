import { beforeEach, describe, expect, it } from 'vitest';

import {
  db,
  addAccount,
  addCategory,
  addTransaction,
  addTransactionsBulk,
  updateTransaction,
  deleteTransaction,
  deleteCategory,
  borrowBudgetBetweenCategories,
  topUpCategoryFromIncome,
  recalculateSpendCounters,
  resetBudget,
  resetCategoriesForIncome,
  resetCategoryTopUps,
  transferMoney,
} from '../db';

const getCategory = (id) => db.categories.get(id);
const getAccount = (id) => db.accounts.get(id);

let accountId;

beforeEach(async () => {
  // Dexie keeps one connection per database name; clearing the tables between
  // tests is faster and less brittle than tearing the schema down each time.
  if (!db.isOpen()) await db.open();
  await Promise.all(db.tables.map(table => table.clear()));
  accountId = await addAccount({ name: 'Test', balance: 1000 });
});

async function makeCategory(overrides = {}) {
  const id = await addCategory({
    name: 'Groceries',
    allowance: 300,
    incomeAllocations: [{ incomeId: 1, percent: 100 }],
    lastReset: new Date('2026-07-01').toISOString(),
    ...overrides,
  }, accountId);
  return id;
}

describe('spend counter invariants', () => {
  it('increments category spend and debits the account on add', async () => {
    const catId = await makeCategory();
    await addTransaction({ accountId, categoryId: catId, amount: 25.5, note: 'Milk' });

    expect((await getCategory(catId)).spent).toBe(25.5);
    expect((await getAccount(accountId)).balance).toBe(974.5);
  });

  it('reverses both on delete', async () => {
    const catId = await makeCategory();
    const txId = await addTransaction({ accountId, categoryId: catId, amount: 40 });
    await deleteTransaction(txId);

    expect((await getCategory(catId)).spent).toBe(0);
    expect((await getAccount(accountId)).balance).toBe(1000);
  });

  it('applies only the difference when an amount is edited', async () => {
    const catId = await makeCategory();
    const txId = await addTransaction({ accountId, categoryId: catId, amount: 30 });
    await updateTransaction(txId, { amount: 50 });

    expect((await getCategory(catId)).spent).toBe(50);
    expect((await getAccount(accountId)).balance).toBe(950);
  });

  it('moves spend between categories when the category is changed', async () => {
    const foodId = await makeCategory({ name: 'Food' });
    const funId = await makeCategory({ name: 'Fun' });
    const txId = await addTransaction({ accountId, categoryId: foodId, amount: 60 });

    await updateTransaction(txId, { categoryId: funId });

    expect((await getCategory(foodId)).spent).toBe(0);
    expect((await getCategory(funId)).spent).toBe(60);
    // Balance is unchanged: the money still left the account.
    expect((await getAccount(accountId)).balance).toBe(940);
  });

  it('never drives a spend counter below zero', async () => {
    const catId = await makeCategory();
    const txId = await addTransaction({ accountId, categoryId: catId, amount: 20 });
    await db.categories.update(catId, { spent: 5 }); // simulate drift
    await deleteTransaction(txId);

    expect((await getCategory(catId)).spent).toBe(0);
  });

  it('totals a bulk add in one pass', async () => {
    const catId = await makeCategory();
    await addTransactionsBulk({
      accountId,
      categoryId: catId,
      transactions: [{ amount: 10 }, { amount: 20 }, { amount: 5.25 }, { amount: 0 }],
    });

    // The zero-amount row is dropped.
    expect(await db.transactions.count()).toBe(3);
    expect((await getCategory(catId)).spent).toBe(35.25);
    expect((await getAccount(accountId)).balance).toBe(964.75);
  });

  it('refunds the account when a category is deleted with its transactions', async () => {
    const catId = await makeCategory();
    await addTransaction({ accountId, categoryId: catId, amount: 75 });
    await deleteCategory(catId);

    expect(await db.transactions.count()).toBe(0);
    expect((await getAccount(accountId)).balance).toBe(1000);
  });
});

describe('spentByIncome buckets', () => {
  it('splits spend across funding incomes by percentage', async () => {
    const catId = await makeCategory({
      incomeAllocations: [{ incomeId: 1, percent: 60 }, { incomeId: 2, percent: 40 }],
    });
    await addTransaction({ accountId, categoryId: catId, amount: 100 });

    const cat = await getCategory(catId);
    expect(cat.spentByIncome).toEqual({ 1: 60, 2: 40 });
  });

  it('clears one income\'s bucket on that income\'s reset, leaving the rest', async () => {
    const catId = await makeCategory({
      incomeAllocations: [{ incomeId: 1, percent: 50 }, { incomeId: 2, percent: 50 }],
    });
    await addTransaction({ accountId, categoryId: catId, amount: 100 });

    const resetCount = await resetCategoriesForIncome(1, new Date().toISOString(), accountId);

    const cat = await getCategory(catId);
    expect(resetCount).toBe(1);
    expect(cat.spent).toBe(50);
    expect(cat.spentByIncome).toEqual({ 2: 50 });
  });

  it('clears boosts only once the category is fully reset', async () => {
    const catId = await makeCategory({
      incomeAllocations: [{ incomeId: 1, percent: 50 }, { incomeId: 2, percent: 50 }],
    });
    await addTransaction({ accountId, categoryId: catId, amount: 100 });
    await topUpCategoryFromIncome(catId, 40);

    await resetCategoriesForIncome(1, new Date().toISOString(), accountId);
    expect((await getCategory(catId)).temporaryBoost).toBe(40); // partial reset

    await resetCategoriesForIncome(2, new Date().toISOString(), accountId);
    const cat = await getCategory(catId);
    expect(cat.spent).toBe(0);
    expect(cat.temporaryBoost).toBe(0);
    expect(cat.boostSources).toEqual([]);
  });

  it('leaves categories funded by other incomes untouched', async () => {
    const mine = await makeCategory({ incomeAllocations: [{ incomeId: 1, percent: 100 }] });
    const theirs = await makeCategory({ incomeAllocations: [{ incomeId: 2, percent: 100 }] });
    await addTransaction({ accountId, categoryId: mine, amount: 30 });
    await addTransaction({ accountId, categoryId: theirs, amount: 30 });

    await resetCategoriesForIncome(1, new Date().toISOString(), accountId);

    expect((await getCategory(mine)).spent).toBe(0);
    expect((await getCategory(theirs)).spent).toBe(30);
  });
});

describe('budget top-ups', () => {
  it('borrows only up to the lender\'s spare and moves it both ways', async () => {
    const lender = await makeCategory({ name: 'Lender', allowance: 100 });
    const borrower = await makeCategory({ name: 'Borrower', allowance: 100 });
    await addTransaction({ accountId, categoryId: lender, amount: 70 }); // £30 spare

    await borrowBudgetBetweenCategories(lender, borrower, 50); // clamped to 30

    expect((await getCategory(lender)).temporaryBoost).toBe(-30);
    expect((await getCategory(borrower)).temporaryBoost).toBe(30);
  });

  it('undoes every top-up a category received, returning borrowed amounts', async () => {
    const lender = await makeCategory({ name: 'Lender', allowance: 100 });
    const borrower = await makeCategory({ name: 'Borrower', allowance: 100 });

    await borrowBudgetBetweenCategories(lender, borrower, 25);
    await topUpCategoryFromIncome(borrower, 15);
    await resetCategoryTopUps(borrower);

    expect((await getCategory(borrower)).temporaryBoost).toBe(0);
    expect((await getCategory(borrower)).boostSources).toEqual([]);
    expect((await getCategory(lender)).temporaryBoost).toBe(0);
  });

  it('resetBudget clears spend and boosts across the account', async () => {
    const catId = await makeCategory();
    await addTransaction({ accountId, categoryId: catId, amount: 50 });
    await topUpCategoryFromIncome(catId, 20);

    await resetBudget(accountId);

    const cat = await getCategory(catId);
    expect(cat.spent).toBe(0);
    expect(cat.temporaryBoost).toBe(0);
    expect(cat.spentByIncome).toEqual({});
  });
});

describe('transfers', () => {
  it('moves money between accounts', async () => {
    const otherId = await addAccount({ name: 'Savings', balance: 0 });
    await transferMoney({ fromAccountId: accountId, toAccountId: otherId, amount: 250 });

    expect((await getAccount(accountId)).balance).toBe(750);
    expect((await getAccount(otherId)).balance).toBe(250);
  });

  it('rejects same-account and non-positive transfers', async () => {
    expect(await transferMoney({ fromAccountId: accountId, toAccountId: accountId, amount: 50 })).toBe(0);
    expect(await transferMoney({ fromAccountId: accountId, toAccountId: accountId + 1, amount: 0 })).toBe(0);
    expect((await getAccount(accountId)).balance).toBe(1000);
  });
});

describe('B7 — recalculateSpendCounters', () => {
  it('repairs a counter that has drifted from the transaction log', async () => {
    const catId = await makeCategory();
    await addTransaction({ accountId, categoryId: catId, amount: 40 });
    await addTransaction({ accountId, categoryId: catId, amount: 60 });

    await db.categories.update(catId, { spent: 12.34 }); // corrupt it

    const report = await recalculateSpendCounters(accountId);

    expect((await getCategory(catId)).spent).toBe(100);
    expect(report.repaired).toBe(1);
    expect(report.categories[0]).toMatchObject({ stored: 12.34, actual: 100 });
  });

  it('reports no repairs when counters already agree', async () => {
    const catId = await makeCategory();
    await addTransaction({ accountId, categoryId: catId, amount: 40 });

    const report = await recalculateSpendCounters(accountId);

    expect(report.checked).toBe(1);
    expect(report.repaired).toBe(0);
  });

  it('counts only transactions since the category\'s last reset', async () => {
    const catId = await makeCategory({ lastReset: new Date('2026-07-15').toISOString() });
    await addTransaction({ accountId, categoryId: catId, amount: 10, date: new Date('2026-07-10').toISOString() });
    await addTransaction({ accountId, categoryId: catId, amount: 25, date: new Date('2026-07-20').toISOString() });

    await recalculateSpendCounters(accountId);

    expect((await getCategory(catId)).spent).toBe(25);
  });

  it('rebuilds the per-income buckets alongside the total', async () => {
    const catId = await makeCategory({
      incomeAllocations: [{ incomeId: 1, percent: 25 }, { incomeId: 2, percent: 75 }],
    });
    await addTransaction({ accountId, categoryId: catId, amount: 200 });
    await db.categories.update(catId, { spent: 0, spentByIncome: {} });

    await recalculateSpendCounters(accountId);

    const cat = await getCategory(catId);
    expect(cat.spent).toBe(200);
    expect(cat.spentByIncome).toEqual({ 1: 50, 2: 150 });
  });
});
