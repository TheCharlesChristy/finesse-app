import { addDays, addMonths, addWeeks, addYears, getDate, getDaysInMonth, setDate, isAfter, isBefore, differenceInDays, format, startOfDay, subMonths } from 'date-fns';
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

  // A debt charging interest can't be divided out like a savings pot: the
  // balance grows between payments. Delegating keeps every existing caller —
  // the Goals view, the off-track nudge — honest without knowing about APR.
  if (goal?.kind === 'debt' && Number(goal?.apr) > 0) {
    const payoff = getDebtPayoff(goal, incomes, now);
    return {
      cycles: payoff.cycles,
      date: payoff.date,
      complete: false,
      perCycle,
      totalInterest: payoff.totalInterest,
      neverClears: payoff.neverClears,
    };
  }

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

// ── Debt ─────────────────────────────────────────────────────────────────────

// A century of payments. Any debt still running past this is one the payment
// never clears, and the loop needs a floor under it regardless.
const MAX_PAYOFF_CYCLES = 1200;

export const DEBT_AVALANCHE = 'avalanche';
export const DEBT_SNOWBALL = 'snowball';

/**
 * The interest rate for one payment cycle, from an annual APR.
 *
 * Proportional to the cycle length rather than compounded to it, which is how
 * lenders actually quote it — a 24% APR card charges 2% a month, not
 * 1.809% (the rate that would compound to 24% over a year).
 */
export function getDebtPeriodicRate(apr, cycleDays = AVERAGE_MONTH_DAYS) {
  const annual = Number(apr);
  if (!Number.isFinite(annual) || annual <= 0) return 0;
  return (annual / 100) * (cycleDays / 365.25);
}

/**
 * Amortise one debt at its current payment.
 *
 * `getGoalEta` divides what's left by the payment, which is right for a savings
 * pot and wrong for a debt: it ignores the interest still accruing on the
 * balance, so it under-reports both the date and the true cost — the difference
 * between a progress bar and a decision.
 *
 * Returns `neverClears` when the payment doesn't cover the interest. That is
 * the single most important thing this function can tell anyone, so it is a
 * flag rather than an absurdly distant date.
 */
export function getDebtPayoff(goal, incomes = [], now = new Date()) {
  const { remaining, complete } = getGoalProgress(goal);
  const payment = roundMoney(goal?.perCycleContribution);
  const income = incomes.find(item => Number(item.id) === Number(goal?.incomeId));
  const cycleDays = getIncomeCycleAverageDays(income ? getIncomeFrequency(income) : 'monthly');
  const rate = getDebtPeriodicRate(goal?.apr, cycleDays);

  if (complete || remaining <= 0) {
    return { cycles: 0, date: null, totalInterest: 0, totalPaid: 0, neverClears: false, complete: true, rate };
  }
  if (!(payment > 0)) {
    return { cycles: null, date: null, totalInterest: null, totalPaid: null, neverClears: false, complete: false, rate };
  }

  const firstInterest = roundMoney(remaining * rate);
  if (payment <= firstInterest) {
    return {
      cycles: null, date: null, totalInterest: null, totalPaid: null,
      neverClears: true, complete: false, rate,
      interestPerCycle: firstInterest,
    };
  }

  let balance = remaining;
  let totalInterest = 0;
  let totalPaid = 0;
  let cycles = 0;

  while (balance > 0 && cycles < MAX_PAYOFF_CYCLES) {
    const interest = roundMoney(balance * rate);
    // The final payment is only ever what's actually left to clear.
    const due = Math.min(roundMoney(balance + interest), payment);
    totalInterest = roundMoney(totalInterest + interest);
    totalPaid = roundMoney(totalPaid + due);
    balance = roundMoney(balance + interest - due);
    cycles += 1;
  }

  return {
    cycles,
    date: addDays(startOfDay(now), Math.round(cycles * cycleDays)),
    totalInterest,
    totalPaid,
    neverClears: false,
    complete: false,
    rate,
  };
}

