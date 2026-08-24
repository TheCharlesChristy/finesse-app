import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildBudgetConfigPlan,
  parseBudgetConfigFile,
  isStagedConfigDue,
  isBudgetConfigUndoExpired,
  describeStagedConfig,
  CONFIG_KIND,
  APPLY_NEXT_CYCLE,
} from '../budgetConfig';
import { evaluateArithmetic, evaluateFormula, evaluateFormulaDetailed } from '../utils';

const REFERENCE = JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/finesse-category-config-v1.json', import.meta.url)), 'utf8'));

// The account the reference config was written against: six categories it
// renames (ids 10-15), one it leaves alone (16), three variables it updates.
function makeContext(overrides = {}) {
  return {
    accounts: [{ id: 3, name: 'Current' }],
    account: { id: 3, name: 'Current' },
    incomes: [{ id: 1, name: 'LM', amount: 2400, resetFrequency: 'monthly', payDayOfMonth: 24 }],
    variables: [
      { id: 5, accountId: 3, name: 'Bills', value: 610 },
      { id: 6, accountId: 3, name: 'Subs', value: 39 },
      { id: 7, accountId: 3, name: 'AnnualBills', value: 720 },
    ],
    categories: [
      { id: 10, accountId: 3, name: 'Household Bills', allowance: 610, spent: 120 },
      { id: 11, accountId: 3, name: 'Subs & Streaming', allowance: 39, spent: 39 },
      { id: 12, accountId: 3, name: 'Yearly Costs', allowance: 60, spent: 0 },
      { id: 13, accountId: 3, name: 'Petrol', allowance: 180, spent: 65.4 },
      { id: 14, accountId: 3, name: 'Food Shop', allowance: 340, spent: 210.55 },
      { id: 15, accountId: 3, name: 'Rainy Day', allowance: 400, spent: 0 },
      { id: 16, accountId: 3, name: 'Transport', allowance: 206.4, spent: 12 },
    ],
    settings: { accountId: 3, payDayOfMonth: 24 },
    ...overrides,
  };
}

const clone = (value) => JSON.parse(JSON.stringify(value));

/** The reference config with one category patched, for the negative cases. */
function withCategory(name, patch) {
  const config = clone(REFERENCE);
  const target = config.categories.find(c => c.name === name);
  Object.assign(target, patch);
  return config;
}

describe('arithmetic parser', () => {
  it('respects precedence rather than evaluating left to right', () => {
    expect(evaluateArithmetic('2 + 3 * 4')).toBe(14);
    expect(evaluateArithmetic('100 - 10 / 2')).toBe(95);
  });

  it('divides', () => {
    expect(evaluateArithmetic('810/12')).toBe(67.5);
  });

  it('handles parentheses, unary minus and the leading-dot form', () => {
    expect(evaluateArithmetic('(2 + 3) * 4')).toBe(20);
    expect(evaluateArithmetic('-5 + 8')).toBe(3);
    expect(evaluateArithmetic('2400 * .416')).toBe(998.4);
  });

  it('chains subtraction across many terms without losing precedence', () => {
    expect(evaluateArithmetic('2400 - 650 - 45 - 810/12 - 60*3.3333333333333333 - 2400*.416'))
      .toBe(439.1);
  });

  it('rejects malformed input instead of guessing', () => {
    expect(evaluateArithmetic('2 +')).toBeNull();
    expect(evaluateArithmetic('(2 + 3')).toBeNull();
    expect(evaluateArithmetic('2 3')).toBeNull();
    expect(evaluateArithmetic('')).toBeNull();
    expect(evaluateArithmetic('1/0')).toBeNull();
  });
});

describe('formula evaluation', () => {
  const variables = [
    { name: 'Bills', value: 650 }, { name: 'Subs', value: 45 },
    { name: 'AnnualBills', value: 810 }, { name: 'CostofFuelTank', value: 60 },
  ];
  const incomes = [{ id: 1, name: 'LM', amount: 2400 }];

  it('evaluates the residual formula the reference config depends on', () => {
    expect(evaluateFormula(
      '{LM} - $Bills - $Subs - $AnnualBills/12 - $CostofFuelTank*3.3333333333333333 - {LM}*.416',
      variables, [], incomes)).toBe(439.1);
  });

  it('names the reference that could not be resolved', () => {
    const detail = evaluateFormulaDetailed('{LM} - $Nonexistent', variables, [], incomes);
    expect(detail.value).toBeNull();
    expect(detail.token).toBe('$Nonexistent');
  });

  it('does not let a short variable name eat a longer one', () => {
    const detail = evaluateFormulaDetailed('$AnnualBills/12',
      [{ name: 'Annual', value: 1 }, { name: 'AnnualBills', value: 810 }], [], incomes);
    expect(detail.value).toBe(67.5);
  });
});

