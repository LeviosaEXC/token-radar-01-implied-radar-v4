// Implied Radar v4 — farm-step generator (shared by program and page).
(function (g) {
'use strict';
var M = g.RadarModel;
var ARCHETYPES = [
  { key: 'incentive-campaign', action: 'join the points campaign: deposit in the flagged pool, do the daily check-in', risk: 'points terms can change mid-campaign' },
  { key: 'LP-pair', action: 'add liquidity to the main pair in equal halves, stake the LP receipt', risk: 'impermanent loss if the pair drifts' },
  { key: 'stable-pool', action: 'deposit stables in the core pool, hold the receipt', risk: 'yield compresses as capital arrives' },
  { key: 'vault', action: 'deposit into the vault share, let the strategy compound', risk: 'strategy/fee changes alter returns' },
  { key: 'lending-supply', action: 'supply the main asset in a conservative LTV band', risk: 'borrow demand swings move rates' },
  { key: 'bridge-incentive', action: 'bridge the minimum amount, hold the receipt', risk: 'bridge incentives end early' },
];
function archetypeFor(tvl, chg) {
  var tier = tvl < 50000000 ? 0 : tvl <= 500000000 ? 1 : 2;
  var up = chg !== null && chg !== undefined && chg > 0 ? 0 : 1;
  return tier * 2 + up;
}
function money(v) {
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
  if (v >= 1000) return '$' + Math.round(v / 100) / 10 + 'k';
  return '$' + Math.round(v);
}
function money2(v) { return (v < 0 ? '-' : '') + '$' + Math.abs(v).toFixed(2); }
function pct(v) { if (v === null || v === undefined) return 'unreported'; return (v >= 0 ? '+' : '') + v.toFixed(1) + '%'; }
function buildFarmPlan(row, econ, gas) {
  var arch = ARCHETYPES[archetypeFor(row.tvl, row.chg)];
  var tierName = M.TIER_NAMES[econ.tier];
  var thin = econ.tier === 2, skip = econ.tier === 3;
  var planDeposit = skip ? 0 : thin ? 250 : 1000;
  var holdDays = thin ? 30 : M.SCEN[1].hold;
  var tenure = row.days === null || row.days === undefined ? 'tenure unknown (imputed)' : row.days + 'd tracked';
  var catHint = row.cat ? row.cat : 'unnamed category';
  var trend = row.chg === null || row.chg === undefined ? 'Growth N/A' : row.chg > 20 ? 'Surge' : row.chg < -20 ? 'Outflow' : 'Stable';
  var beTxt = econ.beOdds > 1 ? 'over 100%' : (econ.beOdds * 100).toFixed(1) + '%';
  var multi = row.nCh >= 2 ? ' Multi-chain: repeat the staging on each of the ' + row.nCh + ' chains.' : '';
  var steps = [];
  steps.push('Check ' + row.name + ' on the snapshot: TVL ' + money(row.tvl) + ', ' + row.nCh + ' chain' + (row.nCh > 1 ? 's' : '') + ', ' + catHint + '. ' + (skip ? 'Deploy $0: the window [' + money(econ.dMin) + '..' + money(econ.dMax) + '] is reference only.' : 'Confirm a ' + money(planDeposit) + ' deposit fits [' + money(econ.dMin) + '..' + money(econ.dMax) + '], ≤0.5% of TVL.') + ' Cost: $0. Time: 10 min. Source: snapshot. Stop: abort if TVL dilutes past 2x.');
  steps.push('Stage ' + money(planDeposit) + ' on ' + row.chain + ': reserve gas ' + money2(gas.base) + ' base (' + money2(gas.low) + '-' + money2(gas.high) + ' assumed).' + multi + ' Cost: ' + money2(gas.base) + ' assumed gas. Time: 15 min. Source: snapshot. Stop: abort if a live quote tops ' + money2(gas.high) + '.');
  if (skip) {
    var reason = econ.beOdds > 0.5 ? 'break-even odds ' + beTxt + ' top the 50% policy line' : 'even the HIGH case nets at or below $0';
    steps.push('Do not deploy: ' + reason + '. If holding, set step-6 exit triggers and reduce on the first. 7-day trend ' + pct(row.chg) + ' (' + trend + '). Cost: $0. Time: 20 min. Source: snapshot. Stop: exit if 7-day TVL falls over 35%.');
  } else if (econ.unpriced) {
    steps.push('Docs check only: confirm the deposit path in the protocol docs, $0 committed. 7-day trend ' + pct(row.chg) + ' (' + trend + '). Cost: $0. Time: 20 min. Source: snapshot. Stop: commit nothing until the missing input is published.');
  } else {
    steps.push('Execute the ' + arch.key + ' play: ' + arch.action + '. 7-day trend ' + pct(row.chg) + ' (' + trend + '). Cost: gas + opportunity cost. Time: 20 min. Source: snapshot. Stop: exit if 7-day TVL falls over 35%.');
  }
  steps.push('Hold ' + holdDays + ' days (' + tenure + ', tenure proxy); check weekly, ~10 min a week.' + (thin ? ' One claim cycle only.' : '') + ' Cost: ' + money2(planDeposit * M.ASSUME.rOpp * (holdDays / 365)) + ' opp. cost at 4.5% APR. Time: ' + holdDays + 'd + 10 min/week. Source: snapshot. Stop: withdraw if the hurdle tops P75.');
  steps.push('Audit the hurdle: launch odds ' + beTxt + ', drop share ' + (econ.alphaBe * 100).toFixed(2) + '%, net ' + money2(econ.netHrs[0][1]) + '/hr at $1,000 (POINT) and ' + money2(econ.netHrs[0][0]) + '/hr (LOW stress). Cost: $0. Time: 10 min. Source: bands. Stop: move to SKIP if POINT net drops below $0.');
  var exec = skip ? 'deploy $0 and monitor only' : thin ? 'unwind the $250 position at the TGE announcement or the ' + holdDays + '-day cap' : 'unwind at the TGE announcement or the ' + holdDays + '-day cap';
  steps.push('Exit: ' + exec + '. Exit triggers: TVL down 35%+, or the hurdle passing P75. Risk: ' + arch.risk + '. Cost: exit gas ' + money2(gas.base / 2) + '. Time: 15 min. Source: verdict ' + tierName + '. Stop: unwind at the ' + holdDays + '-day cap.');
  return steps;
}
g.RadarFarm = { ARCHETYPES: ARCHETYPES, archetypeFor: archetypeFor, buildFarmPlan: buildFarmPlan };
})(typeof globalThis !== 'undefined' ? globalThis : this);
