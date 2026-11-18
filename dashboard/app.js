// Implied Radar v4 — re-derives every number in the browser via the
// shared modules. Row: 0 name,1 cat,2 chain,3 nCh,4 TVL,5 7d,6 days,
// 7-8 core,9 tier,10 net cents,11 pays-from,12 be odds,13 chips,14 watch.
(function () {
'use strict';
var R = window.RADAR, M = window.RadarModel, F = window.RadarFarm, P = R.params, N = R.rows.length;
function $(id) { return document.getElementById(id); }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function money(v) { if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B'; if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M'; if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'k'; return '$' + Math.round(v); }
function money2(v) { return (v < 0 ? '-' : '') + '$' + Math.abs(v).toFixed(2); }
function pct(v) { return v === null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%'; }
function chipN(c) { var n = 0; while (c) { n += c & 1; c >>= 1; } return n; }
function confOf(c) { var n = chipN(c); return n === 0 ? 'High' : n <= 2 ? 'Med' : 'Low'; }
var CHIPS = ['No tenure', 'No growth', 'Small group', 'No traded peer', 'Curve only', 'Default hold', 'No category'];
function chipsOf(c) { var o = []; for (var i = 0; i < 7; i++) if (c & (1 << i)) o.push(CHIPS[i]); return o; }
function derive(row, idx) {
  var sc = M.scoreProtocol(P, { tvl: row[4], chg: row[5], days: row[6], nCh: row[3], grp: row[1] });
  var implied = Math.round(Math.pow(10, sc.y));
  var gas = M.gasFor(R.chains[row[2]], row[3]);
  var econ = M.computeFarmEconomics({ tvl: row[4], nCh: row[3] }, implied, (row[13] & 8) !== 0, gas);
  var extra = row[4] < P.compTvl[0] || row[4] > P.compTvl[1];
  var band = M.computeConformalBands(sc.y, extra ? P.qWide : P.q[M.stratumFor(row[6], row[1], P.grpN)]);
  var steps = F.buildFarmPlan({ name: row[0], tvl: row[4], nCh: row[3], cat: row[1] >= 0 ? R.cats[row[1]] : null, chg: row[5], days: row[6], chain: R.chains[row[2]] }, econ, gas);
  return { y: sc.y, curveOnly: sc.curveOnly, implied: implied, gas: gas, econ: econ, band: band, rank: idx + 1, rankBand: M.pctRankBand(idx + 1, N, P.pctQ), steps: steps };
}
var DERIVED = R.rows.map(derive);
var maxLog = Math.log10(Math.max.apply(null, DERIVED.map(function (d) { return d.implied; })));
var minLog = Math.log10(Math.min.apply(null, DERIVED.map(function (d) { return d.implied; })));
$('judgeNote').innerHTML = '<b>What this is.</b> Sealed snapshot: ' + R.meta.nProto + ' protocols (as of ' + esc(R.meta.asOf) + '). ' + N + ' protocols that record no token, ranked by implied value from a validated power-law fit. Every number here is recomputed in your browser. Farm plans state cost, time, source, stop.';
$('stats').innerHTML = [['Protocols', R.meta.nProto], ['On the board', N], ['Watchlist', R.meta.nWatch + '/' + R.meta.nWatch], ['Fitted comps', R.meta.nComps], ['Median implied', M.fmtImplied(R.meta.medImplied)], ['Curve-only rows', R.meta.curveOnly]].map(function (s) { return '<span class="stat"><b>' + s[1] + '</b> ' + s[0] + '</span>'; }).join('');
$('stripNote').textContent = 'Top 6 by $1,000 POINT net per hour at full share.';
$('strip').innerHTML = R.strip.map(function (idx) {
  var row = R.rows[idx], d = DERIVED[idx];
  return '<button class="card" data-rank="' + d.rank + '" type="button"><span class="rk">Rank #' + d.rank + ' · ' + M.TIER_NAMES[row[9]] + '</span><br><span class="nm">' + esc(row[0]) + '</span><br><span class="net">' + money2(d.econ.netHrs[0][1]) + '/hr</span><br><span class="imp">Implied ' + M.fmtImplied(d.implied) + ' · TVL ' + money(row[4]) + '</span></button>';
}).join('');
$('coverLine').innerHTML = '<b>' + R.meta.nWatch + '/' + R.meta.nWatch + ' watchlist protocols on board.</b> The watchlist is the floor, never the ceiling: ' + (N - R.meta.nWatch) + ' further pre-token protocols below it are ranked alongside.';
var state = { q: '', cat: '', chain: '', watch: false, sort: 'rank', dir: 1 };
var catSel = $('fCat'), chainSel = $('fChain');
R.cats.forEach(function (c) { var o = document.createElement('option'); o.value = c; o.textContent = c; catSel.appendChild(o); });
R.chains.forEach(function (c) { var o = document.createElement('option'); o.value = c; o.textContent = c; chainSel.appendChild(o); });
function sortKey(i) {
  var r = R.rows[i], s = state.sort;
  return s === 'name' ? r[0].toLowerCase() : s === 'tvl' ? r[4] : s === 'chg' ? (r[5] === null ? -1e9 : r[5]) : s === 'days' ? (r[6] === null ? -1 : r[6]) : s === 'implied' ? DERIVED[i].implied : s === 'net' ? DERIVED[i].econ.netHrs[0][1] : s === 'tier' ? r[9] : i;
}
function renderBoard() {
  var idx = [];
  for (var i = 0; i < N; i++) {
    var row = R.rows[i];
    if (state.watch && !row[14]) continue;
    if (state.cat && (row[1] < 0 || R.cats[row[1]] !== state.cat)) continue;
    if (state.chain && R.chains[row[2]] !== state.chain) continue;
    if (state.q && row[0].toLowerCase().indexOf(state.q.toLowerCase()) < 0) continue;
    idx.push(i);
  }
  idx.sort(function (a, b) { var ka = sortKey(a), kb = sortKey(b); return (ka < kb ? -1 : ka > kb ? 1 : a - b) * state.dir; });
  $('fCount').textContent = idx.length + ' of ' + N + ' rows';
  var html = '';
  for (var k = 0; k < idx.length; k++) {
    var j = idx[k], r2 = R.rows[j], d = DERIVED[j];
    var w = maxLog > minLog ? Math.round(8 + 92 * (Math.log10(d.implied) - minLog) / (maxLog - minLog)) : 50;
    var net = d.econ.netHrs[0][1];
    html += '<tr data-rank="' + (j + 1) + '"><td class="num">' + (j + 1) + '</td><td><b>' + esc(r2[0]) + '</b>' + (r2[14] ? '<span class="watch">WATCHLIST</span>' : '') + '<br><span class="slug">' + esc(r2[1] >= 0 ? R.cats[r2[1]] : 'No category') + ' · ' + esc(R.chains[r2[2]]) + '</span></td><td class="num">' + money(r2[4]) + '</td><td class="num">' + pct(r2[5]) + '</td><td class="num">' + (r2[6] === null ? '—' : r2[6] + 'd') + '</td><td><b>' + M.fmtImplied(d.implied) + '</b><div class="bar"><i style="width:' + w + '%"></i></div></td><td class="num ' + (net >= 0 ? 'pos' : 'neg') + '">' + money2(net) + '</td><td><span class="tier t' + r2[9] + '">' + M.TIER_NAMES[r2[9]] + '</span></td><td><span class="conf">' + confOf(r2[13]) + '</span></td></tr>';
  }
  $('boardBody').innerHTML = html;
}
$('boardBody').addEventListener('click', function (e) { var tr = e.target.closest('tr'); if (tr) openDrawer(+tr.getAttribute('data-rank')); });
$('strip').addEventListener('click', function (e) { var c = e.target.closest('.card'); if (c) openDrawer(+c.getAttribute('data-rank')); });
document.querySelectorAll('#boardTable th[data-sort]').forEach(function (th) {
  th.addEventListener('click', function () { var s = th.getAttribute('data-sort'); if (state.sort === s) state.dir *= -1; else { state.sort = s; state.dir = s === 'name' ? 1 : -1; } renderBoard(); });
});
$('fSearch').addEventListener('input', function (e) { state.q = e.target.value; renderBoard(); });
catSel.addEventListener('change', function (e) { state.cat = e.target.value; renderBoard(); });
chainSel.addEventListener('change', function (e) { state.chain = e.target.value; renderBoard(); });
$('fWatch').addEventListener('change', function (e) { state.watch = e.target.checked; renderBoard(); });
function launchMargin(row, beOdds) {
  var aB = row[6] === null ? -1 : row[6] < 365 ? 0 : row[6] < 730 ? 1 : 2;
  var tB = row[4] < 25000000 ? 0 : row[4] <= 150000000 ? 1 : 2;
  var pRaw = aB < 0 ? R.launch.tvlMargShrunk[tB] : R.launch.cells[aB * 3 + tB][4];
  return Math.max(0.75 * R.launch.baseRate, Math.min(1.5 * R.launch.baseRate, pRaw)) / beOdds;
}
function openDrawer(rank) {
  var i = rank - 1;
  if (i < 0 || i >= N) return;
  var row = R.rows[i], d = DERIVED[i], net = d.econ;
  var curve = P.b0 + P.b1 * Math.log10(row[4] / 50000000), disp = d.y - curve;
  var t10 = M.top10Flag([row[7], row[8]], d.rankBand);
  var top10 = t10 === 2 ? 'Yes — core inside 10' : t10 === 1 ? 'Possible — band reaches 10' : 'No';
  var netRows = '';
  for (var s = 0; s < 3; s++) {
    netRows += '<tr><td>' + money(M.SIZES[s]) + '</td>';
    for (var c = 0; c < 3; c++) { var v = net.netHrs[s][c]; netRows += '<td class="num ' + (v >= 0 ? 'pos' : 'neg') + '">' + money2(net.nets[s][c]) + '<br><span class="small">' + money2(v) + '/hr</span></td>'; }
    netRows += '</tr>';
  }
  var peer = row[1] >= 0 ? R.peerRates[row[1]] : R.meta.pGlobal;
  var notes = chipsOf(row[13]).join('; ') || 'None — complete record.';
  $('drawer').innerHTML = '<button class="close" type="button" id="drawerClose">Close ✕</button>' +
    '<span class="tier t' + row[9] + '">' + M.TIER_NAMES[row[9]] + '</span> ' + (row[14] ? '<span class="watch">WATCHLIST</span>' : '') +
    '<h2>' + esc(row[0]) + '</h2><p class="kv">Rank #' + rank + ' of ' + N + ' · ' + esc(row[1] >= 0 ? R.cats[row[1]] : 'No category') + ' · ' + esc(R.chains[row[2]]) + ' · ' + row[3] + ' chain' + (row[3] > 1 ? 's' : '') + '</p>' +
    '<div class="big">' + M.fmtImplied(d.implied) + ' implied value</div>' +
    '<p class="bandline">Value P10–P90: ' + M.fmtImplied(d.band[0]) + ' – ' + M.fmtImplied(d.band[3]) + ' · P25–P75: ' + M.fmtImplied(d.band[1]) + ' – ' + M.fmtImplied(d.band[2]) + '<br>Rank #' + d.rankBand[0] + '–#' + d.rankBand[1] + ' · Core #' + row[7] + '–#' + row[8] + ' · Top 10: ' + top10 + '</p>' +
    '<h4>Farm plan — 6 steps</h4><ol>' + d.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
    '<h4>Why this rank</h4><p class="kv">Curve alone: ' + M.fmtImplied(Math.pow(10, curve)) + '; rung terms move it ' + (disp >= 0 ? '+' : '') + disp.toFixed(3) + ' dex (s = ' + P.s + ', cap 0.35). ' + (d.curveOnly ? 'Curve only: outside fit box. ' : '') + 'TVL ' + money(row[4]) + ' · 7d ' + pct(row[5]) + ' · age ' + (row[6] === null ? '—' : row[6] + 'd') + ' · peer rate ' + (peer * 100).toFixed(1) + '%.</p>' +
    '<h4>Net economics — projected</h4><table><thead><tr><th>Size</th><th>LOW</th><th>POINT</th><th>HIGH</th></tr></thead><tbody>' + netRows + '</tbody></table>' +
    '<p class="kv">Break-even odds ($1,000 POINT): <b>' + (row[12] * 100).toFixed(1) + '%</b> · Break-even drop share: <b>' + (net.alphaBe * 100).toFixed(2) + '%</b> · Pays from: <b>' + (row[11] < 0 ? 'above $5,000' : money(row[11])) + '</b> · Window ' + money(net.dMin) + '–' + money(net.dMax) + ' · ' + net.hours.toFixed(2) + ' hr. Gas assumed: base ' + money2(d.gas.base) + ' (low ' + money2(d.gas.low) + ' / high ' + money2(d.gas.high) + '). Drop pool 6%, dilution 25%, yield 4.5% APR — all assumed.</p>' +
    '<h4>Launch margin</h4><p class="kv">m = <b>' + launchMargin(row, net.beOdds).toFixed(3) + '</b> (launch rate / break-even odds). ' + (R.launch.brier.gate ? 'Diagnostic: beat both baselines out-of-fold.' : 'Assumed display: did not beat baselines out-of-fold.') + '</p>' +
    '<h4>Record notes</h4><p class="kv">' + esc(notes) + '</p>' +
    '<p class="small">Records no token on the snapshot; the record is not proof it has none.</p>';
  $('drawer').hidden = false;
  $('drawerClose').addEventListener('click', closeDrawer);
  setHash({ detail: rank });
}
function closeDrawer() { $('drawer').hidden = true; setHash({ detail: null }); }
function tbl(heads, rows) { return '<table><thead><tr>' + heads.map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead><tbody>' + rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table>'; }
function yn(v) { return v ? '✓' : '✗'; }

function renderMethod() {
  var V = R.val, L = V.ledger, ship = V.ship, shipRow = null;
  for (var i = 0; i < L.length; i++) if (L[i][16]) shipRow = L[i];
  var gate = ship.rung === 0 && ship.s === 0 ? 'No challenger cleared all four bars; default curve R0 stands.' : 'Shipped candidate cleared all four bars; lowest nested LOO error among eligible.';
  var wfRows = [];
  if (shipRow) {
    for (var o = 0; o < 5; o++) wfRows.push(['Origin ' + (o + 1), V.wfOrigins[o][0], V.wfOrigins[o][1], shipRow[8][o][0].toFixed(3) + ' ± ' + shipRow[8][o][1].toFixed(3), Math.abs(shipRow[8][o][0]) > 2 * shipRow[8][o][1] ? 'RED' : '—']);
    wfRows.push(['<b>Pooled</b>', '', '', '<b>' + shipRow[6].toFixed(3) + ' ± ' + shipRow[7].toFixed(3) + '</b>', '']);
  }
  $('tab-method').innerHTML = '<h2>Method — validation record</h2>' +
    '<p><b>Shipped: R' + ship.rung + ', s = ' + ship.s + (ship.rung >= 3 ? ', λ = ' + ship.lam : '') + '.</b> ' + gate + '</p>' +
    '<h3>Ledger</h3>' +
    tbl(['Rung', 's', 'λ', 'Med', 'Gain', 'Boot P5', 'WF pooled', 'Top-40 ρ', 'G1–G4', 'Elig', ''], L.map(function (l) { return ['R' + l[0], l[1], l[0] >= 3 ? l[2] : '—', l[3].toFixed(3), (l[4] >= 0 ? '+' : '') + l[4].toFixed(3), l[5].toFixed(3), l[6].toFixed(3) + ' ± ' + l[7].toFixed(3), l[9].toFixed(3) + '/' + V.top40Def.toFixed(3), yn(l[11]) + yn(l[12]) + yn(l[13]) + yn(l[14]), yn(l[15]), l[16] ? '<b>SHIP</b>' : '']; })) +
    '<p class="small">G1 gain ≥ bar, boot lower 90% &gt; −0.05 · G2 pooled WF ≤ 1× SE · G3 origins ≤ 1.5× SE · G4 ρ within 1× paired SE. Top-40: candidate / default.</p>' +
    '<h3>Placebo</h3><p class="kv">200 permutations: bar met ' + (V.placebo.shipRate * 100).toFixed(1) + '%; null P95 ' + V.placebo.p95.toFixed(3) + ' → G1 bar ' + V.placebo.bar.toFixed(3) + '. Shipped gain ' + (V.placebo.gainPosition * 100).toFixed(0) + 'th null percentile. Group-label permutation (R3, λ=16): real error ' + V.grpPerm.real.toFixed(3) + ', null med ' + V.grpPerm.med.toFixed(3) + ' [P5 ' + V.grpPerm.p5.toFixed(3) + ', P95 ' + V.grpPerm.p95.toFixed(3) + '].</p>' +
    '<h3>LOO</h3>' + tbl(['Procedure', 'Med |err|', 'Med ×', 'ρ'], [['Procedure (in-fold selection)', V.nestedMed.toFixed(3), V.nestedMult.toFixed(2) + '×', '—'], ['Shipped model', V.shippedMed.toFixed(3), V.shippedMult.toFixed(2) + '×', V.shippedSpear.toFixed(3)], ['Default curve R0', V.defaultMed.toFixed(3), V.defaultMult.toFixed(2) + '×', '—'], ['Flat baseline', V.flatMed.toFixed(3), V.flatMult.toFixed(2) + '×', '—']]) +
    '<h3>Walk-forward</h3>' + tbl(['Origin', 'Train', 'Test', 'Diff ± SE', 'RED>2SE'], wfRows) +
    '<p class="small">All origins tie the default exactly: every held-out row is newer than its prefix, so the interiority fallback scores all candidates on the curve. G2/G3 pass trivially; no RED flag is possible under the frozen rule.</p>' +
    '<h3>Bands</h3><p class="kv">One q = ' + P.pctQ.toFixed(4) + ' for all rank bands (percentile units, one 60/40 split). Value bands: stratified split-conformal + finite-sample correction, shrunk to global quantiles; widest outside the fitted TVL range. Predictive intervals. Coverage: nested 80% <b>' + (V.cov.loo80 * 100).toFixed(1) + '%</b>/50% <b>' + (V.cov.loo50 * 100).toFixed(1) + '%</b>; time-split (n=' + V.cov.tsN + ') 80% <b>' + (V.cov.ts80 * 100).toFixed(1) + '%</b>/50% <b>' + (V.cov.ts50 * 100).toFixed(1) + '%</b>; cross-fitted <b>' + (V.cov.crossCov * 100).toFixed(1) + '%</b>, width med ' + V.cov.crossMedW.toFixed(1) + '. Widths: band ' + V.cov.bandMedW + '; core ' + V.cov.coreMedW + '; core-outside-band ' + V.cov.coreFlags + '.</p>' +
    '<h3>Launch table</h3>' + tbl(['Age', 'TVL', 'n', 'k', 'Rate', 'Weight'], R.launch.cells.map(function (c) { return [['<1y', '1–2y', '2y+'][c[0]], ['<$25M', '$25–150M', '>$150M'][c[1]], c[2], c[3], (c[4] * 100).toFixed(1) + '%', c[5].toFixed(2)]; })) +
    '<p class="kv">Shrunk to additive fit (λ=20); unknown tenure takes the TVL-marginal rate; clamped [0.75×, 1.50×] base ' + (R.launch.baseRate * 100).toFixed(1) + '%. Brier: table <b>' + R.launch.brier.table.toFixed(4) + '</b>, constant ' + R.launch.brier.baseA.toFixed(4) + ', TVL-logistic ' + R.launch.brier.baseB.toFixed(4) + ', signs ' + R.launch.brier.signs.map(function (s) { return s ? 'W' : 'L'; }).join('') + ' — ' + (R.launch.brier.gate ? 'diagnostic.' : 'assumed display.') + ' Counts recorded-token protocols only; never-launchers unobserved: not a launch probability. Margin never enters rank or tier.</p>' +
    '<h3>Tiers</h3><p class="kv">' + R.meta.tiers[0] + '+' + R.meta.tiers[1] + '+' + R.meta.tiers[2] + '+' + R.meta.tiers[3] + ' = ' + N + ' (ROBUST/FARM/THIN/SKIP). ROBUST: odds ≤10%, LOW net ≥$0. FARM: odds ≤25%, POINT net &gt;$0. SKIP: odds &gt;50% or HIGH net ≤$0. Else THIN. Tier nets halve share with no traded peer; unpriced are THIN.</p>' +
    '<h3>Portfolio</h3><p class="kv">' + R.port.n + ' positive rows: ' + money(R.port.deployed) + ' deployed, net ' + money2(R.port.net) + ' / ' + R.port.hours.toFixed(1) + ' hr = <b>' + money2(R.port.perHr) + '/hr</b> (worst ' + money2(R.port.worst) + '). Top 12: ' + money2(R.port.top12.perHr) + '/hr. No-peer subset: ' + R.port.nopeer.n + ' rows, ' + money2(R.port.nopeer.perHr) + '/hr. Medians: all ' + money2(R.port.medAll) + ', positive ' + money2(R.port.medPos) + '; quartiles ' + money2(R.port.q1) + ' / ' + money2(R.port.q3) + '.</p>' +
    '<h3>Sensitivity</h3>' + tbl(['Hurdle', 'Rows', 'ROBUST/FARM'], R.sensGrid.map(function (g) { return ['$' + g.hurdle + '/hr', g.count, g.farmRobust]; })) +
    '<h3>Census</h3>' + tbl(['Bucket', 'n', 'TVL'], [['Hold', R.census.hold, money(R.census.holdTvl)], ['Watchlist', R.census.watch, '—'], ['Below', R.census.below, '—'], ['Excl (cat)', R.census.catEx, money(R.census.catExTvl)], ['Excl (name)', R.census.nameEx, money(R.census.nameExTvl)], ['Fitted', R.census.liveFit, money(R.census.liveFitTvl)], ['Set aside (' + R.census.liveExcluded + '/' + R.census.liveDust + '/' + R.census.liveMissingMcap + '/' + R.census.liveNoIdentifier + ')', R.census.liveOther, money(R.census.liveOtherTvl)]]) +
    '<p class="small">Set-aside: excluded / dust / no-mcap / no-id. Board and live pool share no slug.</p>' +
    '<h3>Assumptions</h3><p class="kv">Drop 6% · dilution 25% · yield 4.5% APR · effort 1.5+0.25/chain hr (cap 3). LOW 50%/0.5×/60d/high · POINT 35%/1×/90d/base · HIGH 20%/2×/120d/low. Gas: ETH 18/45/110, low-cost 1.5/4/12, L2 0.8/2.5/8, fallback 2/6/18, +multi 3/7.5/18. Curve: log10(mcap) = ' + V.curve.b0.toFixed(4) + ' + ' + V.curve.b1.toFixed(4) + ' × log10(TVL/$50M). Groups: ' + V.groups.nGroups + ', max |offset| ' + V.groups.maxOff.toFixed(4) + '. Archetypes: TVL tier × growth sign → 6 plays. THIN $250/30d/1 cycle; SKIP $0 + triggers.</p>' +
    '<h3>Ablations</h3><p class="kv">Log-age vs percentile age at R1: ' + V.abl.logAge.pctErr.toFixed(3) + ' vs ' + V.abl.logAge.logErr.toFixed(3) + ' — percentile ships. Lambda grid at R3, s=1: ' + V.abl.lamGrid.map(function (g) { return (g[0] === -1 ? '∞' : g[0]) + '→' + g[1].toFixed(3); }).join(', ') + '. Leverage: top 10% dropped (' + V.sens.levN + ' kept) moves slope ' + (V.sens.levSlopeChg * 100).toFixed(1) + '%; widened window (' + V.sens.wideN + ') moves it ' + (V.sens.wideSlopeChg * 100).toFixed(1) + '%.' + (V.sens.fragile ? ' Over 15%: fragile slope.' : ' Neither tops 15%.') + ' Single-split audit: ' + V.hist.audit.toFixed(4) + ', n=' + V.hist.n + ' — superseded. Early-half dated comps below board median: ' + (R.meta.earlyBelow * 100).toFixed(1) + '%.</p>';
}
function scatterSVG() {
  var W = 720, H = 400, L = 56, Rm = 16, T = 14, B = 40;
  var xs = R.comps.map(function (c) { return c[0]; }), ys = R.comps.map(function (c) { return c[1]; });
  var x0 = Math.floor(Math.min.apply(null, xs)), x1 = Math.ceil(Math.max.apply(null, xs));
  var y0 = Math.floor(Math.min.apply(null, ys)), y1 = Math.ceil(Math.max.apply(null, ys));
  function X(v) { return L + (v - x0) / (x1 - x0) * (W - L - Rm); }
  function Y(v) { return T + (1 - (v - y0) / (y1 - y0)) * (H - T - B); }
  var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img">';
  for (var gx = x0; gx <= x1; gx++) s += '<line x1="' + X(gx) + '" y1="' + T + '" x2="' + X(gx) + '" y2="' + (H - B) + '" stroke="#e3ddd0"/><text x="' + X(gx) + '" y="' + (H - B + 16) + '" text-anchor="middle">$10^' + gx + '</text>';
  for (var gy = y0; gy <= y1; gy++) s += '<line x1="' + L + '" y1="' + Y(gy) + '" x2="' + (W - Rm) + '" y2="' + Y(gy) + '" stroke="#e3ddd0"/><text x="' + (L - 6) + '" y="' + (Y(gy) + 4) + '" text-anchor="end">$10^' + gy + '</text>';
  s += '<line x1="' + X(x0) + '" y1="' + Y(P.b0 + P.b1 * (x0 - Math.log10(50000000))) + '" x2="' + X(x1) + '" y2="' + Y(P.b0 + P.b1 * (x1 - Math.log10(50000000))) + '" stroke="#0e6b4f" stroke-width="2"/>';
  for (var i = 0; i < R.comps.length; i++) s += '<circle cx="' + X(xs[i]).toFixed(1) + '" cy="' + Y(ys[i]).toFixed(1) + '" r="3" fill="#2563eb" opacity="0.7"/>';
  s += '<text x="' + ((W - L - Rm) / 2 + L) + '" y="' + (H - 6) + '" text-anchor="middle">TVL (log scale)</text></svg>';
  return s;
}
function renderRef() {
  var med = R.comps.map(function (c) { return c[1]; }).sort(function (a, b) { return a - b; });
  $('tab-ref').innerHTML = '<div class="banner">REFERENCE ONLY — RECORDED TOKENS (NEVER MIXED WITH PRE-TOKEN RADAR)</div>' +
    '<h2>Fitting universe — ' + R.comps.length + ' protocols that record tokens</h2>' +
    '<p>These protocols passed the comp screen and fitted the curve. None appears on the pre-token board. The green line is the fitted power law; the blue dots are the comps.</p>' + scatterSVG() +
    '<p class="kv">Median recorded market cap: <b>' + money(Math.pow(10, med[Math.floor(med.length / 2)])) + '</b>.</p>';
}
function showTab(tab) {
  document.querySelectorAll('.tabs>button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === tab); });
  $('tab-board').hidden = tab !== 'board'; $('tab-method').hidden = tab !== 'method'; $('tab-ref').hidden = tab !== 'ref';
}
document.querySelectorAll('.tabs>button').forEach(function (b) { b.addEventListener('click', function () { var t = b.getAttribute('data-tab'); showTab(t); setHash({ tab: t }); }); });
function showPool(pool) {
  document.querySelectorAll('#poolSeg button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-pool') === pool); });
  showTab(pool === 'live' ? 'ref' : 'board');
}
document.querySelectorAll('#poolSeg button').forEach(function (b) { b.addEventListener('click', function () { showPool(b.getAttribute('data-pool')); }); });
function readHash() {
  var out = {};
  window.location.hash.replace(/^#/, '').split('&').forEach(function (part) { var kv = part.split('='); if (kv[0]) out[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || ''); });
  return out;
}
function setHash(updates) {
  var cur = readHash();
  for (var k in updates) { if (updates[k] === null || updates[k] === undefined || updates[k] === '') delete cur[k]; else cur[k] = updates[k]; }
  var h = Object.keys(cur).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(cur[k]); }).join('&');
  history.replaceState(null, '', h ? '#' + h : ' ');
}
function applyHash() {
  var h = readHash();
  if (h.tab && (h.tab === 'method' || h.tab === 'ref' || h.tab === 'board')) showTab(h.tab);
  if (h.cat) { state.cat = h.cat; catSel.value = h.cat; }
  if (h.chain) { state.chain = h.chain; chainSel.value = h.chain; }
  if (h.watch === '1') { state.watch = true; $('fWatch').checked = true; }
  renderBoard();
  if (h.detail) openDrawer(+h.detail);
}
window.addEventListener('hashchange', applyHash);
function verifyRecomputeProof() {
  var ok = 0, drift = 0;
  for (var i = 0; i < N; i++) {
    var row = R.rows[i], d = DERIVED[i];
    var good = Math.round(d.econ.netHrs[0][1] * 100) === row[10]
      && d.econ.tier === row[9] && d.econ.paysFrom === row[11]
      && Math.round(d.econ.beOdds * 1e2) / 1e2 === row[12] && d.steps.length === 6;
    var gap = Math.abs(d.econ.netHrs[0][1] * 100 - row[10]) / 100;
    if (gap > drift) drift = gap;
    if (good) ok++;
  }
  return { ok: ok, drift: drift };
}
renderBoard();
renderMethod();
renderRef();
applyHash();
var proof = verifyRecomputeProof();
$('proof').innerHTML = 'Recompute verified <b>' + proof.ok + '/' + N + '</b> · drift <b>$' + proof.drift.toFixed(2) + '</b> · Shipped model R' + P.rung + ', s = ' + P.s + (P.rung >= 3 ? ', λ = ' + P.lam : '') + ' · Snapshot as of ' + esc(R.meta.asOf) + ' · All figures projected from the sealed snapshot; nothing here is live data.';
})();
