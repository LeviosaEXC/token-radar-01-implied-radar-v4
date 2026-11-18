// Implied Radar v4 — token-radar-01 entry program.
//
// Reads the sealed snapshot, fits the validated power-law radar,
// writes the ranked board, the dashboard data, and the dossier.
// Node 22, standard library only, zero network, deterministic:
// no wall-clock or unseeded randomness anywhere in the outputs.
//
// Pipeline: census and exclusions first, then the frozen validation
// contract (nested leave-one-out over the rung ladder with the G1-G4
// shipping gate, placebo permutations, walk-forward origins), then
// bands and rank intervals, then farm economics, then the dashboard
// payload. The shipped selection is embedded in the page, which
// re-derives every value with the same shared code (dashboard/model.js
// and dashboard/farm.js) and proves the board matches.
//
// Timings are measured and printed to stdout only: writing measured
// seconds into the dashboard would break byte-identical reruns.

import { readFileSync, writeFileSync, mkdirSync, cpSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { buildDossier } from './vendor/makefun-board.ts';
import './dashboard/model.js';
import './dashboard/farm.js';

const RadarModel = (globalThis as any).RadarModel;
const RadarFarm = (globalThis as any).RadarFarm;
const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = 20261114;

// ---------------------------------------------------------------- utilities

function fail(msg: string): never { throw new Error('Implied Radar v4: ' + msg); }
function assert(cond: boolean, msg: string) { if (!cond) fail(msg); }

// One seeded xorshift PRNG, fixed seed, no wall-clock dependence.
function makeRng(seed: number) {
  let a = seed >>> 0;
  return function () {
    a ^= a << 13; a ^= a >>> 17; a ^= a << 5; a >>>= 0;
    return a / 4294967296;
  };
}
function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
function median(v: number[]): number {
  if (v.length === 0) return 0;
  const s = v.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mean(v: number[]): number { return v.reduce((a, b) => a + b, 0) / v.length; }
function quantile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const h = (sortedAsc.length - 1) * p;
  const lo = Math.floor(h);
  const frac = h - lo;
  return sortedAsc[lo] + frac * (sortedAsc[Math.min(lo + 1, sortedAsc.length - 1)] - sortedAsc[lo]);
}
// Finite-sample conformal quantile: k-th smallest, k = ceil((n+1)*p).
function conformalQuantile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const k = Math.min(n, Math.max(1, Math.ceil((n + 1) * p)));
  return sortedAsc[k - 1];
}
function iqr(v: number[]): number {
  const s = v.slice().sort((a, b) => a - b);
  return quantile(s, 0.75) - quantile(s, 0.25);
}
function stdev(v: number[]): number {
  if (v.length < 2) return 0;
  const m = mean(v);
  return Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / (v.length - 1));
}
function ranksWithTies(v: number[]): number[] {
  const order = v.map((x, i) => [x, i] as [number, number]).sort((a, b) => a[0] - b[0]);
  const r = new Array(v.length).fill(0);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[order[k][1]] = avg;
    i = j + 1;
  }
  return r;
}
function spearman(a: number[], b: number[]): number {
  if (a.length < 3) return 0;
  const ra = ranksWithTies(a);
  const rb = ranksWithTies(b);
  const ma = mean(ra);
  const mb = mean(rb);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) * (ra[i] - ma);
    db += (rb[i] - mb) * (rb[i] - mb);
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}
// Paired bootstrap over per-row differences: standard error of the
// mean difference, plus a percentile of the resampled means.
function bootstrapMean(values: number[], draws: number, rng: () => number): { se: number; p5: number; p50: number } {
  const n = values.length;
  const means: number[] = [];
  for (let d = 0; d < draws; d++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += values[Math.floor(rng() * n)];
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  return { se: stdev(means), p5: quantile(means, 0.05), p50: quantile(means, 0.5) };
}

// Gaussian elimination with partial pivoting for small dense systems.
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => row.concat([b[i]]));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    const tmp = M[col]; M[col] = M[piv]; M[piv] = tmp;
    const div = M[col][col];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / div;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Array(n);
  for (let i = 0; i < n; i++) x[i] = M[i][n] / M[i][i];
  return x;
}

function weightedLeastSquares(X: number[][], y: number[], w: number[]): number[] | null {
  const p = X[0].length;
  const A: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  const b: number[] = new Array(p).fill(0);
  for (let i = 0; i < X.length; i++) {
    const wi = w[i];
    const xi = X[i];
    for (let a = 0; a < p; a++) {
      b[a] += wi * xi[a] * y[i];
      for (let c = 0; c < p; c++) A[a][c] += wi * xi[a] * xi[c];
    }
  }
  for (let a = 1; a < p; a++) A[a][a] += 1e-6; // ridge on slopes only
  return solveLinear(A, b);
}

// Huber IRLS in log space: tuning constant 1.345 times the robustly
// scaled residual MAD, 25 iterations or max parameter delta below 1e-9.
function huberFit(X: number[][], y: number[]): { beta: number[]; weights: number[]; converged: boolean } {
  const n = X.length;
  let beta = weightedLeastSquares(X, y, new Array(n).fill(1));
  if (beta === null) fail('singular design in Huber fit');
  let weights = new Array(n).fill(1);
  let converged = false;
  for (let iter = 0; iter < 25; iter++) {
    const resid = X.map((xi, i) => y[i] - xi.reduce((s, v, k) => s + v * beta[k], 0));
    const med = median(resid);
    const mad = 1.4826 * median(resid.map((r) => Math.abs(r - med)));
    const c = 1.345 * mad;
    if (c <= 0) { converged = true; break; }
    weights = resid.map((r) => {
      const u = Math.abs(r - med) / c;
      return u <= 1 ? 1 : 1 / u;
    });
    const next = weightedLeastSquares(X, y, weights);
    if (next === null) fail('singular design in Huber IRLS');
    let delta = 0;
    for (let k = 0; k < beta.length; k++) delta = Math.max(delta, Math.abs(next[k] - beta[k]));
    beta = next;
    if (delta < 1e-9) { converged = true; break; }
  }
  return { beta, weights, converged };
}

// ---------------------------------------------------------------- snapshot

type Proto = {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
};

// The kit's watchlist exclusion policy, from the kit's input guide:
// category set, version-suffix pattern, derivative words, exchange
// list. Policy input from the kit, used verbatim, in the exclusion
// screen ONLY — never in the value model.
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const DERIVATIVE_WORDS = ['wrapped', 'staked', 'staking'];
const EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

function exclusionReasons(p: Proto): string[] {
  const reasons: string[] = [];
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) reasons.push('category');
  if (VERSION_SUFFIX.test(p.name)) reasons.push('version-suffix');
  const words = p.name.toLowerCase().split(/[^a-z0-9]+/);
  if (words.some((w) => DERIVATIVE_WORDS.includes(w))) reasons.push('derivative-word');
  for (const ex of EXCHANGE_NAMES) {
    if (p.name === ex || p.name.startsWith(ex + ' ') || p.name.startsWith(ex + '-') || p.name.startsWith(ex + ':')) { reasons.push('exchange-prefix'); break; }
  }
  return reasons;
}
function hasRecordedToken(p: Proto): boolean {
  return p.mcap_usd !== null || p.gecko_id !== null || p.symbol !== null;
}
function recordsNoToken(p: Proto): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}
function daysSince(asOfMs: number, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const t = Date.parse(listedAt + 'T00:00:00Z');
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((asOfMs - t) / 86400000));
}

// ---------------------------------------------------------------- features

type CompRow = {
  proto: Proto; y: number; x: number; days: number | null;
  grpValue: string | null; nCh: number; chg: number | null;
};

type FoldCtx = {
  groupId: Map<string, number>; grpN: number[];
  ageDays: number[]; ageMed: number; ageIqr: number;
  brMed: number; brIqr: number; brLo: number; brHi: number;
  grS: number; grMed: number; grIqr: number; grLo: number; grHi: number;
  boxLo: number[]; boxHi: number[];
};

// All constants recomputed from the fitting window only. Group-id maps
// are rebuilt per fold from fold-train values only.
function buildFoldCtx(rows: CompRow[]): FoldCtx {
  const values = [...new Set(rows.map((r) => r.grpValue).filter((v) => v !== null))].sort() as string[];
  const groupId = new Map(values.map((v, i) => [v, i] as [string, number]));
  const grpN = new Array(values.length).fill(0);
  for (const r of rows) if (r.grpValue !== null) grpN[groupId.get(r.grpValue)!]++;
  const ageDays = rows.map((r) => r.days).filter((d) => d !== null).sort((a, b) => a! - b!) as number[];
  const pcts = rows.map((r) => {
    if (r.days === null || ageDays.length === 0) return 0.5;
    let le = 0;
    for (const d of ageDays) if (d <= r.days!) le++;
    return le / ageDays.length;
  });
  const ageMed = median(pcts);
  const ageIqr = iqr(pcts);
  const brVals = rows.map((r) => Math.log1p(r.nCh));
  const brSorted = brVals.slice().sort((a, b) => a - b);
  const brLo = quantile(brSorted, 0.01);
  const brHi = quantile(brSorted, 0.99);
  const brWin = brVals.map((v) => Math.min(brHi, Math.max(brLo, v)));
  const brMed = median(brWin);
  const brIqr = iqr(brWin);
  const nonNullG = rows.map((r) => r.chg).filter((g) => g !== null) as number[];
  const grS = nonNullG.length > 0 ? median(nonNullG.map((g) => Math.abs(g))) : 0;
  let grMed = 0, grIqr = 0, grLo = 0, grHi = 0;
  if (grS > 0 && nonNullG.length > 0) {
    const tVals = nonNullG.map((g) => Math.asinh(g / grS)).sort((a, b) => a - b);
    grLo = quantile(tVals, 0.01);
    grHi = quantile(tVals, 0.99);
    const win = tVals.map((v) => Math.min(grHi, Math.max(grLo, v)));
    grMed = median(win);
    grIqr = iqr(win);
  }
  const ctx: FoldCtx = {
    groupId, grpN, ageDays, ageMed, ageIqr,
    brMed, brIqr, brLo, brHi, grS, grMed, grIqr, grLo, grHi,
    boxLo: [0, 0, 0], boxHi: [0, 0, 0],
  };
  // Interiority box: 5th-95th percentiles of the standardized
  // features over the fitting window.
  const zs: number[][] = [[], [], []];
  for (const r of rows) {
    const f = rowFeatures(ctx, r.days, r.nCh, r.chg);
    zs[0].push(f[0]); zs[1].push(f[1]); zs[2].push(f[2]);
  }
  for (let k = 0; k < 3; k++) {
    const s = zs[k].slice().sort((a, b) => a - b);
    ctx.boxLo[k] = quantile(s, 0.05);
    ctx.boxHi[k] = quantile(s, 0.95);
  }
  return ctx;
}

