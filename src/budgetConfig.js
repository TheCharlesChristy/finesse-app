/**
 * Budget config import — parsing, validation and the preview diff.
 *
 * Pure and self-contained, in the manner of `csv.js`: no Dexie, no React, no
 * clock of its own. It takes a parsed config object plus a snapshot of the
 * account and returns everything the preview screen and the apply step need.
 * `db.js` owns the writing; this module owns deciding what *would* be written.
 *
 * The central idea is that an import is staged rather than applied. A budget
 * change made mid-cycle corrupts that cycle's pacing and every comparison
 * drawn from it, so a config is validated and previewed now, held, and applied
 * at the next reset — at which point the formulas are evaluated again against
 * whatever the income actually turned out to be.
 */

import {
  roundMoney,
  evaluateFormulaDetailed,
  FORMULA_OK,
  FORMULA_UNDEFINED_VARIABLE,
  FORMULA_UNDEFINED_INCOME,
  FORMULA_UNDEFINED_CATEGORY,
  fmt,
} from './utils';

export const CONFIG_KIND = 'finesse.categoryConfig';
export const SUPPORTED_SCHEMA_VERSIONS = [1];

export const ACTION_CREATE = 'create';
export const ACTION_UPDATE = 'update';
export const ACTION_KEEP = 'keep';
const ACTIONS = [ACTION_CREATE, ACTION_UPDATE, ACTION_KEEP];

// `applyAt` is a promise about *when*, not a date to obey literally: a config
// always lands on a reset boundary. A date narrows which reset.
export const APPLY_NEXT_CYCLE = 'next-cycle';

/**
 * Runtime state, deliberately absent from the config format and never written
 * by an import. A rename must not reset a category's spend or detach its
 * transactions, so on `update` every one of these keeps the value it already
 * had. Listed here rather than only implied by the writer, so the rule is
 * checkable — `assertNoRuntimeFields` rejects a config that tries anyway.
 */
export const RUNTIME_CATEGORY_FIELDS = [
  'spent', 'spentByIncome', 'lastReset', 'incomeResetAt',
  'temporaryBoost', 'boostSources', 'cycleClearedSpend',
];

/** The only category fields an import is allowed to set. */
export const CONFIG_CATEGORY_FIELDS = [
  'name', 'allowance', 'allowanceFormula', 'color', 'sortOrder',
  'rolloverEnabled', 'rolloverCarryOverspend',
  'pacedAllowanceEnabled', 'pacedAllowanceAmount',
  'pacedAllowanceInterval', 'pacedAllowanceUnit',
  'incomeAllocations', 'resetFrequency', 'payDayOfMonth', 'rule',
];

// Penny granularity. The allocation check is meant to be exact, but the
// residual formula runs through several divisions before it gets here, so
// "exact" has to mean "exact once rounded to money".
const PENNY = 0.005;

function err(code, message) { return { code, message }; }
function warn(code, message) { return { code, message }; }

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normaliseAction(value) {
  const action = String(value ?? '').trim().toLowerCase();
  return ACTIONS.includes(action) ? action : null;
}

function nameKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Read a config file's text into an object, without judging its contents.
 * Separated from validation so a JSON syntax error reads as one, rather than
 * as a schema complaint about a file that never parsed.
 */
export function parseBudgetConfigFile(text) {
  try {
    const parsed = JSON.parse(text);
    if (!isPlainObject(parsed)) {
      return { ok: false, config: null, error: 'The file must contain a JSON object.' };
    }
    return { ok: true, config: parsed, error: null };
  } catch (error) {
    return { ok: false, config: null, error: `The file is not valid JSON — ${error.message}` };
  }
}

/** Reject a config that tries to set runtime state, whatever its other merits. */
function assertNoRuntimeFields(entry, label, errors) {
  for (const field of RUNTIME_CATEGORY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(entry, field)) {
      errors.push(err('runtime-field',
        `${label} sets "${field}", which is runtime state an import must never write.`));
    }
  }
}

