import { simulate } from './rollout.js';

const runOne = simulate;

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';

const SCENARIOS = {
  error: { cerr: 3, latmul: 1 },
  latency: { cerr: 0.5, latmul: 1.4 },
  subtle: { cerr: 1, latmul: 1 },
  healthy: { cerr: 0.5, latmul: 1 },
};

function el(tag, attrs = {}, text) {
  const node = tag.startsWith('svg:') ? document.createElementNS(SVG_NS, tag.slice(4)) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

export function parseSteps(text) {
  const parts = String(text).split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length || parts.length > 12) throw new RangeError('enter 1-12 steps like "1:10, 5:10, 100:0"');
  return parts.map((p) => {
    const m = /^(\d+(?:\.\d+)?)\s*:\s*(\d+)$/.exec(p);
    if (!m) throw new RangeError(`bad step "${p.slice(0, 20)}" (use weight%:minutes)`);
    return { weight: Number(m[1]) / 100, bakeMin: Number(m[2]) };
  });
}

function readConfig() {
  return {
    seed: Number($('seed').value) >>> 0,
    requestsPerMin: Number($('rpm').value),
    baselineErrorRate: Number($('berr').value) / 100,
    canaryErrorRate: Number($('cerr').value) / 100,
    baselineLatencyMs: Number($('lat').value),
    canaryLatencyMultiplier: Number($('latmul').value),
    steps: parseSteps($('steps').value),
    alpha: Number($('alpha').value),
    analysisIntervalMin: Math.max(1, Math.floor(Number($('interval').value))),
  };
}

const pct = (x, d = 2) => `${(x * 100).toFixed(d)}%`;
const fmtP = (p) => (p < 1e-4 ? p.toExponential(1) : p.toFixed(4));
const n = (x) => Math.round(x).toLocaleString('en-US');

function renderTiles(r) {
  const tiles = $('tiles');
  tiles.replaceChildren();
  const d = el('div', { class: 'tile' });
  d.append(el('div', { class: 'k' }, 'Decision'), el('div', { class: `decision ${r.decision}` }, r.decision === 'promoted' ? 'Promoted' : 'Rolled back'),
    el('div', { class: 's' }, r.failedCheck ? `${r.failedCheck.reason} at ${pct(r.failedCheck.weight, 0)}` : 'all checks passed'));
  tiles.append(d);
  const e = r.exposure;
  const items = [
    ['Time in rollout', `${r.durationMin} min`, `${r.looks} looks · α/test ${r.alphaPerTest.toExponential(1)}`],
    ['Canary exposure', pct(e.exposureShare, 1), `${n(e.canaryRequests)} of ${n(e.allAtOnceRequests)} requests`],
    ['Excess errors', n(e.excessErrors), `vs ${n(e.allAtOnceExcessErrors)} if deployed all at once`],
  ];
  for (const [k, v, s] of items) {
    const t = el('div', { class: 'tile' });
    t.append(el('div', { class: 'k' }, k), el('div', { class: 'v' }, v), el('div', { class: 's' }, s));
    tiles.append(t);
  }
}

function renderChart(r) {
  const svg = $('chart');
  svg.replaceChildren();
  const W = 800, H = 280, L = 52, R = 12, T = 12, B = 30;
  const tl = r.timeline;
  if (!tl.length) {
    svg.append(el('svg:text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', fill: '#8a94a3', 'font-size': 13 }, 'No bake time: straight to 100%'));
    return;
  }
  const smooth = (key) => tl.map((_, i) => {
    const w = tl.slice(Math.max(0, i - 2), i + 1);
    return w.reduce((s, x) => s + x[key], 0) / w.length;
  });
  const c = smooth('canaryErrRate'), b = smooth('baselineErrRate');
  const yMax = Math.max(0.01, ...c, ...b) * 1.15;
  const x = (i) => L + (i / Math.max(1, tl.length - 1)) * (W - L - R);
  const y = (v) => T + (1 - v / yMax) * (H - T - B);

  tl.forEach((p, i) => {
    const w = (W - L - R) / tl.length;
    const h = p.weight * (H - T - B);
    svg.append(el('svg:rect', { x: L + i * w, y: H - B - h, width: w + 0.5, height: h, fill: 'rgba(69,162,158,0.12)' }));
  });
  for (let i = 0; i <= 4; i++) {
    const v = (yMax / 4) * i;
    svg.append(el('svg:line', { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: '#263040' }));
    svg.append(el('svg:text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end', fill: '#8a94a3', 'font-size': 11 }, pct(v, 1)));
  }
  const path = (vals, color) => svg.append(el('svg:path', { d: vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(''), fill: 'none', stroke: color, 'stroke-width': 2 }));
  path(b, '#66fcf1');
  path(c, '#ff5c7a');
  for (const ev of r.events.filter((e) => e.type === 'analysis')) {
    const i = ev.check.minute - 1;
    svg.append(el('svg:circle', { cx: x(i), cy: T + 4, r: 4, fill: ev.check.pass ? '#4ade80' : '#ff5c7a' }));
  }
  const ticks = Math.min(6, tl.length);
  for (let k = 0; k < ticks; k++) {
    const i = Math.round((k / Math.max(1, ticks - 1)) * (tl.length - 1));
    svg.append(el('svg:text', { x: x(i), y: H - 10, 'text-anchor': 'middle', fill: '#8a94a3', 'font-size': 11 }, `${tl[i].minute}m`));
  }
}

