import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  db,
  addTransaction,
  exportData,
  stageBudgetConfig,
  cancelStagedBudgetConfig,
  applyStagedBudgetConfig,
  reconcileStagedBudgetConfig,
  undoBudgetConfigApply,
  getBudgetConfigContext,
  getSettings,
  saveSettings,
  patchSettings,
  resetCategoriesForIncome,
} from '../db';
import { buildBudgetConfigPlan } from '../budgetConfig';
import { getEffectiveAllowance } from '../utils';

const REFERENCE = JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/finesse-category-config-v1.json', import.meta.url)), 'utf8'));

const ACCOUNT_ID = 3;
const INCOME_ID = 1;
const clone = (value) => JSON.parse(JSON.stringify(value));

const cat = (id) => db.categories.get(id);
const allocation = [{ incomeId: INCOME_ID, percent: 100 }];

/**
 * The account the reference config targets, built with the exact ids it names.
 * Dexie honours an inbound key on a `++id` table, which is what lets the
 * fixture's `update` ids mean something here.
 */
beforeEach(async () => {
  if (!db.isOpen()) await db.open();
  await Promise.all(db.tables.map(table => table.clear()));

  await db.accounts.add({ id: ACCOUNT_ID, name: 'Current', balance: 3000 });
  await db.incomes.add({
    id: INCOME_ID, accountId: ACCOUNT_ID, name: 'LM', amount: 2400,
    resetFrequency: 'monthly', payDayOfMonth: 24, lastPaid: '2026-07-24T00:00:00.000Z',
  });
  await saveSettings({ accountId: ACCOUNT_ID, payDayOfMonth: 24 }, ACCOUNT_ID);

  await db.variables.bulkAdd([
    { id: 5, accountId: ACCOUNT_ID, name: 'Bills', value: 610 },
    { id: 6, accountId: ACCOUNT_ID, name: 'Subs', value: 39 },
    { id: 7, accountId: ACCOUNT_ID, name: 'AnnualBills', value: 720 },
  ]);

  const base = {
    accountId: ACCOUNT_ID, spentByIncome: {}, incomeResetAt: {},
    temporaryBoost: 0, boostSources: [], incomeAllocations: allocation,
  };
  await db.categories.bulkAdd([
    { ...base, id: 10, name: 'Household Bills', allowance: 610, spent: 120 },
    { ...base, id: 11, name: 'Subs & Streaming', allowance: 39, spent: 39 },
    { ...base, id: 12, name: 'Yearly Costs', allowance: 60, spent: 0 },
    { ...base, id: 13, name: 'Petrol', allowance: 180, spent: 65.4 },
    { ...base, id: 14, name: 'Food Shop', allowance: 340, spent: 210.55 },
    { ...base, id: 15, name: 'Rainy Day', allowance: 400, spent: 0 },
    { ...base, id: 16, name: 'Transport', allowance: 206.4, spent: 12 },
  ]);
});

async function stageReference(config = REFERENCE) {
  const context = await getBudgetConfigContext(ACCOUNT_ID);
  const plan = buildBudgetConfigPlan(config, context);
  return { plan, result: await stageBudgetConfig(ACCOUNT_ID, { config, plan, fileName: 'ref.json' }) };
}

/** Everything an import could touch, in a form that compares by value. */
async function snapshotBudget() {
  const [categories, variables] = await Promise.all([
    db.categories.orderBy('id').toArray(),
    db.variables.orderBy('id').toArray(),
  ]);
  return JSON.stringify({ categories, variables });
}

describe('staging', () => {
  it('writes nothing to the budget — the current cycle continues untouched', async () => {
    const before = await snapshotBudget();
    const { plan } = await stageReference();

    expect(plan.ok).toBe(true);
    expect(await snapshotBudget()).toBe(before);

    const settings = await getSettings(ACCOUNT_ID);
    expect(settings.stagedBudgetConfig.plan.categories).toHaveLength(9);
    expect(settings.stagedBudgetConfig.applyIncomeId).toBe(INCOME_ID);
  });

  it('refuses to stage a config that failed validation', async () => {
    const context = await getBudgetConfigContext(ACCOUNT_ID);
    const plan = buildBudgetConfigPlan({ ...REFERENCE, kind: 'nope' }, context);
    await expect(stageBudgetConfig(ACCOUNT_ID, { config: REFERENCE, plan }))
      .rejects.toThrow(/failed validation/);
  });

  it('replaces a previously staged config and reports what it displaced', async () => {
    await stageReference();
    const second = clone(REFERENCE);
    second.importerNotes = ['second'];
    const { result } = await stageReference(second);

    expect(result.replaced).not.toBeNull();
    expect(result.replaced.config.importerNotes).toHaveLength(3);
    const settings = await getSettings(ACCOUNT_ID);
    expect(settings.stagedBudgetConfig.config.importerNotes).toEqual(['second']);
  });

  it('can be cancelled before it lands', async () => {
    await stageReference();
    const cancelled = await cancelStagedBudgetConfig(ACCOUNT_ID);
    expect(cancelled).not.toBeNull();
    expect((await getSettings(ACCOUNT_ID)).stagedBudgetConfig).toBeNull();
  });
});