// Standardized features [zAge, zBreadth, zGrowth] under a fold context.
function rowFeatures(ctx: FoldCtx, days: number | null, nCh: number, chg: number | null): number[] {
  let agePct = 0.5;
  if (days !== null && ctx.ageDays.length > 0) {
    let le = 0;
    for (const d of ctx.ageDays) if (d <= days) le++;
    agePct = le / ctx.ageDays.length;
  }
  const zAge = ctx.ageIqr > 0 ? (agePct - ctx.ageMed) / ctx.ageIqr : 0;
  const brRaw = Math.min(ctx.brHi, Math.max(ctx.brLo, Math.log1p(nCh)));
  const zBr = ctx.brIqr > 0 ? (brRaw - ctx.brMed) / ctx.brIqr : 0;
  let grRaw = ctx.grMed;
  if (chg !== null && ctx.grS > 0) grRaw = Math.min(ctx.grHi, Math.max(ctx.grLo, Math.asinh(chg / ctx.grS)));
  const zGr = ctx.grIqr > 0 ? (grRaw - ctx.grMed) / ctx.grIqr : 0;
  return [zAge, zBr, zGr];
}

function groupOf(ctx: FoldCtx, grpValue: string | null): number {
  if (grpValue === null) return -1;
  const id = ctx.groupId.get(grpValue);
  return id === undefined ? -1 : id;
}

// Design row for a rung: [1, x] plus rung terms. Missingness effects
// ride alongside their feature. Group offsets are handled in the
// two-pass fit, not as design columns.
function designRow(rung: number, x: number, z: number[], missA: number, missG: number): number[] {
  const row = [1, x];
  if (rung >= 1) row.push(z[0], missA);
  if (rung >= 2) row.push(z[1]);
  if (rung >= 4) row.push(z[2], missG);
  return row;
}
function clipCoefs(beta: number[], rung: number): number[] {
  const out = beta.slice();
  let k = 2;
  if (rung >= 1) { out[k] = Math.max(-0.25, Math.min(0.25, out[k])); out[k + 1] = Math.max(-0.15, Math.min(0.15, out[k + 1])); k += 2; }
  if (rung >= 2) { out[k] = Math.max(-0.25, Math.min(0.25, out[k])); k += 1; }
  if (rung >= 4) { out[k] = Math.max(-0.25, Math.min(0.25, out[k])); out[k + 1] = Math.max(-0.15, Math.min(0.15, out[k + 1])); }
  return out;
}

type WindowFit = {
  ctx: FoldCtx; curveBeta: number[]; beta: number[];
  offsets: number[]; converged: boolean;
};

// Fit the bare curve plus one rung on a fitting window. Group offsets
// use at most two passes with shrinkage lambda and the n_g >= 3
// support rule, bounded at +-0.30 dex.
function fitWindow(rows: CompRow[], rung: number, lambda: number): WindowFit {
  const ctx = buildFoldCtx(rows);
  const feats = rows.map((r) => rowFeatures(ctx, r.days, r.nCh, r.chg));
  const curveX = rows.map((r) => [1, r.x]);
  const curve = huberFit(curveX, rows.map((r) => r.y));
  const X = rows.map((r, i) => designRow(rung, r.x, feats[i], r.days === null ? 1 : 0, r.chg === null ? 1 : 0));
  const y = rows.map((r) => r.y);
  let fit = huberFit(X, y);
  let beta = clipCoefs(fit.beta, rung);
  let offsets = new Array(ctx.grpN.length).fill(0);
  if (rung >= 3) {
    for (let pass = 0; pass < 2; pass++) {
      const resid = X.map((xi, i) => y[i] - xi.reduce((s, v, k) => s + v * beta[k], 0));
      const sums = new Array(ctx.grpN.length).fill(0);
      const wsum = new Array(ctx.grpN.length).fill(0);
      for (let i = 0; i < rows.length; i++) {
        const g = groupOf(ctx, rows[i].grpValue);
        if (g < 0) continue;
        sums[g] += fit.weights[i] * resid[i];
        wsum[g] += fit.weights[i];
      }
      offsets = sums.map((s, g) => {
        if (ctx.grpN[g] < 3 || wsum[g] === 0) return 0;
        const u = (ctx.grpN[g] / (ctx.grpN[g] + lambda)) * (s / wsum[g]);
        return Math.max(-0.3, Math.min(0.3, u));
      });
      if (pass === 0) {
        const yAdj = y.map((v, i) => {
          const g = groupOf(ctx, rows[i].grpValue);
          return v - (g < 0 ? 0 : offsets[g]);
        });
        fit = huberFit(X, yAdj);
        beta = clipCoefs(fit.beta, rung);
      }
    }
  }
  return { ctx, curveBeta: curve.beta, beta, offsets, converged: curve.converged && fit.converged };
}

function predictWith(fit: WindowFit, rung: number, s: number, row: { x: number; days: number | null; nCh: number; chg: number | null; grpValue: string | null }): { y: number; curveOnly: boolean } {
  const z = rowFeatures(fit.ctx, row.days, row.nCh, row.chg);
  const curve = fit.curveBeta[0] + fit.curveBeta[1] * row.x;
  let outside = false;
  for (let k = 0; k < 3; k++) if (z[k] < fit.ctx.boxLo[k] || z[k] > fit.ctx.boxHi[k]) outside = true;
  if (outside || rung === 0) return { y: curve, curveOnly: outside };
  const d = designRow(rung, row.x, z, row.days === null ? 1 : 0, row.chg === null ? 1 : 0);
  let model = d.reduce((sum, v, k) => sum + v * fit.beta[k], 0);
  if (rung >= 3) {
    const g = groupOf(fit.ctx, row.grpValue);
    if (g >= 0 && fit.ctx.grpN[g] >= 3) model += fit.offsets[g];
  }
  const disp = Math.max(-0.35, Math.min(0.35, s * (model - curve)));
  return { y: curve + disp, curveOnly: false };
}

// Group-disjoint folds: groups dealt round-robin over anonymous group
// ids sorted by group size descending, then id ascending, so large
// groups spread one per fold. Rows with a null grouping value are
// dealt round-robin by sorted slug order.
function groupDisjointFolds(rows: CompRow[], nFolds: number): number[][] {
  const ctx = buildFoldCtx(rows);
  const byGroup = new Map<number, number[]>();
  const nullRows: number[] = [];
  rows.forEach((r, i) => {
    const g = groupOf(ctx, r.grpValue);
    if (g < 0) nullRows.push(i);
    else {
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g)!.push(i);
    }
  });
  const groups = [...byGroup.entries()].sort((a, b) => (b[1].length - a[1].length) || (a[0] - b[0]));
  const folds: number[][] = Array.from({ length: nFolds }, () => []);
  groups.forEach(([g, idxs], k) => { folds[k % nFolds].push(...idxs); });
  nullRows.sort((a, b) => (rows[a].proto.slug < rows[b].proto.slug ? -1 : 1));
  nullRows.forEach((idx, k) => { folds[k % nFolds].push(idx); });
  // Audit: no group spans two folds.
  const seen = new Map<number, number>();
  folds.forEach((fold, fi) => {
    for (const i of fold) {
      const g = groupOf(ctx, rows[i].grpValue);
      if (g < 0) continue;
      if (seen.has(g) && seen.get(g) !== fi) fail('group-disjoint fold audit: group spans folds');
      seen.set(g, fi);
    }
  });
  return folds;
}

// ---------------------------------------------------------------- selection

const RUNGS = [0, 1, 2, 3, 4];
const S_GRID = [0, 0.25, 0.5, 0.75, 1];
const LAMBDAS = [8, 16, 32];
type Candidate = { rung: number; s: number; index: number };
const CANDIDATES: Candidate[] = [];
{
  let idx = 0;
  for (const rung of RUNGS) {
    for (const s of S_GRID) {
      if (rung === 0 && s !== 0) continue; // R0 collapses: s is irrelevant
      CANDIDATES.push({ rung, s, index: idx++ });
    }
  }
}
assert(CANDIDATES.length === 21, 'candidate menu must hold 21 distinct candidates');

type InnerResult = {
  // per candidate index: pooled inner out-of-fold median error + Spearman
  medErr: number[]; spear: number[]; lambdaByRung: number[];
};

// Inner 5-fold group-disjoint CV over one training set. Fits are
// shared across blend weights: one fit per (fold, rung, lambda),
// five blend predictions from each fit. Lambda for rungs 3-4 is
// selected on the pooled inner error at s = 1, inside this set only.
function innerCV(train: CompRow[]): InnerResult {
  const folds = groupDisjointFolds(train, 5);
  const foldData: { foldTest: CompRow[]; lamScores: Map<string, number[][]> }[] = [];
  for (const testIdx of folds) {
    const testSet = new Set(testIdx);
    const foldTrain = train.filter((_, i) => !testSet.has(i));
    const foldTest = testIdx.map((i) => train[i]);
    const lamScores = new Map<string, number[][]>();
    for (const rung of RUNGS) {
      const lams = rung >= 3 ? LAMBDAS : [LAMBDAS[1]];
      for (const lam of lams) {
        const fit = fitWindow(foldTrain, rung, lam);
        lamScores.set(rung + ':' + lam, foldTest.map((row) => S_GRID.map((s) => predictWith(fit, rung, s, row).y)));
      }
    }
    foldData.push({ foldTest, lamScores });
  }
  const lambdaByRung = [0, 0, 0, LAMBDAS[1], LAMBDAS[1]];
  for (const rung of [3, 4]) {
    let bestLam = LAMBDAS[1];
    let bestErr = Infinity;
    for (const lam of LAMBDAS) {
      const errs: number[] = [];
      for (const fd of foldData) {
        const perRow = fd.lamScores.get(rung + ':' + lam)!;
        fd.foldTest.forEach((row, j) => { errs.push(Math.abs(perRow[j][4] - row.y)); });
      }
      const e = median(errs);
      if (e < bestErr - 1e-12 || (Math.abs(e - bestErr) <= 1e-12 && lam > bestLam)) { bestErr = e; bestLam = lam; }
    }
    lambdaByRung[rung] = bestLam;
  }
  const finalPreds: number[][] = CANDIDATES.map(() => []);
  const finalActual: number[] = [];
  for (const fd of foldData) {
    fd.foldTest.forEach((row, j) => {
      finalActual.push(row.y);
      for (const cand of CANDIDATES) {
        const lam = cand.rung >= 3 ? lambdaByRung[cand.rung] : LAMBDAS[1];
        finalPreds[cand.index].push(fd.lamScores.get(cand.rung + ':' + lam)![j][S_GRID.indexOf(cand.s)]);
      }
    });
  }
  const medErr = CANDIDATES.map((c) => median(finalPreds[c.index].map((p, i) => Math.abs(p - finalActual[i]))));
  const spear = CANDIDATES.map((c) => spearman(finalPreds[c.index], finalActual));
  return { medErr, spear, lambdaByRung };
}

// Inner-fold tie-breaks: median error, Spearman, fewer terms (lower
// rung, then smaller s), larger lambda, fixed candidate order.
function innerWinner(res: InnerResult): { cand: Candidate; lambda: number } {
  let best = CANDIDATES[0];
  for (const c of CANDIDATES) {
    const be = res.medErr[best.index];
    const ce = res.medErr[c.index];
    if (ce < be - 1e-12) { best = c; continue; }
    if (Math.abs(ce - be) > 1e-12) continue;
    if (res.spear[c.index] > res.spear[best.index] + 1e-12) { best = c; continue; }
    if (Math.abs(res.spear[c.index] - res.spear[best.index]) > 1e-12) continue;
    if (c.rung < best.rung || (c.rung === best.rung && c.s < best.s)) { best = c; continue; }
    if (c.rung === best.rung && c.s === best.s) {
      const cl = res.lambdaByRung[c.rung];
      const bl = res.lambdaByRung[best.rung];
      if (cl > bl) best = c;
    }
  }
  return { cand: best, lambda: res.lambdaByRung[best.rung] };
}

