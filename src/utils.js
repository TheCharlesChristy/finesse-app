import { addDays, addMonths, addWeeks, addYears, getDate, getDaysInMonth, setDate, isAfter, isBefore, differenceInDays, format, startOfDay } from 'date-fns';

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

export function addRecurringInterval(fromDate = new Date(), intervalUnit = 'month', interval = 1) {
  const base = startOfDay(fromDate);
  const amount = Math.max(1, Number(interval) || 1);

  switch (intervalUnit) {
    case 'day':
      return addDays(base, amount);
    case 'week':
      return addWeeks(base, amount);
    case 'year':
      return addYears(base, amount);
    case 'month':
    default:
      return addMonths(base, amount);
  }
}

export function getNextRecurringDate(fromDate = new Date(), intervalUnit = 'month', interval = 1, now = new Date()) {
  let next = addRecurringInterval(fromDate, intervalUnit, interval);
  let guard = 0;
  while (next <= now && guard < 240) {
    next = addRecurringInterval(next, intervalUnit, interval);
    guard += 1;
  }
  return next;
}

// ── Income allocation helpers ────────────────────────────────────────────────

export function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

// Effective allowance = base allowance + any temporary top-up funded from
// unallocated income for the current cycle. The boost is cleared on reset, so
// it only affects "how much can I still spend right now", not the recurring
// base allowance used for income allocation, formulas, or pacing.
export function getEffectiveAllowance(category) {
  return roundMoney((Number(category?.allowance) || 0) + (Number(category?.temporaryBoost) || 0));
}

// Spare budget a category can lend or that's still safe to spend: effective
// allowance minus what's already been spent, never negative.
export function getCategorySpare(category) {
  return roundMoney(Math.max(0, getEffectiveAllowance(category) - (Number(category?.spent) || 0)));
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

export function getPacedAllowanceConfig(category) {
  const enabled = Boolean(category?.pacedAllowanceEnabled || category?.dailyAllowanceEnabled);
  if (!enabled) return null;

  const amount = roundMoney(category.pacedAllowanceAmount ?? category.dailyAllowanceAmount);
  if (!(amount > 0)) return null;

  return {
    amount,
    interval: Math.max(1, Number(category.pacedAllowanceInterval) || 1),
    unit: category.pacedAllowanceUnit || 'day',
  };
}

export function getPacedAllowanceIntervalDays(interval = 1, unit = 'day', date = new Date()) {
  const amount = Math.max(1, Number(interval) || 1);
  if (unit === 'week') return amount * 7;
  if (unit === 'month') return amount * getDaysInMonth(date);
  return amount;
}

/**
 * Returns the number of days in one income reset cycle.
 * Defaults to the current calendar-month length when the frequency is monthly
 * or unrecognised.
 */
export function getIncomeCycleDays(resetFrequency, date = new Date()) {
  switch (resetFrequency) {
    case 'weekly':      return 7;
    case 'fortnightly': return 14;
    case '4weekly':     return 28;
    case 'monthly':
    default:            return getDaysInMonth(date);
  }
}

/**
 * Total allowance for one income reset cycle given a repeating spend rate.
 * Pass `cycleDays` to use the income cycle length instead of the calendar month.
 */
export function getPacedAllowanceMonthlyTotal(amount, interval = 1, unit = 'day', date = new Date(), cycleDays = null) {
  const intervalDays = getPacedAllowanceIntervalDays(interval, unit, date);
  const periodDays = cycleDays != null ? cycleDays : getDaysInMonth(date);
  return roundMoney((Number(amount) || 0) * (periodDays / intervalDays));
}

export function formatPacedAllowancePeriod(interval = 1, unit = 'day') {
  const amount = Math.max(1, Number(interval) || 1);
  if (amount === 1) {
    if (unit === 'week') return 'week';
    if (unit === 'month') return 'month';
    return 'day';
  }
  if (unit === 'week') return `${amount} weeks`;
  if (unit === 'month') return `${amount} months`;
  return `${amount} days`;
}

/**
 * Real-time pace status for a paced-allowance category.
 * Pass `cycleDays` (from `getIncomeCycleDays`) to track against the income
 * reset cycle instead of the calendar month.  When cycleDays is provided,
 * `category.lastReset` is used to determine how far into the cycle we are.
 */
export function getPacedAllowanceStatus(category, date = new Date(), cycleDays = null) {
  const config = getPacedAllowanceConfig(category);
  if (!config) return null;

  const day = getDate(date);
  const daysInMonth = getDaysInMonth(date);
  const intervalDays = getPacedAllowanceIntervalDays(config.interval, config.unit, date);
  const allowance = roundMoney(category.allowance || getPacedAllowanceMonthlyTotal(config.amount, config.interval, config.unit, date, cycleDays));
  const spent = roundMoney(category.spent || 0);

  let allowedToDate, daysRemaining;
  if (cycleDays != null && category.lastReset) {
    const daysSinceReset = Math.max(0, differenceInDays(startOfDay(date), startOfDay(new Date(category.lastReset))));
    allowedToDate = roundMoney(allowance * Math.min(1, daysSinceReset / cycleDays));
    daysRemaining = Math.max(1, cycleDays - daysSinceReset);
  } else {
    allowedToDate = roundMoney(allowance * (day / daysInMonth));
    daysRemaining = Math.max(1, daysInMonth - day + 1);
  }

  const paceBalance = roundMoney(allowedToDate - spent);
  const remaining = roundMoney(allowance - spent);
  const periodsRemaining = Math.max(1, daysRemaining / intervalDays);

  return {
    amount: config.amount,
    interval: config.interval,
    unit: config.unit,
    intervalDays,
    periodLabel: formatPacedAllowancePeriod(config.interval, config.unit),
    allowedToDate,
    paceBalance,
    remaining,
    daysRemaining,
    availablePerDay: roundMoney(remaining / daysRemaining),
    availablePerPeriod: roundMoney(remaining / periodsRemaining),
  };
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

    const result = Function('"use strict"; return (' + expr + ')')(); // safe: only [0-9 +\-*/.() ] reach here
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
    return sum + Math.max(0, getEffectiveAllowance(cat) - (cat.spent || 0));
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

/**
 * Convert a `yyyy-MM-dd` date-only string to an ISO timestamp anchored at
 * local midnight. Using `new Date('yyyy-MM-dd')` parses as UTC, which can shift
 * the stored day backwards in negative-offset timezones; this keeps the saved
 * day identical to the day the user picked.
 */
export function dateOnlyToISO(value) {
  if (!value) return new Date().toISOString();
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}