/**
 * Resolve the variable set as it will exist after the variable pass.
 *
 * Variables are written before categories because category formulas
 * dereference them, so the preview has to evaluate against the *post-apply*
 * set — evaluating against today's variables would show numbers the apply step
 * would never produce.
 */
function planVariables(config, context, errors) {
  const existing = context.variables || [];
  const existingById = new Map(existing.map(v => [Number(v.id), v]));
  const rows = Array.isArray(config.variables) ? config.variables : [];

  const seenNames = new Map();
  const seenIds = new Set();
  const plan = [];

  rows.forEach((raw, index) => {
    const label = `Variable ${raw?.name ? `"${raw.name}"` : `#${index + 1}`}`;
    if (!isPlainObject(raw)) {
      errors.push(err('variable-shape', `${label} is not an object.`));
      return;
    }

    const action = normaliseAction(raw.action);
    if (!action) {
      errors.push(err('variable-action', `${label} has an unrecognised action "${raw.action}".`));
      return;
    }

    const name = String(raw.name ?? '').trim();
    if (!name) {
      errors.push(err('variable-name', `${label} has no name.`));
      return;
    }
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
      errors.push(err('variable-name', `Variable "${name}" is not a usable formula reference — use letters, digits and underscores, starting with a letter.`));
    }

    const key = nameKey(name);
    if (seenNames.has(key)) {
      errors.push(err('variable-duplicate-name', `Duplicate variable name "${name}".`));
      return;
    }
    seenNames.set(key, true);

    const value = Number(raw.value);
    if (!Number.isFinite(value)) {
      errors.push(err('variable-value', `Variable "${name}" has a non-numeric value.`));
    }

    let previous = null;
    if (action === ACTION_CREATE) {
      if (raw.id != null) {
        errors.push(err('variable-id', `Variable "${name}" is a create but carries an id.`));
      }
    } else {
      const id = Number(raw.id);
      if (!Number.isFinite(id)) {
        errors.push(err('variable-id', `Variable "${name}" is a ${action} but has no id.`));
      } else if (!existingById.has(id)) {
        errors.push(err('variable-missing', `Variable "${name}" refers to id ${id}, which does not exist on this account.`));
      } else if (seenIds.has(id)) {
        errors.push(err('variable-duplicate-id', `Variable id ${id} appears more than once.`));
      } else {
        seenIds.add(id);
        previous = existingById.get(id);
      }
    }

    plan.push({
      action,
      id: action === ACTION_CREATE ? null : (Number(raw.id) || null),
      name,
      value: Number.isFinite(value) ? roundMoney(value) : 0,
      previousName: previous?.name ?? null,
      previousValue: previous ? roundMoney(previous.value) : null,
      renamed: Boolean(previous && previous.name !== name),
      changed: action === ACTION_CREATE
        || !previous
        || previous.name !== name
        || roundMoney(previous.value) !== roundMoney(value),
    });
  });

  // The set formulas will actually see: every existing variable, with the ones
  // this config touches overwritten. Untouched variables survive — an import
  // never deletes.
  const resolvedById = new Map(existing.map(v => [Number(v.id), { name: v.name, value: roundMoney(v.value) }]));
  for (const row of plan) {
    if (row.action === ACTION_CREATE) {
      resolvedById.set(`new:${row.name}`, { name: row.name, value: row.value });
    } else {
      resolvedById.set(Number(row.id), { name: row.name, value: row.value });
    }
  }

  return { plan, resolved: [...resolvedById.values()] };
}

/** Which income the `{...}` terms are measured against, and what it is worth. */
function resolveBaselineIncome(config, context) {
  const incomes = context.incomes || [];
  const wanted = config.baselineIncome;

  if (isPlainObject(wanted)) {
    const byId = incomes.find(i => Number(i.id) === Number(wanted.id));
    const byName = incomes.find(i => nameKey(i.name) === nameKey(wanted.name));
    const match = byId || byName;
    return {
      income: match || null,
      declaredAmount: Number.isFinite(Number(wanted.amount)) ? roundMoney(wanted.amount) : null,
      declaredName: wanted.name ?? null,
    };
  }

  if (typeof wanted === 'string') {
    const match = incomes.find(i => nameKey(i.name) === nameKey(wanted));
    return { income: match || null, declaredAmount: null, declaredName: wanted };
  }

  // Nothing declared: a single income is unambiguous, several are not.
  return {
    income: incomes.length === 1 ? incomes[0] : null,
    declaredAmount: null,
    declaredName: null,
  };
}

