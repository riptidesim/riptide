# Sprint 51 · T03 — 2-D Agio demonstration + cross-validation

**Date:** 2026-06-25
**Branch:** `feat/sprint-51-multi-axis-depth` (local; not pushed/merged)
**Case study:** Agio (private, outside the repo — `case-studies/agio/program/.riptide/`)
**Requirement:** R3.2 (the "materially deeper" demonstration); R3.1 backed by the
in-repo T01 Rust cross-product test + T02 2-D synthetic cartography test.

This is the in-repo evidence capture. Nothing case-study-side is committed to the
riptide repo; the Agio run artifacts live in the private case-study tree.

---

## The chosen second axis + rationale

**Second axis: `initial_collateral_ratio_bps`** — the un-crashed collateral value
as a percentage of the debt value (the loan's opening over-collateralization).
Values swept: `[13000, 15000, 17500, 20000]` (130%, 150%, 175%, 200%); the 150%
value is the historical 1-D baseline.

**Why this axis (over reaction-delay or duration):** the known 1-D finding is that
lender bad debt onsets once a collateral crash drives the collateral value below
the outstanding debt value. The crash magnitude required to reach that point is a
*direct function of how far above the debt value the loan opened* — i.e. the
initial collateral ratio. So the two axes are not independent: the bad-debt onset
crash and the initial ratio multiply. A 1-D sweep that fixes the ratio at 150%
reports a single onset (~33% crash) and is structurally blind to the fact that the
same protocol bad-debts at a 30% crash for a thinly-collateralized loan and needs
a 60% crash for a 200% loan. That dependence is the interaction a 1-D sweep
flattens, and it is exactly what a depth-1 prospect can't see on the current
single-axis report.

**Mechanism (case-study `flows.rs`):** the ratio axis is realized purely through
the opening collateral `PriceUpdateV2` price — with `collateral_amount = 1000`,
`debt = 100 @ $1.00`, the collateral value is `ratio_bps / 1000` of the debt, so
`collateral_price_initial = ratio_bps * 1000` (expo -8). Both axis values are
recorded on **every** iteration via `world.record_parameter(...)`, so `placeRun`
places every run (the placeability invariant — see below: 28/28 cells populated,
every cell `run_count = 4`).

---

## The 2-D run, end-to-end

Commands (run from `case-studies/agio/program`, the CLI built from this branch):

```
cargo build --release --manifest-path .riptide/sim/Cargo.toml
node <cli>/dist/src/index.js sim run     .riptide/sim --flows 12 --out .riptide/sim/artifacts/sweep-2d
node <cli>/dist/src/index.js sim surface .riptide/sim/artifacts/sweep-2d --sim .riptide/sim
node <cli>/dist/src/index.js assess      .riptide --input .riptide/assessment-input.json --brief --out .riptide/assess-2d
```

`[sim.sweep]` (multi-axis manifest shape — array-of-tables sharing one
`seeds_per_value`):

```toml
[sim.sweep]
seeds_per_value = 4
[[sim.sweep.axes]]
name = "collateral_price_drop_bps"
values = [0, 1000, 2000, 3000, 4000, 5000, 6000]
[[sim.sweep.axes]]
name = "initial_collateral_ratio_bps"
values = [13000, 15000, 17500, 20000]
```

**Run:** 7 × 4 × 4 = **112 iterations, status `passed`, 0 non-passed, 0 panics**,
40 iterations fired `lender_bad_debt`. The cross-product decode was confirmed in
the run log: `initial_collateral_ratio_bps` (last declared axis) varies fastest,
then `collateral_price_drop_bps`, e.g. iterations 96–111 step
`drop=6000 × {13000,13000,13000,13000, 15000,…, 17500,…, 20000,…}`.

**Surface:** 28/28 cells populated (full 7 × 4 grid), every cell `run_count = 4`
— no run dropped for a missing axis coordinate. Both axes survive into
`surface.axes`, both ranked in `surface.sensitivity`, `safe_region` names bounds
on both axes (`collateral_price_drop_bps ∈ {0,1000,2000}`, all ratios).

### Execution-honesty gates (verbatim, `sim surface` + `assess`)

```
execution-honesty gates: pass
    ✓ positive_control: positive control collateral_price_drop_bps=0 passed across 16 iteration(s).
    ✓ lifecycle_executed: all 3 declared lifecycle flow(s) executed on-chain.
    ✓ determinism: surface hash recorded for re-verification (sha256 9ba4762b673c2909…).
```

```
Execution honesty: pass
    ✓ positive_control
    ✓ lifecycle_executed
    ✓ determinism
```

All three gates green on the 2-D run. (`assess` first refused to overwrite the
existing 1-D `.riptide/assessment.*`, the determinism drift guard doing its job;
re-running into the clean `--out .riptide/assess-2d` dir rendered cleanly.)

`risk-surface.json` sha256 `9ba4762b673c2909bd562555856a36acd767d13cdb493e1cbf245dad10e88c51`;
assessment digest `fc3b5c8c158420efab80288176aab59a039ad1d33a971266ed65588e39e604f9`.

---

## The 2-D heatmap (verbatim from `assessment.md`)

```
### Failure-rate heatmap

Legend: `░` 0–25%  `▒` 25–50%  `▓` 50–75%  `█` 75–100%  `·` no runs

Rows: `collateral_price_drop_bps` (most sensitive, rank 1). Columns: `initial_collateral_ratio_bps` (rank 2).

| collateral_price_drop_bps ↓ \ initial_collateral_ratio_bps → | 13000 | 15000 | 17500 | 20000 |
|---|---|---|---|---|
| 0 | ░ 0.0% | ░ 0.0% | ░ 0.0% | ░ 0.0% |
| 1000 | ░ 0.0% | ░ 0.0% | ░ 0.0% | ░ 0.0% |
| 2000 | ░ 0.0% | ░ 0.0% | ░ 0.0% | ░ 0.0% |
| 3000 | █ 100.0% | ░ 0.0% | ░ 0.0% | ░ 0.0% |
| 4000 | █ 100.0% | █ 100.0% | ░ 0.0% | ░ 0.0% |
| 5000 | █ 100.0% | █ 100.0% | █ 100.0% | ░ 0.0% |
| 6000 | █ 100.0% | █ 100.0% | █ 100.0% | █ 100.0% |
```

This is a single 2-D rows × columns grid (not two stacked 1-D gradients), and it
shows a **visible interaction**: the bad-debt frontier is a diagonal staircase.
Read down any column the onset is one crash level; read across the rows the onset
crash *shifts right as the initial ratio rises*:

```
=== bad-debt-fire onset crash per initial collateral ratio (the interaction) ===
CR_bps | CR%  | first drop that fires | onset crash%
 13000 | 130% | 3000 bps | 30%
 15000 | 150% | 4000 bps | 40%
 17500 | 175% | 5000 bps | 50%
 20000 | 200% | 6000 bps | 60%
```

A 1-D sweep that fixes the ratio at 150% reports a single onset (~33%, between
3000–4000 bps) and cannot see that a 130% loan bad-debts at a 30% crash while a
200% loan needs a 60% crash. **That dependence is the 2-D-only finding.** (The
onset is sharp because `lender_bad_debt` fires on a >1%-of-debt shortfall; the
underlying continuous gradient — $10 → $25 → $40 — is recorded as the `bad_debt`
metric per cell.)

---

## Cross-validation: the 1-D marginal slice reproduces the known ~33% onset

The 2-D surface contains the original 1-D experiment as the `initial_collateral_ratio_bps = 15000`
column. Extracting that marginal slice from the same 2-D run document:

```
=== 1-D marginal slice at initial_collateral_ratio_bps=15000 (the historical baseline) ===
drop_bps | crash% | fire | avg bad_debt(USD)
      0 |     0% | 0/4 | 0.00
   1000 |    10% | 0/4 | 0.00
   2000 |    20% | 0/4 | 0.00
   3000 |    30% | 0/4 | 0.00
   4000 |    40% | 4/4 | 10.00
   5000 |    50% | 4/4 | 25.00
   6000 |    60% | 4/4 | 40.00
```

Compared against the **known 1-D baseline** (Agio CONFIG-NOTES, 2026-06-09,
single-axis `collateral_price_drop_bps` sweep at the fixed 150% loan):

| drop_bps | crash | 1-D baseline bad_debt / fire | 2-D CR=15000 slice bad_debt / fire |
|---:|---:|---|---|
| 0    | 0%  | 0.00 / 0%   | 0.00 / 0/4   |
| 1000 | 10% | 0.00 / 0%   | 0.00 / 0/4   |
| 2000 | 20% | 0.00 / 0%   | 0.00 / 0/4   |
| 3000 | 30% | 0.00 / 0%   | 0.00 / 0/4   |
| 4000 | 40% | 10.00 / 100%| 10.00 / 4/4  |
| 5000 | 50% | 25.00 / 100%| 25.00 / 4/4  |
| 6000 | 60% | 40.00 / 100%| 40.00 / 4/4  |

**Identical**: same bad-debt onset (between 3000–4000 bps; analytic ~3334 bps =
~33% for a 150%-start / $100-debt loan), same $10 → $25 → $40 shortfall growth,
same fire pattern. The 2-D surface's 1-D marginal slice reproduces the known
result — the new axis deepened the finding without perturbing the baseline.

---

## Pins / scope confirmation

- This phase **ran the tool**; it changed no engine, fixture, surface-builder, or
  renderer source in the riptide repo. `git status` is unchanged from the Phase 2
  working tree (the T01/T02 `M` files only); the sole repo addition is this
  `reports/sprint-51/` evidence. `cli/src/campaign/surface.ts` and
  `cli/src/report/surface-narrative.ts` (the already-N-axis downstream) were not
  touched — the Sprint 39 surface pin is unreachable from this path.
- The five frozen engine pins, the Sprint 39 surface pin
  (`11c60685…`), and the flagship assess pins (`aa9ab589…`/`2de4739b…`) are
  re-verified at close (T04); nothing in T03 edits their inputs.
- Case-study changes (Agio `flows.rs` second-axis wiring, `Riptide.toml` 2-D
  `[sim.sweep]`, the `sweep-2d`/`assess-2d` artifacts) live in the private
  case-study tree and are **not** committed to the riptide repo.

## Hand-off to Phase 4 (T04 close)

- T03 is **done, not cut.** The 2-D capability is demonstrated on a real protocol
  with a known baseline: the heatmap renders a 2-D rows × columns grid, the three
  execution-honesty gates stay green, the interaction (bad-debt onset crash
  shifts 30% → 60% with the initial ratio) is visible, and the 1-D marginal slice
  cross-validates against the known ~33% onset byte-for-byte on the economics.
- T04 should: re-confirm the 1-D byte-identical cartography test, the Sprint 39 +
  five frozen + flagship assess pins, run `cli` + `riptide-sim` suites green twice
  (plus `cargo fmt --check`, since this sprint touched `riptide-sim`), and land
  the 3–5 logical commits (Rust sweep · TS producer · this demo/eval · close).
  No push, no publish.
