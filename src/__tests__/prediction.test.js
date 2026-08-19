import { describe, expect, it } from 'vitest';
import { addDays } from 'date-fns';

import {
  DEFAULT_HORIZON_DAYS,
  MIN_HISTORY_DAYS,
  backtestPrediction,
  baselineForecast,
  buildCycleProjection,
  buildDailySeries,
  buildPooledPrior,
  buildSpendPrediction,
  fitCategoryModel,
  hashSeed,
  makeNormalDraw,
  makeRng,
  normalCdf,
  pinballLoss,
  probit,
  projectSubscriptions,
  quantileSorted,
  simulateSpend,
} from '../prediction';

const iso = date => date.toISOString();
const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

/** A category that is spent in every `everyNDays`, `days` days back from today. */
function makeHistory({ categoryId = 1, days = 200, everyNDays = 2, amount = 20, from = null } = {}) {
  const base = from || today();
  const rows = [];
  for (let d = days; d >= 1; d -= 1) {
    if (d % everyNDays !== 0) continue;
    rows.push({
      id: rows.length + 1,
      categoryId,
      accountId: 1,
      amount,
      type: 'expense',
      date: iso(addDays(base, -d)),
    });
  }
  return rows;
}

const CATEGORY = { id: 1, accountId: 1, name: 'Food', allowance: 300, spent: 0, color: '#4fffb0' };

describe('P1 — seeded randomness', () => {
  it('produces an identical stream for the same seed', () => {
    const a = makeRng(1234);
    const b = makeRng(1234);
    const left = Array.from({ length: 20 }, () => a());
    const right = Array.from({ length: 20 }, () => b());
    expect(left).toEqual(right);
  });

  it('produces a different stream for a different seed', () => {
    const a = makeRng(1);
    const b = makeRng(2);
    expect(a()).not.toBe(b());
  });

  it('stays inside [0, 1)', () => {
    const rng = makeRng(99);
    for (let i = 0; i < 500; i += 1) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('hashes seed parts stably and sensitively', () => {
    expect(hashSeed('a', 1)).toBe(hashSeed('a', 1));
    expect(hashSeed('a', 1)).not.toBe(hashSeed('a', 2));
  });

  it('draws standard normals with roughly the right moments', () => {
    const normal = makeNormalDraw(makeRng(7));
    const samples = Array.from({ length: 20000 }, () => normal());
    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length;
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(Math.abs(variance - 1)).toBeLessThan(0.05);
  });
});

describe('P2 — normal CDF and its inverse', () => {
  it('agrees with known values of Φ', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.6448536)).toBeCloseTo(0.95, 5);
    expect(normalCdf(-1.9599640)).toBeCloseTo(0.025, 5);
  });

  it('round-trips through probit', () => {
    for (const p of [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99]) {
      expect(normalCdf(probit(p))).toBeCloseTo(p, 5);
    }
  });

  // The simulator compares in z-space rather than mapping draws back through
  // the CDF, so a wrong probit would silently skew every occurrence decision.
  it('makes a threshold comparison fire at the intended rate', () => {
    const normal = makeNormalDraw(makeRng(11));
    const threshold = probit(0.3);
    const draws = 200000;
    let hits = 0;
    for (let i = 0; i < draws; i += 1) if (normal() < threshold) hits += 1;
    expect(hits / draws).toBeCloseTo(0.3, 2);
  });
});

describe('P3 — scoring helpers', () => {
  it('interpolates quantiles of a sorted array', () => {
    const sorted = Float64Array.from([0, 10, 20, 30, 40]);
    expect(quantileSorted(sorted, 0)).toBe(0);
    expect(quantileSorted(sorted, 0.5)).toBe(20);
    expect(quantileSorted(sorted, 1)).toBe(40);
    expect(quantileSorted(sorted, 0.25)).toBe(10);
  });

  it('penalises pinball loss asymmetrically', () => {
    // At q=0.9 under-forecasting should hurt far more than over-forecasting.
    expect(pinballLoss(100, 50, 0.9)).toBeCloseTo(45, 6);
    expect(pinballLoss(50, 100, 0.9)).toBeCloseTo(5, 6);
    expect(pinballLoss(100, 100, 0.5)).toBe(0);
  });
});