describe('applying', () => {
  it('refuses to apply mid-cycle, at another income’s reset', async () => {
    await stageReference();
    const result = await applyStagedBudgetConfig(ACCOUNT_ID, { incomeId: 99 });

    expect(result.applied).toBe(false);
    expect(result.reason).toBe('not-due');
    expect((await cat(10)).name).toBe('Household Bills');
  });

  it('applies at the reset of the income it is measured against', async () => {
    await stageReference();
    const result = await applyStagedBudgetConfig(ACCOUNT_ID, { incomeId: INCOME_ID });

    expect(result.applied).toBe(true);
    expect((await cat(10)).name).toBe('Bills');
    expect((await getSettings(ACCOUNT_ID)).stagedBudgetConfig).toBeNull();
  });

  it('keeps categories 10-15 and their transaction history through the rename', async () => {
    await addTransaction({
      accountId: ACCOUNT_ID, categoryId: 14, amount: 30, note: 'Shop', date: new Date().toISOString(),
    });
    const before = await db.transactions.where('categoryId').equals(14).toArray();

    await stageReference();
    await applyStagedBudgetConfig(ACCOUNT_ID, { incomeId: INCOME_ID });

    const renamed = await cat(14);
    expect(renamed.name).toBe('Groceries');
    expect(renamed.id).toBe(14);

    const after = await db.transactions.where('categoryId').equals(14).toArray();
    expect(after).toEqual(before);

    for (const id of [10, 11, 12, 13, 14, 15]) {
      expect((await cat(id)).id).toBe(id);
    }
  });

  it('leaves every spend counter exactly as it was', async () => {
    const before = Object.fromEntries(
      (await db.categories.toArray()).map(row => [row.id, row.spent]));

    await stageReference();
    await applyStagedBudgetConfig(ACCOUNT_ID, { incomeId: INCOME_ID });

    for (const [id, spent] of Object.entries(before)) {
      expect((await cat(Number(id))).spent).toBe(spent);
    }
  });

  it('writes the variables before the categories that dereference them', async () => {
    await stageReference();
    await applyStagedBudgetConfig(ACCOUNT_ID, { incomeId: INCOME_ID });

    const variables = await db.variables.where('accountId').equals(ACCOUNT_ID).toArray();
    expect(variables.find(v => v.name === 'AnnualBills').value).toBe(810);
    expect(variables.find(v => v.name === 'CostofFuelTank').value).toBe(60);
    // 810/12 — the *new* variable value, not the 720 that was there before.
    expect((await cat(12)).allowance).toBe(67.5);
  });

  it('creates the new categories and leaves unmentioned ones alone', async () => {
    await db.categories.add({
      id: 20, accountId: ACCOUNT_ID, name: 'Gifts', allowance: 15, spent: 3,
      spentByIncome: {}, incomeResetAt: {}, temporaryBoost: 0, boostSources: [],
    });

    await stageReference();
    await applyStagedBudgetConfig(ACCOUNT_ID, { incomeId: INCOME_ID });

    const names = (await db.categories.toArray()).map(c => c.name);
    expect(names).toContain('Eating Out');
    expect(names).toContain('Personal');
    // Never deleted, never altered.
    const gifts = await cat(20);
    expect(gifts.name).toBe('Gifts');
    expect(gifts.allowance).toBe(15);
    expect(gifts.spent).toBe(3);
  });

  it('sums the applied allowances to exactly the income', async () => {
    await stageReference();
    const result = await applyStagedBudgetConfig(ACCOUNT_ID, { incomeId: INCOME_ID });

    const configured = new Set(result.plan.categories.map(c => c.name));
    const total = (await db.categories.toArray())
      .filter(c => configured.has(c.name))
      .reduce((sum, c) => sum + c.allowance, 0);

    expect(Math.round(total * 100) / 100).toBe(2400);
  });

  it('re-evaluates formulas at apply time when income has changed', async () => {
    await stageReference();
    // The config's numbers are for validation; the formulas are the truth.
    await db.incomes.update(INCOME_ID, { amount: 3000 });

    const result = await applyStagedBudgetConfig(ACCOUNT_ID, { incomeId: INCOME_ID });

    // Income moved, so the fixed-cost categories hold and the percentage ones
    // grow — and the total no longer matches, which is caught rather than
    // written at the wrong numbers.
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('validation-failed');
    expect((await cat(10)).name).toBe('Household Bills');
    expect((await getSettings(ACCOUNT_ID)).stagedBudgetConfig).not.toBeNull();
  });

  it('takes an automatic backup before writing anything', async () => {
    await stageReference();
    const result = await applyStagedBudgetConfig(ACCOUNT_ID, { incomeId: INCOME_ID });

    expect(result.undo.backup.categories.find(c => c.id === 10).name).toBe('Household Bills');
    expect((await getSettings(ACCOUNT_ID)).lastAutoBackupAt).toBeTruthy();
  });
});