/** Debt goals with something still owing, in the order a strategy would clear them. */
export function orderDebts(goals = [], method = DEBT_AVALANCHE, incomes = []) {
  const open = goals
    .filter(goal => goal?.kind === 'debt')
    .map(goal => ({ goal, ...getGoalProgress(goal) }))
    .filter(entry => entry.remaining > 0.005);

  return open.sort((a, b) => {
    if (method === DEBT_SNOWBALL) {
      // Smallest balance first: the point is the momentum of clearing one.
      return a.remaining - b.remaining || Number(b.goal.apr || 0) - Number(a.goal.apr || 0);
    }
    // Avalanche: dearest money first, which is always the cheaper arithmetic.
    const aRate = getDebtPeriodicRate(a.goal.apr, 30);
    const bRate = getDebtPeriodicRate(b.goal.apr, 30);
    return bRate - aRate || a.remaining - b.remaining;
  }).map(entry => entry.goal);
}

/**
 * Run every debt forward together under one payoff order.
 *
 * Each cycle: interest accrues on every balance, the minimum goes to each, and
 * everything left in the pool is thrown at the first debt in the order. As
 * balances clear, their payments cascade to the next — which is the whole
 * mechanism behind both strategies, and the reason the two differ in cost.
 *
 * The pool is what the user already commits (the sum of the per-cycle
 * contributions), so this compares *orderings* of the same money rather than
 * quietly assuming they can pay more.
 */
export function simulateDebtStrategy(goals = [], incomes = [], { method = DEBT_AVALANCHE, now = new Date() } = {}) {
  const ordered = orderDebts(goals, method, incomes);
  if (!ordered.length) return { method, cycles: 0, totalInterest: 0, order: [], cleared: [], neverClears: false };

  const income = incomes.find(item => Number(item.id) === Number(ordered[0]?.incomeId));
  const cycleDays = getIncomeCycleAverageDays(income ? getIncomeFrequency(income) : 'monthly');

  const debts = ordered.map(goal => ({
    id: goal.id,
    name: goal.name,
    balance: getGoalProgress(goal).remaining,
    rate: getDebtPeriodicRate(goal.apr, cycleDays),
    minimum: Math.max(0, roundMoney(goal.minimumPayment)),
    payment: Math.max(0, roundMoney(goal.perCycleContribution)),
    clearedAtCycle: null,
  }));

  const pool = roundMoney(debts.reduce((sum, debt) => sum + debt.payment, 0));
  if (!(pool > 0)) {
    return { method, cycles: null, totalInterest: null, order: debts.map(d => d.name), cleared: [], neverClears: false };
  }

  let totalInterest = 0;
  let cycles = 0;

  while (debts.some(debt => debt.balance > 0.005) && cycles < MAX_PAYOFF_CYCLES) {
    for (const debt of debts) {
      if (debt.balance <= 0) continue;
      const interest = roundMoney(debt.balance * debt.rate);
      totalInterest = roundMoney(totalInterest + interest);
      debt.balance = roundMoney(debt.balance + interest);
    }

    let available = pool;
    // Minimums first, in order, so a debt is never left unserviced because the
    // target debt ate the pool.
    for (const debt of debts) {
      if (debt.balance <= 0 || available <= 0) continue;
      const pay = Math.min(debt.minimum, debt.balance, available);
      debt.balance = roundMoney(debt.balance - pay);
      available = roundMoney(available - pay);
    }
    // Everything left goes at the front of the order, then cascades.
    for (const debt of debts) {
      if (debt.balance <= 0 || available <= 0) continue;
      const pay = Math.min(debt.balance, available);
      debt.balance = roundMoney(debt.balance - pay);
      available = roundMoney(available - pay);
    }

    cycles += 1;
    for (const debt of debts) {
      if (debt.balance <= 0.005 && debt.clearedAtCycle == null) debt.clearedAtCycle = cycles;
    }

    // Nothing moved and nothing is clear: the pool can't outpace the interest.
    if (available >= pool - 0.005 && debts.every(debt => debt.balance > 0.005)) {
      return { method, cycles: null, totalInterest: null, order: debts.map(d => d.name), cleared: [], neverClears: true };
    }
  }

  const neverClears = cycles >= MAX_PAYOFF_CYCLES && debts.some(debt => debt.balance > 0.005);

  return {
    method,
    cycles: neverClears ? null : cycles,
    totalInterest: neverClears ? null : totalInterest,
    date: neverClears ? null : addDays(startOfDay(now), Math.round(cycles * cycleDays)),
    order: debts.map(debt => debt.name),
    cleared: debts.map(debt => ({
      id: debt.id,
      name: debt.name,
      cycles: debt.clearedAtCycle,
      date: debt.clearedAtCycle == null ? null : addDays(startOfDay(now), Math.round(debt.clearedAtCycle * cycleDays)),
    })),
    neverClears,
  };
}

