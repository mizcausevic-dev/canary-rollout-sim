# Canary Rollout Sim

[![CI](https://github.com/mizcausevic-dev/canary-rollout-sim/actions/workflows/ci.yml/badge.svg)](https://github.com/mizcausevic-dev/canary-rollout-sim/actions/workflows/ci.yml)
[![Pages](https://github.com/mizcausevic-dev/canary-rollout-sim/actions/workflows/pages.yml/badge.svg)](https://mizcausevic-dev.github.io/canary-rollout-sim/)
![Dependencies: 0](https://img.shields.io/badge/dependencies-0-66fcf1)
![License: MIT](https://img.shields.io/badge/license-MIT-45a29e)

**Live demo: https://mizcausevic-dev.github.io/canary-rollout-sim/**

A progressive-delivery simulator with automated canary analysis that holds up statistically. Configure the rollout steps, inject an error or latency regression, and watch each analysis look decide whether to promote or roll back. Then run 300 rollouts to measure the analysis's false-positive rate and detection power.

## Why this exists

"We do canaries" often means eyeballing a dashboard, or comparing error rates with a threshold that pages on noise at 1% traffic and misses real regressions at 50%. This project shows what an automated canary judge has to get right, and it measures whether it does.

## Results (from this repo's own Monte Carlo, default policy)

| Scenario | Runs | Rolled back | Notes |
|---|---|---|---|
| Healthy release, α = 1% | 1,000 | 0.1% | False-positive rate stays below α |
| Error regression 0.5% → 2.5% | 200 | 100% | Mean 11.9 min to rollback |
| Error regression 0.5% → 1.0% | 200 | 100% | Mean 26.9 min, caught at 25% weight |
| Latency p50 +30% | 200 | 100% | Caught at the first look (5 min, 1% weight) |

A 0.5% → 3% error regression (seed 42) is rolled back at the 5% step after 15 minutes. By then the bad build has served 2.3% of requests, about 26 extra errors, compared with about 1,125 for an all-at-once deploy over the same window.

Reproduce: `node -e "import('./src/rollout.js').then(m => console.log(m.monteCarlo({}, 1000)))"`

## The statistics, and one bug the simulator caught

| Concern | Approach |
|---|---|
| Error-rate comparison | One-sided **Fisher's exact test** (hypergeometric tail, log-gamma via Lanczos) |
| Latency comparison | One-sided **Mann-Whitney U** with tie correction (no normality assumption) |
| Peeking / repeated looks | **Bonferroni**: family-wise α ÷ (looks × 2 metrics) |
| Noise vs. impact | A step fails only when the result is significant **and** practically large (+0.2pp errors or p50 > 1.1×) |
| Reproducibility | Seeded PRNG (mulberry32). The same seed always gives the same rollout |

The first version used a two-proportion z-test. In 500 healthy rollouts it rolled back 1.2% of them against a nominal α of 1%. Every false positive happened at 1% traffic, where the canary sees a few hundred requests and single-digit error counts, so the normal approximation is invalid. Switching to Fisher's exact test brought the false-positive rate to 0.1% over 1,000 runs. A test pins this behavior: on that 1%-weight case, the Fisher p-value must be at least 5× the z-test's.

## Architecture

```
index.html ── src/app.js        controls, SVG chart, analysis log, chunked Monte Carlo (UI stays responsive)
                 │
                 ├─ src/rollout.js   simulate(): traffic split → samples → periodic analysis → decision
                 │                   monteCarlo(): rollback rate across seeds
                 └─ src/stats.js     rng, binomial, normCdf, fisherExactGreater, mannWhitney,
                                     twoProportionTest (kept for comparison), logGamma, quantile
```

All modules are pure ES modules with no DOM in the core. The test suite (15 tests) checks the statistics against hand-computed values. It also uses known-positive controls (injected regressions must roll back) and a known-negative control (the false-positive rate must stay at or below α).

## Run locally

```bash
git clone https://github.com/mizcausevic-dev/canary-rollout-sim
cd canary-rollout-sim
npm test
python3 -m http.server 8080   # open http://localhost:8080
```

## Model limits

Traffic is stationary and requests are independent. Latency is log-normal and errors are Bernoulli. Real canaries also need to handle seasonality, sticky sessions and correlated failures. Bonferroni is conservative; sequential tests (for example mSPRT) would detect faster for the same α.

## License

MIT © 2026 Mirza Causevic / Kinetic Gain LLC
