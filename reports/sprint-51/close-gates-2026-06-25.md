# Sprint 51 close gates - 2026-06-25

Internal close artifact for the v1 multi-axis-depth sprint (the guided-sim
parameter sweep is now N-axis, the cartography producer maps N swept axes into
the already-N-axis risk-surface builder, and a real 2-D Agio demonstration
reveals an interaction the 1-D sweep flattens while its 1-D marginal slice
reproduces the known ~33% bad-debt onset). The single-axis assumption lived in
exactly two places — `riptide-sim/src/runner.rs` (`SweepConfig`) and
`cli/src/sim/cartography.ts` — and both are now N-axis; the downstream surface
builder, heatmap renderer, and `assess` ingest were untouched (they were already
N-axis, proven by the Sprint 39 2×4 campaign fixture). A 1-D guided-sim sweep
produces a **byte-identical** surface to before (the 1-D synthetic cartography
test is unmodified and green); all five frozen engine/surface pins, the Sprint 39
campaign surface pin, and the flagship lending `assess` pins stay byte-identical.
The sprint change set is `riptide-sim` (sweep + manifest) + `cli/src/sim` (the TS
producer) + tests + `reports/` only: the scoped regression diff over
`fixtures`/`programs` is empty.

## Base branch

`feat/sprint-51-multi-axis-depth` branched off **`main`** @ `a1576ab` (the spec's
"cleaner alternative"). `main` and `feat/sprint-50-self-serve-deliverable` point
at the **identical** SHA `a1576ab` — Sprint 50 is already in `main` — so the
brief the 2-D end-to-end demo wants is present without a merge. **Not pushed, not
merged.**

## The capability — a 2-D sweep renders a 2-D heatmap (green)

The in-repo proof is two committed tests: the Rust cross-product decode
(`riptide-sim/src/runner.rs`) and the 2-D synthetic cartography test
(`cli/test/sim-cartography.test.ts`). The "materially deeper" demonstration on a
real protocol with a known 1-D baseline is captured verbatim in
`reports/sprint-51/t03-2d-agio-demonstration-2026-06-25.md`:

- 2-D Agio sweep `collateral_price_drop_bps × initial_collateral_ratio_bps`
  (7×4×4 = 112 iterations, status `passed`, 0 panics); 28/28 cells populated,
  every cell `run_count = 4` (the placeability invariant held — every iteration
  recorded every axis).
- The heatmap is a single rows×columns grid whose bad-debt frontier is a
  **diagonal staircase**: the onset crash shifts 30% → 40% → 50% → 60% as the
  opening collateral ratio rises 130% → 150% → 175% → 200% — the interaction a
  1-D sweep (fixed 150%) flattens to a single ~33% onset.
- Cross-validation: the 2-D surface's `initial_collateral_ratio_bps = 15000`
  marginal slice reproduces the known 1-D baseline byte-for-byte on the economics
  ($10 / $25 / $40 bad debt at 40 / 50 / 60% crash; onset between 3000–4000 bps).
- All three execution-honesty gates (`positive_control` / `lifecycle_executed` /
  `determinism`) stay green on the 2-D run.

## Backward-compat — a 1-D sweep is byte-identical (no schema bump)

The existing 1-D synthetic cartography test is **unmodified** (only the import
line gained `writeFile`/`formatSweepFlags` symbols for the new 2-D test; the 1-D
test body and its determinism pin are untouched). Its byte-identity pin is
unchanged from the branch base:

```sh
$ grep -n "SURFACE_SHA256 =" cli/test/sim-cartography.test.ts          # worktree
218:const SURFACE_SHA256 = "c6f363ad604426e3bb5af4d8c9d00bb376b805ea21332094ceed8cf6e2ea238e";
$ git show a1576ab:cli/test/sim-cartography.test.ts | grep "SURFACE_SHA256 ="  # base
176:const SURFACE_SHA256 = "c6f363ad604426e3bb5af4d8c9d00bb376b805ea21332094ceed8cf6e2ea238e";
```

