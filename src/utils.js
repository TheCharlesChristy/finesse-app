import { addMonths, addWeeks, setDate, isAfter, isBefore, differenceInDays, format, startOfDay } from 'date-fns';

// ── Schedule helpers ─────────────────────────────────────────────────────────

/**
 * Given a pay day of month (e.g. 25) and today's date,
 * calculate when the next reset *should* happen per schedule.
 */
export function calcNextScheduledReset(payDayOfMonth, fromDate = new Date()) {
  const today = startOfDay(fromDate);
  let candidate = setDate(new Date(today.getFullYear(), today.getMonth(), 1), payDayOfMonth);
  // If today is on or after pay day this month, next reset is next month
  if (!isBefore(today, candidate)) {
    candidate = setDate(addMonths(candidate, 1), payDayOfMonth);
  }
  return candidate;
}

/**
 * Returns the effective next reset date, taking into account fast-forward and hold states.
 * - fastForwardDate: if set, the next reset is this date (user got paid early)
 * - holdUntilDate: if set, the reset is paused until this date
 * - Otherwise: use scheduled date
 */
export function getEffectiveNextReset(settings) {
  if (!settings) return null;
  const scheduled = calcNextScheduledReset(settings.payDayOfMonth || 25);
  if (settings.fastForwardDate) {
    const ff = new Date(settings.fastForwardDate);
    if (isAfter(ff, new Date())) return ff;
  }
  if (settings.holdActive) {
    // Hold: show scheduled date but flag it
    return { date: scheduled, held: true };
  }
  return { date: scheduled, held: false };
}

/**
 * Days until the effective next reset.
 */
export function daysUntilReset(settings) {
  const result = getEffectiveNextReset(settings);
  if (!result) return null;
  const d = result.date || result;
  return Math.max(0, differenceInDays(startOfDay(d), startOfDay(new Date())));
}

/**
 * Next reset date for a given frequency, computed from the last reset date.
 * For weekly/fortnightly/4weekly: adds the interval to fromDate.
 * For monthly: uses the next occurrence of payDayOfMonth.
 */
export function calcNextReset(resetFrequency, payDayOfMonth, fromDate = new Date()) {
  const base = startOfDay(fromDate);
  switch (resetFrequency) {
    case 'weekly':      return addWeeks(base, 1);
    case 'fortnightly': return addWeeks(base, 2);
    case '4weekly':     return addWeeks(base, 4);
    case 'monthly':
    default:            return calcNextScheduledReset(payDayOfMonth || 1, fromDate);
  }
}

// ── Income allocation helpers ────────────────────────────────────────────────

export function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

export function normalizeIncomeAllocations(allocations = []) {
  if (!Array.isArray(allocations)) return [];
  return allocations
    .map(a => ({
      incomeId: Number(a.incomeId),
      percent: Math.round((Number(a.percent) || 0) * 100) / 100,
    }))
    .filter(a => Number.isFinite(a.incomeId) && a.percent > 0)
    .reduce((acc, allocation) => {
      const existing = acc.find(a => a.incomeId === allocation.incomeId);
      if (existing) {
        existing.percent = roundMoney(existing.percent + allocation.percent);
      } else {
        acc.push(allocation);
      }
      return acc;
    }, []);
}

export function getAllocationPercentTotal(allocations = []) {
  return roundMoney(normalizeIncomeAllocations(allocations).reduce((sum, a) => sum + a.percent, 0));
}

export function getCategoryIncomeAllocationAmount(category, incomeId) {
  const allocation = normalizeIncomeAllocations(category?.incomeAllocations)
    .find(a => a.incomeId === Number(incomeId));
  if (!allocation) return 0;
  return roundMoney((Number(category?.allowance) || 0) * allocation.percent / 100);
}

export function getIncomeAllocationUsage(incomes = [], categories = [], excludeCategoryId = null) {
  const usage = Object.fromEntries(incomes.map(income => [String(income.id), 0]));

  for (const category of categories) {
    if (excludeCategoryId != null && category.id === excludeCategoryId) continue;
    for (const allocation of normalizeIncomeAllocations(category.incomeAllocations)) {
      const key = String(allocation.incomeId);
      if (!(key in usage)) continue;
      usage[key] = roundMoney(usage[key] + ((Number(category.allowance) || 0) * allocation.percent / 100));
    }
  }

  return usage;
}

export function categoryUsesIncome(category, incomeId) {
  return normalizeIncomeAllocations(category?.incomeAllocations)
    .some(allocation => allocation.incomeId === Number(incomeId));
}

/**
 * Evaluate a formula string with variable and category substitutions.
 * - $varName  → replaced with variable.value
 * - [CatName] → replaced with category.allowance (non-formula categories only)
 * Returns a number rounded to 2dp, or null on any error.
 */
