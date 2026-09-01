import { describe, expect, it } from 'vitest';
import { addDays, format, startOfDay, subMonths } from 'date-fns';

import {
  AVERAGE_MONTH_DAYS,
  buildNudges,
  compareDebtStrategies,
  DEBT_AVALANCHE,
  DEBT_SNOWBALL,
  getDebtPayoff,
  getDebtPeriodicRate,
  orderDebts,
  simulateDebtStrategy,
  buildCashFlowForecast,
  filterDismissedNudges,
  buildMonthlyHistory,
  getCategoryCycle,
  getCumulativeOverspend,
  getDailyBurnRate,
  getEffectiveAllowance,
  getGoalCommitment,
  getGoalEta,
  getGoalProgress,
  getPacedPeriodStatus,
  getRolloverForNextCycle,
  isGoalOffTrack,
  getIncomeCycleAverageDays,
  getNormalisedAllowanceTotal,
  getNormalisedCategoryAllowance,
  getNormalisedIncomeTotal,
  getProjectedSpend,
  getSafeToSpend,
  getUnallocatedIncomeTotal,
  getUpcomingSubscriptionCost,
  getAllTags,
  getMerchantBreakdown,
  getCycleComparison,
  buildBalanceHistory,
  buildNetWorthHistory,
  buildReview,
  flagUnusualSpend,
  getMerchantSuggestions,
  getSignedAmount,
  isRefund,
  normaliseTags,
  suggestCategoryForNote,
  hasMixedIncomeFrequencies,
  projectedEndBalance,
  resolveCategoryAllowance,
  wishlistAffordability,
} from '../utils';

const iso = (date) => date.toISOString();

// A category funded 100% by one income, reset `daysAgo` days ago.
function makeCategory({ id = 1, allowance = 300, spent = 0, incomeId = 10, daysAgo = 10, ...rest }) {
  return {
    id,
    name: `Category ${id}`,
    allowance,
    spent,
    incomeAllocations: incomeId ? [{ incomeId, percent: 100 }] : [],
    lastReset: iso(addDays(new Date(), -daysAgo)),
    ...rest,
  };
}

function makeIncome({ id = 10, amount = 2000, resetFrequency = 'monthly', daysAgo = 10, ...rest }) {
  return { id, name: `Income ${id}`, amount, resetFrequency, lastPaid: iso(addDays(new Date(), -daysAgo)), ...rest };
}

describe('B1 — buildMonthlyHistory month ordering', () => {
  // App.jsx passes transactions newest-first; bucketing on insertion order
  // previously returned the six *oldest* months, in reverse.
  it('returns the most recent months in chronological order', () => {
    const categories = [{ id: 1, name: 'Food' }];
    const now = new Date();
    const transactions = Array.from({ length: 9 }, (_, i) => ({
      categoryId: 1,
      amount: 10 + i,
      date: iso(subMonths(now, i)),
    })); // already newest-first, as the app supplies them

    const history = buildMonthlyHistory(transactions, categories);

    expect(history).toHaveLength(6);
    expect(history.at(-1).month).toBe(format(now, 'MMM yy'));
    expect(history[0].month).toBe(format(subMonths(now, 5), 'MMM yy'));
    expect(history.some(row => 'sortKey' in row)).toBe(false);
  });

  it('produces identical output regardless of input ordering', () => {
    const categories = [{ id: 1, name: 'Food' }];
    const now = new Date();
    const txs = Array.from({ length: 8 }, (_, i) => ({ categoryId: 1, amount: 5, date: iso(subMonths(now, i)) }));

    expect(buildMonthlyHistory(txs, categories)).toEqual(buildMonthlyHistory([...txs].reverse(), categories));
  });

  it('sums amounts per category within a month and skips invalid dates', () => {
    const categories = [{ id: 1, name: 'Food' }];
    const now = new Date();
    const history = buildMonthlyHistory([
      { categoryId: 1, amount: 10, date: iso(now) },
      { categoryId: 1, amount: 5.5, date: iso(now) },
      { categoryId: 1, amount: 99, date: 'not-a-date' },
    ], categories);

    expect(history).toHaveLength(1);
    expect(history[0].Food).toBe(15.5);
  });
});

describe('B2/B3 — effective allowance includes temporary boosts', () => {
  it('counts temporaryBoost toward what is spendable', () => {
    expect(getEffectiveAllowance({ allowance: 100, temporaryBoost: 25 })).toBe(125);
    expect(getEffectiveAllowance({ allowance: 100, temporaryBoost: -25 })).toBe(75);
  });
});

describe('B4 — mixed income frequencies are normalised', () => {
  it('leaves a monthly-only setup exactly as it was', () => {
    const incomes = [makeIncome({ id: 1, amount: 2000 }), makeIncome({ id: 2, amount: 500 })];
    expect(getNormalisedIncomeTotal(incomes, 'month')).toBe(2500);
  });

  it('converts a weekly wage to its monthly equivalent rather than adding it raw', () => {
    const incomes = [
      makeIncome({ id: 1, amount: 2000, resetFrequency: 'monthly' }),
      makeIncome({ id: 2, amount: 200, resetFrequency: 'weekly' }),
    ];
    // The old code reported £2,200. £200/week is ~£869/month.
    const total = getNormalisedIncomeTotal(incomes, 'month');
    expect(total).toBeGreaterThan(2800);
    expect(total).toBeCloseTo(2000 + 200 * (AVERAGE_MONTH_DAYS / 7), 1);
  });

  it('detects mixed frequencies', () => {
    expect(hasMixedIncomeFrequencies([makeIncome({ id: 1 }), makeIncome({ id: 2 })])).toBe(false);
    expect(hasMixedIncomeFrequencies([
      makeIncome({ id: 1 }),
      makeIncome({ id: 2, resetFrequency: 'weekly' }),
    ])).toBe(true);
  });

  it('normalises a category allowance by the cycle of the income funding it', () => {
    const incomes = [makeIncome({ id: 10, amount: 400, resetFrequency: 'weekly' })];
    const weekly = makeCategory({ id: 1, allowance: 100, incomeId: 10 });

    // £100 per weekly cycle is ~£434/month, not £100.
    expect(getNormalisedCategoryAllowance(weekly, incomes, 'month'))
      .toBeCloseTo(100 * (AVERAGE_MONTH_DAYS / 7), 1);
    expect(getNormalisedCategoryAllowance(weekly, incomes, 'week')).toBe(100);
  });

  it('treats unfunded categories as monthly', () => {
    expect(getNormalisedCategoryAllowance({ allowance: 250, incomeAllocations: [] }, [], 'month')).toBe(250);
  });

  it('totals normalised allowances across categories', () => {
    const incomes = [
      makeIncome({ id: 10, amount: 2000, resetFrequency: 'monthly' }),
      makeIncome({ id: 20, amount: 400, resetFrequency: 'weekly' }),
    ];
    const categories = [
      makeCategory({ id: 1, allowance: 500, incomeId: 10 }),
      makeCategory({ id: 2, allowance: 100, incomeId: 20 }),
    ];
    expect(getNormalisedAllowanceTotal(categories, incomes, 'month'))
      .toBeCloseTo(500 + 100 * (AVERAGE_MONTH_DAYS / 7), 1);
  });

  it('computes unallocated income per source, not by subtracting grand totals', () => {
    const incomes = [
      makeIncome({ id: 10, amount: 2000, resetFrequency: 'monthly' }),
      makeIncome({ id: 20, amount: 400, resetFrequency: 'weekly' }),
    ];
    const categories = [
      makeCategory({ id: 1, allowance: 500, incomeId: 10 }),
      makeCategory({ id: 2, allowance: 100, incomeId: 20 }),
    ];
    // £1,500 free monthly + £300 free weekly, each in its own cycle's terms.
    expect(getUnallocatedIncomeTotal(incomes, categories)).toBe(1800);
  });

  it('never reports a negative free pool for an over-allocated income', () => {
    const incomes = [makeIncome({ id: 10, amount: 1000 })];
    const categories = [makeCategory({ id: 1, allowance: 1500, incomeId: 10 })];
    expect(getUnallocatedIncomeTotal(incomes, categories)).toBe(0);
  });
});