function formulaFailureMessage(label, detail) {
  switch (detail.status) {
    case FORMULA_UNDEFINED_VARIABLE:
      return `${label} references ${detail.token}, which is not defined by this config or on this account.`;
    case FORMULA_UNDEFINED_INCOME:
      return `${label} references the income ${detail.token}, which does not exist on this account.`;
    case FORMULA_UNDEFINED_CATEGORY:
      return `${label} references the category ${detail.token}, which is not a plain-value category on this account.`;
    default:
      return `${label} is not a formula that can be evaluated.`;
  }
}

/**
 * Resolve every category's allowance.
 *
 * Two passes, because a formula may reference a plain-value category by name:
 * plain values are known up front, formulas are evaluated against them. A
 * formula referencing another formula stays unsupported, as it is elsewhere in
 * the app — there is no defined evaluation order for it.
 */
function planCategories(config, context, resolvedVariables, baseline, errors, warnings) {
  const existing = context.categories || [];
  const existingById = new Map(existing.map(c => [Number(c.id), c]));
  const rows = Array.isArray(config.categories) ? config.categories : [];

  const incomes = baseline.income ? [baseline.income] : (context.incomes || []);

  const seenNames = new Map();
  const seenIds = new Set();
  const draft = [];

  rows.forEach((raw, index) => {
    const label = `Category ${raw?.name ? `"${raw.name}"` : `#${index + 1}`}`;
    if (!isPlainObject(raw)) {
      errors.push(err('category-shape', `${label} is not an object.`));
      return;
    }

    assertNoRuntimeFields(raw, label, errors);

    const action = normaliseAction(raw.action);
    if (!action) {
      errors.push(err('category-action', `${label} has an unrecognised action "${raw.action}".`));
      return;
    }

    const name = String(raw.name ?? '').trim();
    if (!name) {
      errors.push(err('category-name', `${label} has no name.`));
      return;
    }

    const key = nameKey(name);
    if (seenNames.has(key)) {
      errors.push(err('category-duplicate-name', `Duplicate category name "${name}".`));
      return;
    }
    seenNames.set(key, true);

    let previous = null;
    if (action === ACTION_CREATE) {
      if (raw.id != null) {
        errors.push(err('category-id', `${label} is a create but carries an id.`));
      }
    } else {
      const id = Number(raw.id);
      if (!Number.isFinite(id)) {
        errors.push(err('category-id', `${label} is a ${action} but has no id.`));
      } else if (!existingById.has(id)) {
        errors.push(err('category-missing', `${label} refers to id ${id}, which does not exist on this account.`));
      } else if (seenIds.has(id)) {
        errors.push(err('category-duplicate-id', `Category id ${id} appears more than once.`));
      } else {
        seenIds.add(id);
        previous = existingById.get(id);
      }
    }

    if (raw.renamedFrom && previous && nameKey(raw.renamedFrom) !== nameKey(previous.name)) {
      warnings.push(warn('rename-mismatch',
        `${label} says it was renamed from "${raw.renamedFrom}", but id ${previous.id} is currently called "${previous.name}".`));
    }

    draft.push({
      action,
      id: action === ACTION_CREATE ? null : (Number(raw.id) || null),
      name,
      raw,
      previous,
      label,
      formula: typeof raw.allowanceFormula === 'string' && raw.allowanceFormula.trim()
        ? raw.allowanceFormula.trim()
        : null,
      fallback: typeof raw.allowanceFormulaFallback === 'string' && raw.allowanceFormulaFallback.trim()
        ? raw.allowanceFormulaFallback.trim()
        : null,
      declaredAllowance: Number.isFinite(Number(raw.allowance)) ? roundMoney(raw.allowance) : null,
    });
  });

  // Pass one: plain-value categories, which formulas may reference by name.
  const plainForReference = draft
    .filter(row => !row.formula)
    .map(row => ({ name: row.name, allowance: row.declaredAllowance ?? 0 }));

  // Untouched existing categories are still referenceable — they continue to
  // exist after the import.
  const touchedIds = new Set(draft.map(row => Number(row.id)).filter(Number.isFinite));
  for (const cat of existing) {
    if (touchedIds.has(Number(cat.id))) continue;
    if (cat.allowanceFormula) continue;
    if (plainForReference.some(c => nameKey(c.name) === nameKey(cat.name))) continue;
    plainForReference.push({ name: cat.name, allowance: roundMoney(cat.allowance) });
  }

  const categories = draft.map(row => {
    let allowance = row.declaredAllowance ?? 0;
    let usedFallback = false;
    let fallbackDrift = null;
    let formulaStatus = null;

    if (row.formula) {
      const detail = evaluateFormulaDetailed(row.formula, resolvedVariables, plainForReference, incomes);
      formulaStatus = detail.status;

      if (detail.status === FORMULA_OK) {
        allowance = detail.value;
      } else if (row.fallback) {
        // A fallback keeps the import possible, but it is a different number
        // from the one the budget was designed around. Never silent: the
        // preview says so, and says by how much.
        const fallbackDetail = evaluateFormulaDetailed(row.fallback, resolvedVariables, plainForReference, incomes);
        if (fallbackDetail.status !== FORMULA_OK) {
          errors.push(err('formula', formulaFailureMessage(row.label, detail)));
          errors.push(err('formula-fallback',
            `${row.label} also has a fallback that cannot be evaluated.`));
        } else {
          allowance = fallbackDetail.value;
          usedFallback = true;
          if (row.declaredAllowance != null) {
            fallbackDrift = roundMoney(fallbackDetail.value - row.declaredAllowance);
          }
          warnings.push(warn('formula-fallback',
            `${row.label} fell back to "${row.fallback}" because its formula could not be evaluated`
            + `${row.declaredAllowance != null
              ? ` — ${fmt(fallbackDetail.value)} instead of the ${fmt(row.declaredAllowance)} the config expects, a drift of ${fmt(Math.abs(fallbackDrift))} per cycle`
              : ''}.`));
        }
      } else {
        errors.push(err('formula', formulaFailureMessage(row.label, detail)));
      }
    }

    if (!Number.isFinite(allowance)) {
      errors.push(err('allowance-not-finite', `${row.label} evaluates to a number that is not finite.`));
      allowance = 0;
    } else if (allowance < 0) {
      errors.push(err('allowance-negative', `${row.label} evaluates to ${fmt(allowance)}, which is negative.`));
    }

    const previous = row.previous;
    const previousAllowance = previous ? roundMoney(previous.allowance) : null;

    return {
      action: row.action,
      id: row.id,
      name: row.name,
      previousName: previous?.name ?? null,
      renamedFrom: row.raw.renamedFrom ?? null,
      renamed: Boolean(previous && previous.name !== row.name),
      allowance: roundMoney(allowance),
      previousAllowance,
      delta: previousAllowance == null ? null : roundMoney(allowance - previousAllowance),
      formula: row.formula,
      fallback: row.fallback,
      formulaStatus,
      usedFallback,
      fallbackDrift,
      declaredAllowance: row.declaredAllowance,
      rollover: Boolean(row.raw.rollover ?? row.raw.rolloverEnabled),
      previousRollover: previous ? Boolean(previous.rolloverEnabled) : null,
      rolloverBalance: previous ? roundMoney(previous.rolloverBalance || 0) : 0,
      spent: previous ? roundMoney(previous.spent || 0) : 0,
      color: row.raw.color ?? previous?.color ?? null,
      sortOrder: Number.isFinite(Number(row.raw.sortOrder)) ? Number(row.raw.sortOrder) : null,
      rule: row.raw.rule ?? null,
      // What `db.js` writes. Built here so the preview and the apply step can
      // never disagree about what a row means.
      fields: buildCategoryFields(row, allowance),
    };
  });

  return categories;
}

