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
  restoreCategory,
  exportData,
  borrowBudgetBetweenCategories,
  topUpCategoryFromIncome,
  recalculateSpendCounters,
  resetBudget,
  resetCategoriesForIncome,
  resetCategoryTopUps,
  transferMoney,
  addSplitTransaction,
  addRule,
  getRules,
  addTemplate,
  getTemplates,
  logTemplate,
  addGoal,
  getGoals,
  contributeToGoal,
  autoContributeGoals,
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

  it('bulk-adds rows with per-row categories in one pass', async () => {
    const foodId = await makeCategory({ name: 'Food' });
    const funId = await makeCategory({ name: 'Fun' });

    await addTransactionsBulk([
      { categoryId: foodId, amount: 10 },
      { categoryId: foodId, amount: 15 },
      { categoryId: funId, amount: 20 },
      { categoryId: funId, amount: 5, type: 'refund' },
      { categoryId: null, amount: 99 },   // no category — dropped
    ], accountId);

    expect((await getCategory(foodId)).spent).toBe(25);
    expect((await getCategory(funId)).spent).toBe(15);      // 20 − 5 refund
    expect((await getAccount(accountId)).balance).toBe(960); // 1000 − 40 + 5
    expect(await db.transactions.count()).toBe(4);
  });

  it('refunds the account when a category is deleted with its transactions', async () => {
    const catId = await makeCategory();
    await addTransaction({ accountId, categoryId: catId, amount: 75 });
    await deleteCategory(catId);

    expect(await db.transactions.count()).toBe(0);
    expect((await getAccount(accountId)).balance).toBe(1000);
  });
});

describe('receipts stay out of the JSON export', () => {
  it('drops the blobs and reports how many it left behind', async () => {
    const catId = await makeCategory();
    await addTransaction({
      accountId, categoryId: catId, amount: 12, note: 'Lunch',
      receipt: new Blob(['full']), receiptThumb: new Blob(['thumb']),
      receiptMeta: { bytes: 9 },
    });
    await addTransaction({ accountId, categoryId: catId, amount: 8, note: 'Coffee' });

    const exported = await exportData();
    const withPhoto = exported.transactions.find(tx => tx.note === 'Lunch');

    expect(exported.receiptsOmitted).toBe(1);
    expect(withPhoto).not.toHaveProperty('receipt');
    expect(withPhoto).not.toHaveProperty('receiptThumb');
    expect(withPhoto).not.toHaveProperty('receiptMeta');
    // Everything else about the row is untouched.
    expect(withPhoto.amount).toBe(12);

    // A JSON round trip is the thing that would otherwise silently corrupt.
    expect(() => JSON.stringify(exported)).not.toThrow();
    expect(JSON.parse(JSON.stringify(exported)).transactions).toHaveLength(2);
  });

  it('reports nothing omitted when no receipts exist', async () => {
    const catId = await makeCategory();
    await addTransaction({ accountId, categoryId: catId, amount: 8 });

    expect((await exportData()).receiptsOmitted).toBe(0);
  });
});