describe('P4 — daily series', () => {
  it('buckets transactions into one total per day', () => {
    const base = today();
    const series = buildDailySeries([
      { categoryId: 1, amount: 10, type: 'expense', date: iso(addDays(base, -2)) },
      { categoryId: 1, amount: 5, type: 'expense', date: iso(addDays(base, -2)) },
      { categoryId: 1, amount: 7, type: 'expense', date: iso(base) },
    ], { categoryId: 1, to: base });

    expect(series.dayCount).toBe(3);
    expect(series.amounts[0]).toBeCloseTo(15, 6);
    expect(series.amounts[1]).toBeCloseTo(0, 6);
    expect(series.amounts[2]).toBeCloseTo(7, 6);
    expect(series.counts[0]).toBe(2);
  });

  it('excludes refunds and subscription-generated rows from the fit', () => {
    const base = today();
    const series = buildDailySeries([
      { categoryId: 1, amount: 10, type: 'expense', date: iso(base) },
      { categoryId: 1, amount: 4, type: 'refund', date: iso(base) },
      { categoryId: 1, amount: 9, type: 'expense', date: iso(base), subscriptionRunKey: 'sub-1-2026-01' },
    ], { categoryId: 1, from: base, to: base });

    expect(series.amounts[0]).toBeCloseTo(10, 6);
  });

  it('filters by category and ignores unparseable dates', () => {
    const base = today();
    const series = buildDailySeries([
      { categoryId: 1, amount: 10, type: 'expense', date: iso(base) },
      { categoryId: 2, amount: 99, type: 'expense', date: iso(base) },
      { categoryId: 1, amount: 50, type: 'expense', date: 'nonsense' },
    ], { categoryId: 1, from: base, to: base });

    expect(series.amounts[0]).toBeCloseTo(10, 6);
  });
});

describe('P5 — fitting', () => {
  it('recovers a high occurrence rate from dense history', () => {
    const series = buildDailySeries(makeHistory({ everyNDays: 1, days: 180 }), { categoryId: 1, to: today() });
    const model = fitCategoryModel({ series, prior: buildPooledPrior([series]) });
    expect(model.wetRate).toBeGreaterThan(0.9);
    expect(model.confidence).toBe('ok');
  });

  it('recovers a low occurrence rate from sparse history', () => {
    const series = buildDailySeries(makeHistory({ everyNDays: 10, days: 180 }), { categoryId: 1, to: today() });
    const model = fitCategoryModel({ series, prior: buildPooledPrior([series]) });
    expect(model.wetRate).toBeLessThan(0.2);
    expect(model.wetDays).toBe(18);
  });

  it('flags a category with almost no history as unusable', () => {
    const series = buildDailySeries(makeHistory({ everyNDays: 5, days: 10 }), { categoryId: 1, to: today() });
    const model = fitCategoryModel({ series, prior: buildPooledPrior([series]) });
    expect(model.confidence).toBe('none');
  });

  it('switches to empirical severity once there are enough spend days', () => {
    const dense = buildDailySeries(makeHistory({ everyNDays: 2, days: 200 }), { categoryId: 1, to: today() });
    const sparse = buildDailySeries(makeHistory({ everyNDays: 30, days: 200 }), { categoryId: 1, to: today() });
    expect(fitCategoryModel({ series: dense }).severity.kind).toBe('empirical');
    expect(fitCategoryModel({ series: sparse }).severity.kind).toBe('lognormal');
  });

  it('caps the log-normal tail so a thin category cannot invent a huge day', () => {
    const series = buildDailySeries(makeHistory({ everyNDays: 30, days: 200, amount: 40 }), { categoryId: 1, to: today() });
    const model = fitCategoryModel({ series });
    const sim = simulateSpend({ models: [model], horizonDays: 365, sims: 200, rng: makeRng(3), correlation: 0 });
    expect(sim.byCategory[0].p90).toBeLessThan(model.severity.cap * 365);
    expect(Number.isFinite(sim.total.p90)).toBe(true);
  });
});

