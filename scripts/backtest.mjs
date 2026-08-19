/**
 * Walk-forward backtest for the spending predictor.
 *
 *   node scripts/backtest.mjs                     # synthetic data, known ground truth
 *   node scripts/backtest.mjs my-export.json      # your own Finesse export
 *   node scripts/backtest.mjs my-export.json --horizon=14 --folds=8
 *   node scripts/backtest.mjs --regime          # synthetic, with a behaviour change
 *
 * The export file is whatever Settings → Export Data produces. Nothing leaves
 * your machine — this is a plain local script.
 *
 * Read two numbers:
 *
 *   skill     > 0 means the simulator beat "repeat last month". <= 0 means the
 *               naive baseline is as good, and the honest move is to ship that.
 *   coverage  should sit near 0.80. Much lower and the P10–P90 band is too
 *               tight to be trusted; much higher and it is uselessly wide.
 */

import { readFileSync } from 'node:fs';

import {
  backtestPrediction,
  buildSpendPrediction,
  makeRng,
  DEFAULT_HORIZON_DAYS,
} from '../src/prediction.js';

const args = process.argv.slice(2);
const flags = Object.fromEntries(
  args.filter(a => a.startsWith('--')).map(a => {
    const [key, value = 'true'] = a.replace(/^--/, '').split('=');
    return [key, value];
  }),
);
const filePath = args.find(a => !a.startsWith('--')) || null;

const horizon = Number(flags.horizon) || DEFAULT_HORIZON_DAYS;
const folds = Number(flags.folds) || 6;
const sims = Number(flags.sims) || 600;
const correlation = flags.correlation != null ? Number(flags.correlation) : undefined;

// ── Synthetic data ───────────────────────────────────────────────────────────

/**
 * A believable spender: each category is a two-state Markov chain with a
 * weekend lift and log-normal daily totals, which is exactly the structure the
 * model assumes. That makes this a check that the *implementation* recovers a
 * process it should recover — not evidence it works on real people. Only your
 * own export can tell you that.
 */
function makeSyntheticData({ days = 540, seed = 42, shiftAtDay = 0 } = {}) {
  const rng = makeRng(seed);
  const normal = () => {
    let u = 0;
    let v = 0;
    let s = 0;
    do { u = rng() * 2 - 1; v = rng() * 2 - 1; s = u * u + v * v; } while (s === 0 || s >= 1);
    return u * Math.sqrt((-2 * Math.log(s)) / s);
  };

  // `shift` applies to the most recent `shiftAtDay` days — a change of job,
  // a house move, a new habit. Stationary history flatters the naive baseline;
  // this is where a model that weights recent behaviour earns its keep.
  const profiles = [
    { name: 'Groceries',     p01: 0.28, p11: 0.42, weekend: 1.5, logMu: Math.log(34), logSigma: 0.55, shift: {} },
    { name: 'Eating out',    p01: 0.12, p11: 0.46, weekend: 2.3, logMu: Math.log(23), logSigma: 0.7,  shift: { rate: 2.0, amount: 1.3 } },
    { name: 'Transport',     p01: 0.34, p11: 0.55, weekend: 0.6, logMu: Math.log(9),  logSigma: 0.5,  shift: { rate: 0.25 } },
    { name: 'Shopping',      p01: 0.07, p11: 0.30, weekend: 1.7, logMu: Math.log(48), logSigma: 1.0,  shift: { rate: 0.3 } },
    { name: 'Coffee',        p01: 0.30, p11: 0.60, weekend: 0.8, logMu: Math.log(4),  logSigma: 0.35, shift: {} },
    { name: 'Entertainment', p01: 0.06, p11: 0.25, weekend: 2.6, logMu: Math.log(27), logSigma: 0.8,  shift: { rate: 1.6 } },
  ];

  const categories = profiles.map((profile, index) => ({
    id: index + 1,
    accountId: 1,
    name: profile.name,
    allowance: 250,
    spent: 0,
    color: '#4fffb0',
  }));

  const transactions = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let txId = 1;

  profiles.forEach((profile, index) => {
    let wet = false;
    for (let d = days; d >= 1; d -= 1) {
      const date = new Date(today.getTime() - d * 86400000);
      const isWeekend = date.getDay() === 0 || date.getDay() === 6;
      const shifted = d < shiftAtDay;
      const rateMultiplier = shifted ? (profile.shift.rate ?? 1) : 1;
      const amountMultiplier = shifted ? (profile.shift.amount ?? 1) : 1;
      const base = (wet ? profile.p11 : profile.p01) * rateMultiplier;
      const p = Math.min(0.95, base * (isWeekend ? profile.weekend : 1));
      wet = rng() < p;
      if (!wet) continue;
      const amount = Math.round(Math.exp(profile.logMu + profile.logSigma * normal()) * amountMultiplier * 100) / 100;
      transactions.push({
        id: txId++,
        accountId: 1,
        categoryId: index + 1,
        amount,
        type: 'expense',
        note: profile.name,
        merchant: profile.name,
        date: date.toISOString(),
      });
    }
  });

  const incomes = [{
    id: 1, accountId: 1, name: 'Salary', amount: 2200,
    resetFrequency: 'monthly', payDayOfMonth: 28,
    lastPaid: new Date(today.getTime() - 10 * 86400000).toISOString(),
  }];

  return { categories, transactions, incomes, subscriptions: [], settings: { accountId: 1, payDayOfMonth: 28 } };
}

// ── Load ─────────────────────────────────────────────────────────────────────