describe('getCategoryCycle', () => {
  it('follows the funding income rather than the account pay day', () => {
    const incomes = [makeIncome({ id: 10, resetFrequency: 'weekly', daysAgo: 3 })];
    const category = makeCategory({ id: 1, incomeId: 10, daysAgo: 3 });

    const cycle = getCategoryCycle(category, incomes, { payDayOfMonth: 25 });

    expect(cycle.freq).toBe('weekly');
    expect(cycle.days).toBe(7);
    expect(cycle.elapsed).toBe(3);
    expect(cycle.remaining).toBe(4);
  });

  it('picks the soonest reset when several incomes fund one category', () => {
    // Two weekly incomes paid on different days: the one paid longest ago
    // resets first, and that is the cycle the category must follow. Using two
    // fixed-length cycles keeps this independent of today's calendar date.
    const incomes = [
      makeIncome({ id: 10, resetFrequency: 'weekly', daysAgo: 1 }), // resets in 6 days
      makeIncome({ id: 20, resetFrequency: 'weekly', daysAgo: 6 }), // resets in 1 day
    ];
    const category = {
      ...makeCategory({ id: 1, incomeId: null, daysAgo: 6 }),
      incomeAllocations: [{ incomeId: 10, percent: 50 }, { incomeId: 20, percent: 50 }],
    };

    const cycle = getCategoryCycle(category, incomes);
    const soleFunded = (incomeId) => getCategoryCycle(
      { ...category, incomeAllocations: [{ incomeId, percent: 100 }] },
      incomes,
    );

    expect(cycle.end.getTime()).toBe(
      Math.min(soleFunded(10).end.getTime(), soleFunded(20).end.getTime())
    );
    expect(cycle.remaining).toBe(1);
  });

  it('ignores held incomes and falls back to the legacy category schedule', () => {
    const incomes = [makeIncome({ id: 10, resetFrequency: 'weekly', holdActive: true })];
    const category = { ...makeCategory({ id: 1, incomeId: 10, daysAgo: 5 }), resetFrequency: 'fortnightly' };

    const cycle = getCategoryCycle(category, incomes);

    expect(cycle.freq).toBe('fortnightly');
    expect(cycle.days).toBe(14);
  });

  it('always yields a usable cycle with no incomes and no settings', () => {
    const cycle = getCategoryCycle({ id: 1, allowance: 100 }, [], null);
    expect(cycle.days).toBeGreaterThan(0);
    expect(cycle.remaining).toBeGreaterThanOrEqual(0);
    expect(cycle.end.getTime()).toBeGreaterThan(cycle.start.getTime());
  });
});

describe('getPacedPeriodStatus', () => {
  // A 30-day cycle that started 3 days ago, so "today" is the fourth day of it.
  const cycle = (days = 30, startedDaysAgo = 3) => ({
    start: startOfDay(addDays(new Date(), -startedDaysAgo)),
    end: startOfDay(addDays(new Date(), days - startedDaysAgo)),
  });

  const paced = (rest = {}) => ({
    id: 1,
    allowance: 150,
    pacedAllowanceEnabled: true,
    pacedAllowanceAmount: 5,
    pacedAllowanceInterval: 1,
    pacedAllowanceUnit: 'day',
    ...rest,
  });

  it('returns null for a category with no pace', () => {
    expect(getPacedPeriodStatus({ id: 1, allowance: 150 }, [], cycle())).toBeNull();
  });

  it('returns null without a usable cycle', () => {
    expect(getPacedPeriodStatus(paced(), [], null)).toBeNull();
    expect(getPacedPeriodStatus(paced(), [], { start: 'nope', end: 'nope' })).toBeNull();
  });

  it("counts only today's spend against a daily pace", () => {
    const transactions = [
      { categoryId: 1, amount: 1.8, type: 'expense', date: iso(new Date()) },
      { categoryId: 1, amount: 40, type: 'expense', date: iso(addDays(new Date(), -1)) },
      { categoryId: 2, amount: 3, type: 'expense', date: iso(new Date()) },
    ];

    const status = getPacedPeriodStatus(paced(), transactions, cycle());

    expect(status.allowance).toBe(5);
    expect(status.spent).toBe(1.8);
    expect(status.left).toBe(3.2);
    expect(status.days).toBe(1);
    expect(status.prorated).toBe(false);
    expect(status.scopeLabel).toBe('today');
  });

  it('credits a refund back into the period it landed in', () => {
    const transactions = [
      { categoryId: 1, amount: 4, type: 'expense', date: iso(new Date()) },
      { categoryId: 1, amount: 1.5, type: 'refund', date: iso(new Date()) },
    ];

    expect(getPacedPeriodStatus(paced(), transactions, cycle()).left).toBe(2.5);
  });

  it('goes negative once the period is overspent', () => {
    const transactions = [{ categoryId: 1, amount: 8, type: 'expense', date: iso(new Date()) }];
    expect(getPacedPeriodStatus(paced(), transactions, cycle()).left).toBe(-3);
  });

  it('tiles weeks from the cycle start, not the calendar week', () => {
    // Cycle started 10 days ago: day 7 begins the second week, so today (day 11)
    // sits in the window running from 7 days after the start.
    const weekly = paced({ pacedAllowanceAmount: 50, pacedAllowanceUnit: 'week' });
    const transactions = [
      { categoryId: 1, amount: 12, type: 'expense', date: iso(addDays(new Date(), -2)) }, // day 9 — this week
      { categoryId: 1, amount: 30, type: 'expense', date: iso(addDays(new Date(), -8)) }, // day 3 — last week
    ];

    const status = getPacedPeriodStatus(weekly, transactions, cycle(30, 10));

    expect(status.days).toBe(7);
    expect(status.start.getTime()).toBe(startOfDay(addDays(new Date(), -3)).getTime());
    expect(status.spent).toBe(12);
    expect(status.left).toBe(38);
    expect(status.scopeLabel).toBe('this week');
  });

  it('prorates the stub period the cycle ends on', () => {
    // A 30-day cycle holds four whole weeks and two days. On day 29 the current
    // window is those two days, worth 2/7 of a week.
    const weekly = paced({ pacedAllowanceAmount: 70, pacedAllowanceUnit: 'week' });

    const status = getPacedPeriodStatus(weekly, [], cycle(30, 29));

    expect(status.days).toBe(2);
    expect(status.prorated).toBe(true);
    expect(status.allowance).toBe(20);
    expect(status.left).toBe(20);
  });

  it('names a multi-interval pace generically', () => {
    const status = getPacedPeriodStatus(
      paced({ pacedAllowanceInterval: 3, pacedAllowanceAmount: 15 }), [], cycle(),
    );
    expect(status.periodLabel).toBe('3 days');
    expect(status.scopeLabel).toBe('this period');
    expect(status.allowance).toBe(15);
  });
});

describe('B5 — subscription cost uses the category cycle', () => {
  const subscriptions = [{
    id: 1, categoryId: 1, amount: 10, active: true,
    intervalUnit: 'week', interval: 1,
    nextDueAt: iso(addDays(new Date(), 1)),
  }];

  it('counts every recurrence before the supplied cycle end', () => {
    const cycleEnd = addDays(new Date(), 22); // ~3 weekly charges
    expect(getUpcomingSubscriptionCost(subscriptions, 1, null, new Date(), cycleEnd)).toBe(30);
  });

  it('scopes to a short cycle instead of the account-wide monthly window', () => {
    const cycleEnd = addDays(new Date(), 8); // 1 weekly charge
    expect(getUpcomingSubscriptionCost(subscriptions, 1, null, new Date(), cycleEnd)).toBe(10);
  });

  it('excludes paused subscriptions and other categories', () => {
    const paused = [{ ...subscriptions[0], active: false }];
    expect(getUpcomingSubscriptionCost(paused, 1, null, new Date(), addDays(new Date(), 30))).toBe(0);
    expect(getUpcomingSubscriptionCost(subscriptions, 99, null, new Date(), addDays(new Date(), 30))).toBe(0);
  });
});

describe('B6 — burn rate and projection use each category\'s own cycle', () => {
  it('divides spend by days elapsed in that category cycle', () => {
    const incomes = [makeIncome({ id: 10, resetFrequency: 'weekly', daysAgo: 2 })];
    const categories = [makeCategory({ id: 1, allowance: 70, spent: 20, incomeId: 10, daysAgo: 2 })];

    expect(getDailyBurnRate(categories, null, incomes)[1]).toBeCloseTo(10, 5);
    // 10/day across a 7-day cycle.
    expect(getProjectedSpend(categories, null, incomes)[1]).toBeCloseTo(70, 5);
  });

  it('returns rates even when settings has no lastReset', () => {
    const categories = [makeCategory({ id: 1, spent: 50, incomeId: null, daysAgo: 5 })];
    expect(getDailyBurnRate(categories, null, [])[1]).toBeGreaterThan(0);
  });

  it('compares like with like in projectedEndBalance', () => {
    const incomes = [makeIncome({ id: 10, amount: 1000, resetFrequency: 'monthly', daysAgo: 10 })];
    const categories = [makeCategory({ id: 1, allowance: 600, spent: 100, incomeId: 10, daysAgo: 10 })];

    // £10/day burn ≈ £304/month against £1,000 income.
    expect(projectedEndBalance(categories, null, incomes, 'month'))
      .toBeCloseTo(1000 - 10 * AVERAGE_MONTH_DAYS, 0);
  });
});