// ---------------------------------------------------------------- validation

// Nested leave-one-out: for each omitted comp, all selection happens
// inside the remaining rows via inner 5-fold group-disjoint CV. The
// outer prediction scores the whole selection procedure.
function nestedLOO(comps: CompRow[]): {
  candPreds: number[][]; procPreds: number[]; actual: number[];
  flatPreds: number[]; procChoices: { rung: number; s: number; lam: number }[];
} {
  const candPreds: number[][] = CANDIDATES.map(() => []);
  const procPreds: number[] = [];
  const actual: number[] = [];
  const flatPreds: number[] = [];
  const procChoices: { rung: number; s: number; lam: number }[] = [];
  comps.forEach((held, i) => {
    const train = comps.filter((_, j) => j !== i);
    const inner = innerCV(train);
    const win = innerWinner(inner);
    procChoices.push({ rung: win.cand.rung, s: win.cand.s, lam: win.lambda });
    const fits = new Map<string, WindowFit>();
    for (const cand of CANDIDATES) {
      const lam = cand.rung >= 3 ? inner.lambdaByRung[cand.rung] : LAMBDAS[1];
      const key = cand.rung + ':' + lam;
      if (!fits.has(key)) fits.set(key, fitWindow(train, cand.rung, lam));
      candPreds[cand.index].push(predictWith(fits.get(key)!, cand.rung, cand.s, held).y);
    }
    const wfit = fits.get(win.cand.rung + ':' + (win.cand.rung >= 3 ? win.lambda : LAMBDAS[1]))!;
    procPreds.push(predictWith(wfit, win.cand.rung, win.cand.s, held).y);
    actual.push(held.y);
    // Flat baseline: log10(TVL) + median log10(mcap/TVL) over train.
    const ratios = train.map((r) => r.y - Math.log10(r.proto.tvl_usd));
    flatPreds.push(Math.log10(held.proto.tvl_usd) + median(ratios));
  });
  return { candPreds, procPreds, actual, flatPreds, procChoices };
}

// Placebo: 200 seeded permutations of comp targets, selection
// machinery run 5-fold-inner-only. Gain = inner median-error gain of
// the selected challenger over the bare curve. Ship-rate = share of
// permutations whose best challenger gain clears the 0.008 dex floor.
function placeboGains(comps: CompRow[], perms: number): { gains: number[]; p95: number; shipRate: number } {
  const rng = makeRng(SEED + 7);
  const gains: number[] = [];
  const baseY = comps.map((r) => r.y);
  for (let p = 0; p < perms; p++) {
    const permY = shuffle(baseY, rng);
    const permuted = comps.map((r, i) => ({ ...r, y: permY[i] }));
    const inner = innerCV(permuted);
    const defaultErr = inner.medErr[0];
    let bestGain = 0;
    for (const c of CANDIDATES) {
      if (c.index === 0) continue;
      bestGain = Math.max(bestGain, defaultErr - inner.medErr[c.index]);
    }
    gains.push(bestGain);
  }
  const sorted = gains.slice().sort((a, b) => a - b);
  const p95 = quantile(sorted, 0.95);
  const shipRate = gains.filter((g) => g >= 0.008).length / gains.length;
  return { gains, p95, shipRate };
}

// Group permutation diagnostic: 200 seeded permutations of group ids,
// R3 refit at fixed lambda 16 under 5-fold group-disjoint CV, versus
// the real assignment under the same protocol. Diagnostic only.
function groupPermutation(comps: CompRow[], perms: number): { realErr: number; permMedian: number; permP5: number; permP95: number } {
  const evalWithGroups = (rows: CompRow[]): number => {
    const folds = groupDisjointFolds(rows, 5);
    const errs: number[] = [];
    for (const testIdx of folds) {
      const testSet = new Set(testIdx);
      const foldTrain = rows.filter((_, i) => !testSet.has(i));
      const fit = fitWindow(foldTrain, 3, 16);
      for (const i of testIdx) errs.push(Math.abs(predictWith(fit, 3, 1, rows[i]).y - rows[i].y));
    }
    return median(errs);
  };
  const realErr = evalWithGroups(comps);
  const rng = makeRng(SEED + 11);
  const baseGroups = comps.map((r) => r.grpValue);
  const permErrs: number[] = [];
  for (let p = 0; p < perms; p++) {
    const permG = shuffle(baseGroups, rng);
    permErrs.push(evalWithGroups(comps.map((r, i) => ({ ...r, grpValue: permG[i] }))));
  }
  const sorted = permErrs.slice().sort((a, b) => a - b);
  return { realErr, permMedian: quantile(sorted, 0.5), permP5: quantile(sorted, 0.05), permP95: quantile(sorted, 0.95) };
}

// Walk-forward origins over dated comps: prefixes 34/41/48/55/62,
// test blocks 7/7/7/7/6. Refit and reselect per origin from its
// training prefix only. Returns per-candidate paired differences
// (challenger minus default, absolute log10 error) per origin.
function walkForward(dated: CompRow[]): {
  origins: { trainN: number; testN: number; diffs: number[][] }[];
} {
  const prefixes = [34, 41, 48, 55, 62];
  const origins: { trainN: number; testN: number; diffs: number[][] }[] = [];
  for (const pref of prefixes) {
    const train = dated.slice(0, pref);
    const test = dated.slice(pref, pref + (pref === 62 ? 6 : 7));
    const inner = innerCV(train);
    const fits = new Map<string, WindowFit>();
    const diffs: number[][] = CANDIDATES.map(() => []);
    const defaultErrs: number[] = [];
    for (const cand of CANDIDATES) {
      const lam = cand.rung >= 3 ? inner.lambdaByRung[cand.rung] : LAMBDAS[1];
      const key = cand.rung + ':' + lam;
      if (!fits.has(key)) fits.set(key, fitWindow(train, cand.rung, lam));
      const fit = fits.get(key)!;
      test.forEach((row, j) => {
        const err = Math.abs(predictWith(fit, cand.rung, cand.s, row).y - row.y);
        if (cand.index === 0) defaultErrs.push(err);
        diffs[cand.index].push(err - defaultErrs[j]);
      });
    }
    origins.push({ trainN: train.length, testN: test.length, diffs });
  }
  return { origins };
}

// Top-40 Spearman: the 40 comps with the largest recorded market
// caps, pooled out-of-fold predictions, tie-corrected.
function top40Spearman(preds: number[], actual: number[], y: number[]): number {
  const order = y.map((v, i) => [v, i] as [number, number]).sort((a, b) => b[0] - a[0]).slice(0, 40).map((e) => e[1]);
  return spearman(order.map((i) => preds[i]), order.map((i) => actual[i]));
}

// ---------------------------------------------------------------- shipped fit

// Build the page-facing parameter object from a full-data window fit.
// Group offsets are remapped onto the global category list so the
// page can score rows with the same arrays it displays.
function shippedParams(fit: WindowFit, rung: number, s: number, lam: number, globalCats: string[]): any {
  const co = [0, 0, 0, 0, 0, 0];
  let k = 2;
  if (rung >= 1) { co[0] = fit.beta[k]; co[3] = fit.beta[k + 1]; k += 2; }
  if (rung >= 2) { co[1] = fit.beta[k]; k += 1; }
  if (rung >= 4) { co[2] = fit.beta[k]; co[5] = fit.beta[k + 1]; }
  const grp = new Array(globalCats.length).fill(0);
  const grpN = new Array(globalCats.length).fill(0);
  fit.ctx.groupId.forEach((localId, value) => {
    const gi = globalCats.indexOf(value);
    if (gi >= 0) { grp[gi] = fit.offsets[localId]; grpN[gi] = fit.ctx.grpN[localId]; }
  });
  return {
    b0: fit.curveBeta[0], b1: fit.curveBeta[1], rung, s, lam,
    age: { days: fit.ctx.ageDays, med: fit.ctx.ageMed, iqr: fit.ctx.ageIqr },
    br: { med: fit.ctx.brMed, iqr: fit.ctx.brIqr, lo: fit.ctx.brLo, hi: fit.ctx.brHi },
    gr: { s: fit.ctx.grS, med: fit.ctx.grMed, iqr: fit.ctx.grIqr, lo: fit.ctx.grLo, hi: fit.ctx.grHi },
    box: { lo: fit.ctx.boxLo, hi: fit.ctx.boxHi },
    co, grp, grpN,
  };
}

// Shipped-model leave-one-out: the shipped form refit per fold with
// frozen hyperparameters (selection excluded).
function shippedModelLOO(comps: CompRow[], rung: number, lam: number, s: number): { preds: number[]; actual: number[] } {
  const preds: number[] = [];
  const actual: number[] = [];
  comps.forEach((held, i) => {
    const train = comps.filter((_, j) => j !== i);
    const fit = fitWindow(train, rung, lam);
    preds.push(predictWith(fit, rung, s, held).y);
    actual.push(held.y);
  });
  return { preds, actual };
}

// Stratified split-conformal quantiles from signed out-of-fold
// errors, with the finite-sample correction and small-stratum
// shrinkage toward the global quantiles (weight n / (n + 15)).
function bandQuantiles(errs: number[], strata: number[]): number[][] {
  const global = [0.1, 0.25, 0.75, 0.9].map((p) => conformalQuantile(errs.slice().sort((a, b) => a - b), p));
  const out: number[][] = [];
  for (let s = 0; s < 3; s++) {
    const se = errs.filter((_, i) => strata[i] === s).sort((a, b) => a - b);
    if (se.length === 0) { out.push(global.slice()); continue; }
    const q = [0.1, 0.25, 0.75, 0.9].map((p) => conformalQuantile(se, p));
    const w = se.length / (se.length + 15);
    out.push(q.map((v, k) => w * v + (1 - w) * global[k]));
  }
  return out;
}

// Rank-percentile conformal half-width from one 60/40 fit/calibration
// split: absolute percentile-rank errors in the calibration universe,
// finite-sample conformal quantile at the nominal 80% level.
function percentileHalfWidth(fitRows: CompRow[], calRows: CompRow[], rung: number, lam: number, s: number): number {
  const fit = fitWindow(fitRows, rung, lam);
  const preds = calRows.map((r) => predictWith(fit, rung, s, r).y);
  const actual = calRows.map((r) => r.y);
  const n = calRows.length;
  const pctOf = (v: number[]) => {
    const order = v.map((x, i) => [x, i] as [number, number]).sort((a, b) => a[0] - b[0]);
    const pct = new Array(n);
    order.forEach(([_, i], rank) => { pct[i] = (rank + 0.5) / n; });
    return pct;
  };
  const pp = pctOf(preds);
  const pa = pctOf(actual);
  const errs = pp.map((p, i) => Math.abs(p - pa[i])).sort((a, b) => a - b);
  return conformalQuantile(errs, 0.8);
}