describe('P6 — simulation', () => {
  const buildModel = () => {
    const series = buildDailySeries(makeHistory({ everyNDays: 2, days: 200, amount: 20 }), { categoryId: 1, to: today() });
    return fitCategoryModel({ series, prior: buildPooledPrior([series]) });
  };

  it('is deterministic for a given seed', () => {
    const model = buildModel();
    const run = () => simulateSpend({ models: [model], horizonDays: 30, sims: 200, rng: makeRng(42) });
    expect(run().total).toEqual(run().total);
  });

  it('orders the quantiles', () => {
    const sim = simulateSpend({ models: [buildModel()], horizonDays: 30, sims: 400, rng: makeRng(5) });
    expect(sim.total.p10).toBeLessThanOrEqual(sim.total.p50);
    expect(sim.total.p50).toBeLessThanOrEqual(sim.total.p90);
    for (const point of sim.daily) {
      expect(point.p10).toBeLessThanOrEqual(point.p50);
      expect(point.p50).toBeLessThanOrEqual(point.p90);
    }
  });

  it('produces monotonically rising cumulative paths', () => {
    const sim = simulateSpend({ models: [buildModel()], horizonDays: 30, sims: 300, rng: makeRng(6) });
    for (let i = 1; i < sim.daily.length; i += 1) {
      expect(sim.daily[i].mean).toBeGreaterThanOrEqual(sim.daily[i - 1].mean);
    }
  });

  it('lands near the historical daily rate', () => {
    // Spending £20 every other day is £10/day, so 30 days should centre on £300.
    const sim = simulateSpend({ models: [buildModel()], horizonDays: 30, sims: 2000, rng: makeRng(8), correlation: 0 });
    expect(sim.total.mean).toBeGreaterThan(230);
    expect(sim.total.mean).toBeLessThan(370);
  });

  // Independent categories understate the spread of the *total*: a real
  // expensive weekend hits several at once.
  it('widens the aggregate band as correlation rises', () => {
    const models = [buildModel(), buildModel(), buildModel()];
    const spread = correlation => {
      const sim = simulateSpend({ models, horizonDays: 30, sims: 1500, rng: makeRng(21), correlation });
      return sim.total.p90 - sim.total.p10;
    };
    expect(spread(0.7)).toBeGreaterThan(spread(0));
  });

  it('leaves each category marginal unchanged by correlation', () => {
    const models = [buildModel(), buildModel(), buildModel()];
    const mean = correlation => simulateSpend({
      models, horizonDays: 30, sims: 4000, rng: makeRng(31), correlation,
    }).byCategory[0].mean;
    expect(Math.abs(mean(0.7) - mean(0))).toBeLessThan(mean(0) * 0.1);
  });
});

describe('P7 — deterministic subscriptions', () => {
  it('projects a monthly subscription across the horizon', () => {
    const base = today();
    const plan = projectSubscriptions([
      { id: 1, name: 'Netflix', amount: 12.99, interval: 1, intervalUnit: 'month', nextDueAt: iso(addDays(base, 3)), categoryId: 1, active: true },
    ], { from: base, days: 70 });

    expect(plan.items).toHaveLength(3);
    expect(plan.total).toBeCloseTo(38.97, 2);
    expect(plan.byCategory.get(1)).toBeCloseTo(38.97, 2);
  });

  it('ignores inactive subscriptions and anything past the horizon', () => {
    const base = today();
    const plan = projectSubscriptions([
      { id: 1, name: 'Off', amount: 10, interval: 1, intervalUnit: 'month', nextDueAt: iso(addDays(base, 3)), active: false },
      { id: 2, name: 'Later', amount: 10, interval: 1, intervalUnit: 'year', nextDueAt: iso(addDays(base, 200)), active: true },
    ], { from: base, days: 30 });

    expect(plan.total).toBe(0);
    expect(plan.items).toHaveLength(0);
  });

  it('catches up a subscription whose due date is in the past', () => {
    const base = today();
    const plan = projectSubscriptions([
      { id: 1, name: 'Stale', amount: 5, interval: 1, intervalUnit: 'month', nextDueAt: iso(addDays(base, -95)), active: true },
    ], { from: base, days: 30 });

    expect(plan.items.length).toBeGreaterThanOrEqual(1);
    expect(plan.items[0].amount).toBe(5);
  });
});

