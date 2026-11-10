// Progressive-delivery simulator with automated canary analysis. Pure, deterministic per seed.
import { rng, normal, binomial, fisherExactGreater, mannWhitney, quantile } from './stats.js';

export const DEFAULT_STEPS = Object.freeze([
  { weight: 0.01, bakeMin: 10 },
  { weight: 0.05, bakeMin: 10 },
  { weight: 0.25, bakeMin: 15 },
  { weight: 0.5, bakeMin: 15 },
  { weight: 1, bakeMin: 0 },
]);

export const DEFAULT_CONFIG = Object.freeze({
  seed: 42,
  requestsPerMin: 3000,
  baselineErrorRate: 0.005,
  baselineLatencyMs: 120, // median
  latencySigma: 0.35, // lognormal shape
  canaryErrorRate: 0.005,
  canaryLatencyMultiplier: 1,
  steps: DEFAULT_STEPS,
  analysisIntervalMin: 5,
  alpha: 0.01, // family-wise, split across every look and both metrics (Bonferroni)
  minErrorDelta: 0.002, // practical significance: +0.2 percentage points
  maxLatencyRatio: 1.1, // practical significance: canary p50 more than 10% slower
  latencySamplesPerMin: 120,
});

function validate(cfg) {
  const problems = [];
  if (!(cfg.requestsPerMin >= 10 && cfg.requestsPerMin <= 1e6)) problems.push('requestsPerMin must be 10..1,000,000');
  for (const k of ['baselineErrorRate', 'canaryErrorRate']) if (!(cfg[k] >= 0 && cfg[k] < 1)) problems.push(`${k} must be in [0, 1)`);
  if (!(cfg.canaryLatencyMultiplier > 0 && cfg.canaryLatencyMultiplier <= 20)) problems.push('canaryLatencyMultiplier must be in (0, 20]');
  if (!(cfg.alpha > 0 && cfg.alpha < 0.5)) problems.push('alpha must be in (0, 0.5)');
  if (!Array.isArray(cfg.steps) || cfg.steps.length < 1 || cfg.steps.length > 12) problems.push('steps must have 1-12 entries');
  else {
    let prev = 0;
    for (const s of cfg.steps) {
      if (!(s.weight > prev && s.weight <= 1)) problems.push('step weights must strictly increase within (0, 1]');
      if (!(s.bakeMin >= 0 && s.bakeMin <= 240)) problems.push('bakeMin must be 0..240');
      prev = s.weight;
    }
    if (cfg.steps[cfg.steps.length - 1].weight !== 1) problems.push('last step must be weight 1 (100%)');
  }
  if (problems.length) throw new RangeError(problems.join('; '));
}

/** Total number of analysis looks across the rollout, used for the Bonferroni correction. */
export function countLooks(steps, interval) {
  return steps.reduce((n, s) => n + (s.weight < 1 && s.bakeMin > 0 ? Math.ceil(s.bakeMin / interval) : 0), 0);
}