describe('B8 — cumulative overspend buckets fixed-length cycles correctly', () => {
  it('treats each weekly cycle separately instead of merging them by day-of-month', () => {
    const anchor = addDays(new Date(), -28);
    const transactions = [0, 7, 14, 21].map(offset => ({
      categoryId: 1,
      amount: 60, // £10 over a £50 weekly allowance, four times
      date: iso(addDays(anchor, offset + 1)),
    }));

    const cumulative = getCumulativeOverspend(1, 50, transactions, {
      freq: 'weekly',
      anchor,
    });

    expect(cumulative).toBe(40);
  });

  it('still accepts a bare pay-day number for monthly budgets', () => {
    const transactions = [
      { categoryId: 1, amount: 120, date: iso(subMonths(new Date(), 1)) },
      { categoryId: 1, amount: 80, date: iso(new Date()) },
    ];
    // One cycle £20 over, one £20 under → nets out.
    expect(getCumulativeOverspend(1, 100, transactions, 1)).toBe(0);
  });

  it('returns 0 for a category with no allowance or no transactions', () => {
    expect(getCumulativeOverspend(1, 0, [{ categoryId: 1, amount: 10, date: iso(new Date()) }])).toBe(0);
    expect(getCumulativeOverspend(1, 100, [])).toBe(0);
  });
});

describe('getSafeToSpend', () => {
  const incomes = [makeIncome({ id: 10, amount: 1000, resetFrequency: 'monthly', daysAgo: 0 })];

  it('spreads what is left across the days remaining in the cycle', () => {
    const categories = [makeCategory({ id: 1, allowance: 300, spent: 0, incomeId: 10, daysAgo: 0 })];
    const result = getSafeToSpend({ categories, incomes });
    const cycle = getCategoryCycle(categories[0], incomes);

    expect(result.toReset).toBe(300);
    expect(result.today).toBeCloseTo(300 / cycle.remaining, 2);
    expect(result.week).toBeCloseTo((300 / cycle.remaining) * Math.min(7, cycle.remaining), 2);
  });

  it('reserves subscriptions still due this cycle', () => {
    const categories = [makeCategory({ id: 1, allowance: 300, spent: 0, incomeId: 10, daysAgo: 0 })];
    const subscriptions = [{
      id: 1, categoryId: 1, amount: 50, active: true,
      intervalUnit: 'month', interval: 1,
      nextDueAt: iso(addDays(new Date(), 1)),
    }];

    const result = getSafeToSpend({ categories, incomes, subscriptions });

    expect(result.committedSubscriptions).toBe(50);
    expect(result.toReset).toBe(250);
  });

  it('deducts goal commitments proportionally across every horizon', () => {
    const categories = [makeCategory({ id: 1, allowance: 400, spent: 0, incomeId: 10, daysAgo: 0 })];

    const base = getSafeToSpend({ categories, incomes });
    const withGoal = getSafeToSpend({ categories, incomes, goalCommitment: 100 });

    expect(withGoal.toReset).toBe(300);
    expect(withGoal.committedGoals).toBe(100);
    expect(withGoal.today).toBeCloseTo(base.today * 0.75, 2);
  });

  it('never goes negative for an overspent category', () => {
    const categories = [makeCategory({ id: 1, allowance: 100, spent: 250, incomeId: 10, daysAgo: 0 })];
    const result = getSafeToSpend({ categories, incomes });

    expect(result.toReset).toBe(0);
    expect(result.today).toBe(0);
  });

  it('reports the soonest reset across categories on different cycles', () => {
    // Fortnightly vs weekly, both just paid — the weekly category resets first.
    const mixedIncomes = [
      makeIncome({ id: 10, resetFrequency: 'fortnightly', daysAgo: 0 }),
      makeIncome({ id: 20, resetFrequency: 'weekly', daysAgo: 0 }),
    ];
    const categories = [
      makeCategory({ id: 1, allowance: 300, incomeId: 10, daysAgo: 0 }),
      makeCategory({ id: 2, allowance: 70, incomeId: 20, daysAgo: 0 }),
    ];

    const result = getSafeToSpend({ categories, incomes: mixedIncomes });

    expect(result.daysToReset).toBe(7);
    expect(result.nextReset.getTime())
      .toBe(getCategoryCycle(categories[1], mixedIncomes).end.getTime());
  });

  it('returns zeroes when there are no categories', () => {
    const result = getSafeToSpend({ categories: [], incomes });
    expect(result).toMatchObject({ today: 0, week: 0, toReset: 0, nextReset: null });
  });
});

describe('wishlistAffordability', () => {
  const incomes = [makeIncome({ id: 10, amount: 1000, resetFrequency: 'weekly', daysAgo: 2 })];

  it('affords an item covered by combined leftovers, counting boosts', () => {
    const categories = [makeCategory({ id: 1, allowance: 50, spent: 0, temporaryBoost: 40, incomeId: 10, daysAgo: 2 })];
    const result = wishlistAffordability({ price: 80, categoryIds: [1] }, categories, null, incomes);

    expect(result.canAffordNow).toBe(true);
    expect(result.daysUntil).toBe(0);
  });

  it('uses the funding income cycle for the wait estimate, not the account pay day', () => {
    const categories = [makeCategory({ id: 1, allowance: 100, spent: 90, incomeId: 10, daysAgo: 2 })];
    const result = wishlistAffordability({ price: 100, categoryIds: [1] }, categories, { payDayOfMonth: 25 }, incomes);

    expect(result.canAffordNow).toBe(false);
    expect(result.afterReset).toBe(true);
    expect(result.daysUntil).toBe(5); // 7-day cycle, 2 days elapsed
  });

  it('spans multiple cycles when the price exceeds one cycle of allowance', () => {
    const categories = [makeCategory({ id: 1, allowance: 100, spent: 0, incomeId: 10, daysAgo: 2 })];
    const result = wishlistAffordability({ price: 300, categoryIds: [1] }, categories, null, incomes);

    expect(result.periodsNeeded).toBe(3);
    expect(result.daysUntil).toBe(5 + 2 * 7);
  });

  it('reports the full price as shortfall when no categories are assigned', () => {
    expect(wishlistAffordability({ price: 40, categoryIds: [] }, [], null, []))
      .toMatchObject({ canAffordNow: false, shortfall: 40 });
  });
});

describe('getIncomeCycleAverageDays', () => {
  it('uses a calendar-independent month so period conversion is stable', () => {
    expect(getIncomeCycleAverageDays('weekly')).toBe(7);
    expect(getIncomeCycleAverageDays('fortnightly')).toBe(14);
    expect(getIncomeCycleAverageDays('4weekly')).toBe(28);
    expect(getIncomeCycleAverageDays('monthly')).toBe(AVERAGE_MONTH_DAYS);
    expect(getIncomeCycleAverageDays(undefined)).toBe(AVERAGE_MONTH_DAYS);
  });
});

describe('merchant memory', () => {
  const txs = [
    { note: 'Tesco', categoryId: 1, amount: 20, date: '2026-07-01T00:00:00Z' },
    { note: 'Tesco', categoryId: 2, amount: 35, date: '2026-07-20T00:00:00Z' },
    { note: 'Costa', categoryId: 3, amount: 3.2, date: '2026-07-25T00:00:00Z' },
  ];

  it('ranks by frequency, then recency', () => {
    const [first, second] = getMerchantSuggestions(txs);
    expect(first.label).toBe('Tesco');
    expect(first.count).toBe(2);
    expect(second.label).toBe('Costa');
  });

  it('remembers the category and amount from the most recent visit', () => {
    const [tesco] = getMerchantSuggestions(txs, 'tes');
    expect(tesco.lastCategoryId).toBe(2);
    expect(tesco.lastAmount).toBe(35);
  });

  it('filters on a substring, case-insensitively', () => {
    expect(getMerchantSuggestions(txs, 'COST').map(s => s.label)).toEqual(['Costa']);
    expect(getMerchantSuggestions(txs, 'zzz')).toEqual([]);
  });

  it('prefers an explicit merchant field over the note', () => {
    const [entry] = getMerchantSuggestions([{ merchant: 'Sainsburys', note: 'weekly shop', categoryId: 1, amount: 5 }]);
    expect(entry.label).toBe('Sainsburys');
  });
});

describe('category suggestion', () => {
  const categories = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const transactions = [{ note: 'Tesco', categoryId: 2, amount: 30, date: '2026-07-20T00:00:00Z' }];
  const rules = [{ match: 'tesco', categoryId: 3 }];

  it('prefers an explicit rule over learned history', () => {
    expect(suggestCategoryForNote('Tesco Metro', { rules, transactions, categories }))
      .toMatchObject({ categoryId: 3, source: 'rule' });
  });

  it('falls back to the category last used at that merchant', () => {
    expect(suggestCategoryForNote('Tesco', { rules: [], transactions, categories }))
      .toMatchObject({ categoryId: 2, source: 'history' });
  });

  it('returns null when nothing matches, rather than guessing', () => {
    expect(suggestCategoryForNote('Unknown shop', { rules, transactions, categories })).toBeNull();
    expect(suggestCategoryForNote('', { rules, transactions, categories })).toBeNull();
  });

  it('ignores rules pointing at a deleted category', () => {
    expect(suggestCategoryForNote('Tesco', { rules: [{ match: 'tesco', categoryId: 99 }], transactions: [], categories }))
      .toBeNull();
  });
});