describe('parseBudgetConfigFile', () => {
  it('reports a JSON syntax error as one', () => {
    const result = parseBudgetConfigFile('{ not json');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not valid JSON/);
  });

  it('rejects a JSON document that is not an object', () => {
    expect(parseBudgetConfigFile('[1,2,3]').ok).toBe(false);
  });
});

describe('buildBudgetConfigPlan — the reference config', () => {
  const plan = buildBudgetConfigPlan(REFERENCE, makeContext());

  it('validates against account 3 with no errors', () => {
    expect(plan.errors).toEqual([]);
    expect(plan.ok).toBe(true);
  });

  it('stages nine categories and four variables', () => {
    expect(plan.categories).toHaveLength(9);
    expect(plan.variables).toHaveLength(4);
  });

  it('keeps the ids of categories 10-15 through their renames', () => {
    const renamed = plan.categories.filter(c => c.renamed);
    expect(renamed.map(c => c.id).sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 14, 15]);
    for (const row of renamed) {
      expect(row.action).toBe('update');
      expect(row.name).not.toBe(row.previousName);
    }
  });

  it('never writes runtime state, so a rename cannot reset spend', () => {
    for (const row of plan.categories) {
      for (const field of ['spent', 'spentByIncome', 'lastReset', 'incomeResetAt',
        'temporaryBoost', 'boostSources', 'cycleClearedSpend']) {
        expect(row.fields).not.toHaveProperty(field);
      }
    }
  });

  it('evaluates the allowances the formulas describe', () => {
    const byName = Object.fromEntries(plan.categories.map(c => [c.name, c.allowance]));
    expect(byName['Bills']).toBe(650);
    expect(byName['Subscriptions']).toBe(45);
    expect(byName['Annual Bills']).toBe(67.5);
    expect(byName['Fuel']).toBe(200);
    expect(byName['Groceries']).toBe(360);
    expect(byName['Savings']).toBe(439.1);
    expect(byName['Transport']).toBe(206.4);
  });

  it('sums the evaluated allowances to exactly the income', () => {
    expect(plan.totals.evaluatedTotal).toBe(2400);
    expect(plan.totals.incomeAmount).toBe(2400);
    expect(plan.totals.difference).toBe(0);
  });

  it('resolves formulas against the config variables, not the current ones', () => {
    // AnnualBills is 720 on the account and 810 in the config; 810/12 is the
    // number that must appear, or the preview would show a figure the apply
    // step would never produce.
    expect(plan.categories.find(c => c.name === 'Annual Bills').allowance).toBe(67.5);
  });

  it('marks the two rollover categories', () => {
    expect(plan.categories.filter(c => c.rollover).map(c => c.name).sort())
      .toEqual(['Annual Bills', 'Savings']);
  });

  it('does not fall back when the residual formula parses', () => {
    expect(plan.totals.usedFallback).toBe(0);
    expect(plan.warnings.some(w => w.code === 'formula-fallback')).toBe(false);
  });

  it('reports the delta for each changed category', () => {
    const bills = plan.categories.find(c => c.name === 'Bills');
    expect(bills.previousAllowance).toBe(610);
    expect(bills.delta).toBe(40);
  });

  it('carries the importer notes through for the preview', () => {
    expect(plan.meta.importerNotes).toHaveLength(3);
  });
});