function renderLog(r) {
  const body = $('log').querySelector('tbody');
  body.replaceChildren();
  for (const ev of r.events) {
    const tr = el('tr');
    if (ev.type !== 'analysis') {
      const td = el('td', { colspan: '7' });
      const cls = ev.type === 'rollback' ? 'danger' : ev.type === 'promote' ? 'ok' : 'muted';
      td.append(el('span', { class: `pill ${cls}` }, ev.type), document.createTextNode(` minute ${ev.minute}: ${ev.message}`));
      tr.append(td);
    } else {
      const c = ev.check;
      const res = el('td');
      res.append(el('span', { class: `pill ${c.pass ? 'ok' : 'danger'}` }, c.pass ? 'pass' : 'fail'));
      tr.append(el('td', { class: 'num' }, String(c.minute)), el('td', { class: 'num' }, pct(c.weight, 0)), res,
        el('td', { class: 'num' }, `${c.errDelta >= 0 ? '+' : ''}${(c.errDelta * 100).toFixed(2)}pp`),
        el('td', { class: 'num' }, fmtP(c.errP)), el('td', { class: 'num' }, c.latRatio.toFixed(3)), el('td', { class: 'num' }, fmtP(c.latP)));
    }
    body.append(tr);
  }
}

function update() {
  $('err').textContent = '';
  try {
    const r = simulate(readConfig());
    renderTiles(r);
    renderChart(r);
    renderLog(r);
  } catch (e) {
    $('err').textContent = e.message;
  }
}

function runMonteCarlo() {
  let cfg;
  try { cfg = readConfig(); } catch (e) { $('err').textContent = e.message; return; }
  const RUNS = 300;
  const btn = $('mc');
  const out = $('mc-out');
  btn.disabled = true;
  let i = 0, rolled = 0, minutes = 0;
  const chunk = () => {
    const end = Math.min(RUNS, i + 20);
    for (; i < end; i++) {
      const r = runOne({ ...cfg, seed: 100000 + i });
      if (r.decision === 'rolled-back') { rolled++; minutes += r.durationMin; }
    }
    out.textContent = `Running… ${i}/${RUNS}`;
    if (i < RUNS) { setTimeout(chunk, 0); return; }
    const healthy = cfg.canaryErrorRate <= cfg.baselineErrorRate && cfg.canaryLatencyMultiplier <= 1;
    const rate = rolled / RUNS;
    out.textContent = healthy
      ? `False-positive rate: ${pct(rate, 1)} (${rolled}/${RUNS} healthy releases rolled back) vs α = ${pct(cfg.alpha, 1)}.`
      : `Detection rate: ${pct(rate, 1)} (${rolled}/${RUNS})${rolled ? `, mean ${(minutes / rolled).toFixed(1)} min to rollback` : ''}.`;
    btn.disabled = false;
  };
  chunk();
}

function init() {
  $('scenario').addEventListener('change', (e) => {
    const s = SCENARIOS[e.target.value];
    if (!s) return;
    $('cerr').value = s.cerr;
    $('latmul').value = s.latmul;
    $('mc-out').textContent = '';
    update();
  });
  for (const id of ['cerr', 'latmul', 'berr']) $(id).addEventListener('input', () => { $('scenario').value = 'custom'; });
  $('controls').addEventListener('input', update);
  $('controls').addEventListener('submit', (e) => e.preventDefault());
  $('mc').addEventListener('click', runMonteCarlo);
  update();
}

init();