// ---------------------------------------------------------------- launch table

function logisticFit(X: number[][], y: number[]): number[] {
  let beta = [Math.log(0.116 / 0.884), 0];
  for (let iter = 0; iter < 25; iter++) {
    const grad = [0, 0];
    const hess = [[0, 0], [0, 0]];
    for (let i = 0; i < X.length; i++) {
      const z = beta[0] + beta[1] * X[i][1];
      const p = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
      const d = y[i] - p;
      const w = Math.max(1e-6, p * (1 - p));
      grad[0] += d; grad[1] += d * X[i][1];
      hess[0][0] += w; hess[0][1] += w * X[i][1]; hess[1][0] += w * X[i][1]; hess[1][1] += w * X[i][1] * X[i][1];
    }
    const det = hess[0][0] * hess[1][1] - hess[0][1] * hess[1][0];
    if (Math.abs(det) < 1e-12) break;
    const step0 = (hess[1][1] * grad[0] - hess[0][1] * grad[1]) / det;
    const step1 = (-hess[1][0] * grad[0] + hess[0][0] * grad[1]) / det;
    beta = [beta[0] + step0, beta[1] + step1];
    if (Math.abs(step0) < 1e-9 && Math.abs(step1) < 1e-9) break;
  }
  return beta;
}

// ---------------------------------------------------------------- main

function parseArgs(): { input: string; output: string } {
  const args = process.argv.slice(2);
  let input = '/input/snapshot.json';
  let output = process.env.MAKEFUN_OUTPUT_DIR || '/output';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) input = args[++i];
    else if (args[i] === '--output' && args[i + 1]) output = args[++i];
  }
  return { input, output };
}

function r4(v: number): number { return Math.round(v * 1e4) / 1e4; }
function r3(v: number): number { return Math.round(v * 1e3) / 1e3; }
function r2(v: number): number { return Math.round(v * 1e2) / 1e2; }
function r1(v: number): number { return Math.round(v * 1e1) / 1e1; }