describe('tags', () => {
  it('collects distinct tags alphabetically', () => {
    expect(getAllTags([
      { tags: ['work', 'travel'] }, { tags: ['travel'] }, { tags: [] }, {},
    ])).toEqual(['travel', 'work']);
  });

  it('normalises free-text entry, dropping blanks, hashes and duplicates', () => {
    expect(normaliseTags(' holiday , #work,, holiday ')).toEqual(['holiday', 'work']);
    expect(normaliseTags(['a', 'A'])).toEqual(['a']);
    expect(normaliseTags('')).toEqual([]);
  });
});

describe('signed amounts', () => {
  it('treats a refund as negative spend and an expense as positive', () => {
    expect(getSignedAmount({ amount: 25 })).toBe(25);
    expect(getSignedAmount({ amount: 25, type: 'refund' })).toBe(-25);
    expect(isRefund({ type: 'refund' })).toBe(true);
  });

  it('ignores a stray negative stored amount', () => {
    expect(getSignedAmount({ amount: -25 })).toBe(25);
    expect(getSignedAmount({ amount: -25, type: 'refund' })).toBe(-25);
  });

  it('nets refunds out of monthly history and cumulative overspend', () => {
    const now = new Date().toISOString();
    const categories = [{ id: 1, name: 'Food' }];
    const history = buildMonthlyHistory([
      { categoryId: 1, amount: 100, date: now },
      { categoryId: 1, amount: 30, date: now, type: 'refund' },
    ], categories);
    expect(history[0].Food).toBe(70);

    expect(getCumulativeOverspend(1, 50, [
      { categoryId: 1, amount: 100, date: now },
      { categoryId: 1, amount: 30, date: now, type: 'refund' },
    ], 1)).toBe(20);
  });
});

describe('insight', () => {
  const now = new Date();
  const day = (offset) => iso(addDays(now, offset));

  it('ranks merchants by spend and nets refunds out', () => {
    const breakdown = getMerchantBreakdown([
      { merchant: 'Tesco', amount: 50, date: day(-1) },
      { merchant: 'Tesco', amount: 30, date: day(-2) },
      { merchant: 'Tesco', amount: 20, date: day(-2), type: 'refund' },
      { merchant: 'Costa', amount: 40, date: day(-3) },
    ]);

    expect(breakdown.map(e => [e.label, e.total])).toEqual([['Tesco', 60], ['Costa', 40]]);
  });

  it('excludes merchants outside the window and fully-refunded ones', () => {
    const breakdown = getMerchantBreakdown([
      { merchant: 'Old', amount: 50, date: day(-40) },
      { merchant: 'New', amount: 10, date: day(-1) },
      { merchant: 'Wash', amount: 10, date: day(-1) },
      { merchant: 'Wash', amount: 10, date: day(-1), type: 'refund' },
    ], { since: addDays(now, -7) });

    expect(breakdown.map(e => e.label)).toEqual(['New']);
  });

  it('compares this cycle against the previous one, per category', () => {
    const incomes = [makeIncome({ id: 10, resetFrequency: 'weekly', daysAgo: 2 })];
    const categories = [makeCategory({ id: 1, allowance: 100, incomeId: 10, daysAgo: 2 })];
    const result = getCycleComparison([
      { categoryId: 1, amount: 30, date: day(-1) },  // this cycle
      { categoryId: 1, amount: 50, date: day(-5) },  // previous cycle
    ], categories, incomes);

    expect(result.currentTotal).toBe(30);
    expect(result.previousTotal).toBe(50);
    expect(result.change).toBe(-20);
    expect(result.changePct).toBe(-40);
  });

  it('reports no percentage when there is no previous spend to compare against', () => {
    const incomes = [makeIncome({ id: 10, resetFrequency: 'weekly', daysAgo: 1 })];
    const categories = [makeCategory({ id: 1, incomeId: 10, daysAgo: 1 })];
    const result = getCycleComparison([{ categoryId: 1, amount: 20, date: day(0) }], categories, incomes);

    expect(result.changePct).toBeNull();
    expect(result.categories[0].changePct).toBeNull();
  });

  it('reconstructs balance history backwards from the current balance', () => {
    // Each point is the balance at the *end* of that day. Working forwards:
    // −60 → +200 income → 140 → −40 spend → 100 → unchanged → 100.
    const series = buildBalanceHistory({ id: 1, balance: 100 }, {
      transactions: [{ accountId: 1, amount: 40, date: day(-1) }],
      incomeEvents: [{ accountId: 1, amount: 200, date: day(-2) }],
      days: 3,
    });

    expect(series.map(p => p.balance)).toEqual([-60, 140, 100, 100]);
    expect(series.at(-1).balance).toBe(100); // today matches the stored balance
  });

  it('ignores other accounts and applies transfers in both directions', () => {
    // The £999 belongs to account 2 and must not move account 1's line.
    const out = buildBalanceHistory({ id: 1, balance: 50 }, {
      transactions: [{ accountId: 2, amount: 999, date: day(-1) }],
      transfers: [{ fromAccountId: 1, toAccountId: 2, amount: 25, date: day(-1) }],
      days: 2,
    });
    expect(out.map(p => p.balance)).toEqual([75, 50, 50]);

    // Same transfer seen from the receiving side.
    const incoming = buildBalanceHistory({ id: 2, balance: 75 }, {
      transfers: [{ fromAccountId: 1, toAccountId: 2, amount: 25, date: day(-1) }],
      days: 2,
    });
    expect(incoming.map(p => p.balance)).toEqual([50, 75, 75]);
  });

  it('flags outliers against the category median, not the mean', () => {
    const txs = [
      { id: 1, categoryId: 1, amount: 3, date: day(-1) },
      { id: 2, categoryId: 1, amount: 3.5, date: day(-2) },
      { id: 3, categoryId: 1, amount: 4, date: day(-3) },
      { id: 4, categoryId: 1, amount: 3, date: day(-4) },
      { id: 5, categoryId: 1, amount: 120, date: day(-5) },
    ];
    const flagged = flagUnusualSpend(txs);

    expect(flagged.has(5)).toBe(true);
    expect(flagged.has(1)).toBe(false);
  });

  it('stays quiet without enough history, and never flags refunds', () => {
    expect(flagUnusualSpend([
      { id: 1, categoryId: 1, amount: 5, date: day(-1) },
      { id: 2, categoryId: 1, amount: 500, date: day(-2) },
    ]).size).toBe(0);

    const withRefund = flagUnusualSpend([
      { id: 1, categoryId: 1, amount: 3, date: day(-1) },
      { id: 2, categoryId: 1, amount: 3, date: day(-2) },
      { id: 3, categoryId: 1, amount: 3, date: day(-3) },
      { id: 4, categoryId: 1, amount: 3, date: day(-4) },
      { id: 5, categoryId: 1, amount: 200, date: day(-5), type: 'refund' },
    ]);
    expect(withRefund.has(5)).toBe(false);
  });
});

