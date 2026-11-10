// Small, dependency-free statistics toolkit used by the canary analysis.

/** Deterministic PRNG (mulberry32). Same seed, same run: reproducible experiments. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function normal(rand) {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** Binomial draw: exact Bernoulli loop for small n, normal approximation for large n. */
export function binomial(rand, n, p) {
  if (n <= 0 || p <= 0) return 0;
  if (p >= 1) return n;
  if (n <= 1000) {
    let k = 0;
    for (let i = 0; i < n; i++) if (rand() < p) k++;
    return k;
  }
  const k = Math.round(n * p + Math.sqrt(n * p * (1 - p)) * normal(rand));
  return Math.min(n, Math.max(0, k));
}

/** Standard normal CDF via Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7). */
export function normCdf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/**
 * One-sided two-proportion z-test. H1: canary error rate > baseline error rate.
 * Returns { z, p }. p = 1 when there is no data or no variance.
 */
export function twoProportionTest(errA, nA, errB, nB) {
  if (nA <= 0 || nB <= 0) return { z: 0, p: 1 };
  const pA = errA / nA, pB = errB / nB;
  const pooled = (errA + errB) / (nA + nB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / nA + 1 / nB));
  if (se === 0) return { z: 0, p: 1 };
  const z = (pB - pA) / se;
  return { z, p: 1 - normCdf(z) };
}

/**
 * One-sided Mann-Whitney U test (normal approximation, average ranks for ties).
 * H1: values in `b` (canary) tend to be larger than in `a` (baseline).
 */
export function mannWhitney(a, b) {
  const n1 = a.length, n2 = b.length;
  if (n1 < 8 || n2 < 8) return { z: 0, p: 1 };
  const all = new Array(n1 + n2);
  for (let i = 0; i < n1; i++) all[i] = [a[i], 0];
  for (let i = 0; i < n2; i++) all[n1 + i] = [b[i], 1];
  all.sort((x, y) => x[0] - y[0]);
  let rankSumB = 0;
  let tieTerm = 0;
  for (let i = 0; i < all.length;) {
    let j = i;
    while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    const t = j - i + 1;
    if (t > 1) tieTerm += t ** 3 - t;
    for (let k = i; k <= j; k++) if (all[k][1] === 1) rankSumB += avg;
    i = j + 1;
  }
  const u = rankSumB - (n2 * (n2 + 1)) / 2;
  const mean = (n1 * n2) / 2;
  const n = n1 + n2;
  const variance = (n1 * n2 / 12) * ((n + 1) - tieTerm / (n * (n - 1)));
  if (variance <= 0) return { z: 0, p: 1 };
  const z = (u - mean - 0.5) / Math.sqrt(variance); // continuity correction
  return { z, p: 1 - normCdf(z) };
}

export function quantile(values, q) {
  if (!values.length) return NaN;
  const s = [...values].sort((x, y) => x - y);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];

/** log Gamma via the Lanczos approximation (g = 7). */
export function logGamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = LANCZOS[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

const logChoose = (n, k) => logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);

/**
 * One-sided Fisher's exact test (hypergeometric tail). H1: canary (B) error rate > baseline (A).
 * Exact at any sample size, which matters at 1% canary weight where errors are counted in single digits.
 */
export function fisherExactGreater(errA, nA, errB, nB) {
  if (nA <= 0 || nB <= 0) return { p: 1 };
  const N = nA + nB, K = errA + errB;
  if (K === 0) return { p: 1 };
  const hi = Math.min(K, nB);
  const lo = Math.max(0, K - nA);
  if (errB <= lo) return { p: 1 };
  const logDen = logChoose(N, K);
  let p = 0;
  for (let x = errB; x <= hi; x++) {
    const term = Math.exp(logChoose(nB, x) + logChoose(nA, K - x) - logDen);
    p += term;
    if (term < p * 1e-15 && x > errB + 10) break;
  }
  return { p: Math.min(1, p) };
}
