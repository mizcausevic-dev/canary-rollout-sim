import test from 'node:test';
import assert from 'node:assert/strict';
import { rng, normCdf, twoProportionTest, mannWhitney, quantile, binomial } from '../src/stats.js';
import { simulate, monteCarlo, countLooks, DEFAULT_STEPS } from '../src/rollout.js';

const close = (a, b, eps) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test('PRNG is deterministic per seed', () => {
  const a = rng(7), b = rng(7), c = rng(8);
  const xa = [a(), a(), a()], xb = [b(), b(), b()];
  assert.deepEqual(xa, xb);
  assert.notEqual(xa[0], c());
});

test('normal CDF matches known values', () => {
  close(normCdf(0), 0.5, 1e-7);
  close(normCdf(1.959964), 0.975, 1e-6);
  close(normCdf(-2.326348), 0.01, 1e-6);
});

test('two-proportion test: clear regression is significant, equal rates are not', () => {
  assert.ok(twoProportionTest(50, 10000, 150, 10000).p < 1e-6);
  assert.ok(twoProportionTest(50, 10000, 50, 10000).p > 0.4);
  assert.equal(twoProportionTest(0, 0, 0, 0).p, 1);
});

test('Mann-Whitney detects a shifted distribution and not an identical one', () => {
  const r = rng(3);
  const a = Array.from({ length: 300 }, () => r());
  const b = Array.from({ length: 300 }, () => r() + 0.2);
  const same = Array.from({ length: 300 }, () => r());
  assert.ok(mannWhitney(a, b).p < 1e-6);
  assert.ok(mannWhitney(a, same).p > 0.01);
  assert.equal(mannWhitney([1, 2], [3, 4]).p, 1); // too few samples
});

test('binomial sampler has the right mean for small and large n', () => {
  const r = rng(11);
  let s = 0; for (let i = 0; i < 2000; i++) s += binomial(r, 100, 0.1);
  close(s / 2000, 10, 0.5);
  let t = 0; for (let i = 0; i < 2000; i++) t += binomial(r, 50000, 0.01);
  close(t / 2000, 500, 5);
});

test('quantile interpolates', () => {
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(quantile([0, 10], 0.25), 2.5);
});

test('healthy canary is promoted through every step', () => {
  const r = simulate({ seed: 1 });
  assert.equal(r.decision, 'promoted');
  assert.equal(r.durationMin, DEFAULT_STEPS.reduce((s, x) => s + x.bakeMin, 0));
});

test('known-positive control: error regression is rolled back early with limited exposure', () => {
  const r = simulate({ seed: 1, canaryErrorRate: 0.03 });
  assert.equal(r.decision, 'rolled-back');
  assert.equal(r.failedCheck.reason, 'error rate regression');
  assert.ok(r.exposure.exposureShare < 0.1, `exposure ${r.exposure.exposureShare}`);
  assert.ok(r.exposure.excessErrors < r.exposure.allAtOnceExcessErrors);
});

test('known-positive control: latency regression is rolled back', () => {
  const r = simulate({ seed: 2, canaryLatencyMultiplier: 1.5 });
  assert.equal(r.decision, 'rolled-back');
  assert.equal(r.failedCheck.reason, 'latency regression');
});

test('false-positive rate under no regression stays at or below alpha (Bonferroni across looks)', () => {
  const mc = monteCarlo({ alpha: 0.05 }, 150);
  assert.ok(mc.rate <= 0.05, `FP rate ${mc.rate}`);
});

test('power: a 2pp error regression is caught in nearly every run', () => {
  const mc = monteCarlo({ canaryErrorRate: 0.025 }, 60);
  assert.ok(mc.rate >= 0.95, `power ${mc.rate}`);
});

test('countLooks and validation', () => {
  assert.equal(countLooks(DEFAULT_STEPS, 5), 2 + 2 + 3 + 3);
  assert.throws(() => simulate({ steps: [{ weight: 0.5, bakeMin: 5 }] }), RangeError);
  assert.throws(() => simulate({ steps: [{ weight: 0.5, bakeMin: 5 }, { weight: 0.2, bakeMin: 5 }, { weight: 1, bakeMin: 0 }] }), RangeError);
  assert.throws(() => simulate({ canaryErrorRate: 2 }), RangeError);
});

import { logGamma, fisherExactGreater } from '../src/stats.js';

test('logGamma matches log factorials', () => {
  close(logGamma(11), Math.log(3628800), 1e-9);
  close(logGamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-9);
});

test('Fisher exact test matches a hand-computed hypergeometric tail', () => {
  // 2x2: baseline 1/10 errors, canary 4/10. P(X>=4 | N=20, K=5, n=10) = (C(10,4)C(10,1)+C(10,5)C(10,0))/C(20,5)
  const expected = (210 * 10 + 252 * 1) / 15504;
  close(fisherExactGreater(1, 10, 4, 10).p, expected, 1e-9);
  assert.equal(fisherExactGreater(0, 100, 0, 100).p, 1);
});

test('Fisher is conservative where the z-test is not (small counts at 1% weight)', () => {
  // 6 canary errors out of 300 vs 0.5% baseline on 29,700 requests
  const z = twoProportionTest(148, 29700, 6, 300).p;
  const f = fisherExactGreater(148, 29700, 6, 300).p;
  assert.ok(f > z * 5, `fisher ${f} vs z ${z}`);
});