describe('goals', () => {
  it('reports progress, and treats reaching the target as complete', () => {
    expect(getGoalProgress({ target: 200, saved: 50 }))
      .toMatchObject({ pct: 25, remaining: 150, complete: false });
    expect(getGoalProgress({ target: 200, saved: 200 }).complete).toBe(true);
    expect(getGoalProgress({ target: 0, saved: 0 })).toMatchObject({ pct: 0, complete: false });
  });

  it('estimates completion from the contribution rate and pay cycle', () => {
    const incomes = [makeIncome({ id: 10, resetFrequency: 'monthly' })];
    const eta = getGoalEta({ target: 1000, saved: 200, perCycleContribution: 100, incomeId: 10 }, incomes);

    expect(eta.cycles).toBe(8);
    expect(eta.date).toBeInstanceOf(Date);
  });

  it('says "no end date" rather than infinity when nothing is being contributed', () => {
    expect(getGoalEta({ target: 100, saved: 0, perCycleContribution: 0 }, []))
      .toMatchObject({ cycles: null, date: null });
  });

  it('flags a goal that will miss its target date', () => {
    const incomes = [makeIncome({ id: 10, resetFrequency: 'monthly' })];
    const soon = iso(addDays(new Date(), 30));
    const distant = iso(addDays(new Date(), 3650));

    // £900 to go at £100/month can't be done in a month.
    expect(isGoalOffTrack({ target: 1000, saved: 100, perCycleContribution: 100, incomeId: 10, targetDate: soon }, incomes)).toBe(true);
    expect(isGoalOffTrack({ target: 1000, saved: 100, perCycleContribution: 100, incomeId: 10, targetDate: distant }, incomes)).toBe(false);
    // A deadline with no contribution is off track by definition.
    expect(isGoalOffTrack({ target: 1000, saved: 0, perCycleContribution: 0, targetDate: soon }, incomes)).toBe(true);
    // No deadline means it can't be late.
    expect(isGoalOffTrack({ target: 1000, saved: 0, perCycleContribution: 0 }, incomes)).toBe(false);
    // Finished goals are never off track.
    expect(isGoalOffTrack({ target: 100, saved: 100, targetDate: soon }, incomes)).toBe(false);
  });

  it('counts only contributions still pending this cycle', () => {
    const incomes = [makeIncome({ id: 10, resetFrequency: 'monthly', daysAgo: 3 })];
    const pending = { target: 1000, saved: 0, perCycleContribution: 100, incomeId: 10 };

    expect(getGoalCommitment([pending], incomes)).toBe(100);

    // Already taken this cycle — charging for it again would understate what's free.
    const taken = { ...pending, lastAutoContributeAt: iso(addDays(new Date(), -1)) };
    expect(getGoalCommitment([taken], incomes)).toBe(0);
  });

  it('never commits more than the goal still needs, and skips finished goals', () => {
    const incomes = [makeIncome({ id: 10 })];
    expect(getGoalCommitment([{ target: 100, saved: 80, perCycleContribution: 100, incomeId: 10 }], incomes)).toBe(20);
    expect(getGoalCommitment([{ target: 100, saved: 100, perCycleContribution: 100, incomeId: 10 }], incomes)).toBe(0);
  });

  it('reduces safe-to-spend by pending savings', () => {
    const incomes = [makeIncome({ id: 10, amount: 1000, resetFrequency: 'monthly', daysAgo: 0 })];
    const categories = [makeCategory({ id: 1, allowance: 400, spent: 0, incomeId: 10, daysAgo: 0 })];
    const goals = [{ target: 1000, saved: 0, perCycleContribution: 100, incomeId: 10 }];

    const commitment = getGoalCommitment(goals, incomes);
    const result = getSafeToSpend({ categories, incomes, goalCommitment: commitment });

    expect(commitment).toBe(100);
    expect(result.toReset).toBe(300);
    expect(result.committedGoals).toBe(100);
  });
});

describe('rollover', () => {
  it('adds carried budget to what is spendable', () => {
    expect(getEffectiveAllowance({ allowance: 100, rolloverBalance: 40 })).toBe(140);
    expect(getEffectiveAllowance({ allowance: 100, rolloverBalance: 40, temporaryBoost: 10 })).toBe(150);
  });

  it('carries the unspent remainder, ignoring temporary top-ups', () => {
    expect(getRolloverForNextCycle({ rolloverEnabled: true, allowance: 100, spent: 30 })).toBe(70);
    // The £50 boost is a one-cycle grant and must not become permanent budget.
    expect(getRolloverForNextCycle({ rolloverEnabled: true, allowance: 100, spent: 30, temporaryBoost: 50 })).toBe(70);
  });

  it('compounds an existing carried balance', () => {
    expect(getRolloverForNextCycle({ rolloverEnabled: true, allowance: 100, rolloverBalance: 50, spent: 20 })).toBe(130);
  });

  it('drops overspend unless carrying it was requested', () => {
    expect(getRolloverForNextCycle({ rolloverEnabled: true, allowance: 100, spent: 150 })).toBe(0);
    expect(getRolloverForNextCycle({ rolloverEnabled: true, allowance: 100, spent: 150, rolloverCarryOverspend: true })).toBe(-50);
  });

  it('accounts for spend already cleared by a partial reset', () => {
    // £200 allowance, £60 spent across the cycle, £30 of it already cleared by
    // an earlier income's reset — the true remainder is £140, not £170.
    expect(getRolloverForNextCycle({ rolloverEnabled: true, allowance: 200, spent: 30 }, 30)).toBe(140);
  });

  it('does nothing when the category has not opted in', () => {
    expect(getRolloverForNextCycle({ allowance: 100, spent: 10 })).toBe(0);
  });
});

describe('nudges', () => {
  const now = new Date();
  const day = (offset) => iso(addDays(now, offset));
  const find = (nudges, prefix) => nudges.filter(n => n.id.startsWith(prefix));

  it('warns about subscriptions due soon or overdue, but not distant ones', () => {
    const subscriptions = [
      { id: 1, name: 'Netflix', amount: 10, active: true, nextDueAt: day(1) },
      { id: 2, name: 'Gym', amount: 30, active: true, nextDueAt: day(-2) },
      { id: 3, name: 'Insurance', amount: 90, active: true, nextDueAt: day(20) },
      { id: 4, name: 'Paused', amount: 5, active: false, nextDueAt: day(0) },
    ];
    const nudges = buildNudges({ subscriptions });
    const due = find(nudges, 'sub-due-');

    expect(due).toHaveLength(2);
    expect(due.find(n => n.id.includes('-2-')).severity).toBe('warn'); // overdue
    expect(due.find(n => n.id.includes('-1-')).severity).toBe('info');
  });

  it('flags over-budget categories as the most severe thing on the list', () => {
    const nudges = buildNudges({
      categories: [{ id: 1, name: 'Food', allowance: 100, spent: 150 }],
      transactions: [{ id: 1, amount: 150, date: day(-1) }],
      settings: { lastBackupAt: day(-1) },
    });

    expect(nudges[0].severity).toBe('danger');
    expect(nudges[0].title).toMatch(/over budget/);
  });

  it('nags about backups only when there is something to lose', () => {
    expect(find(buildNudges({}), 'backup-')).toHaveLength(0);

    const never = buildNudges({ categories: [{ id: 1, name: 'Food', allowance: 100, spent: 0 }] });
    expect(find(never, 'backup-')[0].title).toMatch(/never backed up/);

    const stale = buildNudges({
      categories: [{ id: 1, name: 'Food', allowance: 100, spent: 0 }],
      settings: { lastBackupAt: day(-45) },
    });
    expect(find(stale, 'backup-')[0].title).toMatch(/45 days/);

    const fresh = buildNudges({
      categories: [{ id: 1, name: 'Food', allowance: 100, spent: 0 }],
      settings: { lastBackupAt: day(-2) },
    });
    expect(find(fresh, 'backup-')).toHaveLength(0);
  });

  it('warns about evictable storage, but stays quiet until the state is known', () => {
    const categories = [{ id: 1, name: 'Food', allowance: 100, spent: 0 }];

    // null is "not checked yet" — alarming on a race would be worse than late.
    expect(find(buildNudges({ categories, storageState: null }), 'storage-evictable-')).toHaveLength(0);
    expect(find(buildNudges({ categories, storageState: 'persisted' }), 'storage-evictable-')).toHaveLength(0);
    expect(find(buildNudges({ categories, storageState: 'unsupported' }), 'storage-evictable-')).toHaveLength(0);

    const evictable = find(buildNudges({ categories, storageState: 'best-effort' }), 'storage-evictable-');
    expect(evictable).toHaveLength(1);
    expect(evictable[0].severity).toBe('warn');
    expect(evictable[0].view).toBe('settings');

    // Nothing stored yet means nothing to lose.
    expect(find(buildNudges({ storageState: 'best-effort' }), 'storage-evictable-')).toHaveLength(0);
  });

  it('spots a subscription price change from its charge history', () => {
    const nudges = buildNudges({
      subscriptions: [{ id: 1, name: 'Netflix', amount: 12, active: true, nextDueAt: day(20) }],
      transactions: [
        { id: 1, subscriptionId: 1, amount: 12, date: day(-1) },
        { id: 2, subscriptionId: 1, amount: 10, date: day(-31) },
      ],
    });
    const price = find(nudges, 'sub-price-');

    expect(price).toHaveLength(1);
    expect(price[0].body).toMatch(/£10\.00 → £12\.00/);
  });

  it('stays quiet about price when there is only one charge to go on', () => {
    const nudges = buildNudges({
      subscriptions: [{ id: 1, name: 'Netflix', amount: 12, active: true, nextDueAt: day(20) }],
      transactions: [{ id: 1, subscriptionId: 1, amount: 12, date: day(-1) }],
    });
    expect(find(nudges, 'sub-price-')).toHaveLength(0);
  });

  it('prompts a review of long-running subscriptions with the total paid', () => {
    const transactions = Array.from({ length: 8 }, (_, i) => ({
      id: i + 1, subscriptionId: 1, amount: 10, date: day(-30 * (i + 1)),
    }));
    const nudges = buildNudges({
      subscriptions: [{ id: 1, name: 'Netflix', amount: 10, active: true, nextDueAt: day(20) }],
      transactions,
    });
    const review = find(nudges, 'sub-review-');

    expect(review).toHaveLength(1);
    expect(review[0].title).toMatch(/£80\.00/);
  });

  it('flags categories whose funding does not add up', () => {
    const nudges = buildNudges({
      incomes: [makeIncome({ id: 10, amount: 1000 })],
      categories: [{ id: 1, name: 'Food', allowance: 100, spent: 0, incomeAllocations: [{ incomeId: 10, percent: 50 }] }],
    });
    expect(find(nudges, 'funding-')[0].title).toMatch(/not fully funded/);
  });

  it('sorts danger before warn before info', () => {
    const nudges = buildNudges({
      incomes: [makeIncome({ id: 10, amount: 1000 })],
      categories: [
        { id: 1, name: 'Over', allowance: 10, spent: 50, incomeAllocations: [{ incomeId: 10, percent: 100 }] },
        { id: 2, name: 'Broken', allowance: 10, spent: 0, incomeAllocations: [{ incomeId: 10, percent: 20 }] },
      ],
      subscriptions: [{ id: 1, name: 'Netflix', amount: 10, active: true, nextDueAt: day(1) }],
      settings: { lastBackupAt: day(-1) },
    });

    const severities = nudges.map(n => n.severity);
    expect(severities).toEqual([...severities].sort(
      (a, b) => ({ danger: 0, warn: 1, info: 2 }[a] - { danger: 0, warn: 1, info: 2 }[b])
    ));
  });

  it('hides dismissed nudges but keeps the rest', () => {
    const nudges = buildNudges({
      categories: [{ id: 1, name: 'Food', allowance: 100, spent: 150 }],
      transactions: [{ id: 1, amount: 150, date: day(-1) }],
    });
    const dismissed = { [nudges[0].id]: iso(now) };

    expect(filterDismissedNudges(nudges, dismissed)).toHaveLength(nudges.length - 1);
    expect(filterDismissedNudges(nudges, {})).toHaveLength(nudges.length);
  });

  it('keys time-bound nudges by their period so they return next time', () => {
    const nudges = buildNudges({
      subscriptions: [{ id: 1, name: 'Netflix', amount: 10, active: true, nextDueAt: day(1) }],
    });
    // The due date is in the id, so dismissing this month's charge doesn't
    // silence next month's.
    expect(find(nudges, 'sub-due-')[0].id).toMatch(/\d{4}-\d{2}-\d{2}$/);
  });
});