describe('buildBudgetConfigPlan — validation failures', () => {
  const expectError = (config, code, context = makeContext()) => {
    const plan = buildBudgetConfigPlan(config, context);
    expect(plan.ok).toBe(false);
    expect(plan.errors.map(e => e.code)).toContain(code);
    return plan;
  };

  it('rejects an unrecognised schemaVersion', () => {
    expectError({ ...REFERENCE, schemaVersion: 99 }, 'schema-version');
  });

  it('rejects the wrong kind', () => {
    expectError({ ...REFERENCE, kind: 'finesse.backup' }, 'kind');
  });

  it('rejects a targetAccountId that matches no account', () => {
    const plan = expectError({ ...REFERENCE, targetAccountId: 9 }, 'target-account');
    expect(plan.errors[0].message).toMatch(/account 9/);
  });

  it('rejects an update id that does not exist on the account', () => {
    const config = withCategory('Fuel', { id: 999 });
    expectError(config, 'category-missing');
  });

  it('rejects a formula referencing an undefined variable, at import', () => {
    const config = withCategory('Groceries', { allowanceFormula: '{LM} - $Nonexistent' });
    const plan = expectError(config, 'formula');
    expect(plan.errors.find(e => e.code === 'formula').message).toMatch(/\$Nonexistent/);
  });

  it('rejects duplicate variable names', () => {
    const config = clone(REFERENCE);
    config.variables[1].name = 'Bills';
    expectError(config, 'variable-duplicate-name');
  });

  it('rejects duplicate category names', () => {
    const config = withCategory('Fuel', { name: 'Groceries' });
    expectError(config, 'category-duplicate-name');
  });

  it('rejects a duplicate category id', () => {
    const config = withCategory('Fuel', { id: 10 });
    expectError(config, 'category-duplicate-id');
  });

  it('rejects a negative evaluated allowance', () => {
    const config = withCategory('Fuel', { allowanceFormula: '0 - 25', allowance: -25 });
    expectError(config, 'allowance-negative');
  });

  it('rejects a config whose allowances do not sum to income, showing both figures', () => {
    const config = withCategory('Fuel', { allowanceFormula: null, allowance: 150 });
    const plan = expectError(config, 'allocation-total');
    const message = plan.errors.find(e => e.code === 'allocation-total').message;
    expect(message).toMatch(/2,350/);   // what the formulas evaluate to
    expect(message).toMatch(/2,400/);   // what income is, and what the file expects
  });

  it('rejects a config that tries to write runtime state', () => {
    const config = withCategory('Fuel', { spent: 0 });
    expectError(config, 'runtime-field');
  });

  it('rejects a create that carries an id', () => {
    const config = withCategory('Eating Out', { id: 42 });
    expectError(config, 'category-id');
  });

  it('rejects a baseline income the account does not have', () => {
    expectError({ ...REFERENCE, baselineIncome: { id: 88, name: 'Nope', amount: 2400 } }, 'baseline-income');
  });

  it('rejects an unrecognised applyAt', () => {
    expectError({ ...REFERENCE, applyAt: 'right-now' }, 'apply-at');
  });
});

describe('buildBudgetConfigPlan — warnings that do not abort', () => {
  it('warns that an unmentioned category is left untouched, never deleted', () => {
    const context = makeContext();
    context.categories.push({ id: 17, accountId: 3, name: 'Gifts', allowance: 0, spent: 5 });
    const plan = buildBudgetConfigPlan(REFERENCE, context);

    expect(plan.ok).toBe(true);
    const warning = plan.warnings.find(w => w.code === 'untouched-categories');
    expect(warning.message).toMatch(/Gifts/);
    expect(warning.message).toMatch(/never deletes/);
    expect(plan.untouched).toEqual([{ id: 17, name: 'Gifts', allowance: 0 }]);
  });

  it('falls back visibly, naming the drift, when a formula cannot be evaluated', () => {
    // A residual formula the evaluator cannot resolve: the fallback keeps the
    // import possible but is a flat percentage that drifts from the true
    // residual, so it must never pass silently.
    const config = withCategory('Savings', { allowanceFormula: '{LM} - $Missing' });
    const plan = buildBudgetConfigPlan(config, makeContext());

    const savings = plan.categories.find(c => c.name === 'Savings');
    expect(savings.usedFallback).toBe(true);
    expect(savings.allowance).toBe(424.08);
    expect(savings.fallbackDrift).toBeCloseTo(-15.02, 2);

    const warning = plan.warnings.find(w => w.code === 'formula-fallback');
    expect(warning.message).toMatch(/fell back/);
    expect(warning.message).toMatch(/drift/);

    // And the drift is caught by the allocation check rather than shipped.
    expect(plan.ok).toBe(false);
    expect(plan.errors.map(e => e.code)).toContain('allocation-total');
  });
});

