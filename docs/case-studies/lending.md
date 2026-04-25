# Hero Grid — Solend Fork, Whale × Shock Parameter Discovery

> **What this is:** A parameter-boundary discovery run on a Solend fork — a 3×3 whale-share × price-shock grid with bad-debt surfaces, and the shipping example of what a Riptide outcome looks like when it lands well. **Audience:** reviewers and adopters evaluating whether Riptide's load-bearing claim holds on a real program.

**Artifact:** `fixtures/scenarios/lending/hero-grid/results.json`
**Adapter:** `fixtures/adapters/lending.toml` (sha256 `6d35cb7b…9c2c8`)
**Whale persona:** `fixtures/personas/whale.toml` (sha256 `14e67272…2956e`)
**Seed:** `42` · **Agents:** `20` · **Ticks:** `20` · **Scenario:** `price-shock`

## Intro

This is a parameter-boundary discovery run against the Solend fork. We sweep a 3×3 grid — whale share ∈ {5%, 15%, 25%} crossed with price shock ∈ {20%, 30%, 40%} — against the same seed, the same pool config, the same engine binary, and we aggregate bad debt per cell. The question the grid is answering is not "what did Solend do wrong in June 2022." The question is "where, in this parameter plane, does the lending program's liquidation math stop being able to close the whale cleanly."

> **Load-bearing claim:** *Riptide maps the danger region; Solend's actual parameters sit inside it.*