/**
 * The field patch for one category — allowance, presentation and pacing only.
 *
 * Everything in `RUNTIME_CATEGORY_FIELDS` is absent by construction, so an
 * `update` cannot disturb a category's spend, its funding split's reset clocks,
 * or the transactions pointing at its id.
 */
function buildCategoryFields(row, allowance) {
  const raw = row.raw;
  const fields = {
    name: row.name,
    allowance: roundMoney(allowance),
    allowanceFormula: row.formula || null,
  };

  if (raw.color != null) fields.color = raw.color;
  if (Number.isFinite(Number(raw.sortOrder))) fields.sortOrder = Number(raw.sortOrder);
  if (raw.rule != null) fields.rule = raw.rule;
  if (raw.resetFrequency != null) fields.resetFrequency = raw.resetFrequency;
  if (raw.payDayOfMonth != null) fields.payDayOfMonth = Number(raw.payDayOfMonth);
  if (Array.isArray(raw.incomeAllocations)) fields.incomeAllocations = raw.incomeAllocations;

  const rollover = raw.rollover ?? raw.rolloverEnabled;
  if (rollover != null) {
    fields.rolloverEnabled = Boolean(rollover);
    if (raw.rolloverCarryOverspend != null) {
      fields.rolloverCarryOverspend = Boolean(raw.rolloverCarryOverspend);
    }
  }

  if (raw.pacedAllowanceEnabled != null) {
    fields.pacedAllowanceEnabled = Boolean(raw.pacedAllowanceEnabled);
    if (raw.pacedAllowanceAmount != null) fields.pacedAllowanceAmount = roundMoney(raw.pacedAllowanceAmount);
    if (raw.pacedAllowanceInterval != null) fields.pacedAllowanceInterval = Number(raw.pacedAllowanceInterval);
    if (raw.pacedAllowanceUnit != null) fields.pacedAllowanceUnit = raw.pacedAllowanceUnit;
  }

  return fields;
}

