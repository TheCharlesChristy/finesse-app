/**
 * Spending prediction — a Markov occurrence/severity model, evaluated by
 * Monte Carlo simulation.
 *
 * ## Why this shape
 *
 * A single user's history is far too short to train anything neural: one
 * observation per category per month means a year of use is twelve data
 * points. What *does* work at this scale is exploiting the structure of the
 * problem, which splits cleanly in two:
 *
 *   - **Deterministic** — subscriptions have known dates and amounts. They are
 *     not predicted at all, they are projected onto the calendar.
 *   - **Stochastic** — discretionary spend, which is zero-inflated (most days
 *     are £0), right-skewed when non-zero, and *bursty*: spend days cluster
 *     into weekends and trips.
 *
 * Burstiness is why the occurrence process is a two-state Markov chain rather
 * than an independent coin flip per day. Independent draws produce a forecast
 * that is far too smooth in the tails — it never generates the bad week that
 * is the entire reason to look at a forecast. The same construction is used
 * for daily rainfall in hydrology, which has the identical statistical
 * signature.
 *
 * The output is deliberately a *distribution*, not a point estimate. Personal
 * spending is dominated by irreducible noise — no model knows you will book a
 * flight next Tuesday — so "£240–£410, most likely £310" is the honest answer
 * and "£312" is a lie with a decimal place on it.
 *
 * ## Purity
 *
 * Same contract as `utils.js`: no Dexie, no React, no side effects, no wall
 * clock except through an injected `now`. It lives in its own module rather
 * than in `utils.js` only because it is a self-contained algorithm of some
 * size, and burying it in a 1,500-line grab-bag would help nobody.
 */

import { addDays, differenceInDays, format, getDay, startOfDay } from 'date-fns';

import {
  addRecurringInterval,
  getCategoryCycle,
  getEffectiveAllowance,
  getSignedAmount,
  isRefund,
  roundMoney,
} from './utils';

// ── Tunables ─────────────────────────────────────────────────────────────────

/** Quantiles reported everywhere. P10/P90 gives a nominal 80% band. */
export const QUANTILES = [0.1, 0.5, 0.9];

export const DEFAULT_HORIZON_DAYS = 30;
export const DEFAULT_SIMS = 1200;

/**
 * Observations decay with a 90-day half-life. Spending from eighteen months
 * ago is barely evidence, and without this the forecast averages over a
 * lifestyle change instead of tracking it.
 */
export const DEFAULT_HALF_LIFE_DAYS = 90;

/**
 * How much of each day's spend/no-spend decision is driven by a factor shared
 * across every category. Simulating categories independently understates the
 * variance of the *total* badly: a holiday hits food, transport and
 * entertainment at once, and independent draws never produce that.
 */
export const DEFAULT_CORRELATION = 0.35;

/** Below this much history a forecast is not worth showing at all. */
export const MIN_HISTORY_DAYS = 28;
/** Below this many observed spend days a category falls back to its allowance. */
export const MIN_SPEND_DAYS = 4;
/** At or above this many spend days, sample amounts empirically. */
export const SEVERITY_EMPIRICAL_MIN = 20;

/** Cycle split into early / middle / late. More buckets than this starve. */
const CYCLE_PHASES = 3;
const DOW_BUCKETS = 7;

/** Pseudo-observations used when shrinking a bucket toward its parent. */
const DOW_SHRINKAGE = 4;
const CATEGORY_SHRINKAGE = 4;
const PHASE_SHRINKAGE = 12;

/** Transition probabilities are clamped away from 0 and 1 so no state traps. */
const P_MIN = 0.02;
const P_MAX = 0.98;

// ── Random numbers ───────────────────────────────────────────────────────────

/**
 * FNV-1a over the stringified parts.
 *
 * The forecast is seeded from the data it describes, so it stays identical
 * across re-renders but genuinely changes when a transaction is added. A
 * forecast that jitters every time you open the tab reads as broken.
 */
export function hashSeed(...parts) {
  const text = parts.map(part => String(part)).join('|');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32 — small, fast, and good enough for Monte Carlo. */
export function makeRng(seed = 1) {
  let state = (seed >>> 0) || 1;
  return function rng() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normals via the Marsaglia polar method, one spare cached. */
export function makeNormalDraw(rng) {
  let spare = null;
  return function normal() {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return value;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = rng() * 2 - 1;
      v = rng() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const factor = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * factor;
    return u * factor;
  };
}

/** Φ(x) — Zelen & Severo 26.2.17, |error| < 7.5e-8. */
export function normalCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const density = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const poly = t * (0.319381530
    + t * (-0.356563782
    + t * (1.781477937
    + t * (-1.821255978
    + t * 1.330274429))));
  const tail = density * poly;
  return x >= 0 ? 1 - tail : tail;
}

const PROBIT_A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
const PROBIT_B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
const PROBIT_C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const PROBIT_D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
const PROBIT_LOW = 0.02425;

/**
 * Φ⁻¹(p) — Acklam's rational approximation.
 *
 * Lets the simulator compare in z-space (`z < probit(p)`) instead of mapping
 * every draw back through the CDF, which takes an exp() out of the innermost
 * loop and off the phone's main thread budget.
 */
export function probit(p) {
  if (!(p > 0)) return -Infinity;
  if (p >= 1) return Infinity;

  if (p < PROBIT_LOW) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((PROBIT_C[0] * q + PROBIT_C[1]) * q + PROBIT_C[2]) * q + PROBIT_C[3]) * q + PROBIT_C[4]) * q + PROBIT_C[5])
      / ((((PROBIT_D[0] * q + PROBIT_D[1]) * q + PROBIT_D[2]) * q + PROBIT_D[3]) * q + 1);
  }
  if (p > 1 - PROBIT_LOW) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((PROBIT_C[0] * q + PROBIT_C[1]) * q + PROBIT_C[2]) * q + PROBIT_C[3]) * q + PROBIT_C[4]) * q + PROBIT_C[5])
      / ((((PROBIT_D[0] * q + PROBIT_D[1]) * q + PROBIT_D[2]) * q + PROBIT_D[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((PROBIT_A[0] * r + PROBIT_A[1]) * r + PROBIT_A[2]) * r + PROBIT_A[3]) * r + PROBIT_A[4]) * r + PROBIT_A[5]) * q)
    / (((((PROBIT_B[0] * r + PROBIT_B[1]) * r + PROBIT_B[2]) * r + PROBIT_B[3]) * r + PROBIT_B[4]) * r + 1);
}