describe('P8 — end-to-end prediction', () => {
  const transactions = makeHistory({ everyNDays: 2, days: 220, amount: 20 });

  it('refuses to forecast without enough history', () => {
    const result = buildSpendPrediction({
      transactions: makeHistory({ everyNDays: 2, days: 10 }),
      categories: [CATEGORY],
    });
    expect(result.ready).toBe(false);
    expect(result.reason).toContain(String(MIN_HISTORY_DAYS));
  });

  it('refuses when no category has ever been spent in', () => {
    const result = buildSpendPrediction({
      transactions,
      categories: [{ id: 2, name: 'Untouched', allowance: 100 }],
    });
    expect(result.ready).toBe(false);
  });

  it('returns an ordered band and a full horizon of points', () => {
    const result = buildSpendPrediction({ transactions, categories: [CATEGORY], horizonDays: 30 });

    expect(result.ready).toBe(true);
    expect(result.series).toHaveLength(30);
    expect(result.total.p10).toBeLessThanOrEqual(result.total.p50);
    expect(result.total.p50).toBeLessThanOrEqual(result.total.p90);
    expect(result.categories[0].name).toBe('Food');
    expect(result.series.at(-1).p50).toBeCloseTo(result.total.p50, 0);
    expect(result.series[0].band).toEqual([result.series[0].p10, result.series[0].p90]);
  });

  it('is stable across calls and moves when the data moves', () => {
    const a = buildSpendPrediction({ transactions, categories: [CATEGORY] });
    const b = buildSpendPrediction({ transactions, categories: [CATEGORY] });
    expect(a.total).toEqual(b.total);
    expect(a.seed).toBe(b.seed);

    const extra = [...transactions, {
      id: 99999, categoryId: 1, amount: 40, type: 'expense', date: iso(today()),
    }];
    expect(buildSpendPrediction({ transactions: extra, categories: [CATEGORY] }).seed).not.toBe(a.seed);
  });

  // The whole reason subscription rows are dropped from the fit: they are
  // deterministic and are added back on the calendar instead.
  it('counts a subscription once, not twice', () => {
    const base = today();
    const subscription = {
      id: 1, name: 'Gym', amount: 30, interval: 1, intervalUnit: 'month',
      nextDueAt: iso(addDays(base, 5)), categoryId: 1, active: true,
    };
    const logged = [...transactions];
    for (let month = 1; month <= 6; month += 1) {
      logged.push({
        id: 50000 + month,
        categoryId: 1,
        amount: 30,
        type: 'expense',
        date: iso(addDays(base, -30 * month)),
        subscriptionRunKey: `sub-1-${month}`,
      });
    }

    const withSubs = buildSpendPrediction({
      transactions: logged, categories: [CATEGORY], subscriptions: [subscription], horizonDays: 30,
    });
    const withoutSubs = buildSpendPrediction({
      transactions: logged, categories: [CATEGORY], subscriptions: [], horizonDays: 30,
    });

    expect(withSubs.subscriptions.total).toBe(30);
    // Exactly one £30 charge more than the stochastic-only forecast.
    expect(withSubs.total.p50 - withoutSubs.total.p50).toBeCloseTo(30, 6);
    expect(withSubs.stochasticTotal.p50).toBeCloseTo(withoutSubs.stochasticTotal.p50, 6);
  });

  it('reports a subscription in a category with no spend history', () => {
    const base = today();
    const result = buildSpendPrediction({
      transactions,
      categories: [CATEGORY, { id: 7, name: 'Insurance', allowance: 20 }],
      subscriptions: [{
        id: 3, name: 'Cover', amount: 15, interval: 1, intervalUnit: 'month',
        nextDueAt: iso(addDays(base, 2)), categoryId: 7, active: true,
      }],
      horizonDays: 30,
    });

    const row = result.categories.find(entry => entry.id === 7);
    expect(row).toBeDefined();
    expect(row.p10).toBe(15);
    expect(row.p90).toBe(15);
    expect(row.confidence).toBe('none');
  });

  it('gives every category a per-day expected spend series', () => {
    const result = buildSpendPrediction({ transactions, categories: [CATEGORY], horizonDays: 30 });
    const row = result.categories[0];

    expect(row.daily).toHaveLength(30);
    expect(row.cumulative).toHaveLength(30);
    expect(row.daily.every(value => value >= 0)).toBe(true);
    // Cumulative is the running sum of daily, and lands on the category mean.
    for (let i = 1; i < row.cumulative.length; i += 1) {
      expect(row.cumulative[i]).toBeGreaterThanOrEqual(row.cumulative[i - 1]);
    }
    expect(row.cumulative.at(-1)).toBeCloseTo(row.mean, 0);
  });

  it('reconciles per-category daily means against the aggregate', () => {
    const second = { id: 2, name: 'Travel', allowance: 120, color: '#5db8ff' };
    const mixed = [
      ...transactions,
      ...makeHistory({ categoryId: 2, everyNDays: 3, days: 220, amount: 12 }),
    ];
    const result = buildSpendPrediction({ transactions: mixed, categories: [CATEGORY, second], horizonDays: 30 });

    const summed = result.categories.reduce((sum, row) => sum + row.cumulative.at(-1), 0);
    expect(summed).toBeCloseTo(result.total.mean, 0);
  });

  // A subscription is a spike on one known day, not spread across the month.
  it('puts a subscription on its due day in the daily series', () => {
    const base = today();
    const result = buildSpendPrediction({
      transactions,
      categories: [CATEGORY],
      subscriptions: [{
        id: 1, name: 'Gym', amount: 30, interval: 1, intervalUnit: 'month',
        nextDueAt: iso(addDays(base, 5)), categoryId: 1, active: true,
      }],
      horizonDays: 30,
    });

    const row = result.categories.find(entry => entry.id === 1);
    // Horizon starts tomorrow, so a charge 5 days out is index 4.
    const spike = row.daily[4];
    const neighbours = [row.daily[2], row.daily[3], row.daily[5], row.daily[6]];
    expect(spike).toBeGreaterThan(30);
    expect(Math.max(...neighbours)).toBeLessThan(spike - 25);
  });

  it('honours the requested horizon', () => {
    const short = buildSpendPrediction({ transactions, categories: [CATEGORY], horizonDays: 7 });
    const long = buildSpendPrediction({ transactions, categories: [CATEGORY], horizonDays: 60 });
    expect(short.series).toHaveLength(7);
    expect(long.series).toHaveLength(60);
    expect(long.total.p50).toBeGreaterThan(short.total.p50);
  });

  it('defaults to a 30 day horizon', () => {
    expect(buildSpendPrediction({ transactions, categories: [CATEGORY] }).series)
      .toHaveLength(DEFAULT_HORIZON_DAYS);
  });
});