function main() {
  const tStart = performance.now();
  const { input, output } = parseArgs();
  const snap = JSON.parse(readFileSync(input, 'utf8'));
  const protocols: Proto[] = snap.protocols;
  const asOfMs = Date.parse(snap.as_of + 'T00:00:00Z');
  assert(!Number.isNaN(asOfMs), 'snapshot as_of must parse');
  const watchSet = new Set<string>(snap.watchlist);
  const tParse = performance.now();

  // Census and exclusions FIRST. Every protocol lands in exactly one
  // bucket; the buckets sum to the actual protocol count.
  const census = {
    hold: 0, watch: 0, below: 0, catEx: 0, nameEx: 0, liveFit: 0, liveOther: 0,
    holdTvl: 0, catExTvl: 0, nameExTvl: 0, liveFitTvl: 0, liveOtherTvl: 0,
    liveExcluded: 0, liveDust: 0, liveMissingMcap: 0, liveNoIdentifier: 0,
  };
  const boardProtos: Proto[] = [];
  const compProtos: Proto[] = [];
  const compScreen = (p: Proto): string | null => {
    if (!(p.mcap_usd !== null && p.mcap_usd > 0 && (p.gecko_id !== null || p.symbol !== null))) return 'no-token-record';
    if (!(p.tvl_usd >= 5000000)) return 'tvl-floor';
    if (exclusionReasons(p).length > 0) return 'excluded';
    if (p.mcap_usd < 100000) return 'dust-mcap';
    const ratio = p.mcap_usd / p.tvl_usd;
    if (ratio < 0.005 || ratio > 500) return 'ratio-window';
    return null;
  };
  const screenCounts = new Map<string, number>();
  for (const p of protocols) {
    const badDate = p.listed_at !== null && Number.isNaN(Date.parse(p.listed_at + 'T00:00:00Z'));
    if (!(p.tvl_usd > 0) || badDate) {
      census.hold++; census.holdTvl += p.tvl_usd || 0;
      continue;
    }
    const reasons = exclusionReasons(p);
    if (recordsNoToken(p)) {
      if (reasons.length === 0) {
        boardProtos.push(p);
        if (watchSet.has(p.slug)) census.watch++; else census.below++;
      } else if (reasons[0] === 'category') {
        census.catEx++; census.catExTvl += p.tvl_usd;
      } else {
        census.nameEx++; census.nameExTvl += p.tvl_usd;
      }
    } else {
      const reason = compScreen(p);
      screenCounts.set(reason || 'pass', (screenCounts.get(reason || 'pass') || 0) + 1);
      if (reason === null) {
        compProtos.push(p);
        census.liveFit++; census.liveFitTvl += p.tvl_usd;
      } else {
        census.liveOther++; census.liveOtherTvl += p.tvl_usd;
        if (p.mcap_usd === null) census.liveMissingMcap++;
        else if (reason === 'excluded') census.liveExcluded++;
        else if (reason === 'dust-mcap' || reason === 'ratio-window') census.liveDust++;
        else census.liveNoIdentifier++;
      }
    }
  }
  const censusSum = census.hold + census.watch + census.below + census.catEx + census.nameEx + census.liveFit + census.liveOther;
  assert(censusSum === protocols.length, 'census buckets must sum to the protocol count');
  assert(census.watch === snap.watchlist.length, 'every watchlist slug must be an eligible board row');
  for (const slug of snap.watchlist) assert(boardProtos.some((p) => p.slug === slug), 'watchlist slug missing from board: ' + slug);
  const boardSlugs = new Set(boardProtos.map((p) => p.slug));
  for (const p of compProtos) assert(!boardSlugs.has(p.slug), 'board and live pools must not overlap');

  const comps: CompRow[] = compProtos
    .map((proto) => ({
      proto,
      y: Math.log10(proto.mcap_usd!),
      x: Math.log10(proto.tvl_usd / 50000000),
      days: daysSince(asOfMs, proto.listed_at),
      grpValue: proto.category,
      nCh: proto.chains.length,
      chg: proto.change_7d,
    }))
    .sort((a, b) => (a.proto.slug < b.proto.slug ? -1 : 1));
  const dated = comps
    .filter((r) => r.days !== null)
    .sort((a, b) => (b.days! - a.days!) || (a.proto.slug < b.proto.slug ? -1 : 1));
  const tCensus = performance.now();

  // Frozen validation contract.
  const nested = nestedLOO(comps);
  const candMed = CANDIDATES.map((c) => median(nested.candPreds[c.index].map((p, i) => Math.abs(p - nested.actual[i]))));
  const candSpear = CANDIDATES.map((c) => spearman(nested.candPreds[c.index], nested.actual));
  const defaultMed = candMed[0];
  const defaultSpear = candSpear[0];
  const flatMed = median(nested.flatPreds.map((p, i) => Math.abs(p - nested.actual[i])));
  const procMed = median(nested.procPreds.map((p, i) => Math.abs(p - nested.actual[i])));
  const fullInner = innerCV(comps);
  const placebo = placeboGains(comps, 200);
  const g1Bar = Math.max(0.008, placebo.p95);
  const grpPerm = groupPermutation(comps, 200);
  const wf = walkForward(dated);
  const tValid = performance.now();

  // Shipping gate G1-G4 per candidate.
  const bootRng = makeRng(SEED + 21);
  const ledger: any[] = [];
  let shipped: Candidate = CANDIDATES[0];
  let shippedLam = LAMBDAS[1];
  let bestEligibleMed = Infinity;
  for (const cand of CANDIDATES) {
    const gain = defaultMed - candMed[cand.index];
    const improvements = nested.actual.map((_, i) => Math.abs(nested.candPreds[0][i] - nested.actual[i]) - Math.abs(nested.candPreds[cand.index][i] - nested.actual[i]));
    const boot = bootstrapMean(improvements, 2000, bootRng);
    const g1 = cand.index !== 0 && gain >= g1Bar && boot.p5 > -0.05;
    const pooledDiffs: number[] = [];
    const perOrigin: { mean: number; se: number }[] = [];
    for (const origin of wf.origins) {
      const d = origin.diffs[cand.index];
      pooledDiffs.push(...d);
      const b = bootstrapMean(d, 2000, bootRng);
      perOrigin.push({ mean: mean(d), se: b.se });
    }
    const pooledBoot = bootstrapMean(pooledDiffs, 2000, bootRng);
    const pooledMean = mean(pooledDiffs);
    const g2 = cand.index !== 0 && pooledMean <= 1.0 * pooledBoot.se;
    const g3 = cand.index !== 0 && perOrigin.every((o) => o.mean <= 1.5 * o.se);
    const top40 = top40Spearman(nested.candPreds[cand.index], nested.actual, nested.actual.map((_, i) => comps[i].y));
    const top40Def = top40Spearman(nested.candPreds[0], nested.actual, nested.actual.map((_, i) => comps[i].y));
    const order40 = comps.map((r, i) => [r.y, i] as [number, number]).sort((a, b) => b[0] - a[0]).slice(0, 40).map((e) => e[1]);
    const spearDiffs: number[] = [];
    const rng40 = makeRng(SEED + 29 + cand.index);
    for (let d = 0; d < 2000; d++) {
      const idx: number[] = [];
      for (let k = 0; k < 40; k++) idx.push(order40[Math.floor(rng40() * 40)]);
      const sC = spearman(idx.map((i) => nested.candPreds[cand.index][i]), idx.map((i) => nested.actual[i]));
      const sD = spearman(idx.map((i) => nested.candPreds[0][i]), idx.map((i) => nested.actual[i]));
      spearDiffs.push(sD - sC);
    }
    const spearSE = stdev(spearDiffs);
    const g4 = cand.index !== 0 && (top40Def - top40) <= 1.0 * spearSE;
    const eligible = g1 && g2 && g3 && g4;
    const lam = cand.rung >= 3 ? fullInner.lambdaByRung[cand.rung] : 0;
    ledger.push({
      cand, lam, med: candMed[cand.index], gain, bootP5: boot.p5,
      pooledMean, pooledSE: pooledBoot.se, perOrigin,
      top40, top40Def, spearSE, g1, g2, g3, g4, eligible,
    });
    if (eligible) {
      const better = candMed[cand.index] < bestEligibleMed - 1e-12
        || (Math.abs(candMed[cand.index] - bestEligibleMed) <= 1e-12 && (cand.s > shipped.s
          || (cand.s === shipped.s && (cand.rung > shipped.rung
            || (cand.rung === shipped.rung && (lam > shippedLam
              || (lam === shippedLam && cand.index < shipped.index)))))));
      if (better) { shipped = cand; shippedLam = lam; bestEligibleMed = candMed[cand.index]; }
    }
  }
  if (ledger.every((l) => !l.eligible)) { shipped = CANDIDATES[0]; shippedLam = LAMBDAS[1]; }
  const shippedGain = defaultMed - candMed[shipped.index];
  const gainPosition = placebo.gains.filter((g) => g <= shippedGain).length / placebo.gains.length;

  // Shipped fit on all comps with the selected rung, lambda, blend.
  const globalCats = [...new Set(protocols.map((p) => p.category).filter((c) => c !== null))].sort() as string[];
  const globalChains = [...new Set(protocols.map((p) => p.chains[0]))].sort();
  const shippedFit = fitWindow(comps, shipped.rung, shippedLam);
  const params = shippedParams(shippedFit, shipped.rung, shipped.s, shippedLam, globalCats);
  const compTvlMin = Math.min(...comps.map((r) => r.proto.tvl_usd));
  const compTvlMax = Math.max(...comps.map((r) => r.proto.tvl_usd));

  // Board candidates with scoring fields, in slug order for now.
  const boardFeats = boardProtos.map((proto) => ({
    proto,
    x: Math.log10(proto.tvl_usd / 50000000),
    days: daysSince(asOfMs, proto.listed_at),
    grpValue: proto.category,
    nCh: proto.chains.length,
    chg: proto.change_7d,
  }));
  // Shared-code equivalence: the page-facing scorer must agree with
  // the fitting path on every board row.
  for (const bf of boardFeats) {
    const raw = { tvl: bf.proto.tvl_usd, chg: bf.chg, days: bf.days, nCh: bf.nCh, grp: bf.grpValue === null ? -1 : globalCats.indexOf(bf.grpValue) };
    const a = RadarModel.scoreProtocol(params, raw).y;
    const b = predictWith(shippedFit, shipped.rung, shipped.s, bf).y;
    assert(Math.abs(a - b) < 1e-9, 'shared scorer disagrees with fitting path for ' + bf.proto.slug);
  }

  // Shipped-model LOO, bands, coverage.
  const shipLOO = shippedModelLOO(comps, shipped.rung, shippedLam, shipped.s);
  const shipMed = median(shipLOO.preds.map((p, i) => Math.abs(p - shipLOO.actual[i])));
  const shipSpear = spearman(shipLOO.preds, shipLOO.actual);
  const looErrs = shipLOO.preds.map((p, i) => p - shipLOO.actual[i]);
  const looStrata = comps.map((r) => RadarModel.stratumFor(r.days, r.grpValue === null ? -1 : globalCats.indexOf(r.grpValue), params.grpN));
  const quantiles = bandQuantiles(looErrs, looStrata);
  const qWide = [
    Math.min(quantiles[0][0], quantiles[1][0], quantiles[2][0]),
    Math.min(quantiles[0][1], quantiles[1][1], quantiles[2][1]),
    Math.max(quantiles[0][2], quantiles[1][2], quantiles[2][2]),
    Math.max(quantiles[0][3], quantiles[1][3], quantiles[2][3]),
  ];
  // Nested out-of-fold coverage: each row's band from the other rows.
  let cov80 = 0, cov50 = 0;
  for (let i = 0; i < comps.length; i++) {
    const others = looErrs.filter((_, j) => j !== i);
    const otherStrata = looStrata.filter((_, j) => j !== i);
    const q = bandQuantiles(others, otherStrata)[looStrata[i]];
    const pred = shipLOO.preds[i];
    const act = shipLOO.actual[i];
    if (act >= pred + q[0] && act <= pred + q[3]) cov80++;
    if (act >= pred + q[1] && act <= pred + q[2]) cov50++;
  }
  // Time-split coverage: earliest 70% train, newest 30% test.
  const splitAt = Math.floor(dated.length * 0.7);
  const tsTrain = dated.slice(0, splitAt);
  const tsTest = dated.slice(splitAt);
  const tsLOO = shippedModelLOO(tsTrain, shipped.rung, shippedLam, shipped.s);
  const tsErrs = tsLOO.preds.map((p, i) => p - tsLOO.actual[i]);
  const tsQ = [0.1, 0.25, 0.75, 0.9].map((p) => conformalQuantile(tsErrs.slice().sort((a, b) => a - b), p));
  const tsFit = fitWindow(tsTrain, shipped.rung, shippedLam);
  let tsCov80 = 0, tsCov50 = 0;
  for (const row of tsTest) {
    const pred = predictWith(tsFit, shipped.rung, shipped.s, row).y;
    if (row.y >= pred + tsQ[0] && row.y <= pred + tsQ[3]) tsCov80++;
    if (row.y >= pred + tsQ[1] && row.y <= pred + tsQ[2]) tsCov50++;
  }
  // Rank-percentile conformal half-width: final 60/40 split, seeded.
  const rngSplit = makeRng(SEED + 37);
  const shuffled = shuffle(comps, rngSplit);
  const cut60 = Math.floor(comps.length * 0.6);
  const pctQ = percentileHalfWidth(shuffled.slice(0, cut60), shuffled.slice(cut60), shipped.rung, shippedLam, shipped.s);
  // Cross-fitted coverage and widths (diagnostic, one labeled print).
  const rngFolds = makeRng(SEED + 41);
  const foldAssign = shuffle(comps.map((_, i) => i), rngFolds);
  const crossWidths: number[] = [];
  let crossCovered = 0, crossTotal = 0;
  for (let f = 0; f < 5; f++) {
    const outerIdx = foldAssign.filter((_, k) => k % 5 === f);
    const restIdx = foldAssign.filter((_, k) => k % 5 !== f);
    const restShuffled = shuffle(restIdx, rngFolds);
    const cutR = Math.floor(restShuffled.length * 0.6);
    const fitRows = restShuffled.slice(0, cutR).map((i) => comps[i]);
    const calRows = restShuffled.slice(cutR).map((i) => comps[i]);
    const qCal = percentileHalfWidth(fitRows, calRows, shipped.rung, shippedLam, shipped.s);
    const outerRows = outerIdx.map((i) => comps[i]);
    const fitOuter = fitWindow(fitRows.concat(calRows), shipped.rung, shippedLam);
    const preds = outerRows.map((r) => predictWith(fitOuter, shipped.rung, shipped.s, r).y);
    const nO = outerRows.length;
    const pctOf = (v: number[]) => {
      const order = v.map((x, i) => [x, i] as [number, number]).sort((a, b) => a[0] - b[0]);
      const pct = new Array(nO);
      order.forEach(([_, i], rank) => { pct[i] = (rank + 0.5) / nO; });
      return pct;
    };
    const pp = pctOf(preds);
    const pa = pctOf(outerRows.map((r) => r.y));
    for (let i = 0; i < nO; i++) {
      const lo = Math.max(0, pp[i] - qCal);
      const hi = Math.min(1, pp[i] + qCal);
      if (pa[i] >= lo && pa[i] <= hi) crossCovered++;
      crossTotal++;
      crossWidths.push((hi - lo) * boardProtos.length);
    }
  }
  const crossCov = crossTotal > 0 ? crossCovered / crossTotal : 0;

  // Refit core: 200 deterministic bootstrap refits of the selected
  // model, re-ranking the full board per refit; central 80% rank range.
  const rngBoot = makeRng(SEED + 43);
  const rankSamples: number[][] = boardFeats.map(() => []);
  for (let b = 0; b < 200; b++) {
    const sample: CompRow[] = [];
    for (let k = 0; k < comps.length; k++) sample.push(comps[Math.floor(rngBoot() * comps.length)]);
    const fit = fitWindow(sample, shipped.rung, shippedLam);
    const scored = boardFeats.map((bf, i) => ({ i, y: predictWith(fit, shipped.rung, shipped.s, bf).y, tvl: bf.proto.tvl_usd, slug: bf.proto.slug }));
    scored.sort((a, b) => (b.y - a.y) || (b.tvl - a.tvl) || (a.slug < b.slug ? -1 : 1));
    scored.forEach((s, rank) => { rankSamples[s.i].push(rank + 1); });
  }
  const cores = rankSamples.map((rs) => {
    const s = rs.slice().sort((a, b) => a - b);
    return [Math.round(quantile(s, 0.1)), Math.round(quantile(s, 0.9))];
  });
  const tBands = performance.now();

  // Launch table: 3 age buckets x 3 TVL buckets over dated rows,
  // shrunk toward the additive fit with lambda 20. Verdict-side only,
  // through the displayed margin; never in the primary rank.
  const ageBucket = (days: number | null): number => (days === null ? -1 : days < 365 ? 0 : days < 730 ? 1 : 2);
  const tvlBucket = (tvl: number): number => (tvl < 25000000 ? 0 : tvl <= 150000000 ? 1 : 2);
  const isComp = (p: Proto): boolean => compScreen(p) === null;
  const datedRows = protocols.filter((p) => {
    const badDate = p.listed_at !== null && Number.isNaN(Date.parse(p.listed_at + 'T00:00:00Z'));
    return p.tvl_usd > 0 && !badDate && daysSince(asOfMs, p.listed_at) !== null;
  });
  const datedBase = datedRows.filter(isComp).length / datedRows.length;
  const baseAll = compProtos.length / protocols.length;
  const launchCells: { age: number; tvl: number; n: number; k: number; rate: number; weight: number }[] = [];
  {
    const ageMarg = [0, 1, 2].map((a) => {
      const rows = datedRows.filter((p) => ageBucket(daysSince(asOfMs, p.listed_at)) === a);
      return rows.length ? rows.filter(isComp).length / rows.length : datedBase;
    });
    const tvlMarg = [0, 1, 2].map((t) => {
      const rows = datedRows.filter((p) => tvlBucket(p.tvl_usd) === t);
      return rows.length ? rows.filter(isComp).length / rows.length : datedBase;
    });
    for (let a = 0; a < 3; a++) for (let t = 0; t < 3; t++) {
      const rows = datedRows.filter((p) => ageBucket(daysSince(asOfMs, p.listed_at)) === a && tvlBucket(p.tvl_usd) === t);
      const k = rows.filter(isComp).length;
      const pAdd = Math.max(0, Math.min(1, ageMarg[a] + tvlMarg[t] - datedBase));
      const rate = (k + 20 * pAdd) / (rows.length + 20);
      launchCells.push({ age: a, tvl: t, n: rows.length, k, rate, weight: rows.length / (rows.length + 20) });
    }
    (launchCells as any).ageMarg = ageMarg;
    (launchCells as any).tvlMarg = tvlMarg;
  }
  const tvlMargShrunk = [0, 1, 2].map((t) => {
    const rows = datedRows.filter((p) => tvlBucket(p.tvl_usd) === t);
    const k = rows.filter(isComp).length;
    return (k + 20 * datedBase) / (rows.length + 20);
  });
  // Brier gate: 5 folds grouped by cohort over all usable rows.
  const usable = protocols.filter((p) => {
    const badDate = p.listed_at !== null && Number.isNaN(Date.parse(p.listed_at + 'T00:00:00Z'));
    return p.tvl_usd > 0 && !badDate;
  });
  const cohortKey = (p: Proto): string => ageBucket(daysSince(asOfMs, p.listed_at)) + ':' + tvlBucket(p.tvl_usd);
  const cohortGroups = new Map<string, Proto[]>();
  for (const p of usable) {
    const key = cohortKey(p);
    if (!cohortGroups.has(key)) cohortGroups.set(key, []);
    cohortGroups.get(key)!.push(p);
  }
  const brierFolds: Proto[][] = [[], [], [], [], []];
  for (const group of cohortGroups.values()) {
    group.sort((a, b) => (a.slug < b.slug ? -1 : 1));
    group.forEach((p, k) => { brierFolds[k % 5].push(p); });
  }
  const brierScores = { table: [] as number[], baseA: [] as number[], baseB: [] as number[] };
  const foldSigns: boolean[] = [];
  for (let f = 0; f < 5; f++) {
    const test = brierFolds[f];
    const train = brierFolds.flatMap((fold, k) => (k === f ? [] : fold));
    const trainDated = train.filter((p) => daysSince(asOfMs, p.listed_at) !== null);
    const trainBase = train.filter(isComp).length / train.length;
    const trainDatedBase = trainDated.filter(isComp).length / trainDated.length;
    const cellRate = (p: Proto): number => {
      const a = ageBucket(daysSince(asOfMs, p.listed_at));
      const t = tvlBucket(p.tvl_usd);
      if (a < 0) {
        const rows = trainDated.filter((q) => tvlBucket(q.tvl_usd) === t);
        return (rows.filter(isComp).length + 20 * trainDatedBase) / (rows.length + 20);
      }
      const rows = trainDated.filter((q) => ageBucket(daysSince(asOfMs, q.listed_at)) === a && tvlBucket(q.tvl_usd) === t);
      const aRows = trainDated.filter((q) => ageBucket(daysSince(asOfMs, q.listed_at)) === a);
      const tRows = trainDated.filter((q) => tvlBucket(q.tvl_usd) === t);
      const pAdd = Math.max(0, Math.min(1,
        (aRows.filter(isComp).length / Math.max(1, aRows.length)) + (tRows.filter(isComp).length / Math.max(1, tRows.length)) - trainDatedBase));
      return (rows.filter(isComp).length + 20 * pAdd) / (rows.length + 20);
    };
    const logBeta = logisticFit(train.map((p) => [1, Math.log10(p.tvl_usd)]), train.map((p) => (isComp(p) ? 1 : 0)));
    let sT = 0, sA = 0, sB = 0;
    for (const p of test) {
      const y = isComp(p) ? 1 : 0;
      const pT = cellRate(p);
      const z = logBeta[0] + logBeta[1] * Math.log10(p.tvl_usd);
      const pB = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
      sT += (pT - y) * (pT - y);
      sA += (trainBase - y) * (trainBase - y);
      sB += (pB - y) * (pB - y);
    }
    brierScores.table.push(sT / test.length);
    brierScores.baseA.push(sA / test.length);
    brierScores.baseB.push(sB / test.length);
    foldSigns.push(sT < sB);
  }
  const brierTable = mean(brierScores.table);
  const brierA = mean(brierScores.baseA);
  const brierB = mean(brierScores.baseB);
  const launchGate = brierTable < brierB - 0.003 && foldSigns.filter(Boolean).length >= 4;

  // Sensitivity report: 10% highest-leverage comps removed, and the
  // integrity window widened to [0.001, 1000]. A slope move over 15%
  // under either is stated as fragility in the methodology text.
  const curveX = comps.map((r) => [1, r.x]);
  const curveY = comps.map((r) => r.y);
  const baseCurve = huberFit(curveX, curveY).beta;
  const XtX = [[0, 0], [0, 0]];
  for (const xi of curveX) { XtX[0][0] += xi[0] * xi[0]; XtX[0][1] += xi[0] * xi[1]; XtX[1][0] += xi[1] * xi[0]; XtX[1][1] += xi[1] * xi[1]; }
  const leverages = curveX.map((xi) => {
    const z = solveLinear(XtX, xi)!;
    return xi[0] * z[0] + xi[1] * z[1];
  });
  const levOrder = leverages.map((v, i) => [v, i] as [number, number]).sort((a, b) => b[0] - a[0]);
  const dropSet = new Set(levOrder.slice(0, Math.ceil(comps.length * 0.1)).map((e) => e[1]));
  const levKept = comps.filter((_, i) => !dropSet.has(i));
  const levCurve = huberFit(levKept.map((r) => [1, r.x]), levKept.map((r) => r.y)).beta;
  const levSlopeChg = Math.abs(levCurve[1] - baseCurve[1]) / Math.abs(baseCurve[1]);
  const wideComps = protocols.filter((p) => {
    if (!(p.mcap_usd !== null && p.mcap_usd > 0 && (p.gecko_id !== null || p.symbol !== null))) return false;
    if (!(p.tvl_usd >= 5000000)) return false;
    if (exclusionReasons(p).length > 0) return false;
    if (p.mcap_usd < 100000) return false;
    const ratio = p.mcap_usd / p.tvl_usd;
    return ratio >= 0.001 && ratio <= 1000;
  });
  const wideCurve = huberFit(
    wideComps.map((p) => [1, Math.log10(p.tvl_usd / 50000000)]),
    wideComps.map((p) => Math.log10(p.mcap_usd!)),
  ).beta;
  const wideSlopeChg = Math.abs(wideCurve[1] - baseCurve[1]) / Math.abs(baseCurve[1]);
  const fragile = levSlopeChg > 0.15 || wideSlopeChg > 0.15;

  // Ablations (printed, non-shipping): raw log-age versus percentile
  // age at R1, and the group-lambda grid at R3, s = 1.
  const logAgeAblation = (() => {
    const folds = groupDisjointFolds(comps, 5);
    const errsPct: number[] = [];
    const errsLog: number[] = [];
    for (const testIdx of folds) {
      const testSet = new Set(testIdx);
      const foldTrain = comps.filter((_, i) => !testSet.has(i));
      const foldTest = testIdx.map((i) => comps[i]);
      const fit = fitWindow(foldTrain, 1, LAMBDAS[1]);
      for (const row of foldTest) errsPct.push(Math.abs(predictWith(fit, 1, 1, row).y - row.y));
      // Raw log-age variant: log1p(days), standardized by fold IQR,
      // median imputation plus indicator for missing tenure.
      const logVals = foldTrain.filter((r) => r.days !== null).map((r) => Math.log1p(r.days!));
      const med = median(logVals);
      const sd = iqr(logVals);
      const feats = (r: CompRow): number[] => {
        const v = r.days === null ? med : Math.log1p(r.days);
        return [1, r.x, sd > 0 ? (v - med) / sd : 0, r.days === null ? 1 : 0];
      };
      const b = huberFit(foldTrain.map(feats), foldTrain.map((r) => r.y)).beta;
      const clipped = b.slice();
      clipped[2] = Math.max(-0.25, Math.min(0.25, clipped[2]));
      clipped[3] = Math.max(-0.15, Math.min(0.15, clipped[3]));
      for (const row of foldTest) {
        const f = feats(row);
        const pred = f.reduce((s, v, k) => s + v * clipped[k], 0);
        errsLog.push(Math.abs(pred - row.y));
      }
    }
    return { pctErr: median(errsPct), logErr: median(errsLog) };
  })();
  const lambdaAblation = (() => {
    const folds = groupDisjointFolds(comps, 5);
    const grid = [0, 2, 4, 8, 16, 32, Infinity];
    return grid.map((lam) => {
      const errs: number[] = [];
      for (const testIdx of folds) {
        const testSet = new Set(testIdx);
        const foldTrain = comps.filter((_, i) => !testSet.has(i));
        const fit = fitWindow(foldTrain, 3, lam);
        for (const i of testIdx) errs.push(Math.abs(predictWith(fit, 3, 1, comps[i]).y - comps[i].y));
      }
      return { lam: lam === Infinity ? -1 : lam, err: median(errs) };
    });
  })();
  const tAnalysis = performance.now();

  // Board assembly: score, rank, band, economics, tier, chips,
  // launch margin, farm steps — all through the shared modules.
  const eligibleProtos = protocols.filter((p) => {
    const badDate = p.listed_at !== null && Number.isNaN(Date.parse(p.listed_at + 'T00:00:00Z'));
    return p.tvl_usd > 0 && !badDate && exclusionReasons(p).length === 0;
  });
  const tradedEligible = eligibleProtos.filter((p) => !recordsNoToken(p)).length;
  const pGlobal = tradedEligible / eligibleProtos.length;
  const peerRates = globalCats.map((cat) => {
    const rows = eligibleProtos.filter((p) => p.category === cat);
    const k = rows.filter((p) => !recordsNoToken(p)).length;
    return (k + 5 * pGlobal) / (rows.length + 5);
  });
  const peerK = globalCats.map((cat) => eligibleProtos.filter((p) => p.category === cat && !recordsNoToken(p)).length);
  const nBoard = boardFeats.length;

  interface BoardRow {
    slug: string; name: string; catIdx: number; chainIdx: number; nCh: number;
    tvl: number; chg: number | null; days: number | null; y: number; curveOnly: boolean;
    implied: number; rank: number; band: number[]; core: number[]; top10: number;
    econ: any; gas: any; tier: number; chips: number; peerRate: number; noPeer: boolean;
    launchP: number; launchM: number; steps: string[]; stratum: number;
  }
  const board: BoardRow[] = boardFeats.map((bf, i) => {
    const proto = bf.proto;
    const catIdx = proto.category === null ? -1 : globalCats.indexOf(proto.category);
    // The payload carries change_7d rounded to 1 decimal and TVL
    // rounded to thousands; score and build steps from the rounded
    // values so every recompute agrees exactly.
    const chgR = bf.chg === null ? null : r1(bf.chg);
    const tvlR = Math.round(proto.tvl_usd / 1000) * 1000;
    const raw = { tvl: tvlR, chg: chgR, days: bf.days, nCh: proto.chains.length, grp: catIdx };
    const scored = RadarModel.scoreProtocol(params, raw);
    const implied = Math.round(Math.pow(10, scored.y));
    assert(implied > 0 && implied <= 100000000000000, 'implied value outside the gate range for ' + proto.slug);
    const stratum = RadarModel.stratumFor(bf.days, catIdx, params.grpN);
    const noPeer = catIdx >= 0 && peerK[catIdx] === 0;
    const peerRate = catIdx >= 0 ? peerRates[catIdx] : pGlobal;
    const gas = RadarModel.gasFor(proto.chains[0], proto.chains.length);
    const econ = RadarModel.computeFarmEconomics({ tvl: tvlR, nCh: proto.chains.length }, implied, noPeer, gas);
    let chips = 0;
    if (bf.days === null) chips |= 1;
    if (chgR === null) chips |= 2;
    if (shipped.rung >= 3 && catIdx >= 0 && params.grpN[catIdx] < 3) chips |= 4;
    if (noPeer) chips |= 8;
    if (scored.curveOnly) chips |= 16;
    if (bf.days === null) chips |= 32;
    if (proto.category === null) chips |= 64;
    const steps = RadarFarm.buildFarmPlan(
      { name: proto.name, tvl: tvlR, nCh: proto.chains.length, cat: proto.category, chg: chgR, days: bf.days, chain: proto.chains[0] },
      econ, gas,
    );
    assert(steps.length === 6, 'farm plan must have exactly 6 steps: ' + proto.slug);
    for (const st of steps) assert(st.length >= 60 && st.length <= 420, 'farm step length out of range for ' + proto.slug + ': ' + st.length);
    return {
      slug: proto.slug, name: proto.name, catIdx, chainIdx: globalChains.indexOf(proto.chains[0]),
      nCh: proto.chains.length, tvl: tvlR, chg: chgR, days: bf.days,
      y: scored.y, curveOnly: scored.curveOnly, implied, rank: 0,
      band: [0, 0], core: cores[i], top10: 0, econ, gas, tier: econ.tier, chips,
      peerRate, noPeer, launchP: 0, launchM: 0, steps, stratum,
    };
  });
  board.sort((a, b) => (b.y - a.y) || (b.tvl - a.tvl) || (a.slug < b.slug ? -1 : 1));
  board.forEach((row, i) => {
    row.rank = i + 1;
    row.band = RadarModel.pctRankBand(row.rank, nBoard, pctQ);
    row.top10 = RadarModel.top10Flag(row.core, row.band);
  });
  const tierCounts = [0, 0, 0, 0];
  for (const row of board) tierCounts[row.tier]++;
  const curveOnlyCount = board.filter((r) => r.curveOnly).length;
  const netC = (row: BoardRow): number => Math.round(row.econ.netHrs[0][1] * 100);
  const medImplied = median(board.map((r) => r.implied));
  const earlyBelow = dated.length > 0 ? dated.slice(0, Math.ceil(dated.length / 2)).filter((r) => r.y < Math.log10(medImplied)).length / Math.ceil(dated.length / 2) : 0;

  // Portfolio: all positive $1,000 POINT nets; top-12 concentrated
  // line; the warned subset (category with no traded peer).
  const positive = board.filter((r) => r.econ.netHrs[0][1] > 0);
  const portNet = (rows: BoardRow[]): number => rows.reduce((s, r) => s + r.econ.netHrs[0][1] * r.econ.hours, 0);
  const portHours = (rows: BoardRow[]): number => rows.reduce((s, r) => s + r.econ.hours, 0);
  const portDeployed = positive.length * 1000;
  const portNetVal = portNet(positive);
  const portHoursVal = portHours(positive);
  const top12 = positive.slice().sort((a, b) => b.econ.netHrs[0][1] - a.econ.netHrs[0][1]).slice(0, 12);
  const warned = positive.filter((r) => r.noPeer);
  const allNets = board.map((r) => r.econ.netHrs[0][1]).sort((a, b) => a - b);
  const posNets = allNets.filter((v) => v > 0);
  const portLine = {
    n: positive.length, deployed: portDeployed, net: portNetVal, hours: portHoursVal,
    perHr: portHoursVal > 0 ? portNetVal / portHoursVal : 0,
    worst: positive.length ? Math.min(...positive.map((r) => r.econ.netHrs[0][1])) : 0,
    top12: { deployed: top12.length * 1000, net: portNet(top12), hours: portHours(top12), perHr: portHours(top12) > 0 ? portNet(top12) / portHours(top12) : 0 },
    warned: { n: warned.length, perHr: portHours(warned) > 0 ? portNet(warned) / portHours(warned) : 0 },
    medAll: median(allNets), medPos: posNets.length ? median(posNets) : 0,
    q1: quantile(allNets, 0.25), q3: quantile(allNets, 0.75),
  };

  // Practical strip: top 6 by the single net definition ($1,000 POINT
  // net per hour at full share), strictly positive, best first.
  const stripRows = board.filter((r) => r.econ.netHrs[0][1] > 0)
    .sort((a, b) => (b.econ.netHrs[0][1] - a.econ.netHrs[0][1]) || (a.rank - b.rank))
    .slice(0, 6);
  const stripIdx = stripRows.map((r) => board.indexOf(r));

  // Sensitivity grid: hurdle rows plus quartiles plus both medians.
  const sensGrid = [5, 10, 15].map((h) => {
    const rows = board.filter((r) => r.econ.netHrs[0][1] >= h);
    return { hurdle: h, count: rows.length, farmRobust: rows.filter((r) => r.tier <= 1).length };
  });

  // Band and core widths in rows.
  const bandWidths = board.map((r) => r.band[1] - r.band[0]);
  const coreWidths = board.map((r) => r.core[1] - r.core[0]);
  let coreFlags = 0;
  for (const row of board) {
    if (row.core[0] < row.band[0] || row.core[1] > row.band[1]) coreFlags++;
  }
  const tBoard = performance.now();

  // Payload: raw fields plus shipped parameters only. The page
  // re-derives every displayed number from this; nothing else is
  // carried. Rounded values are display-only and are re-derived in
  // the verification pass below.
  const payload = {
    v: 4,
    meta: {
      asOf: snap.as_of, nProto: protocols.length,
      nBoard, nComps: comps.length, nWatch: census.watch,
      medImplied: Math.round(medImplied),
      earlyBelow: r3(earlyBelow), curveOnly: curveOnlyCount,
      tiers: tierCounts, pGlobal: r3(pGlobal),
    },
    cats: globalCats,
    chains: globalChains,
    peerRates: peerRates.map(r3),
    params: {
      b0: params.b0, b1: params.b1, rung: params.rung, s: params.s, lam: params.lam,
      age: params.age, br: params.br, gr: params.gr, box: params.box,
      co: params.co, grp: params.grp, grpN: params.grpN,
      q: quantiles, qWide, pctQ, compTvl: [compTvlMin, compTvlMax],
    },
    rows: board.map((row) => [
      row.name, row.catIdx, row.chainIdx, row.nCh, row.tvl, row.chg, row.days,
      row.core[0], row.core[1], row.tier,
      netC(row), row.econ.paysFrom, r2(row.econ.beOdds), row.chips,
      watchSet.has(row.slug) ? 1 : 0,
    ]),
    comps: comps.map((r) => [r3(Math.log10(r.proto.tvl_usd)), r3(Math.log10(r.proto.mcap_usd))]),
    census: {
      hold: census.hold, watch: census.watch, below: census.below,
      catEx: census.catEx, nameEx: census.nameEx, liveFit: census.liveFit, liveOther: census.liveOther,
      holdTvl: census.holdTvl, catExTvl: census.catExTvl, nameExTvl: census.nameExTvl,
      liveFitTvl: census.liveFitTvl, liveOtherTvl: census.liveOtherTvl,
      liveExcluded: census.liveExcluded, liveDust: census.liveDust,
      liveMissingMcap: census.liveMissingMcap, liveNoIdentifier: census.liveNoIdentifier,
    },
    val: {
      ship: { rung: shipped.rung, s: shipped.s, lam: shippedLam },
      top40Def: r3(ledger[0].top40Def),
      nestedMed: r4(procMed), nestedMult: r4(Math.pow(10, procMed)),
      shippedMed: r4(shipMed), shippedMult: r4(Math.pow(10, shipMed)), shippedSpear: r3(shipSpear),
      defaultMed: r4(defaultMed), defaultMult: r4(Math.pow(10, defaultMed)),
      flatMed: r4(flatMed), flatMult: r4(Math.pow(10, flatMed)),
      ledger: ledger.map((l) => [
        l.cand.rung, l.cand.s, l.lam, r3(l.med), r3(l.gain), r3(l.bootP5),
        r3(l.pooledMean), r3(l.pooledSE), l.cand.index === shipped.index ? l.perOrigin.map((o: any) => [r3(o.mean), r3(o.se)]) : [],
        r3(l.top40), r3(l.spearSE),
        l.g1 ? 1 : 0, l.g2 ? 1 : 0, l.g3 ? 1 : 0, l.g4 ? 1 : 0, l.eligible ? 1 : 0,
        l.cand.index === shipped.index ? 1 : 0,
      ]),
      placebo: { shipRate: r3(placebo.shipRate), p95: r4(placebo.p95), bar: r4(g1Bar), gainPosition: r3(gainPosition) },
      grpPerm: { real: r4(grpPerm.realErr), med: r4(grpPerm.permMedian), p5: r4(grpPerm.permP5), p95: r4(grpPerm.permP95) },
      wfOrigins: wf.origins.map((o) => [o.trainN, o.testN]),
      cov: {
        loo80: r3(cov80 / comps.length), loo50: r3(cov50 / comps.length),
        ts80: r3(tsCov80 / tsTest.length), ts50: r3(tsCov50 / tsTest.length), tsN: tsTest.length,
        crossCov: r3(crossCov), crossMedW: r4(median(crossWidths)),
        bandMedW: median(bandWidths),
        coreMedW: median(coreWidths),
        coreFlags,
      },
      sens: { levSlopeChg: r4(levSlopeChg), wideSlopeChg: r4(wideSlopeChg), fragile: fragile ? 1 : 0, levN: levKept.length, wideN: wideComps.length },
      abl: { logAge: { pctErr: r4(logAgeAblation.pctErr), logErr: r4(logAgeAblation.logErr) }, lamGrid: lambdaAblation.map((g) => [g.lam, r4(g.err)]) },
      curve: { b0: r4(baseCurve[0]), b1: r4(baseCurve[1]) },
      hist: { audit: 0.0892, n: 21 },
      groups: { nGroups: shippedFit.ctx.groupId.size, maxOff: r4(Math.max(...shippedFit.offsets.map(Math.abs))) },
    },
    port: {
      n: portLine.n, deployed: portLine.deployed, net: r4(portLine.net), hours: r4(portLine.hours),
      perHr: r4(portLine.perHr), worst: r4(portLine.worst),
      top12: { perHr: r4(portLine.top12.perHr) },
      nopeer: { n: portLine.warned.n, perHr: r4(portLine.warned.perHr) },
      medAll: r4(portLine.medAll), medPos: r4(portLine.medPos), q1: r4(portLine.q1), q3: r4(portLine.q3),
    },
    strip: stripIdx,
    sensGrid,
    launch: {
      cells: launchCells.map((c) => [c.age, c.tvl, c.n, c.k, r4(c.rate), r3(c.weight)]),
      tvlMargShrunk: tvlMargShrunk.map(r4),
      brier: { table: r4(brierTable), baseA: r4(brierA), baseB: r4(brierB), signs: foldSigns.map((s) => (s ? 1 : 0)), gate: launchGate ? 1 : 0 },
      baseRate: r4(baseAll), datedBase: r4(datedBase),
    },
  };

  // Emit: board.json, data.js, dashboard copy, screenshots, dossier.
  mkdirSync(output, { recursive: true });
  const dashOut = join(output, 'dashboard');
  mkdirSync(dashOut, { recursive: true });
  const dashSrc = join(HERE, 'dashboard');
  for (const f of ['index.html', 'app.css', 'app.js', 'model.js', 'farm.js']) {
    copyFileSync(join(dashSrc, f), join(dashOut, f));
  }
  const dataJs = 'window.RADAR = ' + JSON.stringify(payload) + ';\n';
  writeFileSync(join(dashOut, 'data.js'), dataJs);
  const shotSrc = join(HERE, 'screenshots');
  const shotOut = join(output, 'screenshots');
  mkdirSync(shotOut, { recursive: true });
  for (const f of ['1-board.png', '2-detail.png', '3-filtered.png']) {
    copyFileSync(join(shotSrc, f), join(shotOut, f));
  }
  const boardJson = {
    as_of: snap.as_of,
    model: { rung: shipped.rung, s: shipped.s, lam: shippedLam },
    rows: board.map((row) => ({
      slug: row.slug, name: row.name, rank: row.rank, implied_value_usd: row.implied,
      band_ranks: row.band, core_ranks: row.core, tier: RadarModel.TIER_NAMES[row.tier],
      net_per_hour_usd: r4(row.econ.netHrs[0][1]), pays_from_usd: row.econ.paysFrom,
      be_odds: r4(row.econ.beOdds), chips: row.chips,
      farm_steps: row.steps,
    })),
  };
  writeFileSync(join(output, 'board.json'), JSON.stringify(boardJson, null, 2) + '\n');
  const dossier = buildDossier(output, { text_max_bytes: 65536 });
  writeFileSync(join(output, 'dossier.json'), dossier);
  const tEmit = performance.now();

  // Payload self-verification: re-read the serialized data.js and
  // recompute every display value from the raw fields. Any drift is
  // a hard stop, not a warning.
  const parsed = JSON.parse(readFileSync(join(dashOut, 'data.js'), 'utf8').replace(/^window\.RADAR = /, '').replace(/;\n$/, ''));
  const boardBack = JSON.parse(readFileSync(join(output, 'board.json'), 'utf8'));
  let mismatches = 0;
  peerRates.forEach((pr, i) => { if (r3(pr) !== parsed.peerRates[i]) mismatches++; });
  if (r3(pGlobal) !== parsed.meta.pGlobal) mismatches++;
  const checkRow = (rowArr: any[], row: BoardRow, backRow: any) => {
    const raw = { tvl: rowArr[4], chg: rowArr[5], days: rowArr[6], nCh: rowArr[3], grp: rowArr[1] };
    const scored = RadarModel.scoreProtocol(parsed.params, raw);
    const implied = Math.round(Math.pow(10, scored.y));
    if (rowArr[0] !== backRow.name) mismatches++;
    if (RadarModel.fmtImplied(implied) !== RadarModel.fmtImplied(backRow.implied_value_usd)) mismatches++;
    const gas = RadarModel.gasFor(globalChains[rowArr[2]], rowArr[3]);
    const noPeer = rowArr[1] >= 0 && peerK[rowArr[1]] === 0;
    const econ = RadarModel.computeFarmEconomics({ tvl: rowArr[4], nCh: rowArr[3] }, implied, noPeer, gas);
    if (Math.round(econ.netHrs[0][1] * 100) !== rowArr[10]) mismatches++;
    if (econ.tier !== rowArr[9]) mismatches++;
    if (econ.paysFrom !== rowArr[11]) mismatches++;
    if (r2(econ.beOdds) !== rowArr[12]) mismatches++;
    let chips = 0;
    if (rowArr[6] === null) chips |= 1;
    if (rowArr[5] === null) chips |= 2;
    if (shipped.rung >= 3 && rowArr[1] >= 0 && parsed.params.grpN[rowArr[1]] < 3) chips |= 4;
    if (noPeer) chips |= 8;
    if (scored.curveOnly) chips |= 16;
    if (rowArr[6] === null) chips |= 32;
    if (rowArr[1] < 0) chips |= 64;
    if (chips !== rowArr[13]) mismatches++;
    if (rowArr[14] !== (watchSet.has(backRow.slug) ? 1 : 0)) mismatches++;
    if (rowArr[7] !== row.core[0] || rowArr[8] !== row.core[1]) mismatches++;
    const steps = RadarFarm.buildFarmPlan(
      { name: rowArr[0], tvl: rowArr[4], nCh: rowArr[3], cat: rowArr[1] >= 0 ? globalCats[rowArr[1]] : null, chg: rowArr[5], days: rowArr[6], chain: globalChains[rowArr[2]] },
      econ, gas,
    );
    if (steps.join('\n') !== backRow.farm_steps.join('\n')) mismatches++;
  };
  parsed.rows.forEach((rowArr: any[], i: number) => checkRow(rowArr, board[i], boardBack.rows[i]));
  assert(mismatches === 0, 'payload self-verification found ' + mismatches + ' mismatches');
  const dossierBytes = dossier.length;
  assert(dossierBytes <= 1500000, 'dossier over the 1.5 MiB budget: ' + dossierBytes);
  const dossierText = JSON.parse(Buffer.from(dossier).toString('utf8')).text as string;
  const dossierTextBytes = Buffer.byteLength(dossierText, 'utf8');
  assert(!dossierText.includes('[Cut at'), 'dossier text was cut: dashboard source exceeds 65,536 bytes');
  assert(dossierTextBytes <= 65136, 'dossier text spare under 400 bytes: ' + dossierTextBytes);
  const tEnd = performance.now();

  // Build report on stdout: every measured number, gate verdicts,
  // segment timings. Timings stay here, never in the dashboard.
  const auditFolds = groupDisjointFolds(comps, 5);
  const auditGroups = auditFolds.map((fold) => new Set(fold.map((i) => comps[i].grpValue === null ? '∅' : comps[i].grpValue)).size);
  const seg = (a: number, b: number) => ((b - a) / 1000).toFixed(2) + 's';
  const lines: string[] = [];
  lines.push('TOKEN-RADAR-01 v4 BUILD REPORT');
  lines.push('group-disjoint audit: 5 folds, sizes [' + auditFolds.map((f) => f.length).join(', ') + '], distinct groups per fold [' + auditGroups.join(', ') + '], no group spans folds');
  lines.push('shipped: rung R' + shipped.rung + ' s=' + shipped.s + ' lambda=' + shippedLam);
  lines.push('census: ' + protocols.length + ' protocols; hold=' + census.hold + ' watch=' + census.watch + ' below=' + census.below + ' catEx=' + census.catEx + ' nameEx=' + census.nameEx + ' liveFit=' + census.liveFit + ' liveOther=' + census.liveOther);
  lines.push('comps: ' + comps.length + ' (' + dated.length + ' dated / ' + (comps.length - dated.length) + ' undated)');
  lines.push('nested LOO (selection included): median ' + r4(procMed) + ' dex / ' + r4(Math.pow(10, procMed)) + 'x');
  lines.push('shipped-model LOO (selection excluded): median ' + r4(shipMed) + ' dex / ' + r4(Math.pow(10, shipMed)) + 'x, Spearman ' + r3(shipSpear));
  lines.push('default R0 LOO: ' + r4(defaultMed) + ' dex / ' + r4(Math.pow(10, defaultMed)) + 'x; flat baseline: ' + r4(flatMed) + ' dex / ' + r4(Math.pow(10, flatMed)) + 'x');
  lines.push('placebo: ship rate ' + r3(placebo.shipRate) + ', P95 gain ' + r4(placebo.p95) + ' dex, G1 bar ' + r4(g1Bar) + ' dex; shipped gain position ' + r3(gainPosition));
  lines.push('group permutation: real error ' + r4(grpPerm.realErr) + ', null median ' + r4(grpPerm.permMedian) + ' [P5 ' + r4(grpPerm.permP5) + ', P95 ' + r4(grpPerm.permP95) + ']');
  lines.push('candidate ledger (rung s lam nestedMed gain bootP5 pooledMean pooledSE top40 top40Def spearSE G1 G2 G3 G4 eligible shipped):');
  for (const l of ledger) {
    lines.push('  R' + l.cand.rung + ' s=' + l.cand.s + ' lam=' + l.lam + ' med=' + r4(l.med) + ' gain=' + r4(l.gain) + ' bootP5=' + r4(l.bootP5) + ' wf=' + r4(l.pooledMean) + '±' + r4(l.pooledSE) + ' t40=' + r3(l.top40) + '/' + r3(l.top40Def) + ' se=' + r4(l.spearSE) + ' ' + [l.g1, l.g2, l.g3, l.g4, l.eligible].map((v) => (v ? 'Y' : 'N')).join('') + ' shipped=' + (l.cand.index === shipped.index ? 'Y' : 'N'));
  }
  lines.push('walk-forward origins (train/test, shipped candidate mean diff ± SE):');
  wf.origins.forEach((o, k) => {
    const l = ledger[shipped.index];
    lines.push('  origin ' + (k + 1) + ': train=' + o.trainN + ' test=' + o.testN + ' diff=' + r4(l.perOrigin[k].mean) + '±' + r4(l.perOrigin[k].se));
  });
  lines.push('coverage: nested 80%=' + r3(cov80 / comps.length) + ' 50%=' + r3(cov50 / comps.length) + '; time-split 80%=' + r3(tsCov80 / tsTest.length) + ' 50%=' + r3(tsCov50 / tsTest.length) + ' (n=' + tsTest.length + '); cross-fitted rank coverage=' + r3(crossCov) + ' median width=' + r4(median(crossWidths)) + ' rows p90=' + r4(quantile(crossWidths.sort((a, b) => a - b), 0.9)));
  lines.push('band widths: median=' + median(bandWidths) + ' rows p90=' + quantile(bandWidths.slice().sort((a, b) => a - b), 0.9) + '; core widths median=' + median(coreWidths) + ' p90=' + quantile(coreWidths.slice().sort((a, b) => a - b), 0.9) + '; core-outside-band flags=' + coreFlags);
  lines.push('tiers: ROBUST=' + tierCounts[0] + ' FARM=' + tierCounts[1] + ' THIN=' + tierCounts[2] + ' SKIP=' + tierCounts[3] + '; curve-only rows=' + curveOnlyCount);
  lines.push('portfolio: n=' + portLine.n + ' deployed=$' + portLine.deployed + ' net=$' + r4(portLine.net) + ' hours=' + r4(portLine.hours) + ' perHr=$' + r4(portLine.perHr) + '; top12 perHr=$' + r4(portLine.top12.perHr) + '; warned n=' + portLine.warned.n + ' perHr=$' + r4(portLine.warned.perHr));
  lines.push('strip: ' + stripRows.map((r) => r.slug + ' $' + r4(r.econ.netHrs[0][1]) + '/hr').join(', '));
  lines.push('launch: Brier table=' + r4(brierTable) + ' baseA=' + r4(brierA) + ' baseB=' + r4(brierB) + ' signs=' + foldSigns.map((s) => (s ? 'W' : 'L')).join('') + ' gate=' + (launchGate ? 'diagnostic' : 'assumed'));
  lines.push('sensitivity: leverage slope change=' + r4(levSlopeChg * 100) + '% (n=' + levKept.length + '), widened slope change=' + r4(wideSlopeChg * 100) + '% (n=' + wideComps.length + '), fragile=' + (fragile ? 'YES' : 'no'));
  lines.push('ablation log-age: percentile=' + r4(logAgeAblation.pctErr) + ' raw-log=' + r4(logAgeAblation.logErr) + '; lambda grid: ' + lambdaAblation.map((g) => (g.lam === -1 ? 'inf' : g.lam) + '=' + r4(g.err)).join(' '));
  lines.push('dossier: ' + dossierBytes + ' bytes; dossier text ' + dossierTextBytes + ' bytes (spare ' + (65536 - dossierTextBytes) + ')');
  lines.push('timing: parse=' + seg(tStart, tParse) + ' census=' + seg(tParse, tCensus) + ' validation=' + seg(tCensus, tValid) + ' bands=' + seg(tValid, tBands) + ' analysis=' + seg(tBands, tAnalysis) + ' board=' + seg(tAnalysis, tBoard) + ' emit=' + seg(tBoard, tEmit) + ' verify=' + seg(tEmit, tEnd) + ' total=' + seg(tStart, tEnd));
  lines.push('payload self-verification: 0 mismatches over ' + parsed.rows.length + ' rows');
  console.log(lines.join('\n'));
}

main();