// ── Small helpers ────────────────────────────────────────────────────────────

function toValidDate(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Linear-interpolated quantile of an already-sorted ascending array. */
export function quantileSorted(sorted, q) {
  const n = sorted.length;
  if (!n) return 0;
  if (n === 1) return sorted[0];
  const position = Math.min(Math.max(q, 0), 1) * (n - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/**
 * Pinball (quantile) loss — the correct scoring rule for an interval forecast.
 *
 * Scoring on squared error against the median rewards a well-centred forecast
 * with useless bands, which is exactly the failure mode to avoid here.
 */
export function pinballLoss(actual, predicted, q) {
  return actual >= predicted ? q * (actual - predicted) : (1 - q) * (predicted - actual);
}

/** Which third of its funding cycle a date falls in. */
function cyclePhase(date, cycle) {
  if (!cycle?.start || !cycle?.days) return 0;
  const span = Math.max(1, cycle.days);
  const offset = ((differenceInDays(startOfDay(date), cycle.start) % span) + span) % span;
  return Math.min(CYCLE_PHASES - 1, Math.floor((offset / span) * CYCLE_PHASES));
}

// ── Daily series ─────────────────────────────────────────────────────────────

/**
 * Bucket transactions into one net-expense total per day.
 *
 * Subscription-generated rows are excluded by default: they are deterministic,
 * already projected onto the calendar elsewhere, and letting the Markov chain
 * "learn" them would both fit them badly and double-count them at prediction
 * time. Refunds are excluded from the fit too — they are unpredictable
 * reversals, and modelling them as a symmetric process only widens the band.
 */
export function buildDailySeries(transactions = [], {
  categoryId = null,
  from = null,
  to = new Date(),
  includeSubscriptions = false,
  includeRefunds = false,
} = {}) {
  const wanted = [];
  let earliest = null;

  for (const tx of transactions) {
    if (categoryId != null && Number(tx?.categoryId) !== Number(categoryId)) continue;
    if (!includeSubscriptions && tx?.subscriptionRunKey) continue;
    if (!includeRefunds && isRefund(tx)) continue;
    const date = toValidDate(tx?.date);
    if (!date) continue;
    const day = startOfDay(date);
    wanted.push({ day, amount: getSignedAmount(tx) });
    if (!earliest || day < earliest) earliest = day;
  }

  const end = startOfDay(toValidDate(to) || new Date());
  const start = startOfDay(toValidDate(from) || earliest || end);
  const dayCount = Math.max(0, differenceInDays(end, start) + 1);

  const amounts = new Float64Array(dayCount);
  const counts = new Int32Array(dayCount);

  for (const entry of wanted) {
    const index = differenceInDays(entry.day, start);
    if (index < 0 || index >= dayCount) continue;
    amounts[index] += entry.amount;
    counts[index] += 1;
  }

  return { start, end, dayCount, amounts, counts };
}

// ── Fitting ──────────────────────────────────────────────────────────────────

/**
 * Cross-category averages, used to shrink thin categories toward something
 * sane rather than letting six transactions speak for themselves.
 */
export function buildPooledPrior(seriesByCategory = []) {
  let wetWeight = 0;
  let totalWeight = 0;
  let c01 = 0;
  let n01 = 0;
  let c11 = 0;
  let n11 = 0;
  const logAmounts = [];

  for (const series of seriesByCategory) {
    const { amounts, dayCount } = series;
    for (let i = 0; i < dayCount; i += 1) {
      const wet = amounts[i] > 0;
      totalWeight += 1;
      if (wet) {
        wetWeight += 1;
        logAmounts.push(Math.log(amounts[i]));
      }
      if (i === 0) continue;
      if (amounts[i - 1] > 0) {
        n11 += 1;
        if (wet) c11 += 1;
      } else {
        n01 += 1;
        if (wet) c01 += 1;
      }
    }
  }

  const wetRate = totalWeight > 0 ? wetWeight / totalWeight : 0.25;
  let logMu = Math.log(20);
  let logSigma = 0.9;
  if (logAmounts.length >= 2) {
    logMu = logAmounts.reduce((sum, value) => sum + value, 0) / logAmounts.length;
    const variance = logAmounts.reduce((sum, value) => sum + (value - logMu) ** 2, 0) / (logAmounts.length - 1);
    logSigma = Math.max(0.2, Math.sqrt(variance));
  }

  return {
    wetRate,
    p01: n01 > 0 ? c01 / n01 : wetRate,
    p11: n11 > 0 ? c11 / n11 : wetRate,
    logMu,
    logSigma,
    samples: logAmounts.length,
  };
}

/**
 * Fit one category's occurrence chain and severity distribution.
 *
 * Transitions are estimated per day-of-week and shrunk twice — bucket toward
 * the category's own rate, category toward the pooled cross-category rate — so
 * a category with three Tuesdays of history borrows strength instead of
 * asserting nonsense. The cycle-phase effect is applied as a separate
 * multiplier rather than a full day-of-week × phase cross, because 42 cells
 * over a year of data is five observations each.
 */
export function fitCategoryModel({
  series,
  cycle = null,
  prior = null,
  halfLifeDays = DEFAULT_HALF_LIFE_DAYS,
} = {}) {
  const { amounts, dayCount, start } = series;
  const pooled = prior || {
    wetRate: 0.25, p01: 0.25, p11: 0.4, logMu: Math.log(20), logSigma: 0.9,
  };

  const decay = Math.log(2) / Math.max(1, halfLifeDays);
  const weightAt = index => Math.exp(-decay * (dayCount - 1 - index));

  const c01 = new Float64Array(DOW_BUCKETS);
  const n01 = new Float64Array(DOW_BUCKETS);
  const c11 = new Float64Array(DOW_BUCKETS);
  const n11 = new Float64Array(DOW_BUCKETS);
  const phaseWet = new Float64Array(CYCLE_PHASES);
  const phaseAll = new Float64Array(CYCLE_PHASES);

  let catC01 = 0;
  let catN01 = 0;
  let catC11 = 0;
  let catN11 = 0;
  let wetDays = 0;
  let wetWeight = 0;
  let allWeight = 0;

  const severitySamples = [];
  const severityWeights = [];

  for (let i = 0; i < dayCount; i += 1) {
    const weight = weightAt(i);
    const wet = amounts[i] > 0;
    const date = addDays(start, i);
    const phase = cyclePhase(date, cycle);

    allWeight += weight;
    phaseAll[phase] += weight;
    if (wet) {
      wetDays += 1;
      wetWeight += weight;
      phaseWet[phase] += weight;
      severitySamples.push(amounts[i]);
      severityWeights.push(weight);
    }

    if (i === 0) continue;
    const dow = getDay(date);
    if (amounts[i - 1] > 0) {
      n11[dow] += weight;
      catN11 += weight;
      if (wet) {
        c11[dow] += weight;
        catC11 += weight;
      }
    } else {
      n01[dow] += weight;
      catN01 += weight;
      if (wet) {
        c01[dow] += weight;
        catC01 += weight;
      }
    }
  }

  // Category level, shrunk toward the pooled prior.
  const catP01 = (catC01 + CATEGORY_SHRINKAGE * pooled.p01) / (catN01 + CATEGORY_SHRINKAGE);
  const catP11 = (catC11 + CATEGORY_SHRINKAGE * pooled.p11) / (catN11 + CATEGORY_SHRINKAGE);

  // Cycle-phase multipliers on the occurrence rate, heavily shrunk toward 1.
  const baseWetRate = allWeight > 0 ? wetWeight / allWeight : pooled.wetRate;
  const phaseMultiplier = new Float64Array(CYCLE_PHASES).fill(1);
  if (baseWetRate > 0) {
    for (let phase = 0; phase < CYCLE_PHASES; phase += 1) {
      if (phaseAll[phase] <= 0) continue;
      const ratio = (phaseWet[phase] / phaseAll[phase]) / baseWetRate;
      const shrunk = (phaseAll[phase] * ratio + PHASE_SHRINKAGE) / (phaseAll[phase] + PHASE_SHRINKAGE);
      phaseMultiplier[phase] = Math.min(2, Math.max(0.5, shrunk));
    }
  }

  // Thresholds live in z-space so the simulator never calls a CDF in its hot loop.
  // Layout: [state][dow][phase], state 0 = previous day dry, 1 = previous day wet.
  const thresholds = new Float64Array(2 * DOW_BUCKETS * CYCLE_PHASES);
  for (let dow = 0; dow < DOW_BUCKETS; dow += 1) {
    const p01Dow = (c01[dow] + DOW_SHRINKAGE * catP01) / (n01[dow] + DOW_SHRINKAGE);
    const p11Dow = (c11[dow] + DOW_SHRINKAGE * catP11) / (n11[dow] + DOW_SHRINKAGE);
    for (let phase = 0; phase < CYCLE_PHASES; phase += 1) {
      const multiplier = phaseMultiplier[phase];
      const p01Final = Math.min(P_MAX, Math.max(P_MIN, p01Dow * multiplier));
      const p11Final = Math.min(P_MAX, Math.max(P_MIN, p11Dow * multiplier));
      thresholds[(0 * DOW_BUCKETS + dow) * CYCLE_PHASES + phase] = probit(p01Final);
      thresholds[(1 * DOW_BUCKETS + dow) * CYCLE_PHASES + phase] = probit(p11Final);
    }
  }

  const severity = buildSeverity(severitySamples, severityWeights, pooled);

  let confidence = 'ok';
  if (dayCount < MIN_HISTORY_DAYS || wetDays < MIN_SPEND_DAYS) confidence = 'none';
  else if (dayCount < 60 || wetDays < SEVERITY_EMPIRICAL_MIN) confidence = 'low';

  return {
    thresholds,
    severity,
    phaseMultiplier,
    observedDays: dayCount,
    wetDays,
    wetRate: baseWetRate,
    lastStateWet: dayCount > 0 && amounts[dayCount - 1] > 0,
    meanDailySpend: allWeight > 0
      ? amounts.reduce((sum, value) => sum + value, 0) / Math.max(1, dayCount)
      : 0,
    confidence,
  };
}

/**
 * The amount drawn on a spend day, modelled as the *daily total* rather than a
 * per-transaction amount — occurrence plus severity then reconstructs the
 * observed daily series exactly.
 *
 * Empirical resampling once there are enough spend days to have seen the
 * shape; a recency-weighted log-normal below that, because bootstrapping six
 * days just replays those six days forever.
 */
function buildSeverity(samples, weights, pooled) {
  const count = samples.length;

  if (count >= SEVERITY_EMPIRICAL_MIN) {
    const cumulative = new Float64Array(count);
    const values = Float64Array.from(samples);
    let running = 0;
    for (let i = 0; i < count; i += 1) {
      running += weights[i];
      cumulative[i] = running;
    }
    return { kind: 'empirical', values, cumulative, totalWeight: running, count };
  }

  let weightSum = 0;
  let logSum = 0;
  for (let i = 0; i < count; i += 1) {
    weightSum += weights[i];
    logSum += weights[i] * Math.log(Math.max(0.01, samples[i]));
  }

  // Shrink both moments toward the pooled prior — with four observations the
  // sample variance is noise, and an over-tight sigma produces a confidently
  // wrong band.
  const shrinkage = 6;
  const sampleMu = weightSum > 0 ? logSum / weightSum : pooled.logMu;
  const logMu = (weightSum * sampleMu + shrinkage * pooled.logMu) / (weightSum + shrinkage);

  let variance = 0;
  if (count >= 2 && weightSum > 0) {
    let acc = 0;
    for (let i = 0; i < count; i += 1) {
      acc += weights[i] * (Math.log(Math.max(0.01, samples[i])) - sampleMu) ** 2;
    }
    variance = acc / weightSum;
  }
  const sampleSigma = count >= 2 ? Math.sqrt(variance) : pooled.logSigma;
  const logSigma = Math.max(0.2, (weightSum * sampleSigma + shrinkage * pooled.logSigma) / (weightSum + shrinkage));

  const observedMax = count > 0 ? Math.max(...samples) : Math.exp(pooled.logMu);
  return {
    kind: 'lognormal',
    logMu,
    logSigma,
    // Without a cap the log-normal tail occasionally invents a £40,000 Tuesday.
    cap: Math.max(observedMax * 3, Math.exp(logMu + 3 * logSigma)),
    count,
  };
}

function drawSeverity(severity, rng, normal) {
  if (severity.kind === 'empirical') {
    const target = rng() * severity.totalWeight;
    const { cumulative } = severity;
    let low = 0;
    let high = cumulative.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (cumulative[mid] < target) low = mid + 1;
      else high = mid;
    }
    return severity.values[low];
  }
  return Math.min(severity.cap, Math.exp(severity.logMu + severity.logSigma * normal()));
}

// ── Simulation ───────────────────────────────────────────────────────────────

/**
 * Run the Monte Carlo.
 *
 * Categories are coupled through a Gaussian copula: each day draws one shared
 * standard normal plus one per category, blended as
 * `z = √ρ·z_shared + √(1−ρ)·z_own`, which stays exactly standard normal so
 * every category's marginal behaviour is untouched while the *aggregate* picks
 * up the correlation a real expensive weekend has.
 *
 * Storage is deliberately asymmetric. Per-day *quantiles* are kept only for the
 * aggregate (one sims × days matrix); per category only the horizon total and a
 * running per-day mean. Keeping the full sims × days × categories cube would
 * cost megabytes to answer a question nothing asks — and the per-category
 * per-day *median* would be £0 for most categories anyway, since on any given
 * day most categories are not spent in at all. The mean is the statistic that
 * carries information at that resolution.
 */
export function simulateSpend({
  models = [],
  horizonDays = DEFAULT_HORIZON_DAYS,
  sims = DEFAULT_SIMS,
  startDate = new Date(),
  cycles = null,
  rng = makeRng(1),
  correlation = DEFAULT_CORRELATION,
  horizonByCategory = null,
} = {}) {
  const days = Math.max(1, Math.floor(horizonDays));
  const runs = Math.max(1, Math.floor(sims));
  const count = models.length;
  const normal = makeNormalDraw(rng);

  const rho = Math.min(0.95, Math.max(0, correlation));
  const sharedWeight = Math.sqrt(rho);
  const ownWeight = Math.sqrt(1 - rho);

  const start = startOfDay(startDate);

  // Day-of-week and cycle phase per horizon day, per category. Precomputed so
  // the inner loop is arithmetic only.
  const bucketOffsets = new Int32Array(count * days);
  for (let c = 0; c < count; c += 1) {
    const cycle = cycles ? cycles[c] : null;
    for (let d = 0; d < days; d += 1) {
      const date = addDays(start, d);
      bucketOffsets[c * days + d] = getDay(date) * CYCLE_PHASES + cyclePhase(date, cycle);
    }
  }

  const cumulative = new Float64Array(runs * days);
  const categoryTotals = [];
  const categoryDaily = [];
  for (let c = 0; c < count; c += 1) {
    categoryTotals.push(new Float64Array(runs));
    categoryDaily.push(new Float64Array(days));
  }

  const stateWet = new Uint8Array(count);
  const wetBase = DOW_BUCKETS * CYCLE_PHASES;

  // Each category can stop accumulating at its own day — budget cycles end on
  // different dates, so "what will I have spent by the end of this cycle" is a
  // different horizon per category. The chain still runs the full length so the
  // Markov state stays correct; only the tallying stops.
  const stopAt = new Int32Array(count);
  for (let c = 0; c < count; c += 1) {
    const limit = horizonByCategory ? Math.floor(horizonByCategory[c]) : days;
    stopAt[c] = Math.max(0, Math.min(days, Number.isFinite(limit) ? limit : days));
  }

  for (let sim = 0; sim < runs; sim += 1) {
    for (let c = 0; c < count; c += 1) stateWet[c] = models[c].lastStateWet ? 1 : 0;
    let running = 0;

    for (let d = 0; d < days; d += 1) {
      const shared = normal();
      let dayTotal = 0;

      for (let c = 0; c < count; c += 1) {
        const model = models[c];
        const z = sharedWeight * shared + ownWeight * normal();
        const offset = (stateWet[c] ? wetBase : 0) + bucketOffsets[c * days + d];
        const wet = z < model.thresholds[offset];
        stateWet[c] = wet ? 1 : 0;
        if (!wet) continue;
        const amount = drawSeverity(model.severity, rng, normal);
        if (d >= stopAt[c]) continue;
        dayTotal += amount;
        categoryTotals[c][sim] += amount;
        categoryDaily[c][d] += amount;
      }

      running += dayTotal;
      cumulative[sim * days + d] = running;
    }
  }

  // Quantiles per horizon day, over the cumulative paths.
  const scratch = new Float64Array(runs);
  const daily = [];
  for (let d = 0; d < days; d += 1) {
    for (let sim = 0; sim < runs; sim += 1) scratch[sim] = cumulative[sim * days + d];
    const sorted = scratch.slice().sort();
    let sum = 0;
    for (let sim = 0; sim < runs; sim += 1) sum += scratch[sim];
    daily.push({
      p10: quantileSorted(sorted, 0.1),
      p50: quantileSorted(sorted, 0.5),
      p90: quantileSorted(sorted, 0.9),
      mean: sum / runs,
    });
  }

  for (const daily of categoryDaily) {
    for (let d = 0; d < days; d += 1) daily[d] /= runs;
  }

  const byCategory = categoryTotals.map(totals => {
    const sorted = totals.slice().sort();
    let sum = 0;
    for (let sim = 0; sim < runs; sim += 1) sum += totals[sim];
    return {
      p10: quantileSorted(sorted, 0.1),
      p50: quantileSorted(sorted, 0.5),
      p90: quantileSorted(sorted, 0.9),
      mean: sum / runs,
    };
  });

  const totalSorted = new Float64Array(runs);
  for (let sim = 0; sim < runs; sim += 1) totalSorted[sim] = cumulative[sim * days + (days - 1)];
  let totalSum = 0;
  for (let sim = 0; sim < runs; sim += 1) totalSum += totalSorted[sim];
  const sortedTotals = totalSorted.slice().sort();

  return {
    daily,
    byCategory,
    byCategoryDaily: categoryDaily,
    // Raw per-sim totals, so callers can ask questions quantiles cannot answer
    // — "what fraction of futures blow the allowance?" chief among them.
    byCategorySamples: categoryTotals,
    total: {
      p10: quantileSorted(sortedTotals, 0.1),
      p50: quantileSorted(sortedTotals, 0.5),
      p90: quantileSorted(sortedTotals, 0.9),
      mean: totalSum / runs,
    },
    sims: runs,
    horizonDays: days,
  };
}

// ── Deterministic layer ──────────────────────────────────────────────────────

/**
 * Walk active subscriptions onto the horizon.
 *
 * These are not predicted — the dates and amounts are already known. Because
 * `buildDailySeries` drops subscription-generated transactions from the fit,
 * adding them back here cannot double-count.
 */
export function projectSubscriptions(subscriptions = [], { from = new Date(), days = DEFAULT_HORIZON_DAYS } = {}) {
  const start = startOfDay(from);
  const end = addDays(start, days);
  const items = [];
  const byCategory = new Map();
  const byCategoryDay = new Map();
  const byDay = new Float64Array(days);
  let total = 0;

  for (const sub of subscriptions) {
    if (sub?.active === false) continue;
    const amount = Math.abs(Number(sub?.amount) || 0);
    if (amount <= 0) continue;

    let next = toValidDate(sub?.nextDueAt);
    if (!next) continue;
    next = startOfDay(next);

    const unit = sub.intervalUnit || 'month';
    const interval = Math.max(1, Number(sub.interval) || 1);

    let guard = 0;
    while (next < start && guard < 480) {
      next = startOfDay(addRecurringInterval(next, unit, interval));
      guard += 1;
    }

    guard = 0;
    while (next < end && guard < 480) {
      const dayIndex = differenceInDays(next, start);
      if (dayIndex >= 0 && dayIndex < days) {
        byDay[dayIndex] += amount;
        items.push({
          date: format(next, 'yyyy-MM-dd'),
          dayIndex,
          name: sub.name || 'Subscription',
          amount: roundMoney(amount),
          categoryId: sub.categoryId != null ? Number(sub.categoryId) : null,
        });
        total += amount;
        const key = sub.categoryId != null ? Number(sub.categoryId) : null;
        byCategory.set(key, (byCategory.get(key) || 0) + amount);
        if (!byCategoryDay.has(key)) byCategoryDay.set(key, new Float64Array(days));
        byCategoryDay.get(key)[dayIndex] += amount;
      }
      next = startOfDay(addRecurringInterval(next, unit, interval));
      guard += 1;
    }
  }

  items.sort((a, b) => a.dayIndex - b.dayIndex);
  return { total: roundMoney(total), items, byCategory, byCategoryDay, byDay };
}

// ── Public entry point ───────────────────────────────────────────────────────

/** History older than this contributes almost nothing after decay anyway. */
const MAX_HISTORY_DAYS = 730;

/**
 * Fit every category against a shared history window and pooled prior.
 *
 * Shared by the horizon forecast and the end-of-cycle projection so the two
 * can never disagree about what the model thinks — they differ only in how far
 * forward they tally, not in what they learned.
 */
export function fitAccountModels({
  transactions = [],
  categories = [],
  incomes = [],
  settings = null,
  halfLifeDays = DEFAULT_HALF_LIFE_DAYS,
  now = new Date(),
} = {}) {
  const today = startOfDay(now);
  const spine = buildDailySeries(transactions, { to: today });
  const cappedStart = spine.dayCount > MAX_HISTORY_DAYS
    ? addDays(today, -(MAX_HISTORY_DAYS - 1))
    : spine.start;
  const observedDays = Math.max(0, differenceInDays(today, cappedStart) + 1);

  if (!categories.length) {
    return { ready: false, reason: 'no-categories', observedDays, modelled: [], skipped: [] };
  }
  if (observedDays < MIN_HISTORY_DAYS) {
    return {
      ready: false,
      reason: `Needs about ${MIN_HISTORY_DAYS} days of history — there are ${observedDays}.`,
      observedDays,
      modelled: [],
      skipped: [],
    };
  }

  const seriesByCategory = categories.map(category => buildDailySeries(transactions, {
    categoryId: category.id,
    from: cappedStart,
    to: today,
  }));
  const prior = buildPooledPrior(seriesByCategory);
  const cycles = categories.map(category => getCategoryCycle(category, incomes, settings, now));

  const modelled = [];
  const skipped = [];
  categories.forEach((category, index) => {
    const model = fitCategoryModel({
      series: seriesByCategory[index],
      cycle: cycles[index],
      prior,
      halfLifeDays,
    });
    // A category that has never been spent in has nothing to predict. Letting
    // the pooled prior speak for it would invent spending with no basis.
    if (model.wetDays < 1) skipped.push({ category, model, cycle: cycles[index] });
    else modelled.push({ category, model, cycle: cycles[index] });
  });

  if (!modelled.length) {
    return { ready: false, reason: 'No category has any spending history yet.', observedDays, modelled, skipped };
  }

  return { ready: true, reason: null, observedDays, modelled, skipped };
}

/** Stable seed derived from the data the forecast describes. */
function seedFor(transactions, ...parts) {
  const digest = transactions.reduce(
    (acc, tx) => acc + (Number(tx?.id) || 0) + Math.round(Math.abs(Number(tx?.amount) || 0) * 100),
    transactions.length,
  );
  return hashSeed(...parts, transactions.length, digest);
}

/**
 * The whole pipeline: fit, simulate, add the deterministic layer, report.
 *
 * The forecast covers `horizonDays` starting *tomorrow* — history runs through
 * today inclusive, so today's already-logged spend is never both counted and
 * predicted, and today's wet/dry state is the correct Markov starting state.
 */
export function buildSpendPrediction({
  transactions = [],
  categories = [],
  incomes = [],
  subscriptions = [],
  settings = null,
  horizonDays = DEFAULT_HORIZON_DAYS,
  sims = DEFAULT_SIMS,
  halfLifeDays = DEFAULT_HALF_LIFE_DAYS,
  correlation = DEFAULT_CORRELATION,
  now = new Date(),
  seed = null,
} = {}) {
  const today = startOfDay(now);
  const forecastStart = addDays(today, 1);
  const days = Math.max(1, Math.floor(horizonDays));

  const fit = fitAccountModels({ transactions, categories, incomes, settings, halfLifeDays, now });
  const { observedDays, modelled, skipped } = fit;

  const subscriptionPlan = projectSubscriptions(subscriptions, { from: forecastStart, days });

  const empty = reason => ({
    ready: false,
    reason,
    observedDays,
    horizonDays: days,
    generatedAt: today.toISOString(),
    seed: 0,
    sims: 0,
    total: { p10: 0, p50: 0, p90: 0, mean: 0 },
    stochasticTotal: { p10: 0, p50: 0, p90: 0, mean: 0 },
    subscriptions: subscriptionPlan,
    series: [],
    categories: [],
  });

  if (!fit.ready) return empty(fit.reason);

  const resolvedSeed = seed != null
    ? (Number(seed) >>> 0)
    : seedFor(transactions, days, sims, format(today, 'yyyy-MM-dd'));

  const simulation = simulateSpend({
    models: modelled.map(entry => entry.model),
    cycles: modelled.map(entry => entry.cycle),
    horizonDays: days,
    sims,
    startDate: forecastStart,
    rng: makeRng(resolvedSeed),
    correlation,
  });

  // Subscriptions are a constant, so they shift the whole distribution rather
  // than widening it — add the running total to every quantile alike.
  let runningSubs = 0;
  const series = simulation.daily.map((point, index) => {
    runningSubs += subscriptionPlan.byDay[index] || 0;
    const date = addDays(forecastStart, index);
    return {
      date: format(date, 'yyyy-MM-dd'),
      label: format(date, 'd MMM'),
      p10: roundMoney(point.p10 + runningSubs),
      p50: roundMoney(point.p50 + runningSubs),
      p90: roundMoney(point.p90 + runningSubs),
      mean: roundMoney(point.mean + runningSubs),
      // Recharts draws a range Area straight from a [low, high] tuple.
      band: [roundMoney(point.p10 + runningSubs), roundMoney(point.p90 + runningSubs)],
      subscriptions: roundMoney(runningSubs),
    };
  });

  const categoryRows = modelled.map((entry, index) => {
    const stochastic = simulation.byCategory[index];
    const categoryId = Number(entry.category.id);
    const subs = subscriptionPlan.byCategory.get(categoryId) || 0;
    // Expected spend on each day of the horizon, deterministic charges
    // included, so a subscription shows up as the spike it actually is.
    const subsByDay = subscriptionPlan.byCategoryDay.get(categoryId);
    const stochasticDaily = simulation.byCategoryDaily[index];
    const daily = [];
    let runningDaily = 0;
    const cumulative = [];
    for (let d = 0; d < days; d += 1) {
      const value = roundMoney(stochasticDaily[d] + (subsByDay ? subsByDay[d] : 0));
      daily.push(value);
      runningDaily = roundMoney(runningDaily + value);
      cumulative.push(runningDaily);
    }
    return {
      daily,
      cumulative,
      id: entry.category.id,
      name: entry.category.name,
      color: entry.category.color,
      p10: roundMoney(stochastic.p10 + subs),
      p50: roundMoney(stochastic.p50 + subs),
      p90: roundMoney(stochastic.p90 + subs),
      mean: roundMoney(stochastic.mean + subs),
      subscriptions: roundMoney(subs),
      allowance: Number(entry.category.allowance) || 0,
      confidence: entry.model.confidence,
      observedDays: entry.model.observedDays,
      wetDays: entry.model.wetDays,
    };
  }).sort((a, b) => b.p50 - a.p50);

  for (const entry of skipped) {
    const categoryId = Number(entry.category.id);
    const subs = subscriptionPlan.byCategory.get(categoryId) || 0;
    if (subs <= 0) continue;
    const subsByDay = subscriptionPlan.byCategoryDay.get(categoryId);
    const daily = [];
    const cumulative = [];
    let running = 0;
    for (let d = 0; d < days; d += 1) {
      const value = roundMoney(subsByDay ? subsByDay[d] : 0);
      daily.push(value);
      running = roundMoney(running + value);
      cumulative.push(running);
    }
    // No spend history, but a subscription still lands here — report the
    // deterministic part with a zero-width band, because that part is known.
    categoryRows.push({
      daily,
      cumulative,
      id: entry.category.id,
      name: entry.category.name,
      color: entry.category.color,
      p10: roundMoney(subs),
      p50: roundMoney(subs),
      p90: roundMoney(subs),
      mean: roundMoney(subs),
      subscriptions: roundMoney(subs),
      allowance: Number(entry.category.allowance) || 0,
      confidence: 'none',
      observedDays: entry.model.observedDays,
      wetDays: 0,
    });
  }

  const unassignedSubs = subscriptionPlan.byCategory.get(null) || 0;
  const total = {
    p10: roundMoney(simulation.total.p10 + subscriptionPlan.total),
    p50: roundMoney(simulation.total.p50 + subscriptionPlan.total),
    p90: roundMoney(simulation.total.p90 + subscriptionPlan.total),
    mean: roundMoney(simulation.total.mean + subscriptionPlan.total),
  };

  return {
    ready: true,
    reason: null,
    observedDays,
    horizonDays: days,
    generatedAt: today.toISOString(),
    seed: resolvedSeed,
    sims: simulation.sims,
    from: format(forecastStart, 'yyyy-MM-dd'),
    to: format(addDays(forecastStart, days - 1), 'yyyy-MM-dd'),
    total,
    stochasticTotal: {
      p10: roundMoney(simulation.total.p10),
      p50: roundMoney(simulation.total.p50),
      p90: roundMoney(simulation.total.p90),
      mean: roundMoney(simulation.total.mean),
    },
    subscriptions: { ...subscriptionPlan, unassigned: roundMoney(unassignedSubs) },
    series,
    categories: categoryRows,
  };
}

/**
 * Where each category lands by the end of its *own* budget cycle.
 *
 * This is the question the app exists to answer — "am I going to blow this
 * budget?" — answered with a range and an explicit probability rather than a
 * straight-line extrapolation of the current burn rate.
 *
 * Every category is simulated to its own cycle end, because a weekly-funded
 * category and a monthly-funded one do not share a deadline. The simulator
 * runs the whole chain and simply stops tallying each category at its own day,
 * which keeps the cross-category correlation intact.
 */
export function buildCycleProjection({
  transactions = [],
  categories = [],
  incomes = [],
  subscriptions = [],
  settings = null,
  sims = DEFAULT_SIMS,
  halfLifeDays = DEFAULT_HALF_LIFE_DAYS,
  correlation = DEFAULT_CORRELATION,
  now = new Date(),
  seed = null,
} = {}) {
  const today = startOfDay(now);
  const forecastStart = addDays(today, 1);

  const fit = fitAccountModels({ transactions, categories, incomes, settings, halfLifeDays, now });
  if (!fit.ready) {
    return { ready: false, reason: fit.reason, observedDays: fit.observedDays, categories: [] };
  }

  const { modelled } = fit;
  const remaining = modelled.map(entry => Math.max(0, Math.min(400, entry.cycle?.remaining ?? 0)));
  const horizon = Math.max(1, ...remaining);
  const plan = projectSubscriptions(subscriptions, { from: forecastStart, days: horizon });

  const resolvedSeed = seed != null
    ? (Number(seed) >>> 0)
    : seedFor(transactions, 'cycle', sims, format(today, 'yyyy-MM-dd'));

  const simulation = simulateSpend({
    models: modelled.map(entry => entry.model),
    cycles: modelled.map(entry => entry.cycle),
    horizonDays: horizon,
    sims,
    startDate: forecastStart,
    rng: makeRng(resolvedSeed),
    correlation,
    horizonByCategory: remaining,
  });

  const rows = modelled.map((entry, index) => {
    const { category } = entry;
    const categoryId = Number(category.id);
    // Effective, not base: a temporary boost or a rollover balance is real
    // money this cycle, and comparing against the base allowance would flag an
    // overspend that isn't one.
    const allowance = roundMoney(getEffectiveAllowance(category));
    const spent = roundMoney(Number(category.spent) || 0);

    const subsByDay = plan.byCategoryDay.get(categoryId);
    let subs = 0;
    if (subsByDay) for (let day = 0; day < remaining[index]; day += 1) subs += subsByDay[day];
    subs = roundMoney(subs);

    const band = simulation.byCategory[index];
    const samples = simulation.byCategorySamples[index];
    const project = value => roundMoney(spent + subs + value);

    // How much discretionary room is left before the allowance is gone; the
    // share of simulated futures that exceed it is the overspend risk.
    const headroom = allowance - spent - subs;
    let over = 0;
    for (let i = 0; i < samples.length; i += 1) if (samples[i] > headroom) over += 1;

    return {
      id: category.id,
      name: category.name,
      color: category.color,
      allowance,
      spent,
      subscriptions: subs,
      remainingDays: remaining[index],
      cycleEnd: entry.cycle?.end ? format(entry.cycle.end, 'yyyy-MM-dd') : null,
      p10: project(band.p10),
      p50: project(band.p50),
      p90: project(band.p90),
      mean: project(band.mean),
      dailyMean: remaining[index] > 0 ? roundMoney(band.mean / remaining[index]) : 0,
      overspendRisk: samples.length ? Math.round((over / samples.length) * 100) / 100 : 0,
    };
  });

  return {
    ready: true,
    reason: null,
    observedDays: fit.observedDays,
    seed: resolvedSeed,
    sims: simulation.sims,
    categories: rows.sort((a, b) => b.overspendRisk - a.overspendRisk || b.p50 - a.p50),
  };
}

// ── Backtesting ──────────────────────────────────────────────────────────────

/**
 * Probabilistic seasonal-naive baseline: "the next 30 days will look like some
 * previous 30 days". Quantiles come from every rolling window in the history,
 * so the baseline gets a fair interval rather than being handicapped to a
 * point estimate the pinball loss would punish.
 */
export function baselineForecast(series, horizonDays) {
  const { amounts, dayCount } = series;
  const windows = [];
  for (let start = 0; start + horizonDays <= dayCount; start += 1) {
    let sum = 0;
    for (let i = start; i < start + horizonDays; i += 1) sum += amounts[i];
    windows.push(sum);
  }
  if (!windows.length) {
    let sum = 0;
    for (let i = 0; i < dayCount; i += 1) sum += amounts[i];
    const scaled = dayCount > 0 ? (sum / dayCount) * horizonDays : 0;
    return { p10: scaled, p50: scaled, p90: scaled, mean: scaled, windows: 0 };
  }
  const sorted = Float64Array.from(windows).sort();
  return {
    p10: quantileSorted(sorted, 0.1),
    p50: quantileSorted(sorted, 0.5),
    p90: quantileSorted(sorted, 0.9),
    mean: windows.reduce((sum, value) => sum + value, 0) / windows.length,
    windows: windows.length,
  };
}

function scoreFold(actual, forecast) {
  const losses = QUANTILES.map(q => pinballLoss(actual, forecast[`p${Math.round(q * 100)}`], q));
  return {
    pinball: losses.reduce((sum, value) => sum + value, 0) / losses.length,
    absoluteError: Math.abs(actual - forecast.p50),
    covered: actual >= forecast.p10 && actual <= forecast.p90,
  };
}

/**
 * Walk-forward backtest against the user's own history.
 *
 * This is the part that decides whether the feature is worth having. Two
 * numbers matter:
 *
 *   - **pinball loss** vs. the naive baseline. If the simulator cannot beat
 *     "repeat last month", ship the baseline and delete this file.
 *   - **coverage** — does the P10–P90 band actually contain the truth about
 *     80% of the time? A band catching 40% is actively lying to the user, and
 *     you would never notice it by eyeballing a chart.
 *
 * Subscriptions are excluded from both sides. Their projection depends on
 * `nextDueAt`, which is present-day state, so including them would leak the
 * future into a historical fold and flatter the result.
 */
export function backtestPrediction({
  transactions = [],
  categories = [],
  incomes = [],
  settings = null,
  horizonDays = DEFAULT_HORIZON_DAYS,
  folds = 6,
  sims = 400,
  minHistoryDays = 60,
  halfLifeDays = DEFAULT_HALF_LIFE_DAYS,
  correlation = DEFAULT_CORRELATION,
  now = new Date(),
  seed = 987654321,
} = {}) {
  const today = startOfDay(now);
  const horizon = Math.max(1, Math.floor(horizonDays));
  const spine = buildDailySeries(transactions, { to: today });

  const results = [];
  const skippedFolds = [];

  for (let fold = 0; fold < folds; fold += 1) {
    const cutoff = addDays(today, -((folds - fold) * horizon));
    const historyEnd = addDays(cutoff, -1);
    const historyDays = differenceInDays(historyEnd, spine.start) + 1;

    if (historyDays < minHistoryDays) {
      skippedFolds.push({ cutoff: format(cutoff, 'yyyy-MM-dd'), reason: 'insufficient-history', historyDays });
      continue;
    }

    const historyTransactions = transactions.filter(tx => {
      const date = toValidDate(tx?.date);
      return date && startOfDay(date) <= historyEnd;
    });

    const seriesByCategory = categories.map(category => buildDailySeries(historyTransactions, {
      categoryId: category.id,
      from: spine.start,
      to: historyEnd,
    }));
    const prior = buildPooledPrior(seriesByCategory);

    const modelled = [];
    categories.forEach((category, index) => {
      const model = fitCategoryModel({
        series: seriesByCategory[index],
        cycle: getCategoryCycle(category, incomes, settings, cutoff),
        prior,
        halfLifeDays,
      });
      if (model.wetDays >= 1) {
        modelled.push({ model, cycle: getCategoryCycle(category, incomes, settings, cutoff) });
      }
    });

    if (!modelled.length) {
      skippedFolds.push({ cutoff: format(cutoff, 'yyyy-MM-dd'), reason: 'no-modelled-categories', historyDays });
      continue;
    }

    const simulation = simulateSpend({
      models: modelled.map(entry => entry.model),
      cycles: modelled.map(entry => entry.cycle),
      horizonDays: horizon,
      sims,
      startDate: cutoff,
      rng: makeRng(hashSeed(seed, fold)),
      correlation,
    });

    const windowEnd = addDays(cutoff, horizon);
    let actual = 0;
    for (const tx of transactions) {
      if (tx?.subscriptionRunKey) continue;
      if (isRefund(tx)) continue;
      const date = toValidDate(tx?.date);
      if (!date) continue;
      const day = startOfDay(date);
      if (day >= cutoff && day < windowEnd) actual += getSignedAmount(tx);
    }

    const historySpine = buildDailySeries(historyTransactions, { from: spine.start, to: historyEnd });
    const baseline = baselineForecast(historySpine, horizon);

    const model = scoreFold(actual, simulation.total);
    const naive = scoreFold(actual, baseline);

    results.push({
      cutoff: format(cutoff, 'yyyy-MM-dd'),
      historyDays,
      actual: roundMoney(actual),
      model: {
        p10: roundMoney(simulation.total.p10),
        p50: roundMoney(simulation.total.p50),
        p90: roundMoney(simulation.total.p90),
        ...model,
      },
      baseline: {
        p10: roundMoney(baseline.p10),
        p50: roundMoney(baseline.p50),
        p90: roundMoney(baseline.p90),
        ...naive,
      },
    });
  }

  const summarise = key => {
    if (!results.length) return { pinball: 0, coverage: 0, mae: 0, mape: 0 };
    const pinball = results.reduce((sum, row) => sum + row[key].pinball, 0) / results.length;
    const coverage = results.filter(row => row[key].covered).length / results.length;
    const mae = results.reduce((sum, row) => sum + row[key].absoluteError, 0) / results.length;
    const scored = results.filter(row => row.actual > 0);
    const mape = scored.length
      ? scored.reduce((sum, row) => sum + row[key].absoluteError / row.actual, 0) / scored.length
      : 0;
    return {
      pinball: roundMoney(pinball),
      coverage: Math.round(coverage * 100) / 100,
      mae: roundMoney(mae),
      mape: Math.round(mape * 1000) / 1000,
    };
  };

  const model = summarise('model');
  const baseline = summarise('baseline');

  return {
    horizonDays: horizon,
    foldsRequested: folds,
    foldsScored: results.length,
    skippedFolds,
    folds: results,
    model,
    baseline,
    // > 0 means the simulator beat "repeat last month"; <= 0 means ship the baseline.
    skill: baseline.pinball > 0
      ? Math.round((1 - model.pinball / baseline.pinball) * 1000) / 1000
      : 0,
    // Target 0.8. Materially below means the band is too tight to trust.
    coverageTarget: 0.8,
  };
}