export function evaluateFormula(formula, variables = [], categories = [], incomes = []) {
  if (!formula || typeof formula !== 'string') return null;
  try {
    let expr = formula;

    // Replace $varName tokens (longest name first to avoid partial matches)
    const varsSorted = [...variables].sort((a, b) => b.name.length - a.name.length);
    for (const v of varsSorted) {
      expr = expr.replace(new RegExp(`\\$${v.name}(?![a-zA-Z0-9_])`, 'g'), String(v.value ?? 0));
    }

    // Replace {IncomeName} tokens
    const incomesSorted = [...incomes].sort((a, b) => b.name.length - a.name.length);
    for (const i of incomesSorted) {
      const escaped = i.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expr = expr.replace(new RegExp(`\\{${escaped}\\}`, 'g'), String(i.amount ?? 0));
    }

    // Replace [CategoryName] tokens — only plain-number (non-formula) categories
    const plainCats = categories.filter(c => !c.allowanceFormula);
    const catsSorted = [...plainCats].sort((a, b) => b.name.length - a.name.length);
    for (const c of catsSorted) {
      const escaped = c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expr = expr.replace(new RegExp(`\\[${escaped}\\]`, 'g'), String(c.allowance ?? 0));
    }

    // Safety: only digits, operators, parens, dots, whitespace allowed after substitution
    if (!/^[\d\s+\-*/().]+$/.test(expr)) return null;

    // eslint-disable-next-line no-new-func
    const result = Function('"use strict"; return (' + expr + ')')();
    if (typeof result !== 'number' || !isFinite(result)) return null;
    return Math.round(result * 100) / 100;
  } catch {
    return null;
  }
}

// ── Forecasting ──────────────────────────────────────────────────────────────

/**
 * Daily burn rate per category, based on amount spent and days elapsed this period.
 */
export function getDailyBurnRate(categories, settings) {
  if (!settings?.lastReset) return {};
  const daysElapsed = Math.max(1, differenceInDays(new Date(), new Date(settings.lastReset)));
  const rates = {};
  for (const cat of categories) {
    rates[cat.id] = (cat.spent || 0) / daysElapsed;
  }
  return rates;
}

/**
 * Projected spend by end of period, per category.
 */
export function getProjectedSpend(categories, settings) {
  if (!settings?.lastReset) return {};
  const daysElapsed = Math.max(1, differenceInDays(new Date(), new Date(settings.lastReset)));
  const daysLeft = daysUntilReset(settings) || 0;
  const totalDays = daysElapsed + daysLeft;
  const projected = {};
  for (const cat of categories) {
    const rate = (cat.spent || 0) / daysElapsed;
    projected[cat.id] = rate * totalDays;
  }
  return projected;
}

/**
 * For a wishlist item, determine:
 * - canAffordNow: combined leftover across assigned categories >= item price
 * - daysUntil: if not now, how many days until burn rate frees enough
 * - shortfall: how much more is needed
 */
export function wishlistAffordability(item, categories, settings) {
  const catMap = Object.fromEntries(categories.map(c => [c.id, c]));
  const assignedIds = item.categoryIds || [];
  
  if (!assignedIds.length) return { canAffordNow: false, daysUntil: null, shortfall: item.price, combinedLeftover: 0 };

  const assigned = assignedIds.map(id => catMap[id]).filter(Boolean);
  const combinedLeftover = assigned.reduce((sum, cat) => {
    return sum + Math.max(0, (cat.allowance || 0) - (cat.spent || 0));
  }, 0);

  const canAffordNow = combinedLeftover >= item.price;

  if (canAffordNow) return { canAffordNow: true, daysUntil: 0, shortfall: 0, combinedLeftover };

  const shortfall = item.price - combinedLeftover;

  // Estimate days: next reset restores allowances, so if price <= total allowances they can afford after reset
  const totalAllowance = assigned.reduce((sum, cat) => sum + (cat.allowance || 0), 0);
  
  if (item.price <= totalAllowance) {
    // Will be affordable after reset
    const resetDays = daysUntilReset(settings);
    return { canAffordNow: false, daysUntil: resetDays, shortfall, combinedLeftover, afterReset: true };
  }

  // Price exceeds total allowance — needs multiple periods
  const monthlyAccumulation = totalAllowance;
  if (monthlyAccumulation <= 0) return { canAffordNow: false, daysUntil: null, shortfall, combinedLeftover };
  
  const periodsNeeded = Math.ceil(item.price / monthlyAccumulation);
  const resetDays = daysUntilReset(settings);
  const daysUntil = (resetDays || 0) + (periodsNeeded - 1) * 30;
  
  return { canAffordNow: false, daysUntil, shortfall, combinedLeftover, periodsNeeded };
}

/**
 * Build monthly spend history per category for chart.
 * Aggregates transactions by month.
 */
export function buildMonthlyHistory(transactions, categories) {
  const catMap = Object.fromEntries(categories.map(c => [c.id, c.name]));
  const byMonth = {};

  for (const tx of transactions) {
    const key = format(new Date(tx.date), 'MMM yy');
    if (!byMonth[key]) byMonth[key] = { month: key };
    const catName = catMap[tx.categoryId] || 'Other';
    byMonth[key][catName] = (byMonth[key][catName] || 0) + tx.amount;
  }

  return Object.values(byMonth).slice(-6); // last 6 months
}

/**
 * Projected end-of-period balance.
 */
export function projectedEndBalance(categories, settings, incomes = []) {
  if (!settings && !incomes.length) return 0;
  const income = incomes.length > 0
    ? incomes.reduce((sum, item) => sum + (Number(item.amount) || 0), 0)
    : (settings?.income || 0);
  const projected = getProjectedSpend(categories, settings);
  const totalProjected = Object.values(projected).reduce((a, b) => a + b, 0);
  return income - totalProjected;
}

export function fmt(amount) {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(amount);
}

export function fmtShort(amount) {
  if (Math.abs(amount) >= 1000) return `£${(amount/1000).toFixed(1)}k`;
  return `£${amount.toFixed(0)}`;
}