/**
 * A reset can reach `applyStagedBudgetConfig` more than once — the reset path
 * fires again as live queries settle, and an installed PWA can have two tabs
 * open on the same database. Applying twice is not a near-miss: every `create`
 * row runs again, so the account ends up with two categories of one name and
 * two variables of one name, and from there `evaluateFormula` resolves `$Name`
 * and `[Name]` by whichever row Dexie returns first while every allowance total
 * counts the duplicates twice.
 */
describe('applying twice', () => {
  it('writes one budget when two applies race for the same reset', async () => {
    await stageReference();

    const results = await Promise.all([
      applyStagedBudgetConfig(ACCOUNT_ID, { incomeId: INCOME_ID }),
      applyStagedBudgetConfig(ACCOUNT_ID, { incomeId: INCOME_ID }),
    ]);

    // Exactly one wrote. The other is not an error — the budget the user
    // approved is live either way.
    expect(results.filter(r => r.applied)).toHaveLength(1);
    expect(results.find(r => !r.applied).reason).toMatch(/nothing-staged|superseded/);

    const names = (await db.categories.where('accountId').equals(ACCOUNT_ID).toArray())
      .map(c => c.name);
    expect(names).toHaveLength(new Set(names).size);

    const varNames = (await db.variables.where('accountId').equals(ACCOUNT_ID).toArray())
      .map(v => v.name);
    expect(varNames).toHaveLength(new Set(varNames).size);
  });

  it('refuses a plan whose staged config was already applied', async () => {
    await stageReference();
    // A plan built and held while another apply lands first — which is what an
    // overlapping reset does, the backup step being long enough to fit one.
    const context = await getBudgetConfigContext(ACCOUNT_ID);
    const stale = buildBudgetConfigPlan(REFERENCE, context);
    expect(stale.ok).toBe(true);

    await applyStagedBudgetConfig(ACCOUNT_ID, { incomeId: INCOME_ID });
    const after = await snapshotBudget();

    const second = await applyStagedBudgetConfig(ACCOUNT_ID, { incomeId: INCOME_ID });
    expect(second.applied).toBe(false);
    expect(await snapshotBudget()).toBe(after);
  });

  it('does not apply again at the next reset', async () => {
    await stageReference();
    await applyStagedBudgetConfig(ACCOUNT_ID, { incomeId: INCOME_ID });

    // Nothing is queued any more, so the following cycle changes nothing.
    const afterFirst = await snapshotBudget();
    const next = await applyStagedBudgetConfig(ACCOUNT_ID, { incomeId: INCOME_ID });

    expect(next.applied).toBe(false);
    expect(next.reason).toBe('nothing-staged');
    expect(await snapshotBudget()).toBe(afterFirst);
  });
});

/**
 * The settings row holds the user's own preferences next to machine-managed
 * state the reset path rewrites on its own schedule — `stagedBudgetConfig`,
 * `lastReset`, `budgetConfigUndo`. Writing one field through a copy of the row
 * therefore writes the others too, at whatever values the copy was taken with.
 *
 * That is how an applied config came back from the dead: apply cleared
 * `stagedBudgetConfig`, and a settings write built from a snapshot taken before
 * it put the config straight back, leaving the account holding a live budget
 * *and* a config still queued to apply again at the next reset.
 */