The pin assertion (`a.riskSurfaceJson === b.riskSurfaceJson` then
`sha256(...) === SURFACE_SHA256`) is green in both suite runs below — a 1-D
guided-sim sweep produces the exact same `risk-surface.json` bytes as before.
No surface schema version bump: `RISK_SURFACE_SCHEMA_VERSION = "risk-surface.v1"`
and `RISK_SURFACE_HASH_PREFIX = "riptide-risk-surface-v1"` are unchanged
(`cli/src/campaign/surface.ts` is not in this sprint's diff).

## Scoped regression diff (no engine/fixture/program changes)

This sprint's commits (base = `main` @ `a1576ab`):

```sh
$ git diff --name-only a1576ab..HEAD -- fixtures programs
```

```text
(empty)
```

The full branch diff touches only `riptide-sim/src/runner.rs`,
`riptide-sim/src/bootstrap.rs`, `riptide-sim/src/world.rs` (whitespace only),
`cli/src/sim/cartography.ts`, `cli/src/sim/manifest.ts`,
`cli/src/commands/sim.ts`, `cli/test/sim-cartography.test.ts`,
`cli/test/sim-cli.test.ts`, and `reports/sprint-51/`. The campaign path
(`cli/src/campaign/surface.ts`, `cli/src/report/surface-narrative.ts`, the assess
ingest) is untouched, so the Sprint 39 surface pin is unreachable from this work.

## Frozen hash gates (five pins, byte-identical)

The release engine was rebuilt from the closed tree before re-running the dynamic
pins — `cargo build --release -p riptide-engine` reported `Finished in 0.23s`
with no recompilation, confirming `riptide-sim` is not in the engine's build
graph (the engine pins are structurally untouched). Full log:
`reports/sprint-51/raw-logs/engine-pins-2026-06-25.log`.

```sh
$ sha256sum fixtures/scenarios/lending/whale-shock-grid/simulation-result.json fixtures/campaigns/lending/whale-shock-cartography/expected-risk-surface.json
```

```text
60f72adee15451af60f559cdfb9609813b54c34565f7c76fe7e5cf8495a42470  fixtures/scenarios/lending/whale-shock-grid/simulation-result.json
11c60685a6e57f02bce65ef63d2fd49566268669bacd03cbd4f294024873206f  fixtures/campaigns/lending/whale-shock-cartography/expected-risk-surface.json
```

```sh
$ env RIPTIDE_ENGINE_BIN=target/release/riptide-engine bash scripts/perpetuals-scratch.sh
    run A: 1518bcfdeb6cdb7d538be86584195b4b348b73beed610003d4a35939994f1878
    run B: 1518bcfdeb6cdb7d538be86584195b4b348b73beed610003d4a35939994f1878
>>> OK — perps scratch scenario is deterministic across two replays

$ env RIPTIDE_ENGINE_BIN=target/release/riptide-engine bash scripts/amm-scratch.sh
    run A: 5de060cdcacfbacaa598a387a9f249e7633fedac449f137d62c0ede9cf10624f
    run B: 5de060cdcacfbacaa598a387a9f249e7633fedac449f137d62c0ede9cf10624f
>>> OK — amm scratch scenario is deterministic across two replays

$ bash fixtures/replays/lending-whale-bad-debt/rerun.sh
wrote pack: .../replay-lending-whale-bad-debt (run-id=replay-lending-whale-bad-debt, canonical-hash=6c59db5ebf916c8cc068c8fea8727d4edf26d244f288f6dadd7e9ae47d16c4a1)
```

All five pins match their frozen values:

- whale-shock-grid `60f72adee15451af60f559cdfb9609813b54c34565f7c76fe7e5cf8495a42470`
- perps scratch `1518bcfdeb6cdb7d538be86584195b4b348b73beed610003d4a35939994f1878`
- AMM scratch `5de060cdcacfbacaa598a387a9f249e7633fedac449f137d62c0ede9cf10624f`
- lending replay `6c59db5ebf916c8cc068c8fea8727d4edf26d244f288f6dadd7e9ae47d16c4a1`
- Sprint 39 surface `11c60685a6e57f02bce65ef63d2fd49566268669bacd03cbd4f294024873206f`

## Flagship assess pins (identical)

Regenerated end-to-end with the canonical out path the pin was taken from (the
assessment embeds the campaign root label, so byte-identity requires
`tmp/flagship-run`), against the CLI rebuilt at the final tree. Full log:
`reports/sprint-51/raw-logs/flagship-assess-pins-2026-06-25.log`.

```sh
$ node cli/dist/src/index.js campaign run fixtures/campaigns/lending/whale-shock-cartography/campaign.toml --out tmp/flagship-run
  Digest: 40a5f239691a...4277f2
$ node cli/dist/src/index.js assess tmp/flagship-run/campaign_40a5f239691a --out <tmp>
$ sha256sum <tmp>/assessment.md <tmp>/assessment.json
```

```text
aa9ab5894ceb9454695004a8d4b537bf506f72fd60ce7bac82ff0465d4107d21  assessment.md
2de4739b505241dd9e73e715a661bf13a55a68e4e302045be8e882c5a6a29f9e  assessment.json
```

Byte-identical to the authoritative pins (`aa9ab589…` / `2de4739b…`); campaign
digest `40a5f239691a…` unchanged. The real-campaign branch of the narrative is
untouched by construction (this sprint changed only the upstream guided-sim sweep
+ producer, not the campaign or assess paths); the in-suite flagship byte-pin
tests are green in both suite runs below.

## CLI suite (twice, at the final tree)

Full verbatim stdout committed at
`reports/sprint-51/raw-logs/npm-test-2026-06-25-run1.log` and
`reports/sprint-51/raw-logs/npm-test-2026-06-25-run2.log`.

```sh
$ npm --prefix cli test   # run 1
```

```text
ℹ tests 767
ℹ suites 0
ℹ pass 762
ℹ fail 0
ℹ cancelled 0
ℹ skipped 5
ℹ todo 0
```

```sh
$ npm --prefix cli test   # run 2
```

```text
ℹ tests 767
ℹ suites 0
ℹ pass 762
ℹ fail 0
ℹ cancelled 0
ℹ skipped 5
ℹ todo 0
```

The 5 skips are pre-existing (unchanged since Sprint 49); the suite grew from 764
to 767 tests this sprint (the multi-axis manifest reader/formatter/lint tests +
the 2-D synthetic cartography test).

## riptide-sim suite + fmt (this sprint touched Rust)

Full logs `reports/sprint-51/raw-logs/cargo-test-riptide-sim-2026-06-25.log` and
`reports/sprint-51/raw-logs/cargo-fmt-check-2026-06-25.log`.

```sh
$ cargo test -p riptide-sim
test result: ok. 52 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 3.07s
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.15s
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

$ cargo fmt -p riptide-sim --check
(clean — exit 0, no diff)
```

The 4 new sweep tests (cross-product decode, single-axis linear-sequence parity,
per-cell population, record-every-axis-per-iteration) plus the multi-axis
manifest deserialize test are inside the 52 unit tests.

## Commits (logical chunks)

On `feat/sprint-51-multi-axis-depth` off `main` @ `a1576ab`:

- `d4df737` — Generalize the guided-sim sweep from one axis to a cross-product of N (Rust sweep)
- `bda30fa` — Accept the multi-axis sweep shape from the sim manifest (Rust manifest)
- `7d4816e` — Map N swept axes through the cartography producer into the surface (TS producer)
- `234b3d5` — Record the 2-D Agio demonstration + 1-D cross-validation (demo/eval)
- (this artifact + the suite/pin logs land in the close-record commit that follows)

## Process gates

No push (branch is local; `main` == public `origin/main` @ `a1576ab`), no publish
(`docker push` / `gh release create` / `npm publish` / `cargo publish` unused), no
`--amend`, no `git add -A` (every commit staged explicit paths), no engine/surface
hash retune. The `cli/.riptide/runs/baseline/` sample-run files re-dirty with
nondeterministic `wall_clock` timing when the suite runs; that timing-only churn
was restored (`git restore`) and never staged. Vocab grep over the sprint's code
surfaces clean (sprint/phase/T-ID vocab confined to `.specs/` + Obsidian +
`reports/`).