describe('cash-flow forecast', () => {
  const account = { id: 1, balance: 500 };

  it('starts at the current balance and applies scheduled income and subscriptions', () => {
    const { series } = buildCashFlowForecast({
      account,
      incomes: [makeIncome({ id: 10, amount: 1000, resetFrequency: 'weekly', daysAgo: 0 })],
      subscriptions: [{ id: 1, name: 'Rent', amount: 200, active: true, intervalUnit: 'month', interval: 1, nextDueAt: iso(addDays(new Date(), 3)) }],
      days: 10,
    });

    expect(series[0].balance).toBe(500);          // today, untouched
    expect(series).toHaveLength(11);              // today plus 10 days
    // Rent lands on day 3 and income on day 7.
    expect(series[3].events.map(e => e.label)).toContain('Rent');
    expect(series[7].events.map(e => e.label)).toContain('Income 10');
  });

  it('finds the first day the balance goes negative', () => {
    const { firstNegative, lowest } = buildCashFlowForecast({
      account: { id: 1, balance: 100 },
      subscriptions: [{ id: 1, name: 'Rent', amount: 400, active: true, intervalUnit: 'month', interval: 1, nextDueAt: iso(addDays(new Date(), 2)) }],
      days: 10,
    });

    expect(firstNegative).toBeInstanceOf(Date);
    expect(lowest.balance).toBeLessThan(0);
  });

  it('reports no negative day when income covers the outgoings', () => {
    const { firstNegative } = buildCashFlowForecast({
      account: { id: 1, balance: 5000 },
      subscriptions: [{ id: 1, name: 'Rent', amount: 100, active: true, intervalUnit: 'month', interval: 1, nextDueAt: iso(addDays(new Date(), 2)) }],
      days: 10,
    });
    expect(firstNegative).toBeNull();
  });

  it('does not double-count subscriptions in the burn rate', () => {
    // A category whose entire spend is one subscription should contribute
    // nothing extra to the daily burn — the charge lands on its own date.
    const incomes = [makeIncome({ id: 10, resetFrequency: 'monthly', daysAgo: 10 })];
    const categories = [makeCategory({ id: 1, allowance: 300, spent: 100, incomeId: 10, daysAgo: 10 })];
    const subscriptions = [{
      id: 1, categoryId: 1, name: 'Rent', amount: 300, active: true,
      intervalUnit: 'month', interval: 1, nextDueAt: iso(addDays(new Date(), 5)),
    }];

    const withSub = buildCashFlowForecast({ account, categories, incomes, subscriptions, days: 10 });
    const withoutSub = buildCashFlowForecast({ account, categories, incomes, subscriptions: [], days: 10 });

    expect(withSub.dailyBurn).toBeLessThan(withoutSub.dailyBurn);
    expect(withSub.dailyBurn).toBeGreaterThanOrEqual(0);
  });

  it('ignores paused subscriptions and held incomes', () => {
    const { series } = buildCashFlowForecast({
      account,
      incomes: [makeIncome({ id: 10, amount: 1000, resetFrequency: 'weekly', daysAgo: 0, holdActive: true })],
      subscriptions: [{ id: 1, name: 'Paused', amount: 200, active: false, intervalUnit: 'month', interval: 1, nextDueAt: iso(addDays(new Date(), 3)) }],
      days: 10,
    });

    expect(series.every(point => point.events.length === 0)).toBe(true);
  });
});

describe('debt amortisation', () => {
  const debt = (overrides = {}) => ({
    id: 1, name: 'Card', kind: 'debt', target: 1000, saved: 0,
    apr: 24, perCycleContribution: 100, minimumPayment: 25, incomeId: 1,
    ...overrides,
  });
  const monthly = [{ id: 1, name: 'Salary', amount: 2000, resetFrequency: 'monthly' }];

  it('converts an APR to the rate lenders actually charge per month', () => {
    // 24% APR is quoted as 2% a month, not the rate that compounds to 24%.
    expect(getDebtPeriodicRate(24, 365.25 / 12)).toBeCloseTo(0.02, 6);
    expect(getDebtPeriodicRate(0)).toBe(0);
    expect(getDebtPeriodicRate(null)).toBe(0);
    expect(getDebtPeriodicRate(-5)).toBe(0);
  });

  it('takes longer than dividing the balance by the payment', () => {
    const payoff = getDebtPayoff(debt(), monthly);

    // £1000 at £100/month is 10 payments with no interest; at 24% APR it isn't.
    expect(payoff.cycles).toBeGreaterThan(10);
    expect(payoff.totalInterest).toBeGreaterThan(0);
    expect(payoff.totalPaid).toBeCloseTo(1000 + payoff.totalInterest, 2);
  });

  it('charges no interest when the APR is zero', () => {
    const payoff = getDebtPayoff(debt({ apr: 0 }), monthly);

    expect(payoff.cycles).toBe(10);
    expect(payoff.totalInterest).toBe(0);
    expect(payoff.totalPaid).toBeCloseTo(1000, 2);
  });

  it('flags a payment that never clears the balance', () => {
    // £1000 at 24% accrues £20 a month; £15 never gets there.
    const payoff = getDebtPayoff(debt({ perCycleContribution: 15 }), monthly);

    expect(payoff.neverClears).toBe(true);
    expect(payoff.cycles).toBeNull();
    expect(payoff.date).toBeNull();
    expect(payoff.interestPerCycle).toBeCloseTo(20, 2);
  });

  it('counts only what is left after what has been paid off', () => {
    const payoff = getDebtPayoff(debt({ saved: 900 }), monthly);
    expect(payoff.cycles).toBe(2);
  });

  it('reports a cleared debt as complete', () => {
    const payoff = getDebtPayoff(debt({ saved: 1000 }), monthly);
    expect(payoff).toMatchObject({ complete: true, cycles: 0, totalInterest: 0 });
  });

  it('says nothing rather than guessing when no payment is set', () => {
    const payoff = getDebtPayoff(debt({ perCycleContribution: 0 }), monthly);
    expect(payoff).toMatchObject({ cycles: null, date: null, neverClears: false });
  });

  it('routes a debt goal ETA through the interest maths', () => {
    const withInterest = getGoalEta(debt(), monthly);
    const withoutInterest = getGoalEta(debt({ apr: 0 }), monthly);

    expect(withInterest.cycles).toBeGreaterThan(withoutInterest.cycles);
    expect(withInterest.totalInterest).toBeGreaterThan(0);
    // A savings goal is unaffected — no interest to model.
    expect(getGoalEta({ kind: 'saving', target: 1000, saved: 0, perCycleContribution: 100, incomeId: 1 }, monthly).cycles).toBe(10);
  });

  it('calls a debt that never clears off track, deadline or not', () => {
    const stuck = debt({ perCycleContribution: 15, targetDate: '2027-01-01' });
    expect(isGoalOffTrack(stuck, monthly, new Date('2026-01-01'))).toBe(true);
  });
});