function loadExport(path) {
  const payload = JSON.parse(readFileSync(path, 'utf8'));
  const transactions = payload.transactions || [];

  // An export can hold several accounts; back-test the busiest one.
  const counts = new Map();
  for (const tx of transactions) {
    const key = Number(tx.accountId) || 0;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const accountId = Number(flags.account)
    || [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    || 0;

  const scoped = rows => (rows || []).filter(row => !row.accountId || Number(row.accountId) === accountId);

  return {
    accountId,
    categories: scoped(payload.categories),
    transactions: scoped(transactions),
    incomes: scoped(payload.incomes),
    subscriptions: scoped(payload.subscriptions),
    settings: scoped(payload.settings)[0] || null,
  };
}

// ── Report ───────────────────────────────────────────────────────────────────

const money = value => `£${Number(value).toFixed(2)}`.padStart(10);
const pad = (value, width) => String(value).padEnd(width);

const shiftAtDay = flags.regime === 'true' ? 200 : Number(flags.regime) || 0;
const data = filePath ? loadExport(filePath) : makeSyntheticData({ shiftAtDay });

console.log('');
console.log(filePath
  ? `Source     : ${filePath} (account ${data.accountId})`
  : `Source     : synthetic data (${shiftAtDay ? `regime shift ${shiftAtDay} days ago` : 'stationary'})`);
console.log(`Categories : ${data.categories.length}`);
console.log(`Transactions: ${data.transactions.length}`);
console.log(`Horizon    : ${horizon} days   Folds: ${folds}   Sims: ${sims}   Correlation: ${correlation ?? 'default'}`);

const started = performance.now();
const report = backtestPrediction({
  transactions: data.transactions,
  categories: data.categories,
  incomes: data.incomes,
  settings: data.settings,
  horizonDays: horizon,
  folds,
  sims,
  ...(correlation != null ? { correlation } : {}),
});
const elapsed = performance.now() - started;

console.log('');
console.log('Per fold (subscriptions excluded from both sides — see backtestPrediction)');
console.log('');
console.log(`  ${pad('cutoff', 12)}${pad('actual', 11)}${pad('model p50', 12)}${pad('model band', 24)}${pad('hit', 5)}${pad('naive p50', 12)}${'naive hit'}`);
for (const fold of report.folds) {
  console.log(
    `  ${pad(fold.cutoff, 12)}${money(fold.actual)} ${money(fold.model.p50)} `
    + `${pad(`${money(fold.model.p10)} – ${money(fold.model.p90)}`, 24)}`
    + `${pad(fold.model.covered ? ' yes' : ' NO', 5)}${money(fold.baseline.p50)} `
    + `${fold.baseline.covered ? 'yes' : 'NO'}`,
  );
}

if (report.skippedFolds.length) {
  console.log('');
  for (const skipped of report.skippedFolds) {
    console.log(`  skipped ${skipped.cutoff}: ${skipped.reason} (${skipped.historyDays} days of history)`);
  }
}

console.log('');
console.log('Summary');
console.log('');
console.log(`  ${pad('', 14)}${pad('pinball', 12)}${pad('coverage', 12)}${pad('MAE', 12)}${'MAPE'}`);
console.log(`  ${pad('model', 14)}${pad(report.model.pinball.toFixed(2), 12)}${pad(report.model.coverage.toFixed(2), 12)}${pad(report.model.mae.toFixed(2), 12)}${(report.model.mape * 100).toFixed(1)}%`);
console.log(`  ${pad('naive', 14)}${pad(report.baseline.pinball.toFixed(2), 12)}${pad(report.baseline.coverage.toFixed(2), 12)}${pad(report.baseline.mae.toFixed(2), 12)}${(report.baseline.mape * 100).toFixed(1)}%`);
console.log('');
console.log(`  skill vs naive : ${report.skill > 0 ? '+' : ''}${(report.skill * 100).toFixed(1)}%  ${report.skill > 0 ? '(model wins)' : '(naive wins — ship the baseline)'}`);
console.log(`  coverage target: ${report.coverageTarget.toFixed(2)}  (model ${report.model.coverage.toFixed(2)})`);
console.log(`  folds scored   : ${report.foldsScored}/${report.foldsRequested}`);
console.log(`  backtest took  : ${elapsed.toFixed(0)} ms`);

// One live forecast, and the timing that decides whether this needs a worker.
const forecastStart = performance.now();
const forecast = buildSpendPrediction({
  transactions: data.transactions,
  categories: data.categories,
  incomes: data.incomes,
  subscriptions: data.subscriptions,
  settings: data.settings,
  horizonDays: horizon,
});
const forecastMs = performance.now() - forecastStart;

console.log('');
console.log(`Live forecast (${forecast.sims} sims, ${forecast.horizonDays} days): ${forecastMs.toFixed(1)} ms`);
if (!forecast.ready) {
  console.log(`  not ready: ${forecast.reason}`);
} else {
  console.log(`  total  ${money(forecast.total.p10)} – ${money(forecast.total.p90)}  (median ${money(forecast.total.p50)})`);
  console.log('');
  console.log('  Note: on *stationary* synthetic data the naive baseline is near-optimal and');
  console.log('  wins by a few percent — there is nothing to adapt to. Run --regime to see the');
  console.log('  case recency weighting exists for. Your own export is the only test that counts.');
  console.log('');
  for (const row of forecast.categories) {
    console.log(`  ${pad(row.name, 16)}${money(row.p10)} – ${money(row.p90)}   median ${money(row.p50)}   [${row.confidence}]`);
  }
}
console.log('');