describe('settings patches', () => {
  /** The state the bug produced: applied and still queued, both at once. */
  const bothAtOnce = (settings) =>
    Boolean(settings.stagedBudgetConfig) && Boolean(settings.budgetConfigUndo);

  it('never leaves a live budget and a queued config at once', async () => {
    await stageReference();

    // Held across the apply, exactly as a React snapshot in a Settings toggle
    // or an overlapping reset run would hold it.
    const stale = await getSettings(ACCOUNT_ID);
    expect(stale.stagedBudgetConfig).not.toBeNull();

    await applyStagedBudgetConfig(ACCOUNT_ID, { incomeId: INCOME_ID });

    // Everything the app writes to settings around a reset.
    await patchSettings(ACCOUNT_ID, { lastReset: new Date().toISOString() });
    await patchSettings(ACCOUNT_ID, { themeMode: 'light' });
    await patchSettings(ACCOUNT_ID, { notificationsEnabled: true });

    const after = await getSettings(ACCOUNT_ID);
    expect(bothAtOnce(after)).toBe(false);
    expect(after.stagedBudgetConfig).toBeNull();
    expect(after.budgetConfigUndo).toBeTruthy();
    expect(after.themeMode).toBe('light');
  });

  it('is not interchangeable with saveSettings, which replaces the row', async () => {
    // Pins the difference, so collapsing the two back together is caught here
    // rather than by a budget applying twice. `saveSettings` is a replace and
    // is correct only when the caller really does hold the whole current row.
    await stageReference();
    const stale = await getSettings(ACCOUNT_ID);
    await applyStagedBudgetConfig(ACCOUNT_ID, { incomeId: INCOME_ID });

    await saveSettings({ ...stale, lastReset: '2026-08-24T00:00:00.000Z' }, ACCOUNT_ID);
    expect(bothAtOnce(await getSettings(ACCOUNT_ID))).toBe(true);

    // The same write through `patchSettings` touches nothing else.
    await patchSettings(ACCOUNT_ID, { stagedBudgetConfig: null });
    await patchSettings(ACCOUNT_ID, { lastReset: '2026-08-25T00:00:00.000Z' });

    const after = await getSettings(ACCOUNT_ID);
    expect(bothAtOnce(after)).toBe(false);
    expect(after.lastReset).toBe('2026-08-25T00:00:00.000Z');
  });

  it('changes only the fields it is given', async () => {
    await patchSettings(ACCOUNT_ID, { themeMode: 'light' });
    const after = await getSettings(ACCOUNT_ID);

    expect(after.themeMode).toBe('light');
    expect(after.payDayOfMonth).toBe(24);
    expect(after.accountId).toBe(ACCOUNT_ID);
  });

  it('creates the row when an account has no settings yet', async () => {
    await db.settings.clear();
    await patchSettings(ACCOUNT_ID, { lastReset: '2026-08-24T00:00:00.000Z' });

    const after = await getSettings(ACCOUNT_ID);
    expect(after.lastReset).toBe('2026-08-24T00:00:00.000Z');
    expect(after.accountId).toBe(ACCOUNT_ID);
  });
});

/**
 * Databases that already hold the impossible state — a budget applied, and the
 * config that applied it still sitting in the staged slot — have to come back
 * on their own. Left there it applies a second time at the next reset, running
 * every `create` row again.
 */