describe('debt payoff strategies', () => {
  const monthly = [{ id: 1, name: 'Salary', amount: 3000, resetFrequency: 'monthly' }];
  // A small cheap debt and a large dear one: the case where the two orders
  // genuinely disagree.
  const goals = [
    { id: 1, name: 'Store card', kind: 'debt', target: 500, saved: 0, apr: 5, perCycleContribution: 60, minimumPayment: 25, incomeId: 1 },
    { id: 2, name: 'Credit card', kind: 'debt', target: 3000, saved: 0, apr: 29, perCycleContribution: 150, minimumPayment: 60, incomeId: 1 },
  ];

  it('orders by rate for avalanche and by balance for snowball', () => {
    expect(orderDebts(goals, DEBT_AVALANCHE).map(g => g.name)).toEqual(['Credit card', 'Store card']);
    expect(orderDebts(goals, DEBT_SNOWBALL).map(g => g.name)).toEqual(['Store card', 'Credit card']);
  });

  it('ignores savings goals and debts already cleared', () => {
    const mixed = [
      ...goals,
      { id: 3, name: 'Holiday', kind: 'saving', target: 800, saved: 0, incomeId: 1 },
      { id: 4, name: 'Paid off', kind: 'debt', target: 200, saved: 200, apr: 40, incomeId: 1 },
    ];
    expect(orderDebts(mixed, DEBT_AVALANCHE).map(g => g.name)).toEqual(['Credit card', 'Store card']);
  });

  it('clears everything and costs interest along the way', () => {
    const result = simulateDebtStrategy(goals, monthly, { method: DEBT_AVALANCHE });

    expect(result.neverClears).toBe(false);
    expect(result.cycles).toBeGreaterThan(0);
    expect(result.totalInterest).toBeGreaterThan(0);
    expect(result.cleared.every(entry => entry.cycles != null)).toBe(true);
  });

  it('cascades a cleared debt’s payment into the next one', () => {
    const result = simulateDebtStrategy(goals, monthly, { method: DEBT_SNOWBALL });
    const [first, second] = result.cleared;

    // The small debt goes first under snowball, and the big one finishes
    // sooner than its own £150/month could manage alone.
    expect(first.cycles).toBeLessThan(second.cycles);
    expect(result.cycles).toBe(second.cycles);
  });

  it('makes avalanche at least as cheap as snowball', () => {
    const { avalanche, snowball, saving, differs } = compareDebtStrategies(goals, monthly);

    expect(differs).toBe(true);
    expect(avalanche.totalInterest).toBeLessThanOrEqual(snowball.totalInterest);
    expect(saving).toBeCloseTo(snowball.totalInterest - avalanche.totalInterest, 2);
    expect(saving).toBeGreaterThan(0);
  });

  it('reports no difference when one order matches the other', () => {
    const single = [goals[0]];
    expect(compareDebtStrategies(single, monthly).differs).toBe(false);
  });

  it('flags a pool that cannot outpace the interest', () => {
    const hopeless = [
      { id: 1, name: 'Card', kind: 'debt', target: 5000, saved: 0, apr: 30, perCycleContribution: 20, minimumPayment: 20, incomeId: 1 },
    ];
    const result = simulateDebtStrategy(hopeless, monthly, { method: DEBT_AVALANCHE });

    expect(result.neverClears).toBe(true);
    expect(result.totalInterest).toBeNull();
  });

  it('handles having no debts at all', () => {
    expect(simulateDebtStrategy([], monthly)).toMatchObject({ cycles: 0, totalInterest: 0 });
    expect(compareDebtStrategies([], monthly).saving).toBe(0);
  });
});

describe('buildNetWorthHistory', () => {
  const today = new Date();
  const day = (offset) => iso(addDays(today, offset));

  it('ends at the total the Accounts page shows', () => {
    const { series, current } = buildNetWorthHistory({
      accounts: [{ id: 1, balance: 600 }, { id: 2, balance: 400 }],
      days: 10,
    });

    expect(series.at(-1).assets).toBe(1000);
    expect(current.assets).toBe(1000);
  });

  it('walks backwards through spending and income across every account', () => {
    const { series } = buildNetWorthHistory({
      accounts: [{ id: 1, balance: 900 }, { id: 2, balance: 100 }],
      transactions: [{ accountId: 1, amount: 100, type: 'expense', date: day(-2) }],
      incomeEvents: [{ accountId: 2, amount: 50, date: day(-1) }],
      days: 5,
    });

    // Each point is the balance at the *end* of that day, as buildBalanceHistory
    // already does: yesterday closes at 1000 having taken the £50 in, the day
    // before closes at 950 having paid the £100 out, and the day before that
    // still held 1050.
    expect(series.at(-1).assets).toBe(1000);
    expect(series.at(-2).assets).toBe(1000);
    expect(series.at(-3).assets).toBe(950);
    expect(series.at(-4).assets).toBe(1050);
  });

  it('ignores a transfer between two tracked accounts', () => {
    const { series } = buildNetWorthHistory({
      accounts: [{ id: 1, balance: 700 }, { id: 2, balance: 300 }],
      transfers: [{ fromAccountId: 1, toAccountId: 2, amount: 200, date: day(-2) }],
      days: 5,
    });

    // Money moved within the estate, so the total never changed.
    expect(series.every(point => point.assets === 1000)).toBe(true);
  });

  it('counts a transfer with only one leg inside the estate', () => {
    const { series } = buildNetWorthHistory({
      accounts: [{ id: 1, balance: 800 }],
      transfers: [{ fromAccountId: 1, toAccountId: 99, amount: 200, date: day(-2) }],
      days: 5,
    });

    expect(series.at(-1).assets).toBe(800);
    expect(series[0].assets).toBe(1000);
  });

  it('subtracts open debts from net worth without inventing a debt history', () => {
    const { current, debtHasHistory, series } = buildNetWorthHistory({
      accounts: [{ id: 1, balance: 1000 }],
      goals: [
        { id: 1, kind: 'debt', target: 500, saved: 200 },
        { id: 2, kind: 'debt', target: 100, saved: 100 },
      ],
      days: 5,
    });

    expect(current.debt).toBe(300);
    expect(current.netWorth).toBe(700);
    // Finesse doesn't log when debt payments landed, so no point claims one.
    expect(debtHasHistory).toBe(false);
    expect(series[0]).not.toHaveProperty('debt');
  });

  it('does not count savings goals as assets on top of the balance holding them', () => {
    const withPot = buildNetWorthHistory({
      accounts: [{ id: 1, balance: 1000 }],
      goals: [{ id: 1, kind: 'saving', target: 500, saved: 400 }],
      days: 5,
    });

    // A goal is an earmark; the money is already in the account balance.
    expect(withPot.current.assets).toBe(1000);
    expect(withPot.current.netWorth).toBe(1000);
  });

  it('reports the change across the window', () => {
    const { change } = buildNetWorthHistory({
      accounts: [{ id: 1, balance: 1000 }],
      transactions: [{ accountId: 1, amount: 200, type: 'expense', date: day(-3) }],
      days: 10,
    });

    expect(change).toBe(-200);
  });

  it('handles having no accounts at all', () => {
    const result = buildNetWorthHistory({ days: 3 });
    expect(result.current).toEqual({ assets: 0, debt: 0, netWorth: 0 });
    expect(result.series).toHaveLength(4);
  });
});