/**
 * Validate a config against an account and build the preview diff.
 *
 * Returns `{ ok, errors, warnings, ... }`. Nothing is written; a caller stages
 * the result only when `ok` is true. Errors are collected rather than thrown at
 * the first failure, so a bad file can be fixed in one pass instead of ten.
 *
 * @param config   parsed config object
 * @param context  { account, accounts, categories, variables, incomes, settings }
 */
export function buildBudgetConfigPlan(config, context = {}) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(config)) {
    return { ok: false, errors: [err('shape', 'The config is not an object.')], warnings: [] };
  }

  // ── Header ──
  const schemaVersion = Number(config.schemaVersion);
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(schemaVersion)) {
    errors.push(err('schema-version',
      `Unrecognised schemaVersion ${JSON.stringify(config.schemaVersion)}. This app understands ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}.`));
  }

  if (config.kind !== CONFIG_KIND) {
    errors.push(err('kind',
      `Expected kind "${CONFIG_KIND}" but found ${JSON.stringify(config.kind ?? null)}.`));
  }

  const accounts = context.accounts || (context.account ? [context.account] : []);
  const targetAccountId = Number(config.targetAccountId);
  const targetAccount = accounts.find(a => Number(a.id) === targetAccountId) || null;
  if (!Number.isFinite(targetAccountId)) {
    errors.push(err('target-account', 'The config has no targetAccountId.'));
  } else if (!targetAccount) {
    errors.push(err('target-account',
      `The config targets account ${targetAccountId}, which does not exist${accounts.length ? ` (this device has ${accounts.map(a => `${a.id} "${a.name}"`).join(', ')})` : ''}.`));
  }

  // `applyAt` may name the next cycle or a date; either way it lands on a reset.
  const applyAtRaw = config.applyAt ?? APPLY_NEXT_CYCLE;
  let applyNotBefore = null;
  if (applyAtRaw !== APPLY_NEXT_CYCLE) {
    const parsed = new Date(applyAtRaw);
    if (Number.isNaN(parsed.getTime())) {
      errors.push(err('apply-at',
        `Unrecognised applyAt ${JSON.stringify(applyAtRaw)} — expected "${APPLY_NEXT_CYCLE}" or a date.`));
    } else {
      applyNotBefore = parsed.toISOString();
    }
  }

  // Bail before touching rows if the file isn't even the right kind of thing:
  // per-row messages about the wrong account would only be noise.
  if (errors.length > 0) {
    return { ok: false, errors, warnings, meta: null, variables: [], categories: [], totals: null, untouched: [] };
  }

  // ── Variables, then categories: formulas dereference variables. ──
  const { plan: variables, resolved: resolvedVariables } = planVariables(config, context, errors);
  const baseline = resolveBaselineIncome(config, context);

  if (!baseline.income) {
    errors.push(err('baseline-income',
      baseline.declaredName
        ? `The config is measured against income "${baseline.declaredName}", which does not exist on this account.`
        : 'The config does not name a baseline income, and this account does not have exactly one to infer.'));
  }

  const categories = planCategories(config, context, resolvedVariables, baseline, errors, warnings);

  // ── Allocation check ──
  // The meaningful one. This config is built to allocate 100% of income with a
  // residual category absorbing the headroom, so a total that misses means a
  // formula misparsed — the numbers would look plausible and be wrong.
  const evaluatedTotal = roundMoney(categories.reduce((sum, c) => sum + c.allowance, 0));
  const incomeAmount = baseline.income ? roundMoney(baseline.income.amount) : null;
  const declaredTotal = Number.isFinite(Number(config.validation?.expectedAllowanceTotal))
    ? roundMoney(config.validation.expectedAllowanceTotal)
    : null;
  const declaredIncome = Number.isFinite(Number(config.validation?.expectedIncomeTotal))
    ? roundMoney(config.validation.expectedIncomeTotal)
    : (baseline.declaredAmount ?? null);

  if (incomeAmount != null && Math.abs(evaluatedTotal - incomeAmount) > PENNY) {
    const parts = [
      `The evaluated allowances total ${fmt(evaluatedTotal)}, but income "${baseline.income.name}" is ${fmt(incomeAmount)}`,
      `— a difference of ${fmt(Math.abs(evaluatedTotal - incomeAmount))}.`,
    ];
    if (declaredTotal != null) {
      parts.push(`The config expects ${fmt(declaredTotal)} at a baseline income of ${declaredIncome != null ? fmt(declaredIncome) : 'the same figure'}.`);
    }
    parts.push('A formula has most likely misparsed.');
    errors.push(err('allocation-total', parts.join(' ')));
  }

  // A config that disagrees with its own validation block is suspect even when
  // it happens to balance against live income.
  if (declaredTotal != null && Math.abs(evaluatedTotal - declaredTotal) > PENNY
    && (declaredIncome == null || incomeAmount == null || Math.abs(declaredIncome - incomeAmount) <= PENNY)) {
    warnings.push(warn('validation-block',
      `The config's own validation block expects a total of ${fmt(declaredTotal)}, but these formulas evaluate to ${fmt(evaluatedTotal)}.`));
  }

  // ── Categories the config doesn't mention ──
  // Never deleted, and never silently: a budget that still funds something the
  // new plan forgot is the user's to reconcile, not this importer's.
  const touchedIds = new Set(categories.map(c => Number(c.id)).filter(Number.isFinite));
  const untouched = (context.categories || [])
    .filter(cat => !touchedIds.has(Number(cat.id)))
    .map(cat => ({ id: cat.id, name: cat.name, allowance: roundMoney(cat.allowance) }));

  if (untouched.length > 0) {
    warnings.push(warn('untouched-categories',
      `${untouched.length} existing categor${untouched.length === 1 ? 'y is' : 'ies are'} not mentioned by this config `
      + `(${untouched.map(c => `"${c.name}"`).join(', ')}). `
      + `${untouched.length === 1 ? 'It' : 'They'} will be left exactly as ${untouched.length === 1 ? 'it is' : 'they are'} — an import never deletes a category.`));
  }

  const untouchedTotal = roundMoney(untouched.reduce((sum, c) => sum + c.allowance, 0));

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    meta: {
      schemaVersion,
      kind: config.kind,
      targetAccountId,
      targetAccountName: targetAccount?.name ?? null,
      applyAt: applyAtRaw,
      applyNotBefore,
      baselineIncomeId: baseline.income?.id ?? null,
      baselineIncomeName: baseline.income?.name ?? baseline.declaredName ?? null,
      baselineIncomeAmount: incomeAmount,
      declaredIncomeAmount: baseline.declaredAmount ?? declaredIncome,
      importerNotes: Array.isArray(config.importerNotes) ? config.importerNotes : [],
    },
    variables,
    categories,
    totals: {
      evaluatedTotal,
      incomeAmount,
      declaredTotal,
      declaredIncome,
      difference: incomeAmount == null ? null : roundMoney(evaluatedTotal - incomeAmount),
      untouchedTotal,
      created: categories.filter(c => c.action === ACTION_CREATE).length,
      updated: categories.filter(c => c.action === ACTION_UPDATE).length,
      kept: categories.filter(c => c.action === ACTION_KEEP).length,
      renamed: categories.filter(c => c.renamed).length,
      usedFallback: categories.filter(c => c.usedFallback).length,
    },
    untouched,
  };
}