/**
 * Avalanche against snowball, on the same money.
 *
 * Avalanche is always at least as cheap — it is what minimising interest means
 * — so `saving` is what the cheaper order is worth, and the UI can be honest
 * that snowball costs more while still being the one some people finish.
 */
export function compareDebtStrategies(goals = [], incomes = [], now = new Date()) {
  const avalanche = simulateDebtStrategy(goals, incomes, { method: DEBT_AVALANCHE, now });
  const snowball = simulateDebtStrategy(goals, incomes, { method: DEBT_SNOWBALL, now });

  const comparable = avalanche.totalInterest != null && snowball.totalInterest != null;
  return {
    avalanche,
    snowball,
    saving: comparable ? roundMoney(snowball.totalInterest - avalanche.totalInterest) : null,
    // Only worth showing a choice when the two orders actually differ.
    differs: comparable && avalanche.order.join('|') !== snowball.order.join('|'),
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
  // No date covers both "nothing being contributed" and "the payment never
  // outpaces the interest" — a deadline is missed either way.
  if (!eta.date) return true;
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

// ── Cash-flow forecast ───────────────────────────────────────────────────────

/**
 * Day-by-day projected account balance.
 *
 * Budget categories answer "can I afford this out of my Groceries allowance?".
 * This answers the different and more urgent question: "will the money actually
 * be in the account when that direct debit comes out?" — the one that produces
 * failed payments.
 *
 * Combines scheduled income, scheduled subscriptions, and the current burn rate
 * for everything else. Returns the series plus the first date the balance goes
 * negative, if any.
 */
export function buildCashFlowForecast({
  account = null,
  categories = [],
  incomes = [],
  subscriptions = [],
  settings = null,
  days = 45,
  now = new Date(),
} = {}) {
  const today = startOfDay(now);
  const end = addDays(today, days);

  // Discretionary burn, excluding anything a subscription already accounts for
  // — those land on their own dates below and would otherwise be counted twice.
  const burnRates = getDailyBurnRate(categories, settings, incomes, now);
  const subscriptionDailyCost = subscriptions
    .filter(sub => sub.active !== false)
    .reduce((sum, sub) => {
      const interval = Math.max(1, Number(sub.interval) || 1);
      const unitDays = { day: 1, week: 7, month: AVERAGE_MONTH_DAYS, year: 365.25 }[sub.intervalUnit || 'month'] ?? AVERAGE_MONTH_DAYS;
      return sum + (Number(sub.amount) || 0) / (interval * unitDays);
    }, 0);
  const dailyBurn = Math.max(0, Object.values(burnRates).reduce((sum, rate) => sum + rate, 0) - subscriptionDailyCost);

  const events = new Map(); // yyyy-MM-dd → [{ label, amount }]
  const addEvent = (date, label, amount) => {
    const day = startOfDay(date);
    if (day < today || day > end) return;
    const key = format(day, 'yyyy-MM-dd');
    if (!events.has(key)) events.set(key, []);
    events.get(key).push({ label, amount: roundMoney(amount) });
  };

  for (const income of incomes) {
    if (income.holdActive) continue;
    const freq = income.resetFrequency || (income.payDayOfMonth ? 'monthly' : null);
    if (!freq) continue;

    let next = calcNextReset(freq, income.payDayOfMonth, toValidDate(income.lastPaid) || today);
    let guard = 0;
    while (next <= end && guard < 240) {
      if (next > today) addEvent(next, income.name || 'Income', Number(income.amount) || 0);
      next = calcNextReset(freq, income.payDayOfMonth, next);
      guard += 1;
    }
  }

  for (const sub of subscriptions) {
    if (sub.active === false || !sub.nextDueAt) continue;
    let next = toValidDate(sub.nextDueAt);
    if (!next) continue;
    next = startOfDay(next);

    let guard = 0;
    while (next <= end && guard < 240) {
      addEvent(next, sub.name || 'Subscription', -(Number(sub.amount) || 0));
      next = addRecurringInterval(next, sub.intervalUnit || 'month', sub.interval || 1);
      guard += 1;
    }
  }

  const series = [];
  let balance = roundMoney(Number(account?.balance) || 0);
  let lowest = { date: null, balance };
  let firstNegative = null;

  for (let day = today; day <= end; day = addDays(day, 1)) {
    const key = format(day, 'yyyy-MM-dd');
    const dayEvents = events.get(key) || [];

    if (day > today) {
      for (const event of dayEvents) balance = roundMoney(balance + event.amount);
      balance = roundMoney(balance - dailyBurn);
    }

    if (balance < lowest.balance) lowest = { date: day, balance };
    if (firstNegative === null && balance < 0) firstNegative = day;

    series.push({
      date: key,
      label: format(day, 'd MMM'),
      balance,
      events: dayEvents,
    });
  }

  return { series, firstNegative, lowest, dailyBurn: roundMoney(dailyBurn) };
}

// ── Nudges ───────────────────────────────────────────────────────────────────

export const NUDGE_DANGER = 'danger';
export const NUDGE_WARN = 'warn';
export const NUDGE_INFO = 'info';

const SUBSCRIPTION_DUE_WINDOW_DAYS = 3;
const BACKUP_STALE_DAYS = 30;
const SUBSCRIPTION_REVIEW_MONTHS = 6;

/**
 * Everything the app wants to tell you, as plain data.
 *
 * One source for both the in-app nudge centre and OS notifications, so the two
 * can never disagree about what's outstanding. Pure and synchronous: no
 * permissions, no scheduling, no side effects — callers decide how to deliver.
 *
 * Each nudge's `id` embeds the period it belongs to, so dismissing "payday
 * today" hides it for today and not forever.
 */
export function buildNudges({
  categories = [],
  incomes = [],
  subscriptions = [],
  goals = [],
  transactions = [],
  settings = null,
  storageState = null,
  now = new Date(),
} = {}) {
  const today = startOfDay(now);
  const nudges = [];
  const dayKey = format(today, 'yyyy-MM-dd');

  // ── Subscriptions due or overdue ──
  for (const sub of subscriptions) {
    if (sub.active === false || !sub.nextDueAt) continue;
    const due = toValidDate(sub.nextDueAt);
    if (!due) continue;

    const days = differenceInDays(startOfDay(due), today);
    if (days > SUBSCRIPTION_DUE_WINDOW_DAYS) continue;

    nudges.push({
      id: `sub-due-${sub.id}-${format(startOfDay(due), 'yyyy-MM-dd')}`,
      severity: days < 0 ? NUDGE_WARN : NUDGE_INFO,
      title: days < 0 ? `${sub.name} is overdue`
        : days === 0 ? `${sub.name} is due today`
        : `${sub.name} due in ${days} day${days === 1 ? '' : 's'}`,
      body: `${fmt(sub.amount || 0)} will be logged automatically.`,
      view: 'subscriptions',
    });
  }

  // ── Payday ──
  for (const income of incomes) {
    if (income.holdActive) continue;
    const freq = income.resetFrequency || (income.payDayOfMonth ? 'monthly' : null);
    if (!freq) continue;

    const base = toValidDate(income.lastPaid) || today;
    let next = calcNextReset(freq, income.payDayOfMonth, base);
    let guard = 0;
    while (next <= today && guard < 240) {
      next = calcNextReset(freq, income.payDayOfMonth, next);
      guard += 1;
    }

    const days = differenceInDays(startOfDay(next), today);
    if (days > 1) continue;

    nudges.push({
      id: `payday-${income.id}-${format(startOfDay(next), 'yyyy-MM-dd')}`,
      severity: NUDGE_INFO,
      title: days === 0 ? `${income.name} lands today` : `${income.name} lands tomorrow`,
      body: `${fmt(income.amount || 0)} — funded categories will reset.`,
      view: 'dashboard',
    });
  }

  // ── Over budget ──
  const overspent = categories.filter(cat => (cat.spent || 0) > getEffectiveAllowance(cat) + 0.005);
  if (overspent.length > 0) {
    const total = roundMoney(overspent.reduce(
      (sum, cat) => sum + ((cat.spent || 0) - getEffectiveAllowance(cat)), 0));
    nudges.push({
      id: `overspent-${dayKey}`,
      severity: NUDGE_DANGER,
      title: `${overspent.length} categor${overspent.length === 1 ? 'y is' : 'ies are'} over budget`,
      body: `${fmt(total)} over in total: ${overspent.map(c => c.name).join(', ')}.`,
      view: 'dashboard',
    });
  }

  // ── Broken funding ──
  const incomeIds = new Set(incomes.map(income => Number(income.id)));
  const brokenFunding = categories.filter(cat => {
    if (!incomes.length) return false;
    const allocations = normalizeIncomeAllocations(cat.incomeAllocations);
    return Math.abs(getAllocationPercentTotal(allocations) - 100) > 0.01
      || allocations.some(allocation => !incomeIds.has(allocation.incomeId));
  });
  if (brokenFunding.length > 0) {
    nudges.push({
      id: `funding-${dayKey}`,
      severity: NUDGE_WARN,
      title: `${brokenFunding.length} categor${brokenFunding.length === 1 ? 'y is' : 'ies are'} not fully funded`,
      body: `${brokenFunding.map(c => c.name).join(', ')} won't reset properly until fixed.`,
      view: 'dashboard',
    });
  }

  // ── Unallocated income ──
  const unallocated = getUnallocatedIncomeTotal(incomes, categories);
  const incomeTotal = incomes.reduce((sum, income) => sum + (Number(income.amount) || 0), 0);
  if (incomeTotal > 0 && unallocated > incomeTotal * 0.2) {
    nudges.push({
      id: `unallocated-${dayKey}`,
      severity: NUDGE_INFO,
      title: `${fmt(unallocated)} of income isn't budgeted`,
      body: 'Money without a job tends to get spent. Give it a category or a goal.',
      view: 'dashboard',
    });
  }

  // ── Goals off track ──
  for (const goal of goals) {
    if (!isGoalOffTrack(goal, incomes, now)) continue;
    const { remaining } = getGoalProgress(goal);
    nudges.push({
      id: `goal-${goal.id}-${format(today, 'yyyy-MM')}`,
      severity: NUDGE_WARN,
      title: `"${goal.name}" won't hit its date`,
      body: `${fmt(remaining)} still to go at the current rate.`,
      view: 'goals',
    });
  }

  // ── Subscription price changes ──
  for (const sub of subscriptions) {
    if (sub.active === false) continue;
    const charges = transactions
      .filter(tx => Number(tx.subscriptionId) === Number(sub.id))
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    if (charges.length < 2) continue;

    const latest = Math.abs(Number(charges[0].amount) || 0);
    const previous = Math.abs(Number(charges[1].amount) || 0);
    if (previous <= 0 || Math.abs(latest - previous) < 0.01) continue;

    nudges.push({
      id: `sub-price-${sub.id}-${latest}`,
      severity: NUDGE_WARN,
      title: `${sub.name} changed price`,
      body: `${fmt(previous)} → ${fmt(latest)} per charge.`,
      view: 'subscriptions',
    });
  }

  // ── Long-running subscriptions worth a look ──
  for (const sub of subscriptions) {
    if (sub.active === false) continue;
    const charges = transactions.filter(tx => Number(tx.subscriptionId) === Number(sub.id));
    if (charges.length < SUBSCRIPTION_REVIEW_MONTHS) continue;

    const total = roundMoney(charges.reduce((sum, tx) => sum + getSignedAmount(tx), 0));
    nudges.push({
      id: `sub-review-${sub.id}-${format(today, 'yyyy-MM')}`,
      severity: NUDGE_INFO,
      title: `You've paid ${fmt(total)} for ${sub.name}`,
      body: `${charges.length} charges so far. Still worth it?`,
      view: 'subscriptions',
    });
  }

  // ── Backup health ──
  // Everything lives in one browser. Clearing site data loses the lot, and
  // there is no server-side copy to fall back on.
  const lastBackup = toValidDate(settings?.lastBackupAt);
  const hasData = transactions.length > 0 || categories.length > 0;
  if (hasData) {
    const daysSince = lastBackup ? differenceInDays(today, startOfDay(lastBackup)) : null;
    if (daysSince == null || daysSince >= BACKUP_STALE_DAYS) {
      nudges.push({
        id: `backup-${format(today, 'yyyy-MM')}`,
        severity: NUDGE_WARN,
        title: lastBackup ? `No backup for ${daysSince} days` : 'You have never backed up',
        body: 'Your data lives only in this browser. Clearing site data would lose it.',
        view: 'settings',
      });
    }
  }

  // ── Evictable storage ──
  // Stronger than the backup nudge and deliberately separate: a stale backup
  // means an out-of-date copy exists, whereas evictable storage means the
  // browser is free to delete the original without asking. `null` is "not
  // checked yet", which must stay silent rather than alarm on a race.
  if (hasData && storageState === 'best-effort') {
    nudges.push({
      id: `storage-evictable-${format(today, 'yyyy-MM')}`,
      severity: NUDGE_WARN,
      title: 'Your data can be evicted',
      body: 'This browser has not promised to keep it. Turn on persistent storage in Settings.',
      view: 'settings',
    });
  }

  const order = { [NUDGE_DANGER]: 0, [NUDGE_WARN]: 1, [NUDGE_INFO]: 2 };
  return nudges.sort((a, b) => order[a.severity] - order[b.severity]);
}

/** Drop nudges the user has already dismissed. */
export function filterDismissedNudges(nudges = [], dismissed = {}) {
  return nudges.filter(nudge => !dismissed?.[nudge.id]);
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
 * A long look back — the retrospective the app never had.
 *
 * `getCycleComparison` covers this cycle against the last, and
 * `buildMonthlyHistory` charts six months of category totals. Neither answers
 * the questions you ask once a year: where did it all actually go, which months
 * were the bad ones, and has the subscription pile quietly grown?
 *
 * Everything is derived from the transaction log, which is the real record —
 * the spend counters are per-cycle and reset, so they cannot answer any of this.
 *
 * Refunds subtract via `getSignedAmount`, so a category with a big return shows
 * what it truly cost rather than what passed through it.
 */
export function buildReview({
  transactions = [], categories = [], incomeEvents = [], subscriptions = [],
  months = 12, now = new Date(),
} = {}) {
  const to = startOfDay(now);
  const from = startOfDay(subMonths(to, months - 1));
  const fromMonthKey = format(from, 'yyyy-MM');
  const catMap = new Map(categories.map(category => [Number(category.id), category]));
  const subscriptionIds = new Set(subscriptions.map(sub => Number(sub.id)));

  // One bucket per month in the window, created up front so a month with no
  // spending charts as a genuine zero rather than vanishing from the series.
  const monthly = new Map();
  for (let i = 0; i < months; i += 1) {
    const date = subMonths(to, months - 1 - i);
    monthly.set(format(date, 'yyyy-MM'), {
      key: format(date, 'yyyy-MM'),
      label: format(date, 'MMM yy'),
      spent: 0, income: 0, subscriptions: 0, count: 0,
    });
  }

  const byCategory = new Map();
  let spent = 0;
  let refunded = 0;
  let transactionCount = 0;
  let biggest = null;

  for (const tx of transactions) {
    const date = toValidDate(tx.date);
    if (!date) continue;
    const key = format(date, 'yyyy-MM');
    if (key < fromMonthKey) continue;

    const bucket = monthly.get(key);
    if (!bucket) continue;

    const signed = getSignedAmount(tx);
    const amount = Math.abs(Number(tx.amount) || 0);

    bucket.spent = roundMoney(bucket.spent + signed);
    bucket.count += 1;
    if (subscriptionIds.has(Number(tx.subscriptionId))) {
      bucket.subscriptions = roundMoney(bucket.subscriptions + signed);
    }

    if (isRefund(tx)) refunded = roundMoney(refunded + amount);
    else spent = roundMoney(spent + amount);
    transactionCount += 1;

    const categoryId = Number(tx.categoryId);
    const entry = byCategory.get(categoryId) || { id: categoryId, total: 0, count: 0 };
    entry.total = roundMoney(entry.total + signed);
    entry.count += 1;
    byCategory.set(categoryId, entry);

    // Biggest single outgoing, refunds excluded — a large refund is good news.
    if (!isRefund(tx) && (!biggest || amount > Math.abs(Number(biggest.amount) || 0))) biggest = tx;
  }

  let income = 0;
  for (const event of incomeEvents) {
    const date = toValidDate(event.date);
    if (!date) continue;
    const key = format(date, 'yyyy-MM');
    const bucket = monthly.get(key);
    if (!bucket) continue;
    const amount = Number(event.amount) || 0;
    bucket.income = roundMoney(bucket.income + amount);
    income = roundMoney(income + amount);
  }

  const series = [...monthly.values()].map(row => ({ ...row, net: roundMoney(row.income - row.spent) }));
  const net = roundMoney(spent - refunded);

  const categoryRows = [...byCategory.values()]
    .map(entry => {
      const category = catMap.get(entry.id);
      return {
        id: entry.id,
        name: category?.name || 'Deleted category',
        color: category?.color || 'var(--accent-blue)',
        total: entry.total,
        count: entry.count,
        share: net > 0 ? roundMoney((entry.total / net) * 100) : 0,
        monthlyAverage: roundMoney(entry.total / months),
      };
    })
    .filter(row => row.total > 0)
    .sort((a, b) => b.total - a.total);

  // Only months that actually happened can be the busiest or the quietest — a
  // window longer than the history would otherwise crown an empty month.
  const active = series.filter(row => row.count > 0);
  const bySpend = [...active].sort((a, b) => b.spent - a.spent);

  // Subscription creep: the first and last months that had any, so a window
  // starting before the first subscription doesn't report infinite growth.
  const withSubs = series.filter(row => row.subscriptions > 0);
  const firstSubs = withSubs[0]?.subscriptions ?? 0;
  const lastSubs = withSubs.at(-1)?.subscriptions ?? 0;

  return {
    from,
    to,
    months,
    totals: {
      spent, refunded, net, income,
      saved: roundMoney(income - net),
      transactionCount,
      monthlyAverage: roundMoney(net / months),
    },
    series,
    categories: categoryRows,
    merchants: getMerchantBreakdown(transactions, { since: from, limit: 8 }),
    subscriptionTrend: withSubs.length > 1
      ? {
        first: firstSubs,
        last: lastSubs,
        firstLabel: withSubs[0].label,
        lastLabel: withSubs.at(-1).label,
        change: roundMoney(lastSubs - firstSubs),
        changePct: firstSubs > 0 ? roundMoney(((lastSubs - firstSubs) / firstSubs) * 100) : null,
        total: roundMoney(series.reduce((sum, row) => sum + row.subscriptions, 0)),
      }
      : null,
    biggest,
    busiest: bySpend[0] || null,
    quietest: bySpend.length > 1 ? bySpend.at(-1) : null,
    hasData: transactionCount > 0,
  };
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
 * Everything you own, across every account, over time — plus what you owe.
 *
 * The asset side is real history: the same backwards walk from today's known
 * balance that `buildBalanceHistory` does, summed across accounts. Nothing is
 * invented, and the last point always equals the total the Accounts page shows.
 *
 * The debt side deliberately isn't a series. Finesse records what remains on a
 * debt goal, not when each payment landed, so any historical debt line would be
 * fabricated — and drawing today's balance flat across the last six months
 * would claim you owed that much all along. So debt is reported as a single
 * current figure, and `debtHasHistory: false` tells the UI to say so rather
 * than plot a line it can't stand behind.
 *
 * Savings goals are not added as assets: contributing to one is an earmark, not
 * a transfer, so that money is already inside an account balance. Counting it
 * again would inflate net worth by the size of every pot.
 */
export function buildNetWorthHistory({
  accounts = [], transactions = [], incomeEvents = [], transfers = [], goals = [], days = 90,
} = {}) {
  const today = startOfDay(new Date());
  const from = addDays(today, -days);
  const accountIds = new Set(accounts.map(account => Number(account.id)));

  const deltas = new Map();
  const bump = (date, amount) => {
    const day = toValidDate(date);
    if (!day) return;
    const key = format(startOfDay(day), 'yyyy-MM-dd');
    deltas.set(key, roundMoney((deltas.get(key) || 0) + amount));
  };

  for (const tx of transactions) {
    if (!accountIds.has(Number(tx.accountId))) continue;
    bump(tx.date, -getSignedAmount(tx));
  }
  for (const event of incomeEvents) {
    if (!accountIds.has(Number(event.accountId))) continue;
    bump(event.date, Number(event.amount) || 0);
  }
  // Transfers between two tracked accounts net to nothing across the whole
  // estate, so only one leg landing outside it moves the total.
  for (const transfer of transfers) {
    const amount = Number(transfer.amount) || 0;
    const into = accountIds.has(Number(transfer.toAccountId));
    const outOf = accountIds.has(Number(transfer.fromAccountId));
    if (into && !outOf) bump(transfer.date, amount);
    if (outOf && !into) bump(transfer.date, -amount);
  }

  const debt = roundMoney(goals
    .filter(goal => goal?.kind === 'debt')
    .reduce((sum, goal) => sum + getGoalProgress(goal).remaining, 0));

  let assets = roundMoney(accounts.reduce((sum, account) => sum + (Number(account.balance) || 0), 0));
  const latestAssets = assets;
  const series = [];

  for (let day = today; day >= from; day = addDays(day, -1)) {
    const key = format(day, 'yyyy-MM-dd');
    series.unshift({ date: key, label: format(day, 'd MMM'), assets });
    assets = roundMoney(assets - (deltas.get(key) || 0));
  }

  return {
    series,
    debtHasHistory: false,
    current: {
      assets: latestAssets,
      debt,
      netWorth: roundMoney(latestAssets - debt),
    },
    // How the estate moved over the window — the figure a trend is actually for.
    change: series.length ? roundMoney(latestAssets - series[0].assets) : 0,
  };
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