describe('P9 — end-of-cycle projection', () => {
  const transactions = makeHistory({ everyNDays: 2, days: 220, amount: 20 });
  const income = { id: 10, name: 'Salary', amount: 2000, resetFrequency: 'monthly', lastPaid: iso(addDays(today(), -8)) };
  const funded = {
    ...CATEGORY,
    spent: 120,
    incomeAllocations: [{ incomeId: 10, percent: 100 }],
    lastReset: iso(addDays(today(), -8)),
  };

  it('projects each category to its own cycle end', () => {
    const result = buildCycleProjection({
      transactions, categories: [funded], incomes: [income], sims: 400,
    });

    expect(result.ready).toBe(true);
    const row = result.categories[0];
    expect(row.remainingDays).toBeGreaterThan(0);
    // Projection starts from what is already spent, not from zero.
    expect(row.p10).toBeGreaterThanOrEqual(row.spent);
    expect(row.p10).toBeLessThanOrEqual(row.p50);
    expect(row.p50).toBeLessThanOrEqual(row.p90);
    expect(row.overspendRisk).toBeGreaterThanOrEqual(0);
    expect(row.overspendRisk).toBeLessThanOrEqual(1);
  });

  it('reports near-certain overspend against a hopeless allowance', () => {
    const doomed = { ...funded, allowance: 1, spent: 300 };
    const result = buildCycleProjection({
      transactions, categories: [doomed], incomes: [income], sims: 400,
    });
    expect(result.categories[0].overspendRisk).toBeGreaterThan(0.9);
  });

  it('reports near-zero overspend against a generous allowance', () => {
    const safe = { ...funded, allowance: 100000, spent: 0 };
    const result = buildCycleProjection({
      transactions, categories: [safe], incomes: [income], sims: 400,
    });
    expect(result.categories[0].overspendRisk).toBeLessThan(0.05);
  });

  // A rollover balance or a temporary boost is real money this cycle; comparing
  // against the base allowance would flag an overspend that isn't one.
  it('counts rollover and boosts as headroom', () => {
    const base = { ...funded, allowance: 200, spent: 190, rolloverBalance: 0, temporaryBoost: 0 };
    const boosted = { ...base, rolloverBalance: 400, temporaryBoost: 400 };
    const risk = category => buildCycleProjection({
      transactions, categories: [category], incomes: [income], sims: 400,
    }).categories[0].overspendRisk;

    expect(risk(boosted)).toBeLessThan(risk(base));
  });

  it('refuses without enough history', () => {
    const result = buildCycleProjection({
      transactions: makeHistory({ everyNDays: 2, days: 8 }),
      categories: [funded],
      incomes: [income],
    });
    expect(result.ready).toBe(false);
    expect(result.categories).toEqual([]);
  });

  it('is deterministic for the same data', () => {
    const run = () => buildCycleProjection({
      transactions, categories: [funded], incomes: [income], sims: 300,
    }).categories[0];
    expect(run()).toEqual(run());
  });
});