describe('buildReview', () => {
  const now = new Date('2026-08-15T12:00:00Z');
  const monthsAgo = (n, day = 10) => iso(new Date(Date.UTC(2026, 7 - n, day, 12)));
  const categories = [
    { id: 1, name: 'Food', color: '#aaa' },
    { id: 2, name: 'Fun', color: '#bbb' },
  ];

  it('totals spending net of refunds', () => {
    const { totals } = buildReview({
      transactions: [
        { id: 1, categoryId: 1, amount: 100, type: 'expense', date: monthsAgo(0) },
        { id: 2, categoryId: 1, amount: 30, type: 'refund', date: monthsAgo(0) },
        { id: 3, categoryId: 2, amount: 50, type: 'expense', date: monthsAgo(1) },
      ],
      categories, months: 12, now,
    });

    expect(totals.spent).toBe(150);
    expect(totals.refunded).toBe(30);
    expect(totals.net).toBe(120);
    expect(totals.transactionCount).toBe(3);
  });

  it('ignores anything older than the window', () => {
    const { totals } = buildReview({
      transactions: [
        { id: 1, categoryId: 1, amount: 100, type: 'expense', date: monthsAgo(1) },
        { id: 2, categoryId: 1, amount: 999, type: 'expense', date: monthsAgo(20) },
      ],
      categories, months: 6, now,
    });

    expect(totals.net).toBe(100);
    expect(totals.transactionCount).toBe(1);
  });

  it('charts a month with no spending as a real zero', () => {
    const { series } = buildReview({
      transactions: [{ id: 1, categoryId: 1, amount: 100, type: 'expense', date: monthsAgo(0) }],
      categories, months: 4, now,
    });

    expect(series).toHaveLength(4);
    expect(series.map(row => row.spent)).toEqual([0, 0, 0, 100]);
    expect(series.at(-1).label).toBe('Aug 26');
  });

  it('ranks categories by what they truly cost, after refunds', () => {
    const { categories: rows } = buildReview({
      transactions: [
        { id: 1, categoryId: 1, amount: 200, type: 'expense', date: monthsAgo(0) },
        { id: 2, categoryId: 1, amount: 150, type: 'refund', date: monthsAgo(0) },
        { id: 3, categoryId: 2, amount: 120, type: 'expense', date: monthsAgo(0) },
      ],
      categories, months: 12, now,
    });

    // Food passed £200 through but cost £50, so Fun is the bigger spend.
    expect(rows.map(row => row.name)).toEqual(['Fun', 'Food']);
    expect(rows[0].total).toBe(120);
    expect(rows[1].total).toBe(50);
    expect(rows[0].share).toBeCloseTo(120 / 170 * 100, 1);
  });

  it('names a category that has since been deleted rather than dropping its spend', () => {
    const { categories: rows } = buildReview({
      transactions: [{ id: 1, categoryId: 99, amount: 40, type: 'expense', date: monthsAgo(0) }],
      categories, months: 12, now,
    });

    expect(rows[0]).toMatchObject({ name: 'Deleted category', total: 40 });
  });

  it('counts income and what was kept', () => {
    const { totals } = buildReview({
      transactions: [{ id: 1, categoryId: 1, amount: 400, type: 'expense', date: monthsAgo(0) }],
      incomeEvents: [
        { id: 1, amount: 1000, date: monthsAgo(0) },
        { id: 2, amount: 1000, date: monthsAgo(1) },
        { id: 3, amount: 999, date: monthsAgo(30) },  // outside the window
      ],
      categories, months: 12, now,
    });

    expect(totals.income).toBe(2000);
    expect(totals.saved).toBe(1600);
  });

  it('finds the busiest and quietest months that actually happened', () => {
    const { busiest, quietest } = buildReview({
      transactions: [
        { id: 1, categoryId: 1, amount: 500, type: 'expense', date: monthsAgo(1) },
        { id: 2, categoryId: 1, amount: 50, type: 'expense', date: monthsAgo(2) },
      ],
      categories, months: 12, now,
    });

    // Ten empty months in the window must not be crowned "quietest".
    expect(busiest.spent).toBe(500);
    expect(quietest.spent).toBe(50);
  });

  it('picks the biggest single outgoing, never a refund', () => {
    const { biggest } = buildReview({
      transactions: [
        { id: 1, categoryId: 1, amount: 90, type: 'expense', date: monthsAgo(0) },
        { id: 2, categoryId: 1, amount: 500, type: 'refund', date: monthsAgo(0) },
      ],
      categories, months: 12, now,
    });

    expect(biggest.id).toBe(1);
  });

  it('measures subscription creep between the first and last months that had any', () => {
    const { subscriptionTrend } = buildReview({
      transactions: [
        { id: 1, categoryId: 1, amount: 10, type: 'expense', subscriptionId: 7, date: monthsAgo(5) },
        { id: 2, categoryId: 1, amount: 25, type: 'expense', subscriptionId: 7, date: monthsAgo(0) },
      ],
      subscriptions: [{ id: 7, name: 'Streaming' }],
      categories, months: 12, now,
    });

    expect(subscriptionTrend).toMatchObject({ first: 10, last: 25, change: 15, changePct: 150, total: 35 });
  });

  it('reports no subscription trend from a single month', () => {
    const { subscriptionTrend } = buildReview({
      transactions: [{ id: 1, categoryId: 1, amount: 10, type: 'expense', subscriptionId: 7, date: monthsAgo(0) }],
      subscriptions: [{ id: 7, name: 'Streaming' }],
      categories, months: 12, now,
    });

    expect(subscriptionTrend).toBeNull();
  });

  it('says plainly when there is nothing to review', () => {
    const review = buildReview({ categories, months: 12, now });

    expect(review.hasData).toBe(false);
    expect(review.totals.net).toBe(0);
    expect(review.categories).toEqual([]);
    expect(review.busiest).toBeNull();
    expect(review.series).toHaveLength(12);
  });
});

/**
 * Pacing and a formula both derive an allowance. When one category carried
 * both, two separate effects wrote it in turn and the stored value flipped
 * between them for as long as the app was open. One resolver, one answer.
 */
describe('resolveCategoryAllowance', () => {
  const MONTHLY = { id: 1, name: 'LM', amount: 2400, resetFrequency: 'monthly' };
  const WEEKLY = { id: 2, name: 'Wage', amount: 500, resetFrequency: 'weekly' };
  const fundedBy = (id) => [{ incomeId: id, percent: 100 }];

  it('settles on one value for a category carrying a formula and pacing', () => {
    const category = {
      id: 10, name: 'Eating Out',
      allowanceFormula: '{LM}*.08',
      pacedAllowanceEnabled: true, pacedAllowanceAmount: 5,
      pacedAllowanceInterval: 1, pacedAllowanceUnit: 'day',
      incomeAllocations: fundedBy(1),
    };
    const context = { variables: [], categories: [category], incomes: [MONTHLY] };

    // Pacing wins, matching what the category editor does when both are set.
    const first = resolveCategoryAllowance(category, context);
    expect(first).not.toBeNull();
    expect(first).not.toBe(192);

    // And feeding the answer back gives the same answer — no second value to
    // flip to, which is the property that was missing.
    const settled = resolveCategoryAllowance({ ...category, allowance: first }, context);
    expect(settled).toBe(first);
  });

  it('paces against the funding income\'s cycle, not the calendar month', () => {
    const paced = {
      name: 'Coffee', pacedAllowanceEnabled: true, pacedAllowanceAmount: 5,
      pacedAllowanceInterval: 1, pacedAllowanceUnit: 'day',
      incomeAllocations: fundedBy(2),
    };
    // £5/day on a weekly wage is a week's worth, not a month's.
    expect(resolveCategoryAllowance(paced, { incomes: [WEEKLY] })).toBe(35);
  });

  it('waits rather than guessing while the funding income is still loading', () => {
    const paced = {
      name: 'Coffee', pacedAllowanceEnabled: true, pacedAllowanceAmount: 5,
      pacedAllowanceInterval: 1, pacedAllowanceUnit: 'day',
      incomeAllocations: fundedBy(2),
    };
    // Allocations that resolve to no income mean the cycle length is unknown.
    // Pacing it to the calendar month here would write a month's allowance to a
    // weekly category and correct it a moment later.
    expect(resolveCategoryAllowance(paced, { incomes: [] })).toBeNull();
  });

  it('evaluates a formula when there is no pacing', () => {
    const category = { name: 'Eating Out', allowanceFormula: '{LM}*.08' };
    expect(resolveCategoryAllowance(category, { incomes: [MONTHLY] })).toBe(192);
  });

  it('leaves a plain allowance and an unresolvable formula alone', () => {
    expect(resolveCategoryAllowance({ name: 'Petrol', allowance: 180 }, {})).toBeNull();
    expect(resolveCategoryAllowance(
      { name: 'Petrol', allowanceFormula: '$Nope * 2' }, { incomes: [MONTHLY] },
    )).toBeNull();
  });
});

describe('a category with two allowance sources is surfaced', () => {
  const paced = {
    id: 10, name: 'Eating Out', allowance: 155, spent: 0,
    allowanceFormula: '{LM}*.08',
    pacedAllowanceEnabled: true, pacedAllowanceAmount: 5,
    pacedAllowanceInterval: 1, pacedAllowanceUnit: 'day',
  };

  const find = (nudges) => nudges.find(n => n.id.startsWith('allowance-source-'));

  it('names the categories and where to fix them', () => {
    const nudge = find(buildNudges({ categories: [paced] }));

    expect(nudge).toBeTruthy();
    expect(nudge.title).toContain('Eating Out');
    expect(nudge.body).toContain('Eating Out');
    expect(nudge.view).toBe('dashboard');
  });

  it('counts them when there is more than one', () => {
    const nudge = find(buildNudges({
      categories: [paced, { ...paced, id: 11, name: 'Personal' }],
    }));
    expect(nudge.title).toContain('2 categories');
    expect(nudge.body).toContain('Personal');
  });

  it('says nothing about a category with only one of the two', () => {
    const formulaOnly = { ...paced, pacedAllowanceEnabled: false };
    const pacedOnly = { ...paced, id: 12, allowanceFormula: null };
    expect(find(buildNudges({ categories: [formulaOnly, pacedOnly] }))).toBeUndefined();
  });
});