describe('staged config timing', () => {
  const staged = {
    stagedAt: '2026-08-19T00:00:00.000Z',
    applyIncomeId: 1,
    applyNotBefore: null,
    consumedAt: null,
    plan: { totals: { created: 2, updated: 6, renamed: 6, kept: 1, evaluatedTotal: 2400 },
      categories: new Array(9), variables: new Array(4), meta: { baselineIncomeName: 'LM' } },
  };

  it('is due at its own income reset', () => {
    expect(isStagedConfigDue(staged, { incomeId: 1 })).toBe(true);
  });

  it('waits when another income resets', () => {
    expect(isStagedConfigDue(staged, { incomeId: 2 })).toBe(false);
  });

  it('is never due once consumed', () => {
    expect(isStagedConfigDue({ ...staged, consumedAt: '2026-08-24' }, { incomeId: 1 })).toBe(false);
  });

  it('honours an applyNotBefore date', () => {
    const dated = { ...staged, applyNotBefore: '2026-09-24T00:00:00.000Z' };
    expect(isStagedConfigDue(dated, { incomeId: 1, resetAt: new Date('2026-08-24') })).toBe(false);
    expect(isStagedConfigDue(dated, { incomeId: 1, resetAt: new Date('2026-09-24') })).toBe(true);
  });

  it('summarises itself for the banner', () => {
    const described = describeStagedConfig(staged);
    expect(described.categoryCount).toBe(9);
    expect(described.variableCount).toBe(4);
    expect(described.summary).toBe('2 new, 6 changed, 6 renamed, 1 unchanged');
  });
});

describe('undo window', () => {
  it('is open before its expiry and closed after', () => {
    const undo = { undoExpiresAt: '2026-09-24T00:00:00.000Z' };
    expect(isBudgetConfigUndoExpired(undo, new Date('2026-09-01'))).toBe(false);
    expect(isBudgetConfigUndoExpired(undo, new Date('2026-09-25'))).toBe(true);
  });

  it('treats a record with no expiry as still open', () => {
    expect(isBudgetConfigUndoExpired({ appliedAt: '2026-08-24' })).toBe(false);
    expect(isBudgetConfigUndoExpired(null)).toBe(false);
  });
});

describe('contract constants', () => {
  it('matches the reference file header', () => {
    expect(REFERENCE.kind).toBe(CONFIG_KIND);
    expect(REFERENCE.applyAt).toBe(APPLY_NEXT_CYCLE);
  });
});

/**
 * A category cannot have two things deciding its allowance. When one did, the
 * runtime wrote it from the pace and from the formula in turn, so the value
 * flipped between them for as long as the app was open.
 */
describe('one source for an allowance', () => {
  it('refuses a category that sets both a formula and pacing', () => {
    const config = withCategory('Eating Out', {
      pacedAllowanceEnabled: true,
      pacedAllowanceAmount: 5,
      pacedAllowanceInterval: 1,
      pacedAllowanceUnit: 'day',
    });
    const plan = buildBudgetConfigPlan(config, makeContext());

    expect(plan.ok).toBe(false);
    const failure = plan.errors.find(e => e.code === 'category-allowance-source');
    expect(failure).toBeTruthy();
    // Names the category and both fields, so the config can actually be fixed.
    expect(failure.message).toContain('Eating Out');
    expect(failure.message).toContain('allowanceFormula');
    expect(failure.message).toContain('pacedAllowanceEnabled');
  });

  it('accepts pacing on its own', () => {
    const config = withCategory('Eating Out', {
      allowanceFormula: undefined,
      allowance: 155,
      pacedAllowanceEnabled: true,
      pacedAllowanceAmount: 5,
      pacedAllowanceInterval: 1,
      pacedAllowanceUnit: 'day',
    });
    const plan = buildBudgetConfigPlan(config, makeContext());
    const eatingOut = plan.categories.find(c => c.name === 'Eating Out');

    expect(plan.errors.some(e => e.code === 'category-allowance-source')).toBe(false);
    expect(eatingOut.fields.pacedAllowanceEnabled).toBe(true);
    expect(eatingOut.fields.allowanceFormula).toBeNull();
  });

  it('accepts a formula on its own', () => {
    const plan = buildBudgetConfigPlan(clone(REFERENCE), makeContext());
    expect(plan.ok).toBe(true);
    expect(plan.errors.some(e => e.code === 'category-allowance-source')).toBe(false);
  });

  it('ignores pacing set to false alongside a formula', () => {
    const config = withCategory('Eating Out', { pacedAllowanceEnabled: false });
    const plan = buildBudgetConfigPlan(config, makeContext());
    expect(plan.ok).toBe(true);
  });
});