/**
 * Has a staged config reached its apply moment?
 *
 * Staged configs wait for a reset — never mid-cycle, however the user asks. The
 * `resetAt` argument is the reset actually happening now, so this answers
 * "is *this* the reset it was waiting for", not "is it due by the clock".
 */
export function isStagedConfigDue(staged, { incomeId = null, resetAt = new Date() } = {}) {
  if (!staged || staged.consumedAt) return false;

  // A config measured against one income waits for that income's reset — the
  // formulas are written in terms of it, so any other reset would evaluate them
  // against a cycle they don't describe.
  const wantedIncomeId = staged.applyIncomeId;
  if (wantedIncomeId != null && incomeId != null && Number(wantedIncomeId) !== Number(incomeId)) {
    return false;
  }

  if (staged.applyNotBefore) {
    const notBefore = new Date(staged.applyNotBefore);
    const at = resetAt instanceof Date ? resetAt : new Date(resetAt);
    if (!Number.isNaN(notBefore.getTime()) && at < notBefore) return false;
  }

  return true;
}

/**
 * Has the undo window closed?
 *
 * Undo stays available for one cycle, not forever. Restoring a months-old
 * budget would put back stale allowances *and* discard every rollover balance
 * accumulated since — an undo that destroys real money is not an undo.
 *
 * Exported so the UI can hide the button on the same rule the writer enforces,
 * rather than offering an action that will be refused.
 */
export function isBudgetConfigUndoExpired(undo, now = new Date()) {
  if (!undo?.undoExpiresAt) return false;
  const expires = new Date(undo.undoExpiresAt);
  if (Number.isNaN(expires.getTime())) return false;
  return (now instanceof Date ? now : new Date(now)) >= expires;
}

/** Human summary of a staged config, for the banner and the nudge. */
export function describeStagedConfig(staged) {
  if (!staged) return null;
  const totals = staged.plan?.totals || {};
  const bits = [];
  if (totals.created) bits.push(`${totals.created} new`);
  if (totals.updated) bits.push(`${totals.updated} changed`);
  if (totals.renamed) bits.push(`${totals.renamed} renamed`);
  if (totals.kept) bits.push(`${totals.kept} unchanged`);
  return {
    categoryCount: staged.plan?.categories?.length || 0,
    variableCount: staged.plan?.variables?.length || 0,
    summary: bits.join(', ') || 'no changes',
    total: totals.evaluatedTotal ?? null,
    incomeName: staged.plan?.meta?.baselineIncomeName ?? null,
  };
}
