import { describe, expect, it } from 'vitest';
import { addDays, format, subMonths } from 'date-fns';

import {
  AVERAGE_MONTH_DAYS,
  buildMonthlyHistory,
  getCategoryCycle,
  getCumulativeOverspend,
  getDailyBurnRate,
  getEffectiveAllowance,
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
  flagUnusualSpend,
  getMerchantSuggestions,
  getSignedAmount,
  isRefund,
  normaliseTags,
  suggestCategoryForNote,
  hasMixedIncomeFrequencies,
  projectedEndBalance,
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
