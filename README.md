# Implied Radar v4 — token-radar-01

[![Competition](https://make.fun/badge/token-radar-01.svg)](https://make.fun/)
[![Rank](https://make.fun/badge/token-radar-01/LeviosaEXC/token-radar-01-implied-radar-v4/rank.svg)](https://make.fun/)
[![Reward](https://make.fun/badge/token-radar-01/LeviosaEXC/token-radar-01-implied-radar-v4/reward.svg)](https://make.fun/)

A token launch radar: it reads a sealed snapshot of every protocol,
works out which ones record no token yet, ranks them by what their
launch would be worth, and hands in a web dashboard with the board, a
detail view for every protocol, and the steps to farm it.

## What it does

The program (`main.ts`, Node 22, standard library only) reads the
sealed snapshot at `/input/snapshot.json` and writes:

- `/output/board.json` — 198 ranked pre-token protocols, each with an
  implied value and a six-step farm plan.
- `/output/dashboard/` — a static page that renders with no network:
  the board, a detail drawer per protocol, filters, the full
  validation record, and a reference view of the fitted universe.
- `/output/screenshots/` — three captures of the dashboard.
- `/output/dossier.json` — built with the kit's `buildDossier`.

Every number on the page is recomputed in the browser from the
snapshot fields plus the shipped parameters, using the same shared
modules the program runs (`dashboard/model.js`, `dashboard/farm.js`).
The page footer proves it: recompute verified 198/198, drift $0.00.

## The model

A Huber power law in log10(market cap) on log10(TVL / $50M), fitted
on 88 live comps that pass the comp screen, with a rung ladder of
candidate enrichments (window-relative age percentile, chain breadth,
guarded group offsets, growth) blended toward the bare curve. The
shipping gate (G1–G4: placebo-calibrated significance, walk-forward
non-inferiority, ordinal non-inferiority) admitted no challenger, so
the shipped model is the bare curve itself: rung R0, blend s = 0.

Measured validation (see the Method tab for the full record):

- Nested leave-one-out, selection included: 0.5186 dex / 3.30x.
- Shipped-model leave-one-out: 0.5398 dex / 3.47x, Spearman 0.332.
- Flat baseline: 0.6162 dex / 4.13x.
- Placebo: 200 seeded target permutations, ship rate 71.5%,
  P95 null gain 0.0791 dex sets the G1 bar; best challenger gain
  0.0538 dex clears nothing.
- Coverage: nested 80% band 84.1%, time-split 80% band 85.7%.
- Tiers: 0 ROBUST, 0 FARM, 0 THIN, 198 SKIP — the honest output of
  the frozen tier rule at these implied values; the practical strip
  still surfaces the six best positive-net rows.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /input/snapshot.json
```

Two runs write identical bytes. Runtime is about 25 seconds on one
CPU, inside the 120-second limit.

## Layout

- `main.ts` — the entry program: census, validation, bands, economics,
  payload, dossier.
- `dashboard/` — `index.html`, `app.css`, `app.js`, plus the shared
  `model.js` and `farm.js`. `data.js` is written by the program.
- `vendor/makefun-board.ts` — the kit's dossier library, byte for byte.
- `screenshots/` — the board, a detail view, and a filtered view.

## License

MIT — see `LICENSE`.