describe('reconciling an already-applied config', () => {
  /** Put the staged record back after the apply, as the stale write used to. */
  async function resurrect() {
    const stale = await getSettings(ACCOUNT_ID);
    await applyStagedBudgetConfig(ACCOUNT_ID, { incomeId: INCOME_ID });
    await saveSettings({ ...stale, lastReset: new Date().toISOString() }, ACCOUNT_ID);
    return getSettings(ACCOUNT_ID);
  }

  it('clears the ghost so it cannot apply a second time', async () => {
    await stageReference();
    const broken = await resurrect();
    expect(broken.stagedBudgetConfig).not.toBeNull();
    expect(broken.budgetConfigUndo).toBeTruthy();

    const result = await reconcileStagedBudgetConfig(ACCOUNT_ID);
    expect(result.cleared).toBe(true);

    const after = await getSettings(ACCOUNT_ID);
    expect(after.stagedBudgetConfig).toBeNull();
    // The applied budget is untouched — this cancels a queued copy, nothing more.
    expect(after.budgetConfigUndo).toBeTruthy();
    expect((await cat(10)).name).toBe('Bills');

    // Which is the whole point: the next reset now changes nothing.
    const snapshot = await snapshotBudget();
    const next = await applyStagedBudgetConfig(ACCOUNT_ID, { incomeId: INCOME_ID });
    expect(next.applied).toBe(false);
    expect(await snapshotBudget()).toBe(snapshot);
  });

  it('identifies the ghost on undo records written before it was marked', async () => {
    await stageReference();
    await resurrect();

    // An undo record from the old code has no `stagedAt`; the backup's
    // `exportedAt` dates the apply on the real clock instead.
    const settings = await getSettings(ACCOUNT_ID);
    const { stagedAt, ...legacyUndo } = settings.budgetConfigUndo;
    expect(stagedAt).toBeTruthy();
    expect(legacyUndo.backup.exportedAt).toBeTruthy();
    await patchSettings(ACCOUNT_ID, { budgetConfigUndo: legacyUndo });

    expect((await reconcileStagedBudgetConfig(ACCOUNT_ID)).cleared).toBe(true);
    expect((await getSettings(ACCOUNT_ID)).stagedBudgetConfig).toBeNull();
  });

  it('leaves a config imported after the apply alone', async () => {
    await stageReference();
    await applyStagedBudgetConfig(ACCOUNT_ID, { incomeId: INCOME_ID });

    // A genuine new import, staged against the budget the apply just wrote.
    await new Promise(resolve => setTimeout(resolve, 5));
    const { plan } = await stageReference(clone(REFERENCE));
    expect(plan.ok).toBe(true);

    const result = await reconcileStagedBudgetConfig(ACCOUNT_ID);
    expect(result.cleared).toBe(false);
    expect(result.reason).toBe('staged-after-apply');
    expect((await getSettings(ACCOUNT_ID)).stagedBudgetConfig).not.toBeNull();
  });

  it('does nothing on an account in a good state', async () => {
    expect((await reconcileStagedBudgetConfig(ACCOUNT_ID)).cleared).toBe(false);

    await stageReference();
    const staged = await snapshotBudget();
    expect((await reconcileStagedBudgetConfig(ACCOUNT_ID)).cleared).toBe(false);
    expect((await getSettings(ACCOUNT_ID)).stagedBudgetConfig).not.toBeNull();
    expect(await snapshotBudget()).toBe(staged);
  });
});

describe('a malformed config leaves the database byte-identical', () => {
  const cases = {
    'wrong kind': { ...REFERENCE, kind: 'finesse.backup' },
    'unknown schema version': { ...REFERENCE, schemaVersion: 99 },
    'wrong account': { ...REFERENCE, targetAccountId: 41 },
    'missing update id': (() => {
      const c = clone(REFERENCE);
      c.categories.find(x => x.name === 'Fuel').id = 999;
      return c;
    })(),
    'undefined variable': (() => {
      const c = clone(REFERENCE);
      c.categories.find(x => x.name === 'Groceries').allowanceFormula = '{LM} - $Nonexistent';
      return c;
    })(),
    'allowances that do not sum to income': (() => {
      const c = clone(REFERENCE);
      const fuel = c.categories.find(x => x.name === 'Fuel');
      fuel.allowanceFormula = null;
      fuel.allowance = 150;
      return c;
    })(),
  };

  for (const [label, config] of Object.entries(cases)) {
    it(`rejects ${label} without touching a row`, async () => {
      const before = JSON.stringify(await exportData());
      const context = await getBudgetConfigContext(ACCOUNT_ID);
      const plan = buildBudgetConfigPlan(config, context);

      expect(plan.ok).toBe(false);
      await expect(stageBudgetConfig(ACCOUNT_ID, { config, plan })).rejects.toThrow();

      const after = JSON.parse(before);
      const now = await exportData();
      expect(JSON.stringify({ ...now, exportedAt: after.exportedAt })).toBe(before);
    });
  }
});