describe('category delete is reversible', () => {
  it('hands back everything it removed', async () => {
    const catId = await makeCategory();
    await addTransaction({ accountId, categoryId: catId, amount: 75 });
    await addTransaction({ accountId, categoryId: catId, amount: 25 });
    await db.subscriptions.add({ accountId, categoryId: catId, name: 'Netflix', amount: 10 });

    const snapshot = await deleteCategory(catId);

    expect(snapshot.category.id).toBe(catId);
    expect(snapshot.transactions).toHaveLength(2);
    expect(snapshot.subscriptions).toHaveLength(1);
  });

  it('restores the rows with their original ids, not lookalike copies', async () => {
    const catId = await makeCategory();
    const txId = await addTransaction({ accountId, categoryId: catId, amount: 75, note: 'Milk' });
    const subId = await db.subscriptions.add({ accountId, categoryId: catId, name: 'Netflix', amount: 10 });

    const snapshot = await deleteCategory(catId);
    await restoreCategory(snapshot);

    expect((await getCategory(catId)).name).toBe('Groceries');
    expect((await db.transactions.get(txId)).note).toBe('Milk');
    expect((await db.subscriptions.get(subId)).name).toBe('Netflix');
    expect(await db.transactions.count()).toBe(1);
  });

  it('puts the account balance back exactly, including refunds', async () => {
    const catId = await makeCategory();
    await addTransaction({ accountId, categoryId: catId, amount: 75 });
    await addTransaction({ accountId, categoryId: catId, amount: 20, type: 'refund' });

    const before = (await getAccount(accountId)).balance;
    const snapshot = await deleteCategory(catId);
    expect((await getAccount(accountId)).balance).not.toBe(before);

    await restoreCategory(snapshot);
    expect((await getAccount(accountId)).balance).toBe(before);
  });

  it('leaves the spend counter matching the restored transaction log', async () => {
    const catId = await makeCategory();
    await addTransaction({ accountId, categoryId: catId, amount: 75 });
    await addTransaction({ accountId, categoryId: catId, amount: 20, type: 'refund' });
    const spentBefore = (await getCategory(catId)).spent;

    await restoreCategory(await deleteCategory(catId));

    expect((await getCategory(catId)).spent).toBe(spentBefore);
    const report = await recalculateSpendCounters(accountId);
    expect(report.repaired).toBe(0);
  });

  it('is idempotent — a double undo does not credit the account twice', async () => {
    const catId = await makeCategory();
    await addTransaction({ accountId, categoryId: catId, amount: 75 });

    const before = (await getAccount(accountId)).balance;
    const snapshot = await deleteCategory(catId);
    await restoreCategory(snapshot);
    await restoreCategory(snapshot);

    expect((await getAccount(accountId)).balance).toBe(before);
    expect(await db.transactions.count()).toBe(1);
  });

  it('ignores an empty snapshot rather than throwing', async () => {
    await expect(restoreCategory(null)).resolves.toBe(0);
    await expect(restoreCategory({})).resolves.toBe(0);
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

describe('refunds', () => {
  it('reduces category spend and credits the account', async () => {
    const catId = await makeCategory();
    await addTransaction({ accountId, categoryId: catId, amount: 100 });
    await addTransaction({ accountId, categoryId: catId, amount: 30, type: 'refund' });

    expect((await getCategory(catId)).spent).toBe(70);
    expect((await getAccount(accountId)).balance).toBe(930); // -100 +30
  });

  it('reverses cleanly on delete', async () => {
    const catId = await makeCategory();
    await addTransaction({ accountId, categoryId: catId, amount: 100 });
    const refundId = await addTransaction({ accountId, categoryId: catId, amount: 30, type: 'refund' });
    await deleteTransaction(refundId);

    expect((await getCategory(catId)).spent).toBe(100);
    expect((await getAccount(accountId)).balance).toBe(900);
  });

  it('flips both counters when an expense is switched to a refund', async () => {
    const catId = await makeCategory();
    const txId = await addTransaction({ accountId, categoryId: catId, amount: 40 });
    await updateTransaction(txId, { type: 'refund' });

    expect((await getCategory(catId)).spent).toBe(0);
    expect((await getAccount(accountId)).balance).toBe(1040);
    // Stored amount stays positive; `type` carries the direction.
    expect((await db.transactions.get(txId)).amount).toBe(40);
  });

  it('is counted signed when counters are rebuilt', async () => {
    const catId = await makeCategory();
    await addTransaction({ accountId, categoryId: catId, amount: 80 });
    await addTransaction({ accountId, categoryId: catId, amount: 20, type: 'refund' });
    await db.categories.update(catId, { spent: 999 });

    await recalculateSpendCounters(accountId);
    expect((await getCategory(catId)).spent).toBe(60);
  });
});

describe('split transactions', () => {
  it('writes one transaction per part, sharing a split group', async () => {
    const foodId = await makeCategory({ name: 'Food' });
    const funId = await makeCategory({ name: 'Fun' });

    const ids = await addSplitTransaction({
      accountId,
      merchant: 'Supermarket',
      parts: [{ categoryId: foodId, amount: 60 }, { categoryId: funId, amount: 15 }],
    });

    expect(ids).toHaveLength(2);
    expect((await getCategory(foodId)).spent).toBe(60);
    expect((await getCategory(funId)).spent).toBe(15);
    expect((await getAccount(accountId)).balance).toBe(925);

    const rows = await db.transactions.toArray();
    expect(new Set(rows.map(r => r.splitGroupId)).size).toBe(1);
    expect(rows.every(r => r.merchant === 'Supermarket')).toBe(true);
  });

  it('drops zero-amount parts and no-ops on an empty split', async () => {
    const catId = await makeCategory();
    await addSplitTransaction({ accountId, parts: [{ categoryId: catId, amount: 10 }, { categoryId: catId, amount: 0 }] });
    expect(await db.transactions.count()).toBe(1);

    expect(await addSplitTransaction({ accountId, parts: [] })).toEqual([]);
  });

  it('lets one part be deleted independently', async () => {
    const foodId = await makeCategory({ name: 'Food' });
    const funId = await makeCategory({ name: 'Fun' });
    const [firstId] = await addSplitTransaction({
      accountId, parts: [{ categoryId: foodId, amount: 60 }, { categoryId: funId, amount: 15 }],
    });

    await deleteTransaction(firstId);

    expect((await getCategory(foodId)).spent).toBe(0);
    expect((await getCategory(funId)).spent).toBe(15);
  });
});

describe('rules and templates', () => {
  it('sorts rules by priority, then by most specific match', async () => {
    const catId = await makeCategory();
    await addRule({ match: 'tesco', categoryId: catId, priority: 1 }, accountId);
    await addRule({ match: 'tesco express', categoryId: catId, priority: 1 }, accountId);
    await addRule({ match: 'aldi', categoryId: catId, priority: 0 }, accountId);

    const rules = await getRules(accountId);
    expect(rules.map(r => r.match)).toEqual(['aldi', 'tesco express', 'tesco']);
  });

  it('logs a template as an expense and counts the use', async () => {
    const catId = await makeCategory();
    const templateId = await addTemplate({ name: 'Coffee', categoryId: catId, amount: 3.2 }, accountId);

    await logTemplate(templateId, accountId);
    await logTemplate(templateId, accountId);

    expect((await getCategory(catId)).spent).toBe(6.4);
    expect((await db.templates.get(templateId)).useCount).toBe(2);
  });

  it('orders templates by how often they are used', async () => {
    const catId = await makeCategory();
    await addTemplate({ name: 'Rare', categoryId: catId, amount: 1 }, accountId);
    const commonId = await addTemplate({ name: 'Common', categoryId: catId, amount: 2 }, accountId);
    await logTemplate(commonId, accountId);

    expect((await getTemplates(accountId)).map(t => t.name)).toEqual(['Common', 'Rare']);
  });
});

describe('category rollover', () => {
  it('carries unspent budget into the next cycle when enabled', async () => {
    const catId = await makeCategory({ allowance: 300, rolloverEnabled: true });
    await addTransaction({ accountId, categoryId: catId, amount: 100 });

    await resetCategoriesForIncome(1, new Date().toISOString(), accountId);

    const cat = await getCategory(catId);
    expect(cat.spent).toBe(0);
    expect(cat.rolloverBalance).toBe(200);
  });

  it('accumulates across several cycles', async () => {
    const catId = await makeCategory({ allowance: 100, rolloverEnabled: true });

    await resetCategoriesForIncome(1, new Date().toISOString(), accountId);
    expect((await getCategory(catId)).rolloverBalance).toBe(100);

    await resetCategoriesForIncome(1, new Date().toISOString(), accountId);
    expect((await getCategory(catId)).rolloverBalance).toBe(200);
  });

  it('does nothing unless the category opts in', async () => {
    const catId = await makeCategory({ allowance: 300 });
    await addTransaction({ accountId, categoryId: catId, amount: 100 });

    await resetCategoriesForIncome(1, new Date().toISOString(), accountId);
    expect((await getCategory(catId)).rolloverBalance).toBe(0);
  });

  it('drops overspend by default, but carries it when asked', async () => {
    const forgiving = await makeCategory({ allowance: 100, rolloverEnabled: true });
    const strict = await makeCategory({ allowance: 100, rolloverEnabled: true, rolloverCarryOverspend: true });
    await addTransaction({ accountId, categoryId: forgiving, amount: 150 });
    await addTransaction({ accountId, categoryId: strict, amount: 150 });

    await resetBudget(accountId);

    expect((await getCategory(forgiving)).rolloverBalance).toBe(0);
    expect((await getCategory(strict)).rolloverBalance).toBe(-50);
  });

  it('does not convert an unspent top-up into permanent budget', async () => {
    const catId = await makeCategory({ allowance: 100, rolloverEnabled: true });
    await topUpCategoryFromIncome(catId, 50);

    await resetBudget(accountId);

    const cat = await getCategory(catId);
    expect(cat.rolloverBalance).toBe(100); // the allowance, not 150
    expect(cat.temporaryBoost).toBe(0);
  });

  it('leaves rollover alone on a partial reset', async () => {
    const catId = await makeCategory({
      allowance: 200,
      rolloverEnabled: true,
      incomeAllocations: [{ incomeId: 1, percent: 50 }, { incomeId: 2, percent: 50 }],
    });
    await addTransaction({ accountId, categoryId: catId, amount: 60 });

    await resetCategoriesForIncome(1, new Date().toISOString(), accountId);
    expect((await getCategory(catId)).rolloverBalance ?? 0).toBe(0); // cycle not finished

    await resetCategoriesForIncome(2, new Date().toISOString(), accountId);
    expect((await getCategory(catId)).rolloverBalance).toBe(140);
  });
});

describe('goals', () => {
  it('caps a contribution at the target and never goes negative', async () => {
    const goalId = await addGoal({ name: 'Laptop', target: 100, perCycleContribution: 25 }, accountId);

    expect(await contributeToGoal(goalId, 40)).toBe(40);
    expect(await contributeToGoal(goalId, 500)).toBe(100);   // capped at target
    expect(await contributeToGoal(goalId, -250)).toBe(0);    // floored at zero
  });

  it('takes the per-cycle contribution from linked goals when income lands', async () => {
    const linked = await addGoal({ name: 'Holiday', target: 1000, perCycleContribution: 100, incomeId: 1 }, accountId);
    const other = await addGoal({ name: 'Car', target: 500, perCycleContribution: 50, incomeId: 2 }, accountId);

    const count = await autoContributeGoals(1, accountId, '2026-07-25T00:00:00.000Z');

    expect(count).toBe(1);
    expect((await db.goals.get(linked)).saved).toBe(100);
    expect((await db.goals.get(other)).saved).toBe(0);
  });

  it('does not contribute twice for the same pay date', async () => {
    const goalId = await addGoal({ name: 'Holiday', target: 1000, perCycleContribution: 100, incomeId: 1 }, accountId);
    const at = '2026-07-25T00:00:00.000Z';

    await autoContributeGoals(1, accountId, at);
    await autoContributeGoals(1, accountId, at); // live queries can re-fire this

    expect((await db.goals.get(goalId)).saved).toBe(100);

    await autoContributeGoals(1, accountId, '2026-08-25T00:00:00.000Z');
    expect((await db.goals.get(goalId)).saved).toBe(200);
  });

  it('stops contributing once the target is reached', async () => {
    const goalId = await addGoal({ name: 'Small', target: 120, perCycleContribution: 100, incomeId: 1 }, accountId);

    await autoContributeGoals(1, accountId, '2026-07-25T00:00:00.000Z');
    await autoContributeGoals(1, accountId, '2026-08-25T00:00:00.000Z');
    await autoContributeGoals(1, accountId, '2026-09-25T00:00:00.000Z');

    expect((await db.goals.get(goalId)).saved).toBe(120);
  });

  it('sorts unfinished goals by target date and sinks completed ones', async () => {
    await addGoal({ name: 'Done', target: 10, saved: 10 }, accountId);
    await addGoal({ name: 'Later', target: 100, targetDate: '2027-01-01' }, accountId);
    await addGoal({ name: 'Sooner', target: 100, targetDate: '2026-09-01' }, accountId);

    expect((await getGoals(accountId)).map(g => g.name)).toEqual(['Sooner', 'Later', 'Done']);
  });

  it('does not touch the account balance — a goal is an earmark, not a transfer', async () => {
    const goalId = await addGoal({ name: 'Laptop', target: 100 }, accountId);
    await contributeToGoal(goalId, 60);

    expect((await getAccount(accountId)).balance).toBe(1000);
  });
});

describe('recalculateSpendCounters day boundaries', () => {
  it('counts a transaction logged earlier on the reset day', async () => {
    // dateOnlyToISO stores transactions at local midnight, while lastReset is a
    // full timestamp. Comparing them directly wrongly excluded same-day spend.
    const midday = new Date();
    midday.setHours(12, 0, 0, 0);
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);

    const catId = await makeCategory({ lastReset: midday.toISOString() });
    await addTransaction({ accountId, categoryId: catId, amount: 50.75, date: midnight.toISOString() });

    const report = await recalculateSpendCounters(accountId);

    expect((await getCategory(catId)).spent).toBe(50.75);
    expect(report.repaired).toBe(0);
  });

  it('still excludes spend from before the reset day', async () => {
    const catId = await makeCategory({ lastReset: new Date('2026-07-15T09:00:00Z').toISOString() });
    await addTransaction({ accountId, categoryId: catId, amount: 10, date: new Date('2026-07-14T23:00:00Z').toISOString() });
    await addTransaction({ accountId, categoryId: catId, amount: 25, date: new Date('2026-07-16T09:00:00Z').toISOString() });

    await recalculateSpendCounters(accountId);
    expect((await getCategory(catId)).spent).toBe(25);
  });
});