describe('P10 — per-category simulation horizons', () => {
  const buildModel = () => {
    const series = buildDailySeries(makeHistory({ everyNDays: 2, days: 200, amount: 20 }), { categoryId: 1, to: today() });
    return fitCategoryModel({ series, prior: buildPooledPrior([series]) });
  };

  it('stops tallying a category at its own horizon', () => {
    const models = [buildModel(), buildModel()];
    const sim = simulateSpend({
      models, horizonDays: 60, sims: 800, rng: makeRng(77), correlation: 0,
      horizonByCategory: [60, 30],
    });
    // Half the days should be roughly half the spend.
    expect(sim.byCategory[1].mean).toBeGreaterThan(sim.byCategory[0].mean * 0.35);
    expect(sim.byCategory[1].mean).toBeLessThan(sim.byCategory[0].mean * 0.65);
  });

  it('records nothing for a category whose cycle has already ended', () => {
    const sim = simulateSpend({
      models: [buildModel()], horizonDays: 30, sims: 200, rng: makeRng(5), horizonByCategory: [0],
    });
    expect(sim.byCategory[0].mean).toBe(0);
    expect(sim.byCategory[0].p90).toBe(0);
  });
});

describe('P11 — backtesting', () => {
  const transactions = makeHistory({ everyNDays: 2, days: 400, amount: 20 });

  it('scores every fold it has history for', () => {
    const report = backtestPrediction({
      transactions, categories: [CATEGORY], horizonDays: 30, folds: 4, sims: 120,
    });
    expect(report.foldsScored).toBeGreaterThan(0);
    expect(report.folds[0]).toHaveProperty('actual');
    expect(report.folds[0].model).toHaveProperty('pinball');
    expect(report.model.coverage).toBeGreaterThanOrEqual(0);
    expect(report.model.coverage).toBeLessThanOrEqual(1);
  });

  it('skips folds without enough history rather than scoring noise', () => {
    const report = backtestPrediction({
      transactions: makeHistory({ everyNDays: 2, days: 80 }),
      categories: [CATEGORY],
      horizonDays: 30,
      folds: 6,
      minHistoryDays: 60,
      sims: 60,
    });
    expect(report.skippedFolds.length).toBeGreaterThan(0);
    expect(report.foldsScored).toBeLessThan(6);
  });

  // A metronome-regular spender is precisely where a naive baseline is
  // optimal — every rolling window sums to the same number, so its loss is
  // zero and nothing can beat it. The honest claim is that the simulator
  // stays close.
  it('tracks a perfectly regular spender to within a few percent', () => {
    const report = backtestPrediction({
      transactions, categories: [CATEGORY], horizonDays: 30, folds: 4, sims: 600,
    });
    const actual = report.folds[0].actual;
    expect(report.model.mae).toBeLessThan(actual * 0.15);
    expect(report.model.coverage).toBeGreaterThanOrEqual(0.75);
  });

  // The design justification for recency weighting, pinned as a regression:
  // when habits change, weighting recent behaviour beats "repeat last month".
  it('beats the naive baseline when spending habits change', () => {
    const base = today();
    const changed = [];
    let id = 1;
    for (let d = 420; d >= 1; d -= 1) {
      // Quiet for the first year, then four times as often.
      const everyN = d > 150 ? 4 : 1;
      if (d % everyN !== 0) continue;
      changed.push({
        id: id++, categoryId: 1, accountId: 1, amount: 20, type: 'expense',
        date: iso(addDays(base, -d)),
      });
    }

    const report = backtestPrediction({
      transactions: changed, categories: [CATEGORY], horizonDays: 30, folds: 4, sims: 600,
    });

    expect(report.skill).toBeGreaterThan(0);
    expect(report.model.pinball).toBeLessThan(report.baseline.pinball);
  });

  it('builds a baseline band from rolling windows', () => {
    const series = buildDailySeries(transactions, { categoryId: 1, to: today() });
    const baseline = baselineForecast(series, 30);
    expect(baseline.windows).toBeGreaterThan(0);
    expect(baseline.p10).toBeLessThanOrEqual(baseline.p50);
    expect(baseline.p50).toBeLessThanOrEqual(baseline.p90);
  });
});