describe('rollover across cycles', () => {
  it('accumulates Annual Bills across two cycles instead of resetting it', async () => {
    await stageReference();
    await applyStagedBudgetConfig(ACCOUNT_ID, { incomeId: INCOME_ID });

    const annual = await cat(12);
    expect(annual.name).toBe('Annual Bills');
    expect(annual.rolloverEnabled).toBe(true);
    expect(annual.allowance).toBe(67.5);

    // Cycle one: nothing spent against it.
    await resetCategoriesForIncome(INCOME_ID, '2026-09-24T00:00:00.000Z', ACCOUNT_ID);
    expect((await cat(12)).rolloverBalance).toBe(67.5);

    // Cycle two: still nothing spent. A non-rollover category would be back to
    // its bare allowance by now; this one is a month further along.
    await resetCategoriesForIncome(INCOME_ID, '2026-10-24T00:00:00.000Z', ACCOUNT_ID);
    expect((await cat(12)).rolloverBalance).toBe(135);
    expect(getEffectiveAllowance(await cat(12))).toBe(202.5);
  });

  it('accumulates Savings too, net of what was spent', async () => {
    await stageReference();
    await applyStagedBudgetConfig(ACCOUNT_ID, { incomeId: INCOME_ID });

    await addTransaction({
      accountId: ACCOUNT_ID, categoryId: 15, amount: 100, note: 'dip', date: new Date().toISOString(),
    });

    await resetCategoriesForIncome(INCOME_ID, '2026-09-24T00:00:00.000Z', ACCOUNT_ID);
    expect((await cat(15)).rolloverBalance).toBe(339.1);

    // Second cycle: nothing spent, so the whole fresh allowance banks on top of
    // what the first cycle left — 439.10 + 339.10.
    await resetCategoriesForIncome(INCOME_ID, '2026-10-24T00:00:00.000Z', ACCOUNT_ID);
    expect((await cat(15)).rolloverBalance).toBe(778.2);
  });

  it('zeroes at reset for the categories that do not opt in', async () => {
    await stageReference();
    await applyStagedBudgetConfig(ACCOUNT_ID, { incomeId: INCOME_ID });

    await resetCategoriesForIncome(INCOME_ID, '2026-09-24T00:00:00.000Z', ACCOUNT_ID);
    expect((await cat(14)).rolloverBalance ?? 0).toBe(0);
    expect((await cat(14)).spent).toBe(0);
  });
});

describe('undo', () => {
  it('puts the budget back as it was', async () => {
    const before = await snapshotBudget();

    await stageReference();
    await applyStagedBudgetConfig(ACCOUNT_ID, { incomeId: INCOME_ID });
    expect(await snapshotBudget()).not.toBe(before);

    const result = await undoBudgetConfigApply(ACCOUNT_ID);
    expect(result.undone).toBe(true);
    expect(await snapshotBudget()).toBe(before);
    expect((await getSettings(ACCOUNT_ID)).budgetConfigUndo).toBeNull();
  });

  it('keeps a created category that has since been spent against', async () => {
    await stageReference();
    await applyStagedBudgetConfig(ACCOUNT_ID, { incomeId: INCOME_ID });

    const eatingOut = (await db.categories.toArray()).find(c => c.name === 'Eating Out');
    await addTransaction({
      accountId: ACCOUNT_ID, categoryId: eatingOut.id, amount: 22, note: 'Lunch',
      date: new Date().toISOString(),
    });

    const result = await undoBudgetConfigApply(ACCOUNT_ID);
    expect(result.keptCategories).toEqual([{ id: eatingOut.id, name: 'Eating Out' }]);
    // The transaction — real spending — survives, which is the point.
    expect(await db.transactions.where('categoryId').equals(eatingOut.id).count()).toBe(1);
    // Everything else is back.
    expect((await cat(10)).name).toBe('Household Bills');
  });

  it('stays available for a full cycle, then closes', async () => {
    await stageReference();
    const result = await applyStagedBudgetConfig(ACCOUNT_ID, { incomeId: INCOME_ID });

    const { undoExpiresAt, appliedAt } = result.undo;
    const days = (new Date(undoExpiresAt) - new Date(appliedAt)) / 86400000;
    expect(days).toBeGreaterThanOrEqual(28);

    // Rewind the window past its end and the offer is withdrawn rather than
    // silently restoring allowances that have gone stale.
    const settings = await getSettings(ACCOUNT_ID);
    await saveSettings({
      ...settings,
      budgetConfigUndo: { ...settings.budgetConfigUndo, undoExpiresAt: '2020-01-01T00:00:00.000Z' },
    }, ACCOUNT_ID);

    const expired = await undoBudgetConfigApply(ACCOUNT_ID);
    expect(expired.undone).toBe(false);
    expect(expired.reason).toBe('expired');
    expect((await cat(10)).name).toBe('Bills');
  });

  it('does nothing when there is nothing to undo', async () => {
    const result = await undoBudgetConfigApply(ACCOUNT_ID);
    expect(result.undone).toBe(false);
    expect(result.reason).toBe('nothing-to-undo');
  });
});
