import { addDays, addMonths, addWeeks, addYears, getDate, getDaysInMonth, setDate, isAfter, isBefore, differenceInDays, format, startOfDay } from 'date-fns';
import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from 'lz-string';

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

// Mean Gregorian month length. Used for period conversion so that "monthly"
// means the same thing in February as it does in March.
export const AVERAGE_MONTH_DAYS = 365.25 / 12;

export function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function toValidDate(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Effective allowance = base allowance
//   + any temporary top-up funded from unallocated income for this cycle
//   + anything rolled over from previous cycles.
//
// The three are kept as separate fields because they behave differently at
// reset: `temporaryBoost` is cleared, `rolloverBalance` is *created*, and
// `allowance` is untouched. None of them affect the recurring base allowance
// used for income allocation, formulas, or pacing.
export function getEffectiveAllowance(category) {
  return roundMoney(
    (Number(category?.allowance) || 0)
    + (Number(category?.temporaryBoost) || 0)
    + (Number(category?.rolloverBalance) || 0)
  );
}

/**
 * What an opt-in rollover category carries into its next cycle.
 *
 * Deliberately excludes `temporaryBoost`: a top-up is borrowed or granted for
 * one cycle, so leaving it unspent should release it rather than convert it
 * into permanent budget.
 *
 * Overspend only carries when the user asked for it. Silently starting the next
 * cycle in the red is a nasty surprise, but for people who want a true running
 * balance it's the honest behaviour.
 */
export function getRolloverForNextCycle(category, clearedThisCycle = 0) {
  if (!category?.rolloverEnabled) return 0;

  const base = roundMoney((Number(category.allowance) || 0) + (Number(category.rolloverBalance) || 0));
  // A category funded by several incomes has its counter cleared piecemeal, one
  // income at a time, so by the final reset `spent` only holds the remainder.
  // `clearedThisCycle` restores the rest, or rollover would over-credit by
  // everything the earlier partial resets already wiped.
  const spentThisCycle = roundMoney((Number(category.spent) || 0) + (Number(clearedThisCycle) || 0));
  const leftover = roundMoney(base - spentThisCycle);

  if (leftover >= 0) return leftover;
  return category.rolloverCarryOverspend ? leftover : 0;
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
 * Average (calendar-independent) length of one reset cycle in days.
 *
 * Unlike `getIncomeCycleDays`, monthly resolves to 365.25/12 rather than the
 * length of a specific month. Use this when converting amounts *between*
 * periods, where anchoring to one particular month would skew the result.
 */
export function getIncomeCycleAverageDays(resetFrequency) {
  switch (resetFrequency) {
    case 'weekly':      return 7;
    case 'fortnightly': return 14;
    case '4weekly':     return 28;
    case 'monthly':
    default:            return AVERAGE_MONTH_DAYS;
  }
}

export function getIncomeFrequency(income) {
  return income?.resetFrequency || (income?.payDayOfMonth ? 'monthly' : 'monthly');
}

const PERIOD_DAYS = { day: 1, week: 7, fortnight: 14, month: AVERAGE_MONTH_DAYS, year: 365.25 };

export function getPeriodDays(period = 'month') {
  return PERIOD_DAYS[period] ?? AVERAGE_MONTH_DAYS;
}

/** What one income is worth per day, whatever its pay frequency. */
export function getIncomeDailyRate(income) {
  const amount = Number(income?.amount) || 0;
  if (amount <= 0) return 0;
  return amount / getIncomeCycleAverageDays(getIncomeFrequency(income));
}

/** A single income expressed over an arbitrary period. */
export function getIncomeForPeriod(income, period = 'month') {
  return roundMoney(getIncomeDailyRate(income) * getPeriodDays(period));
}

/**
 * Total income across every source, normalised to one period.
 *
 * Summing `income.amount` directly is wrong whenever pay frequencies differ —
 * a weekly £200 and a monthly £2,000 are not £2,200 of anything. This converts
 * each source to a daily rate first. Monthly-only setups are unaffected.
 */
export function getNormalisedIncomeTotal(incomes = [], period = 'month') {
  return roundMoney(
    incomes.reduce((sum, income) => sum + getIncomeDailyRate(income) * getPeriodDays(period), 0)
  );
}

/** True when income sources don't all share one pay frequency. */
export function hasMixedIncomeFrequencies(incomes = []) {
  const freqs = new Set(incomes.filter(i => (Number(i?.amount) || 0) > 0).map(getIncomeFrequency));
  return freqs.size > 1;
}

/**
 * One category's allowance normalised to a period.
 *
 * A category's `allowance` is denominated in the cycle of whichever income
 * funds it — a category funded by a weekly wage holds a *weekly* allowance.
 * Allowances must therefore be converted the same way incomes are before the
 * two can be compared.
 */
export function getNormalisedCategoryAllowance(category, incomes = [], period = 'month') {
  const allowance = Number(category?.allowance) || 0;
  if (allowance === 0) return 0;

  const targetDays = getPeriodDays(period);
  const incomeMap = new Map(incomes.map(income => [Number(income.id), income]));
  const allocations = normalizeIncomeAllocations(category.incomeAllocations)
    .filter(allocation => incomeMap.has(allocation.incomeId));

  // Unfunded / legacy categories are monthly by convention.
  if (!allocations.length) {
    const cycleDays = getIncomeCycleAverageDays(category?.resetFrequency || 'monthly');
    return roundMoney(allowance * (targetDays / cycleDays));
  }

  let total = 0;
  for (const allocation of allocations) {
    const cycleDays = getIncomeCycleAverageDays(getIncomeFrequency(incomeMap.get(allocation.incomeId)));
    total += (allowance * allocation.percent / 100) * (targetDays / cycleDays);
  }
  return roundMoney(total);
}

/** Total category allowance normalised to one period. */
export function getNormalisedAllowanceTotal(categories = [], incomes = [], period = 'month') {
  return roundMoney(
    categories.reduce((sum, category) => sum + getNormalisedCategoryAllowance(category, incomes, period), 0)
  );
}

/**
 * Income not yet committed to any category, measured per pay cycle.
 *
 * Computed per source (each income's own amount minus what categories draw
 * from it) rather than by subtracting one mixed-frequency total from another,
 * which silently over- or under-states the free pool whenever pay frequencies
 * differ. This is the pool a temporary top-up can safely draw on.
 */
export function getUnallocatedIncomeTotal(incomes = [], categories = []) {
  const usage = getIncomeAllocationUsage(incomes, categories);
  return roundMoney(
    incomes.reduce((sum, income) => (
      sum + Math.max(0, roundMoney((Number(income.amount) || 0) - (usage[String(income.id)] || 0)))
    ), 0)
  );
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

// ── Budget cycles ────────────────────────────────────────────────────────────

/**
 * The current budget cycle for one category.
 *
 * A category's spend counter is zeroed by whichever income funds it, so its
 * cycle is the income's — not the account-wide `settings` schedule, which only
 * ever matched single-monthly-income setups. Resolution order:
 *   1. the soonest-resetting income that funds this category
 *   2. the category's own legacy `resetFrequency`
 *   3. the account `settings` schedule
 *
 * Returns { start, end, freq, days, elapsed, remaining }.
 */
export function getCategoryCycle(category, incomes = [], settings = null, now = new Date()) {
  const today = startOfDay(now);
  const incomeMap = new Map(incomes.map(income => [Number(income.id), income]));

  const advancePast = (freq, payDay, base) => {
    let next = calcNextReset(freq, payDay, base);
    let guard = 0;
    while (next <= today && guard < 240) {
      next = calcNextReset(freq, payDay, next);
      guard += 1;
    }
    return next;
  };

  let end = null;
  let freq = null;

  for (const allocation of normalizeIncomeAllocations(category?.incomeAllocations)) {
    const income = incomeMap.get(allocation.incomeId);
    if (!income || income.holdActive) continue;
    const incomeFreq = income.resetFrequency || (income.payDayOfMonth ? 'monthly' : null);
    if (!incomeFreq) continue;

    const base = toValidDate(income.lastPaid) || today;
    const next = advancePast(incomeFreq, income.payDayOfMonth, base);
    if (!end || next < end) {
      end = next;
      freq = incomeFreq;
    }
  }

  if (!end && category?.resetFrequency) {
    const base = toValidDate(category.lastReset) || today;
    end = advancePast(category.resetFrequency, category.payDayOfMonth, base);
    freq = category.resetFrequency;
  }

  if (!end) {
    const scheduled = getEffectiveNextReset(settings);
    const scheduledDate = scheduled ? toValidDate(scheduled.date || scheduled) : null;
    end = scheduledDate || addMonths(today, 1);
    freq = 'monthly';
  }

  end = startOfDay(end);

  const lastReset = toValidDate(category?.lastReset);
  const start = lastReset
    ? startOfDay(lastReset)
    : startOfDay(addDays(end, -Math.round(getIncomeCycleAverageDays(freq))));

  const days = Math.max(1, differenceInDays(end, start));
  const elapsed = Math.max(0, Math.min(days, differenceInDays(today, start)));

  return { start, end, freq, days, elapsed, remaining: Math.max(0, days - elapsed) };
}

// ── Transactions ─────────────────────────────────────────────────────────────

export const TX_EXPENSE = 'expense';
export const TX_REFUND = 'refund';

/**
 * A transaction's effect on spend, signed.
 *
 * `amount` is always stored positive and `type` carries the direction, so a
 * refund reduces the category's spend and credits the account. Anything that
 * totals transactions must go through this, or refunds get counted as spend.
 */
export function getSignedAmount(transaction) {
  const amount = Math.abs(Number(transaction?.amount) || 0);
  return roundMoney(transaction?.type === TX_REFUND ? -amount : amount);
}

export function isRefund(transaction) {
  return transaction?.type === TX_REFUND;
}

// ── Fast capture: merchant memory & rules ────────────────────────────────────

/** The label a transaction is remembered by — explicit merchant, else its note. */
export function getTransactionMerchant(transaction) {
  return String(transaction?.merchant || transaction?.note || '').trim();
}

/**
 * Places you've spent before, most useful first.
 *
 * Ranked by frequency then recency, so the shop you visit weekly outranks the
 * one you visited once yesterday. Each entry carries the category you last
 * used, which is what makes one-tap categorisation possible.
 */
export function getMerchantSuggestions(transactions = [], query = '', limit = 6) {
  const search = String(query || '').trim().toLowerCase();
  const byMerchant = new Map();

  for (const tx of transactions) {
    const label = getTransactionMerchant(tx);
    if (!label) continue;

    const key = label.toLowerCase();
    const date = toValidDate(tx.date);
    const existing = byMerchant.get(key);

    if (!existing) {
      byMerchant.set(key, {
        label, count: 1, lastDate: date, lastCategoryId: tx.categoryId, lastAmount: Number(tx.amount) || 0,
      });
      continue;
    }

    existing.count += 1;
    if (date && (!existing.lastDate || date > existing.lastDate)) {
      existing.lastDate = date;
      existing.lastCategoryId = tx.categoryId;
      existing.lastAmount = Number(tx.amount) || 0;
    }
  }

  return [...byMerchant.values()]
    .filter(entry => !search || entry.label.toLowerCase().includes(search))
    .sort((a, b) => (
      b.count - a.count
      || (b.lastDate?.getTime() || 0) - (a.lastDate?.getTime() || 0)
      || a.label.localeCompare(b.label)
    ))
    .slice(0, limit);
}

/**
 * First rule whose match text appears in `text`, or null.
 * Rules are expected pre-sorted by priority (see `getRules` in db.js).
 */
export function matchRule(text, rules = []) {
  const haystack = String(text || '').toLowerCase();
  if (!haystack) return null;
  return rules.find(rule => {
    const needle = String(rule?.match || '').trim().toLowerCase();
    return needle && haystack.includes(needle);
  }) || null;
}

/**
 * Best guess at the category for a note, and why.
 *
 * Explicit rules win over learned history: a rule is something the user stated,
 * history is only inference. Returns null when there's nothing to go on, so
 * callers can leave the current selection alone rather than guessing wildly.
 */
export function suggestCategoryForNote(text, { rules = [], transactions = [], categories = [] } = {}) {
  const label = String(text || '').trim();
  if (!label) return null;

  const validCategory = (id) => categories.some(cat => Number(cat.id) === Number(id));

  const rule = matchRule(label, rules);
  if (rule && validCategory(rule.categoryId)) {
    return { categoryId: Number(rule.categoryId), source: 'rule', match: rule.match };
  }

  const lower = label.toLowerCase();
  const [best] = getMerchantSuggestions(transactions, '', Infinity)
    .filter(entry => entry.label.toLowerCase() === lower || entry.label.toLowerCase().startsWith(lower));

  if (best && validCategory(best.lastCategoryId)) {
    return {
      categoryId: Number(best.lastCategoryId),
      source: 'history',
      match: best.label,
      lastAmount: best.lastAmount,
    };
  }

  return null;
}

/** Every distinct tag in use, alphabetically — for filter chips and autocomplete. */
export function getAllTags(transactions = []) {
  const tags = new Set();
  for (const tx of transactions) {
    if (!Array.isArray(tx?.tags)) continue;
    for (const tag of tx.tags) {
      const clean = String(tag || '').trim();
      if (clean) tags.add(clean);
    }
  }
  return [...tags].sort((a, b) => a.localeCompare(b));
}

/** Normalise free-text tag entry: trimmed, de-duplicated, no empties. */
export function normaliseTags(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(',');
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const tag = String(raw || '').trim().replace(/^#/, '');
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

// ── Forecasting ──────────────────────────────────────────────────────────────

/**
 * Daily burn rate per category, based on amount spent and days elapsed in that
 * category's own cycle.
 */
export function getDailyBurnRate(categories = [], settings, incomes = [], now = new Date()) {
  const rates = {};
  for (const cat of categories) {
    const { elapsed } = getCategoryCycle(cat, incomes, settings, now);
    rates[cat.id] = (Number(cat.spent) || 0) / Math.max(1, elapsed);
  }
  return rates;
}

/**
 * Projected spend by the end of the current cycle, per category.
 */
export function getProjectedSpend(categories = [], settings, incomes = [], now = new Date()) {
  const projected = {};
  for (const cat of categories) {
    const { elapsed, days } = getCategoryCycle(cat, incomes, settings, now);
    const rate = (Number(cat.spent) || 0) / Math.max(1, elapsed);
    projected[cat.id] = roundMoney(rate * days);
  }
  return projected;
}

/**
 * Total upcoming subscription charges for a category within the current budget period.
 * Counts every recurrence from each active subscription's nextDueAt until the next reset.
 */
export function getUpcomingSubscriptionCost(subscriptions = [], categoryId, settings, now = new Date(), cycleEnd = null) {
  // Prefer the caller's cycle end (from getCategoryCycle) — it follows the
  // funding income. Falling back to `settings` only matters for legacy setups.
  let nextReset = cycleEnd ? toValidDate(cycleEnd) : null;
  if (!nextReset) {
    const nextResetResult = getEffectiveNextReset(settings);
    if (!nextResetResult) return 0;
    nextReset = toValidDate(nextResetResult.date || nextResetResult);
    if (!nextReset) return 0;
  }
  nextReset = startOfDay(nextReset);

  const catSubs = subscriptions.filter(s =>
    Number(s.categoryId) === Number(categoryId) && s.active !== false
  );

  let total = 0;
  for (const sub of catSubs) {
    if (!sub.nextDueAt) continue;
    let due = startOfDay(new Date(sub.nextDueAt));
    let guard = 0;
    while (due < nextReset && guard < 60) {
      total += Number(sub.amount) || 0;
      due = addRecurringInterval(due, sub.intervalUnit || 'month', sub.interval || 1);
      guard++;
    }
  }

  return roundMoney(total);
}

/**
 * For a wishlist item, determine:
 * - canAffordNow: combined leftover across assigned categories >= item price
 * - daysUntil: if not now, how many days until burn rate frees enough
 * - shortfall: how much more is needed
 */
export function wishlistAffordability(item, categories, settings, incomes = []) {
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

  // Reset timing follows the funding income of the assigned categories, not the
  // account-wide schedule. Use the soonest — that's when money first frees up.
  const cycles = assigned.map(cat => getCategoryCycle(cat, incomes, settings));
  const soonest = cycles.reduce((best, cycle) => (!best || cycle.end < best.end ? cycle : best), null);
  const resetDays = soonest ? soonest.remaining : daysUntilReset(settings);
  const cycleDays = soonest ? soonest.days : 30;

  // Estimate: a reset restores allowances, so if the price fits inside one
  // cycle's total allowance it becomes affordable at the next reset.
  const totalAllowance = assigned.reduce((sum, cat) => sum + (cat.allowance || 0), 0);

  if (item.price <= totalAllowance) {
    return { canAffordNow: false, daysUntil: resetDays, shortfall, combinedLeftover, afterReset: true };
  }

  if (totalAllowance <= 0) return { canAffordNow: false, daysUntil: null, shortfall, combinedLeftover };

  const periodsNeeded = Math.ceil(item.price / totalAllowance);
  const daysUntil = (resetDays || 0) + (periodsNeeded - 1) * cycleDays;

  return { canAffordNow: false, daysUntil, shortfall, combinedLeftover, periodsNeeded };
}

/**
 * The one number the app never had: how much is actually free to spend.
 *
 * Per category: spare budget, minus subscriptions still due before its reset,
 * spread across the days left in its own cycle. Summed across categories and
 * reported over three horizons. `goalCommitment` (savings still to be set
 * aside this cycle) is deducted proportionally.
 */
export function getSafeToSpend({
  categories = [],
  incomes = [],
  subscriptions = [],
  settings = null,
  goalCommitment = 0,
  now = new Date(),
} = {}) {
  let perDay = 0;
  let week = 0;
  let toReset = 0;
  let committedSubscriptions = 0;
  let nextReset = null;
  let daysToReset = null;

  for (const cat of categories) {
    const cycle = getCategoryCycle(cat, incomes, settings, now);
    const spare = getCategorySpare(cat);
    const subs = getUpcomingSubscriptionCost(subscriptions, cat.id, settings, now, cycle.end);

    committedSubscriptions = roundMoney(committedSubscriptions + Math.min(subs, spare));

    const available = Math.max(0, roundMoney(spare - subs));
    const daysLeft = Math.max(1, cycle.remaining);
    const dailyRate = available / daysLeft;

    perDay += dailyRate;
    week += dailyRate * Math.min(7, daysLeft);
    toReset += available;

    if (!nextReset || cycle.end < nextReset) {
      nextReset = cycle.end;
      daysToReset = cycle.remaining;
    }
  }

  const committedGoals = Math.min(Math.max(0, roundMoney(goalCommitment)), roundMoney(toReset));
  const ratio = toReset > 0 ? Math.max(0, (toReset - committedGoals) / toReset) : 0;

  return {
    today: roundMoney(perDay * ratio),
    week: roundMoney(week * ratio),
    toReset: roundMoney(toReset - committedGoals),
    committedSubscriptions,
    committedGoals,
    nextReset,
    daysToReset,
  };
}

/**
 * Build monthly spend history per category for chart.
 * Aggregates transactions by month.
 */
export function buildMonthlyHistory(transactions, categories, monthCount = 6) {
  const catMap = Object.fromEntries(categories.map(c => [c.id, c.name]));
  const byMonth = new Map();

  for (const tx of transactions) {
    const date = toValidDate(tx.date);
    if (!date) continue;

    // Bucket on a sortable key: callers pass transactions in varying orders, so
    // relying on insertion order silently returned the wrong six months.
    const sortKey = format(date, 'yyyy-MM');
    if (!byMonth.has(sortKey)) byMonth.set(sortKey, { sortKey, month: format(date, 'MMM yy') });

    const bucket = byMonth.get(sortKey);
    const catName = catMap[tx.categoryId] || 'Other';
    bucket[catName] = roundMoney((bucket[catName] || 0) + getSignedAmount(tx));
  }

  return [...byMonth.values()]
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
    .slice(-monthCount)
    .map(row => {
      const chartRow = { ...row };
      delete chartRow.sortKey;
      return chartRow;
    });
}

/**
 * Projected balance at the end of one period: income for that period minus
 * projected spend over the same period.
 *
 * Both sides are normalised to `period` first. Categories on different cycles
 * have projections denominated in different lengths of time, so the daily burn
 * rate is the only common unit the two sides can meet in.
 */
export function projectedEndBalance(categories = [], settings, incomes = [], period = 'month') {
  if (!settings && !incomes.length) return 0;

  const income = incomes.length > 0
    ? getNormalisedIncomeTotal(incomes, period)
    : (settings?.income || 0);

  const periodDays = getPeriodDays(period);
  const burnRates = getDailyBurnRate(categories, settings, incomes);
  const totalProjected = Object.values(burnRates).reduce((sum, rate) => sum + rate, 0) * periodDays;

  return roundMoney(income - totalProjected);
}

// ── Goals ────────────────────────────────────────────────────────────────────

export function getGoalProgress(goal) {
  const target = Math.abs(roundMoney(goal?.target));
  const saved = Math.max(0, roundMoney(goal?.saved));
  const remaining = Math.max(0, roundMoney(target - saved));

  return {
    target,
    saved,
    remaining,
    pct: target > 0 ? Math.min(100, (saved / target) * 100) : 0,
    complete: target > 0 && saved >= target - 0.005,
  };
}

/**
 * When a goal finishes at its current contribution rate.
 *
 * Returns nulls rather than Infinity when there's no contribution set — "no
 * end date" is the honest answer, and it lets the UI say so.
 */
export function getGoalEta(goal, incomes = [], now = new Date()) {
  const { remaining, complete } = getGoalProgress(goal);
  if (complete) return { cycles: 0, date: null, complete: true };

  const perCycle = roundMoney(goal?.perCycleContribution);
  if (!(perCycle > 0)) return { cycles: null, date: null, complete: false };

  const income = incomes.find(item => Number(item.id) === Number(goal?.incomeId));
  const cycleDays = getIncomeCycleAverageDays(income ? getIncomeFrequency(income) : 'monthly');
  const cycles = Math.ceil(remaining / perCycle);

  return {
    cycles,
    date: addDays(startOfDay(now), Math.round(cycles * cycleDays)),
    complete: false,
    perCycle,
  };
}

/** True when a goal will miss its target date at the current rate. */
export function isGoalOffTrack(goal, incomes = [], now = new Date()) {
  if (!goal?.targetDate) return false;
  const target = toValidDate(goal.targetDate);
  if (!target) return false;

  const { complete } = getGoalProgress(goal);
  if (complete) return false;

  const eta = getGoalEta(goal, incomes, now);
  if (!eta.date) return true; // a deadline with no contribution is off track by definition
  return eta.date > startOfDay(target);
}

/**
 * Savings still to be set aside this cycle, for deduction from safe-to-spend.
 *
 * Only counts goals that haven't yet had this cycle's contribution taken —
 * money already moved into a goal has left the spendable pool once, and
 * charging for it twice would understate what's actually free.
 */
export function getGoalCommitment(goals = [], incomes = [], settings = null, now = new Date()) {
  let total = 0;

  for (const goal of goals) {
    const perCycle = roundMoney(goal?.perCycleContribution);
    if (!(perCycle > 0)) continue;

    const { remaining, complete } = getGoalProgress(goal);
    if (complete) continue;

    const income = incomes.find(item => Number(item.id) === Number(goal.incomeId));
    if (income) {
      // Already taken for this cycle? Then it's no longer pending.
      const cycle = getCategoryCycle(
        { incomeAllocations: [{ incomeId: Number(goal.incomeId), percent: 100 }] },
        incomes, settings, now,
      );
      const lastTaken = toValidDate(goal.lastAutoContributeAt);
      if (lastTaken && lastTaken >= cycle.start) continue;
    }

    total = roundMoney(total + Math.min(perCycle, remaining));
  }

  return total;
}

// ── Insight ──────────────────────────────────────────────────────────────────

/**
 * Where the money actually went, by merchant.
 *
 * Categories say what kind of spending it was; merchants say what you actually
 * bought — which is usually the more actionable of the two.
 */
export function getMerchantBreakdown(transactions = [], { since = null, limit = 8 } = {}) {
  const from = toValidDate(since);
  const totals = new Map();

  for (const tx of transactions) {
    const date = toValidDate(tx.date);
    if (from && (!date || date < from)) continue;

    const label = getTransactionMerchant(tx) || 'Uncategorised';
    const key = label.toLowerCase();
    const existing = totals.get(key) || { label, total: 0, count: 0 };
    existing.total = roundMoney(existing.total + getSignedAmount(tx));
    existing.count += 1;
    totals.set(key, existing);
  }

  return [...totals.values()]
    .filter(entry => entry.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

/**
 * This cycle versus the one before it, overall and per category.
 *
 * Cycles are resolved per category, so a weekly-funded category is compared
 * against its own previous week rather than against a calendar month.
 */
export function getCycleComparison(transactions = [], categories = [], incomes = [], settings = null, now = new Date()) {
  const rows = [];
  let currentTotal = 0;
  let previousTotal = 0;

  for (const category of categories) {
    const cycle = getCategoryCycle(category, incomes, settings, now);
    const previousStart = addDays(cycle.start, -cycle.days);

    let current = 0;
    let previous = 0;

    for (const tx of transactions) {
      if (Number(tx.categoryId) !== Number(category.id)) continue;
      const date = toValidDate(tx.date);
      if (!date) continue;
      const day = startOfDay(date);

      if (day >= cycle.start && day < cycle.end) current = roundMoney(current + getSignedAmount(tx));
      else if (day >= previousStart && day < cycle.start) previous = roundMoney(previous + getSignedAmount(tx));
    }

    currentTotal = roundMoney(currentTotal + current);
    previousTotal = roundMoney(previousTotal + previous);

    rows.push({
      id: category.id,
      name: category.name,
      color: category.color,
      current,
      previous,
      change: roundMoney(current - previous),
      // No previous spend means "new", not "infinitely worse" — leave the
      // percentage null so callers can say so rather than print ∞%.
      changePct: previous > 0 ? roundMoney(((current - previous) / previous) * 100) : null,
    });
  }

  return {
    categories: rows.sort((a, b) => Math.abs(b.change) - Math.abs(a.change)),
    currentTotal,
    previousTotal,
    change: roundMoney(currentTotal - previousTotal),
    changePct: previousTotal > 0 ? roundMoney(((currentTotal - previousTotal) / previousTotal) * 100) : null,
  };
}

/**
 * Running account balance over time, derived from the ledger.
 *
 * Balances aren't stored historically — only the current figure is. Working
 * backwards from it keeps the series consistent with what the app shows now,
 * rather than inventing a second source of truth.
 */
export function buildBalanceHistory(account, { transactions = [], incomeEvents = [], transfers = [], days = 60 } = {}) {
  const today = startOfDay(new Date());
  const from = addDays(today, -days);
  const accountId = Number(account?.id);

  const deltas = new Map(); // yyyy-MM-dd → net change that day
  const bump = (date, amount) => {
    const day = toValidDate(date);
    if (!day) return;
    const key = format(startOfDay(day), 'yyyy-MM-dd');
    deltas.set(key, roundMoney((deltas.get(key) || 0) + amount));
  };

  for (const tx of transactions) {
    if (Number(tx.accountId) !== accountId) continue;
    bump(tx.date, -getSignedAmount(tx));
  }
  for (const event of incomeEvents) {
    if (Number(event.accountId) !== accountId) continue;
    bump(event.date, Number(event.amount) || 0);
  }
  for (const transfer of transfers) {
    const amount = Number(transfer.amount) || 0;
    if (Number(transfer.toAccountId) === accountId) bump(transfer.date, amount);
    if (Number(transfer.fromAccountId) === accountId) bump(transfer.date, -amount);
  }

  // Walk back from today's known balance to find where the window started.
  let balance = roundMoney(Number(account?.balance) || 0);
  const series = [];
  for (let day = today; day >= from; day = addDays(day, -1)) {
    const key = format(day, 'yyyy-MM-dd');
    series.unshift({ date: key, label: format(day, 'd MMM'), balance });
    balance = roundMoney(balance - (deltas.get(key) || 0));
  }

  return series;
}

/**
 * Transactions that stand out against their category's usual size.
 *
 * Uses a median-based threshold rather than a mean: a single huge outlier drags
 * a mean upward enough to hide itself.
 */
export function flagUnusualSpend(transactions = [], { multiplier = 3, minimumAmount = 20 } = {}) {
  const byCategory = new Map();
  for (const tx of transactions) {
    if (isRefund(tx)) continue;
    const key = Number(tx.categoryId);
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(Math.abs(Number(tx.amount) || 0));
  }

  const thresholds = new Map();
  for (const [categoryId, amounts] of byCategory) {
    if (amounts.length < 4) continue; // too little history to call anything unusual
    const sorted = [...amounts].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median > 0) thresholds.set(categoryId, median * multiplier);
  }

  const flagged = new Set();
  for (const tx of transactions) {
    if (isRefund(tx)) continue;
    const threshold = thresholds.get(Number(tx.categoryId));
    const amount = Math.abs(Number(tx.amount) || 0);
    if (threshold && amount >= Math.max(threshold, minimumAmount)) flagged.add(tx.id);
  }

  return flagged;
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

function getCycleStartForDate(date, payDay) {
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const effectiveDay = Math.min(payDay, daysInMonth);
  if (day >= effectiveDay) {
    return new Date(year, month, effectiveDay);
  }
  const prevYear = month === 0 ? year - 1 : year;
  const prevMonth = month === 0 ? 11 : month - 1;
  const daysInPrevMonth = new Date(prevYear, prevMonth + 1, 0).getDate();
  return new Date(prevYear, prevMonth, Math.min(payDay, daysInPrevMonth));
}

/**
 * Running total of over/underspend against `allowance`, summed across every
 * past budget cycle.
 *
 * `options` may be a plain pay-day number (legacy monthly behaviour) or
 * `{ freq, payDayOfMonth, anchor }`. Weekly/fortnightly/4-weekly cycles are
 * bucketed by offset from `anchor` — slicing them by day-of-month, as this
 * previously did, put several cycles' spend into a single bucket and reported
 * phantom overspend.
 */
export function getCumulativeOverspend(categoryId, allowance, transactions, options = 1) {
  if (!allowance || allowance <= 0) return 0;

  const catTxs = transactions.filter(tx => Number(tx.categoryId) === Number(categoryId));
  if (!catTxs.length) return 0;

  const config = (options && typeof options === 'object') ? options : { payDayOfMonth: options };
  const freq = config.freq || 'monthly';
  const payDay = Number(config.payDayOfMonth) || 1;
  const anchor = toValidDate(config.anchor);
  const fixedCycleDays = { weekly: 7, fortnightly: 14, '4weekly': 28 }[freq] || null;

  const cycleSpend = new Map();
  for (const tx of catTxs) {
    const date = toValidDate(tx.date);
    if (!date) continue;

    let key;
    if (fixedCycleDays && anchor) {
      key = `c${Math.floor(differenceInDays(startOfDay(date), startOfDay(anchor)) / fixedCycleDays)}`;
    } else {
      const cycleStart = getCycleStartForDate(date, payDay);
      key = `${cycleStart.getFullYear()}-${cycleStart.getMonth()}-${cycleStart.getDate()}`;
    }
    cycleSpend.set(key, roundMoney((cycleSpend.get(key) || 0) + getSignedAmount(tx)));
  }

  let cumulative = 0;
  for (const spent of cycleSpend.values()) {
    cumulative += spent - allowance;
  }
  return roundMoney(cumulative);
}

/**
 * Compress a JSON-serialisable snapshot into a URL-safe string for embedding
 * in a share link's hash fragment.
 */
export function encodeSnapshotForUrl(snapshot) {
  return compressToEncodedURIComponent(JSON.stringify(snapshot));
}

/**
 * Reverse of encodeSnapshotForUrl. Returns null on any decode/parse failure
 * so callers can safely no-op on a missing or corrupt fragment.
 */
export function decodeSnapshotFromUrl(encoded) {
  if (!encoded) return null;
  try {
    const json = decompressFromEncodedURIComponent(encoded);
    if (!json) return null;
    return JSON.parse(json);
  } catch {
    return null;
  }
}