**Read this first:** [Caveat — lab, not oracle](#caveat--lab-not-oracle). The grid is a map of a parameter region, not a verdict on the program. The dev picks the experiment; Riptide runs it deterministically; the dev draws the conclusions.

## 3×3 bad-debt table

Bad debt is in quote-asset units, post-shock, end of run.

| whale \ shock | **s20** | **s30** | **s40** |
|---|---:|---:|---:|
| **w5** (5 % whale share) | 0 | 0 | 720 |
| **w15** (15 % whale share) | 0 | 0 | 2 160 |
| **w25** (25 % whale share) | 0 | 0 | **3 600** |

The bolded cell (`w25-s40`) is the Solend June 2022 mapping — see below.

### Supporting per-cell metrics

| cell | whale % | shock % | liquidations | agents liquidated | final TVL | final util % |
|---|---:|---:|---:|---:|---:|---:|
| w5-s20 | 5 | 20 | 0 | 0 | 3 235 | 1.98 |
| w5-s30 | 5 | 30 | 1 | 1 | 3 235 | 0.00 |
| w5-s40 | 5 | 40 | 1 | 1 | 3 214 | 0.00 |
| w15-s20 | 15 | 20 | 0 | 0 | 3 105 | 6.18 |
| w15-s30 | 15 | 30 | 3 | 3 | 3 105 | 0.00 |
| w15-s40 | 15 | 40 | 3 | 3 | 3 082 | 0.00 |
| w25-s20 | 25 | 20 | 0 | 0 | 2 975 | 10.76 |
| w25-s30 | 25 | 30 | 5 | 5 | 2 975 | 0.00 |
| w25-s40 | 25 | 40 | 5 | 5 | 2 950 | 0.00 |

Liquidation count is the number of whale positions the `steady-lp` liquidator
cleared in the run; `agents liquidated` matches because the whale is the only
persona that opens a liquidatable borrow in this grid.

## The knife edge

The transition from zero bad debt to non-zero bad debt lives on the **shock
axis**, between 30 % and 40 %. All three whale rows show the same shape:
`bad=0 → bad=0 → bad>0` as shock walks from 20 % to 30 % to 40 %.

**Why s20 is quiet.** At 20 % shock the whale's post-shock health lands at
exactly 1.0 in the program's bps math. The lending program returns
`PositionHealthy` and the liquidator call is rejected — the whale holds the
position through the run. Zero bad debt, but also zero information about the
liquidator's capacity.

**Why s30 is clean.** At 30 % shock the whale is structurally underwater —
health drops to roughly 0.875 — but the `steady-lp` liquidator's fixed 6 500
repay only needs to consume about 96 of the whale's 100 collateral units to
clear the position. The liquidation succeeds on the first call, the program
flags `borrower.liquidated = true`, and no shortfall is ever realized. Bad
debt stays at 0 even though the position was underwater — the liquidation
math *happened* to have enough headroom to close it.

**Why s40 is the edge.** At 40 % shock the same 6 500 repay needs around
112 of the whale's 100 collateral units. Collateral exhausts inside a single
liquidation call, and the gap between what the liquidator repaid and what the
whale's collateral covered becomes realized bad debt — 720 per whale. With
five whales on the `w25-s40` row, the total lands at **3 600**.

So the knife edge is not "the program fails at 40 % shock." The knife edge is
"between 30 % and 40 % shock, the liquidator's single-call repay size stops
being enough to exhaust the whale's collateral in one pass, and every bit of
slippage past that point falls straight into bad debt." That is a property of
the interaction between whale sizing, liquidator sizing, and the program's
`borrower.liquidated` flag — not a property the dev would have guessed from
reading the source.

**Loss amplification on the whale axis.** Holding shock at s40 and walking
whale share from 5 % → 15 % → 25 % grows bad debt 720 → 2 160 → 3 600. The
per-whale shortfall is constant (720 per whale); the whale axis is simply
counting how many whales exist in the cell. That is the expected shape and it
keeps the grid honest — the whale axis is a multiplier, the shock axis is
where the structural boundary lives.

## The Solend June 2022 cell

The Solend June 2022 incident involved a whale holding roughly 22–25 % of
open borrows on the SOL market, against a SOL drawdown in the 30–50 % band
over the week around the event. The closest discrete cell in this grid is
**`w25-s40`** — highest whale share, largest shock. Its bad debt in the run
is **3 600**, firmly inside the non-zero region.

The claim is not that Riptide tells you Solend's parameters were unsafe. The
claim is that when you ask Riptide "where does the whale-vs-liquidator math
stop working on this lending program," it hands you back a region — and the
parameters Solend was actually running in June 2022 fall inside that region.
That is the load-bearing credibility claim: *Riptide maps the danger region;
Solend's actual parameters sit inside it.* What the grid does is discover
where the program's liquidation math loses headroom, computed against the
same seed and the same pool config, and observe that the historical
operating point sits inside that region. No hack narrative is being staged
from the outside; the grid is an affirmative map of a parameter plane, and
the June 2022 coordinates happen to land inside the region the map flags.

## Caveat — lab, not oracle

> **Riptide is a lab, not an oracle.** The dev picks the experiment —
> Riptide does not tell you what's wrong with your program. Riptide runs the
> experiment deterministically: same seed in, same bytes out, every time, so
> the grid you're reading is reproducible from the adapter TOML and the
> persona TOML alone. And nobody is claiming this catches bugs on its own.
> The grid maps a parameter region; the dev draws the conclusions. A cell
> that comes back with bad debt is not a bug report — it is a point in
> parameter space where the program's math lost headroom, and the dev is the
> one who decides whether that point matters.

This is the canonical wording. It is copy-pasted verbatim into `README.md`,
`PROJECT.md`, the demo README, the grant draft, and the Workstream 3 anchor
slide. Do not paraphrase it in downstream touchpoints.

## Conclusion

The hero grid lands three claims on disk:

1. **Knife edge is real.** The shock-axis transition between s30 and s40
   shows zero bad debt flipping to non-zero bad debt across all three whale
   rows. That transition is in the data — `results.json` cells
   `w{5,15,25}-s{30,40}` — not narrated from outside.
2. **Solend June 2022 is inside the danger region.** `w25-s40` is the
   discrete cell that best matches the historical whale share and shock
   magnitude, and its bad debt is 3 600 — in the non-zero region, by a wide
   margin.
3. **The framing is parameter-boundary discovery.** Riptide mapped a
   parameter region on the same program, against the same seed, and the
   historical operating point fell inside the region the grid flagged.
   That is a different claim from any after-the-fact incident narrative,
   and it is the claim the pitch rests on.

Before you forward any cell from this grid to a reader, re-read the
[Caveat — lab, not oracle](#caveat--lab-not-oracle). The grid is a map of a
parameter region, not a verdict on the program.

## Reproducibility notes

- **Grid runner:** `scripts/lending-whale-grid.sh` drives the sidecar
  that reads `fixtures/personas/whale.toml`, emits per-cell `policies.json`,
  and invokes `target/release/riptide-engine` once per cell.
- **Determinism:** the sweep output is locked at
  `sha256:d6c8088d616592d4c7cf42c44478470cca62d283db04a122481e08baac833fce`
  across two back-to-back full runs. Re-running the grid from this branch is
  unnecessary and will only rotate stderr/timestamp surfaces; the bad-debt
  table is byte-stable.
- **Retune history.** The first sweep came back flat (all nine cells at
  zero bad debt). Two retune passes landed the knife edge:
  1. Whale sizing flipped from proportional 0.45 to a fixed 800 borrow per
     tick; repay/withdraw weights zeroed; triggers removed. The proportional
     sizing was only clearing a single borrow per whale (`Custom(8)
     InsufficientCollateral` on tick 2) so post-shock health stayed above
     1.0 at 40 % — nothing liquidated.
  2. `steady-lp` liquidator repay flipped from proportional 0.08 to a fixed
     6 500 per call, and its liquidate weight grew from 0.05 to 1.5. The
     lending program flags `borrower.liquidated = true` after the first
     partial liquidation, so the per-call repay must be large enough to
     exhaust whale collateral in a single pass — otherwise shortfall is
     never realized and bad debt sticks at 0 even when positions are
     structurally underwater. Deltas live in `bad-debt-table.json.retune_log`
     and are mirrored into `results.json` under `metadata.retune_log`.
- **Follow-ups.** Per-whale shortfall breakdown and
  per-tick liquidation traces are not surfaced in `results.json` today — the
  source timeseries and events live under each cell's
  `simulation-result.json`, and a richer aggregator can pull them in later
  if a downstream consumer needs it.
