// Implied Radar v4 — shared scoring and economics.
(function (g) {
'use strict';
var ASSUME = { alphaDrop: 0.06, etaDil: 1.25, rOpp: 0.045, hoursBase: 1.5, hoursPerChain: 0.25, hoursCap: 3.0 };
var SCEN = [
  { drop: 0.5, mult: 0.5, hold: 60, gas: 'high' },
  { drop: 0.35, mult: 1.0, hold: 90, gas: 'base' },
  { drop: 0.2, mult: 2.0, hold: 120, gas: 'low' },
];
var SIZES = [1000, 5000, 10000];
var TIER_NAMES = ['ROBUST', 'FARM', 'THIN', 'SKIP'];
var GAS_TIERS = [
  { names: ['Ethereum'], low: 18, base: 45, high: 110 },
  { names: ['Solana', 'BNB', 'Binance', 'Avalanche', 'Bitcoin', 'Tron', 'Sui', 'Aptos', 'Hyperliquid', 'Hyperliquid L1'], low: 1.5, base: 4, high: 12 },
  { names: ['Arbitrum', 'Optimism', 'Base', 'Polygon', 'Scroll', 'Linea', 'zkSync Era', 'Starknet', 'Blast', 'Mantle', 'Berachain', 'Sonic'], low: 0.8, base: 2.5, high: 8 },
];
var GAS_FALLBACK = { low: 2, base: 6, high: 18 };
var GAS_MULTI = { low: 3, base: 7.5, high: 18 };
function gasFor(primaryChain, nChains) {
  var t = GAS_FALLBACK;
  for (var i = 0; i < 3; i++) if (GAS_TIERS[i].names.includes(primaryChain)) { t = GAS_TIERS[i]; break; }
  var multi = nChains >= 2;
  return { low: t.low + (multi ? GAS_MULTI.low : 0), base: t.base + (multi ? GAS_MULTI.base : 0), high: t.high + (multi ? GAS_MULTI.high : 0) };
}
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function scoreProtocol(params, raw) {
  var x = Math.log10(raw.tvl / 50000000);
  var curve = params.b0 + params.b1 * x;
  var agePct;
  if (raw.days === null || raw.days === undefined) agePct = 0.5;
  else {
    var arr = params.age.days, le = 0;
    for (var i = 0; i < arr.length; i++) if (arr[i] <= raw.days) le++;
    agePct = le / arr.length;
  }
  var zAge = params.age.iqr > 0 ? (agePct - params.age.med) / params.age.iqr : 0;
  var brRaw = clamp(Math.log1p(raw.nCh), params.br.lo, params.br.hi);
  var zBr = params.br.iqr > 0 ? (brRaw - params.br.med) / params.br.iqr : 0;
  var missG = raw.chg === null || raw.chg === undefined;
  var grRaw = clamp(missG ? params.gr.med : Math.asinh(raw.chg / params.gr.s), params.gr.lo, params.gr.hi);
  var zGr = params.gr.iqr > 0 ? (grRaw - params.gr.med) / params.gr.iqr : 0;
  var missA = raw.days === null || raw.days === undefined ? 1 : 0;
  var model = curve, co = params.co;
  if (params.rung >= 1) model += co[0] * zAge + co[3] * missA;
  if (params.rung >= 2) model += co[1] * zBr;
  if (params.rung >= 3 && raw.grp >= 0 && params.grpN[raw.grp] >= 3) model += params.grp[raw.grp];
  if (params.rung >= 4) model += co[2] * zGr + co[5] * (missG ? 1 : 0);
  var zs = [zAge, zBr, zGr], outside = false;
  for (var k = 0; k < 3; k++) if (zs[k] < params.box.lo[k] || zs[k] > params.box.hi[k]) outside = true;
  if (outside) return { y: curve, curveOnly: true };
  return { y: curve + clamp(params.s * (model - curve), -0.35, 0.35), curveOnly: false };
}
function stratumFor(days, grp, grpN) {
  if (days === null || days === undefined) return 2;
  return (grp < 0 || grpN[grp] < 6) ? 1 : 0;
}
function computeConformalBands(y, q) { return [Math.pow(10, y + q[0]), Math.pow(10, y + q[1]), Math.pow(10, y + q[2]), Math.pow(10, y + q[3])]; }
function pctRankBand(rank, n, q) {
  var pct = 1 - (rank - 0.5) / n;
  var lo = Math.max(0, pct - q), hi = Math.min(1, pct + q);
  var best = Math.max(1, Math.floor(n * (1 - hi) + 0.5));
  var worst = Math.min(n, Math.ceil(n * (1 - lo) + 0.5));
  if (best > rank) best = rank;
  if (worst < rank) worst = rank;
  return [best, worst];
}
function top10Flag(core, band) { if (core[1] <= 10) return 2; return band[0] <= 10 ? 1 : 0; }
function assignTier(beOdds, tierNets, unpriced) {
  if (unpriced) return { tier: 2, unpriced: true };
  if (beOdds <= 0.1 && tierNets[0] >= 0) return { tier: 0, unpriced: false };
  if (beOdds <= 0.25 && tierNets[1] > 0) return { tier: 1, unpriced: false };
  return (beOdds > 0.5 || tierNets[2] <= 0) ? { tier: 3, unpriced: false } : { tier: 2, unpriced: false };
}
function computeFarmEconomics(raw, implied, noPeer, gas) {
  var hours = Math.min(ASSUME.hoursCap, ASSUME.hoursBase + ASSUME.hoursPerChain * (raw.nCh - 1));
  function shareK(mult, drop) { return (implied * ASSUME.alphaDrop * mult * (1 - drop)) / (raw.tvl * ASSUME.etaDil); }
  var nets = [], netHrs = [];
  for (var a = 0; a < SIZES.length; a++) {
    var rowN = [], rowH = [];
    for (var b = 0; b < SCEN.length; b++) {
      var sc = SCEN[b];
      var net = SIZES[a] * shareK(sc.mult, sc.drop) - (gas[sc.gas] + SIZES[a] * ASSUME.rOpp * (sc.hold / 365));
      rowN.push(net);
      rowH.push(net / hours);
    }
    nets.push(rowN);
    netHrs.push(rowH);
  }
  var tierNets = SCEN.map(function (sc) {
    return 1000 * shareK(sc.mult * (noPeer ? 0.5 : 1), sc.drop) - (gas[sc.gas] + 1000 * ASSUME.rOpp * (sc.hold / 365));
  });
  var grossPoint = 1000 * shareK(1, SCEN[1].drop);
  var costPoint = gas.base + 1000 * ASSUME.rOpp * (SCEN[1].hold / 365);
  var beOdds = grossPoint > 0 ? Math.min(99, costPoint / grossPoint) : 99;
  var share1000 = 1000 / (raw.tvl * ASSUME.etaDil);
  var alphaBe = implied * share1000 > 0 ? costPoint / (implied * share1000) : 99;
  var kPoint = shareK(1, SCEN[1].drop);
  var dMin = kPoint > 0 ? Math.ceil((2 * gas.base) / kPoint) : 0;
  var dMax = Math.min(0.005 * raw.tvl, 50000);
  var paysFrom = -1;
  for (var i = 0; i < SIZES.length; i++) if (nets[i][0] > 0) { paysFrom = SIZES[i]; break; }
  if (paysFrom < 0) {
    var sc0 = SCEN[0];
    var slope = shareK(sc0.mult, sc0.drop) - ASSUME.rOpp * (sc0.hold / 365);
    if (slope > 0) {
      var be = Math.ceil(gas[sc0.gas] / slope / 50) * 50;
      paysFrom = be > 5000 ? -1 : be;
    }
  }
  var unpriced = !(raw.tvl > 0) || !(implied > 0);
  var t = assignTier(beOdds, tierNets, unpriced);
  return { nets: nets, netHrs: netHrs, tierNets: tierNets, beOdds: beOdds, alphaBe: alphaBe, dMin: dMin, dMax: dMax, paysFrom: paysFrom, hours: hours, tier: t.tier, unpriced: t.unpriced };
}
function sig2(m) {
  if (m >= 100) return String(Math.round(m / 10) * 10);
  if (m >= 10) return String(Math.round(m));
  return m >= 1 ? String(Math.round(m * 10) / 10) : m.toPrecision(2);
}
function fmtImplied(v) {
  if (v >= 1e9) return '$' + sig2(v / 1e9) + 'B';
  if (v >= 1e6) return '$' + sig2(v / 1e6) + 'M';
  return v >= 1e3 ? '$' + sig2(v / 1e3) + 'k' : '$' + sig2(v);
}
g.RadarModel = { ASSUME: ASSUME, SCEN: SCEN, SIZES: SIZES, TIER_NAMES: TIER_NAMES, gasFor: gasFor, scoreProtocol: scoreProtocol, stratumFor: stratumFor, computeConformalBands: computeConformalBands, pctRankBand: pctRankBand, top10Flag: top10Flag, assignTier: assignTier, computeFarmEconomics: computeFarmEconomics, fmtImplied: fmtImplied };
})(typeof globalThis !== 'undefined' ? globalThis : this);