/** Runs one rollout. Returns the decision, the timeline and an exposure comparison. */
export function simulate(userConfig = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...userConfig };
  validate(cfg);
  const rand = rng(cfg.seed);
  const looks = Math.max(1, countLooks(cfg.steps, cfg.analysisIntervalMin));
  const alphaPerTest = cfg.alpha / (looks * 2);
  const mu = Math.log(cfg.baselineLatencyMs);
  const latency = (mult) => Math.exp(mu + Math.log(mult) + cfg.latencySigma * normal(rand));

  const timeline = [];
  const events = [];
  let minute = 0;
  let canaryRequests = 0, canaryErrors = 0;
  let decision = 'promoted';
  let failedCheck = null;

  outer: for (let si = 0; si < cfg.steps.length; si++) {
    const step = cfg.steps[si];
    events.push({ minute, type: 'step', weight: step.weight, message: `Shift ${Math.round(step.weight * 1000) / 10}% of traffic to canary` });
    if (step.weight >= 1) break;
    const acc = { bN: 0, bE: 0, cN: 0, cE: 0, bLat: [], cLat: [] };
    for (let m = 1; m <= step.bakeMin; m++) {
      const cN = Math.round(cfg.requestsPerMin * step.weight);
      const bN = cfg.requestsPerMin - cN;
      const cE = binomial(rand, cN, cfg.canaryErrorRate);
      const bE = binomial(rand, bN, cfg.baselineErrorRate);
      acc.bN += bN; acc.bE += bE; acc.cN += cN; acc.cE += cE;
      const k = cfg.latencySamplesPerMin;
      for (let i = 0; i < Math.min(k, bN); i++) acc.bLat.push(latency(1));
      for (let i = 0; i < Math.min(k, cN); i++) acc.cLat.push(latency(cfg.canaryLatencyMultiplier));
      canaryRequests += cN;
      canaryErrors += cE;
      minute++;
      timeline.push({ minute, weight: step.weight, baselineErrRate: bN ? bE / bN : 0, canaryErrRate: cN ? cE / cN : 0 });

      if (m % cfg.analysisIntervalMin === 0 || m === step.bakeMin) {
        const err = fisherExactGreater(acc.bE, acc.bN, acc.cE, acc.cN);
        const errDelta = acc.cE / Math.max(1, acc.cN) - acc.bE / Math.max(1, acc.bN);
        const lat = mannWhitney(acc.bLat, acc.cLat);
        const p50b = quantile(acc.bLat, 0.5), p50c = quantile(acc.cLat, 0.5);
        const latRatio = p50c / p50b;
        const errFail = err.p < alphaPerTest && errDelta > cfg.minErrorDelta;
        const latFail = lat.p < alphaPerTest && latRatio > cfg.maxLatencyRatio;
        const check = {
          minute, weight: step.weight,
          errP: err.p, errDelta, latP: lat.p, latRatio,
          p99Baseline: quantile(acc.bLat, 0.99), p99Canary: quantile(acc.cLat, 0.99),
          canarySamples: acc.cN, pass: !(errFail || latFail),
          reason: errFail ? 'error rate regression' : latFail ? 'latency regression' : null,
        };
        events.push({ minute, type: 'analysis', check, message: check.pass ? 'Analysis passed' : `Analysis FAILED: ${check.reason}` });
        if (!check.pass) {
          decision = 'rolled-back';
          failedCheck = check;
          events.push({ minute, type: 'rollback', message: 'Automated rollback: 100% traffic to stable' });
          break outer;
        }
      }
    }
  }
  if (decision === 'promoted') events.push({ minute, type: 'promote', message: 'Canary promoted to 100%' });

  // Exposure comparison: an all-at-once deploy serves every request with the new version for the same wall-clock time.
  const allAtOnceRequests = cfg.requestsPerMin * minute;
  const extraErrorRate = Math.max(0, cfg.canaryErrorRate - cfg.baselineErrorRate);
  return {
    config: cfg,
    alphaPerTest,
    looks,
    decision,
    failedCheck,
    durationMin: minute,
    events,
    timeline,
    exposure: {
      canaryRequests,
      canaryErrors,
      excessErrors: Math.round(canaryRequests * extraErrorRate), // expected, so noise is not counted as harm
      allAtOnceRequests,
      allAtOnceExcessErrors: Math.round(allAtOnceRequests * extraErrorRate),
      exposureShare: allAtOnceRequests ? canaryRequests / allAtOnceRequests : 0,
    },
  };
}

/** Monte Carlo: how often does the analysis roll back across many seeds? */
export function monteCarlo(userConfig = {}, runs = 200, seed0 = 1000) {
  let rolledBack = 0;
  let detectMinutes = 0;
  for (let i = 0; i < runs; i++) {
    const r = simulate({ ...userConfig, seed: seed0 + i });
    if (r.decision === 'rolled-back') { rolledBack++; detectMinutes += r.durationMin; }
  }
  return { runs, rolledBack, rate: rolledBack / runs, meanMinutesToRollback: rolledBack ? detectMinutes / rolledBack : null };
}
