# Sprint 34 Phase 2 Battle-Test Results

Captured: 2026-05-13

This report records fresh Phase 2 command evidence for the battle-test matrix.
All execution stayed local: no private keys, no deployments, no live RPC writes,
no publishing, and no protocol-support claim beyond the exact declared inputs
and generated artifacts.

Sprint 35 added a semantic AMM evidence summary at:

```text
reports/real-world-scale/semantic-amm-evidence.md
```

Generated Sprint 34 artifacts are under:

```text
reports/real-world-scale/artifacts/t04
```

Artifact size observed after the runs:

```text
$ cd /home/ailton/Work/riptide/riptide && du -sh reports/real-world-scale/artifacts/t04
23M	reports/real-world-scale/artifacts/t04
```

## Verdict Summary

| Target | Fresh evidence | Exit status | Actual verdict | Blocker class | Next smallest action |
| --- | --- | ---: | --- | --- | --- |
| Raydium CP-Swap | `doctor`, `readiness`, `lint`, direct `run`, campaign `validate`, `plan`, bounded `run`, campaign `review`; Sprint 35 semantic `amm.v1` lint/direct/campaign/review | all 0 | `runs` with semantic AMM local-slice evidence | Sprint 35 removed the generic-only semantic blocker for the bounded CP-Swap smoke slice. | Keep the claim scoped to Raydium CP-Swap semantic AMM local-slice evidence; do not claim broad Raydium support. |
| Lending committed controls | root `doctor`, `run`, campaign `validate`, `plan`, bounded `run`, campaign `review`, flagship `replay` | doctor 1, others 0 | `runs` | Root doctor warning is fixture lint coverage, not execution failure. Temp replay clone exposed missing built SBF artifact if the clone does not build programs. | Keep clean-checkout gate building SBF before replay; do not claim proof-level review unless provenance/proof metadata is present. |
| Mango V4 | `readiness`, `lint`, direct `run`, campaign `validate`, `plan`, bounded `run`, campaign `review` | all 0 | `runs` | No T04 execution blocker for bounded local slice. | Expand market-state target selection before claiming order placement, fills, funding, PnL settlement, bankruptcy, or liquidation coverage. |
| Whirlpools | `readiness`, `lint`, direct `run`, attempted direct `review`, campaign `validate`, `plan`, bounded `run`, campaign `review`; Sprint 35 semantic lint/review classification | direct review 2, others 0 | `runs` with base `amm.v1` proxy evidence | Direct run output is not a review pack; campaign review is the supported review path. Full CLMM semantics are not covered. | Keep the campaign retained-case review as base AMM proxy evidence; defer tick/range/position/fee-growth/reward semantics to a future CLMM extension. |
| Anchor Uniswap V2 | `readiness`, `lint` | readiness 0, lint 2 | `blocked` | Repo artifact/setup blocker. | Finish adapter accounts/actions/personas and restore or regenerate scenario/campaign/guided artifacts before execution. |
| Drift protocol-v2 | `readiness`, `lint` | both 0 | `blocked` | Repo artifact/setup blocker despite lint pass: run collection lacks passing state movement and no harness is present. | Adjust scenario/personas/adapter dispatch or add harness so a run produces state movement. |
| SPL selected target | `readiness`, `lint` | both 0 | `blocked` | Evidence blocker for stronger claim: readiness partial, no harness, lint skips machine lineage validation. | Add harness or clearly document harness-free boundary; add `[lineage]` for machine validation. |
| Stablecoin protocol | `readiness`, `lint` | both 0 | `out-of-scope` | No static blocker observed; not part of bounded direct execution cut. | Direct-run a PSM slice in a later pass if this row becomes a Phase 2 execution target. |
| Liquid staking candidates | `readiness`, `lint` for Marinade program and fork | all 0 | `out-of-scope` | No static blocker observed for bounded LST slices; direct execution deferred. | Direct-run a selected LST slice later; full stake-account, validator-management, admin, delayed-unstake, and crank coverage remain future work. |
| Perpetuals | `readiness`, `lint` | both 0 | `out-of-scope` | No static blocker observed; direct execution deferred. | Direct-run a collateral/perps slice later; liquidation, collateral removal, open-position lifecycle, and adverse oracle trajectories remain future work. |

## Runnable Evidence

### Raydium CP-Swap

Static health:

```text
$ cd /home/ailton/Work/riptide/case-studies/raydium-cp-swap && NO_COLOR=1 RIPTIDE_ENGINE_BIN=/home/ailton/Work/riptide/riptide/target/release/riptide-engine node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js doctor --quiet
Summary
   PASS :8   WARN :0   FAIL :0
  Verdict: PASS (exit 0)
```

Adapter lint:

```text
$ cd /home/ailton/Work/riptide/case-studies/raydium-cp-swap && NO_COLOR=1 RIPTIDE_ENGINE_BIN=/home/ailton/Work/riptide/riptide/target/release/riptide-engine node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js lint .riptide/adapters/raydium-cp-swap.toml
Summary
   PASS :1   WARN :0   FAIL :0   SKIP :0
  Verdict: PASS (exit 0)
```

Readiness boundary:

```text
$ cd /home/ailton/Work/riptide/case-studies/raydium-cp-swap && NO_COLOR=1 RIPTIDE_ENGINE_BIN=/home/ailton/Work/riptide/riptide/target/release/riptide-engine node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js readiness .
- Observed support level: L4 - generic E2E observed
- Status: blocked
- Missing inputs: semantic_e2e_run
- next action (semantics): Add a [semantics] block using the existing amm.v1 core class and rerun until semantics_evaluated passes.
```

Direct run:

```text
$ cd /home/ailton/Work/riptide/case-studies/raydium-cp-swap && NO_COLOR=1 RIPTIDE_ENGINE_BIN=/home/ailton/Work/riptide/riptide/target/release/riptide-engine node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js run .riptide/scenarios/swap-pressure/run-config.json --adapter .riptide/adapters/raydium-cp-swap.toml --harness .riptide/harness --seeds 1 --seed-root 1337 --output-dir /home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t04/raydium-run --quiet
riptide run: 1 scenario
ok swap-pressure  (21.2s, no failure observed, confidence: medium, coverage: exercised)

1 pass · 0 fail · 0 error · 0 skip
verdicts: 1 no-failure-observed
```

Bounded campaign:

```text
$ cd /home/ailton/Work/riptide/case-studies/raydium-cp-swap && NO_COLOR=1 RIPTIDE_ENGINE_BIN=/home/ailton/Work/riptide/riptide/target/release/riptide-engine node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js campaign run .riptide/campaigns/raydium-cp-swap-smoke.campaign.toml --max-runs 2 --out /home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t04/raydium-campaign --harness .riptide/harness
Campaign complete: raydium-cp-swap-smoke
  Runs: 2/2 completed, 0 setup errors, 0 skipped runs
  Size: 2x swap_pressure (40 agents x 100 ticks)
  Simulation time: 2.93s
  Artifacts: /home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t04/raydium-campaign/campaign_c691a3a7933c
```

Campaign review:

```text
$ cd /home/ailton/Work/riptide/case-studies/raydium-cp-swap && NO_COLOR=1 RIPTIDE_ENGINE_BIN=/home/ailton/Work/riptide/riptide/target/release/riptide-engine node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js review /home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t04/raydium-campaign/campaign_c691a3a7933c --quiet
# Campaign Review: raydium-cp-swap-smoke
- Completed runs: 2
- Invariant-failed runs: 0
- Setup errors: 0
- pass: retained case digest verified: 61391e33445457aa3841395d86a566b68a65af45664ab904352eac5f4be0134e
```

Sprint 35 semantic update:

- New artifact root: `reports/real-world-scale/artifacts/semantic-amm/raydium/campaign_c691a3a7933c`
- Classification: Raydium CP-Swap semantic `amm.v1` local-slice evidence.
- Boundary: this is the local CP-Swap smoke slice only, not broad Raydium support.
- Summary: `reports/real-world-scale/semantic-amm-evidence.md`

### Lending Controls

Root doctor:

```text
$ cd /home/ailton/Work/riptide/riptide && NO_COLOR=1 RIPTIDE_ENGINE_BIN=/home/ailton/Work/riptide/riptide/target/release/riptide-engine node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js doctor --quiet
Summary
   PASS :12   WARN :1   FAIL :0
  Verdict: WARN (exit 1)
```

The warning is the fixture `liquid-staking` adapter lint coverage caveat. It did
not block the committed lending run or campaign.

Safe run:

```text
$ cd /home/ailton/Work/riptide/riptide && NO_COLOR=1 RIPTIDE_ENGINE_BIN=/home/ailton/Work/riptide/riptide/target/release/riptide-engine node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js run examples/configs/safe.json --adapter fixtures/adapters/lending.toml --output-dir /home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t04/lending-safe --quiet
riptide run: 1 scenario
LLM unavailable — using default policies (shown once per command)
ok configs  (0.1s, no failure observed, confidence: medium, coverage: exercised)

1 pass · 0 fail · 0 error · 0 skip
verdicts: 1 no-failure-observed
```

Lending campaign:

```text
$ cd /home/ailton/Work/riptide/riptide && NO_COLOR=1 RIPTIDE_ENGINE_BIN=/home/ailton/Work/riptide/riptide/target/release/riptide-engine node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js campaign run fixtures/campaigns/lending/solend-shape-liquidation-safety/campaign.toml --max-runs 3 --out /home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t04/lending-campaign
Campaign complete: solend-shape-liquidation-safety
  Runs: 3/3 completed, 0 setup errors, 0 skipped runs
  Risk signals: bad debt max=4320, liquidations max=6, max utilization=16.8
  Size: 1x oracle_lag_baseline (10 agents x 22 ticks), 1x whale_share_sweep (20 agents x 20 ticks), 1x whale_shock_grid (20 agents x 20 ticks)
  Simulation time: 175ms
```

Lending campaign review:

```text
$ cd /home/ailton/Work/riptide/riptide && NO_COLOR=1 RIPTIDE_ENGINE_BIN=/home/ailton/Work/riptide/riptide/target/release/riptide-engine node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js review reports/real-world-scale/artifacts/t04/lending-campaign/campaign_2a93d0358025 --quiet
# Campaign Review: solend-shape-liquidation-safety
- Completed runs: 3
- Invariant-failed runs: 0
- Setup errors: 0
- pass: worst_bad_debt maps to run_000002_2465e1b314c3
- pass: worst_liquidity maps to run_000002_2465e1b314c3
```

Flagship replay from the main checkout:

```text
$ cd /home/ailton/Work/riptide/riptide && NO_COLOR=1 RIPTIDE_ENGINE_BIN=/home/ailton/Work/riptide/riptide/target/release/riptide-engine node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js replay fixtures/replays/lst-lending-contagion-proof/config.json --allow-invariant-violations --quiet
riptide replay (multi-component): components=liquid_staking, lending
riptide-engine: 3 invariant violation(s) recorded; --allow-invariant-violations restores exit 0
Scenario: replay:multi:lst-lending-contagion-proof-upstream
Invariants:
  - liquid_staking:no_slash_during_healthy_run: liquid_staking.pool.cumulative_slashed == 0 (2×)
  - liquid_staking:no_queue_formation: liquid_staking.pool.pending_unstake_count == 0 (0×)
  - lending:no_bad_debt: lending.pool.bad_debt == 0 (1×)
wrote pack: /home/ailton/Work/riptide/riptide/.riptide/pack/replay-multi-lst-lending-contagion-proof-upstream (run-id=replay-multi-lst-lending-contagion-proof-upstream, canonical-hash=d04feab99390d63de6625bad4994a05e89cede359b4599431e815fe327cd0aeb)
```

Temp-checkout replay blocker, captured before rerunning from the main checkout:

```text
error: bootstrap multi-component harness: component `liquid_staking`: load adapter: /tmp/riptide-s34-t04-replay-abs-100461/checkout/fixtures/replays/lst-lending-contagion-proof/../liquid-staking-depeg-redemption-run/adapter.toml: `program_so`: program .so not found at /tmp/riptide-s34-t04-replay-abs-100461/checkout/fixtures/replays/lst-lending-contagion-proof/../liquid-staking-depeg-redemption-run/../../../programs/liquid-staking/target/deploy/liquid_staking.so\nExpected a compiled SBF artifact on disk.\nRun: cargo build-sbf --manifest-path <program>/Cargo.toml (or fix the `program_so` path in the adapter TOML) and retry.
```

That blocker is a clean/temp-checkout setup artifact: the replay needs compiled
SBF outputs unless the clean-checkout gate builds them first.

### Mango V4

Readiness and lint:

```text
$ cd /home/ailton/Work/riptide/case-studies/mango-v4 && NO_COLOR=1 RIPTIDE_ENGINE_BIN=/home/ailton/Work/riptide/riptide/target/release/riptide-engine node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js readiness .
- Observed support level: L7 - campaign-ready inputs present
- Status: ready
- E2E evidence kind: risk-slice
```

```text
$ cd /home/ailton/Work/riptide/case-studies/mango-v4 && NO_COLOR=1 RIPTIDE_ENGINE_BIN=/home/ailton/Work/riptide/riptide/target/release/riptide-engine node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js lint .riptide/adapters/mango-v4.toml
Summary
   PASS :2   WARN :0   FAIL :0   SKIP :0
  Verdict: PASS (exit 0)
```

Direct run:

```text
$ cd /home/ailton/Work/riptide/case-studies/mango-v4 && NO_COLOR=1 RIPTIDE_ENGINE_BIN=/home/ailton/Work/riptide/riptide/target/release/riptide-engine node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js run .riptide/scenarios/collateral-turnover/run-config.json --adapter .riptide/adapters/mango-v4.toml --harness .riptide/harness --seeds 1 --seed-root 1337 --output-dir /home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t04/mango-run --quiet
riptide run: 1 scenario
ok collateral-turnover  (23.0s, no failure observed, confidence: medium, coverage: exercised)

1 pass · 0 fail · 0 error · 0 skip
verdicts: 1 no-failure-observed
```

Campaign and review:

```text
$ cd /home/ailton/Work/riptide/case-studies/mango-v4 && NO_COLOR=1 RIPTIDE_ENGINE_BIN=/home/ailton/Work/riptide/riptide/target/release/riptide-engine node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js campaign run .riptide/campaigns/mango-v4-broad-perps.campaign.toml --max-runs 3 --out /home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t04/mango-campaign --harness .riptide/harness
Campaign complete: mango-v4-broad-perps
  Runs: 3/3 completed, 0 setup errors, 0 skipped runs
  Size: 1x liquidation_cascade (96 agents x 144 ticks), 1x oracle_shock_margin (64 agents x 118 ticks), 1x orderbook_keeper_pressure (80 agents x 130 ticks)
  Simulation time: 14s
```

```text
$ cd /home/ailton/Work/riptide/case-studies/mango-v4 && NO_COLOR=1 RIPTIDE_ENGINE_BIN=/home/ailton/Work/riptide/riptide/target/release/riptide-engine node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js review /home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t04/mango-campaign/campaign_26ed10054503 --quiet
# Campaign Review: mango-v4-broad-perps
- Completed runs: 3
- Invariant-failed runs: 0
- Setup errors: 0
- pass: median maps to run_000001_4b92df2fcc69
- pass: surprising_outlier maps to run_000000_44713dd4efda
```

### Whirlpools

Readiness and lint:

```text
$ cd /home/ailton/Work/riptide/case-studies/whirlpools && NO_COLOR=1 RIPTIDE_ENGINE_BIN=/home/ailton/Work/riptide/riptide/target/release/riptide-engine node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js readiness .
- Observed support level: L7 - campaign-ready inputs present
- Status: ready
- E2E evidence kind: risk-slice
```

```text
$ cd /home/ailton/Work/riptide/case-studies/whirlpools && NO_COLOR=1 RIPTIDE_ENGINE_BIN=/home/ailton/Work/riptide/riptide/target/release/riptide-engine node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js lint .riptide/adapters/whirlpool.toml
Summary
   PASS :2   WARN :0   FAIL :0   SKIP :0
  Verdict: PASS (exit 0)
```

Direct run:

```text
$ cd /home/ailton/Work/riptide/case-studies/whirlpools && NO_COLOR=1 RIPTIDE_ENGINE_BIN=/home/ailton/Work/riptide/riptide/target/release/riptide-engine node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js run .riptide/scenarios/whale-exit-pressure/run-config.json --adapter .riptide/adapters/whirlpool.toml --harness .riptide/harness --seeds 1 --seed-root 1337 --output-dir /home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t04/whirlpool-run --quiet
riptide run: 1 scenario
ok whale-exit-pressure  (23.5s, no failure observed, confidence: medium, coverage: exercised)

1 pass · 0 fail · 0 error · 0 skip
verdicts: 1 no-failure-observed
```

Direct review of a run artifact is not supported:

```text
$ cd /home/ailton/Work/riptide/case-studies/whirlpools && NO_COLOR=1 RIPTIDE_ENGINE_BIN=/home/ailton/Work/riptide/riptide/target/release/riptide-engine node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js review /home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t04/whirlpool-run/whale-exit-pressure --quiet
riptide: review manifest not found
  expected: /home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t04/whirlpool-run/whale-exit-pressure/manifest.json
  next: pass a Riptide evidence pack directory containing manifest.json
(set RIPTIDE_DEBUG=1 for the full stack trace)
```

The campaign review path succeeds:

```text
$ cd /home/ailton/Work/riptide/case-studies/whirlpools && NO_COLOR=1 RIPTIDE_ENGINE_BIN=/home/ailton/Work/riptide/riptide/target/release/riptide-engine node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js campaign run .riptide/campaigns/whirlpool-amm-broad.campaign.toml --max-runs 2 --out /home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t04/whirlpool-campaign --harness .riptide/harness
Campaign complete: whirlpool-amm-broad
  Runs: 2/2 completed, 0 setup errors, 0 skipped runs
  Size: 1x fee_growth_churn (88 agents x 144 ticks), 1x whale_exit_pressure (80 agents x 115 ticks)
  Simulation time: 8.44s
```

```text
$ cd /home/ailton/Work/riptide/case-studies/whirlpools && NO_COLOR=1 RIPTIDE_ENGINE_BIN=/home/ailton/Work/riptide/riptide/target/release/riptide-engine node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js review /home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t04/whirlpool-campaign/campaign_a0852f66871d --quiet
# Campaign Review: whirlpool-amm-broad
- Completed runs: 2
- Invariant-failed runs: 0
- Setup errors: 0
- pass: median maps to run_000000_41c052cc85f5
```

Sprint 35 boundary update:

- Classification: base `amm.v1` proxy evidence for the current local slice.
- Boundary: not full concentrated-liquidity coverage.
- Missing CLMM concepts include tick arrays, range positions, `sqrt_price`/tick movement, fee-growth accounting, rewards, V2/token-extension paths, bundled positions, metadata, and two-hop routing.
- The Whirlpool campaign summary was regenerated with the current class-aware renderer so the `amm.v1` summary no longer shows lending-only risk columns.
- Summary: `reports/real-world-scale/semantic-amm-evidence.md`

## Blocker Evidence

### Anchor Uniswap V2

Readiness:

```text
$ cd /home/ailton/Work/riptide/case-studies/anchor-uniswap-v2 && NO_COLOR=1 RIPTIDE_ENGINE_BIN=/home/ailton/Work/riptide/riptide/target/release/riptide-engine node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js readiness .
- Observed support level: L3 - Riptide workspace initialized
- Status: blocked
- Missing inputs: generic_e2e_run
- adapter: Adapter .riptide/adapters/ammv2.toml exists but is not yet machine-readable: /home/ailton/Work/riptide/case-studies/anchor-uniswap-v2/.riptide/adapters/ammv2.toml: `[accounts]`: generic adapters must declare at least one account binding.
```

Lint:

```text
$ cd /home/ailton/Work/riptide/case-studies/anchor-uniswap-v2 && NO_COLOR=1 RIPTIDE_ENGINE_BIN=/home/ailton/Work/riptide/riptide/target/release/riptide-engine node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js lint .riptide/adapters/ammv2.toml
riptide lint: adapter is still an incomplete `riptide init` stub: /home/ailton/Work/riptide/case-studies/anchor-uniswap-v2/.riptide/adapters/ammv2.toml
schema check stopped at: /home/ailton/Work/riptide/case-studies/anchor-uniswap-v2/.riptide/adapters/ammv2.toml: `[accounts]`: generic adapters must declare at least one account binding
next step: invoke `/riptide-config` to finish the adapter, harness, scenarios, and campaign. Manual / advanced path: open .riptide/adapters/ammv2.toml and fill the TODO blocks for accounts, instructions, state_mapping, actions, observations, and personas. Then rerun `riptide lint .riptide/adapters/ammv2.toml`.
```

### Drift Protocol V2

Readiness:

```text
$ cd /home/ailton/Work/riptide/case-studies/protocol-v2 && NO_COLOR=1 RIPTIDE_ENGINE_BIN=/home/ailton/Work/riptide/riptide/target/release/riptide-engine node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js readiness .
- Observed support level: L3 - Riptide workspace initialized
- Status: blocked
- Missing inputs: generic_e2e_run
- run-evidence: Run collection .riptide/run-collection.json exists, but no passing state-movement check was observed. A passing run with no state movement is not meaningful economic stress evidence yet.
- harness: No .riptide harness was discovered. Some adapters may still be inspectable, but local E2E execution will need a harness entry point.
```

Lint passes, so this is not a missing-IDL blocker:

```text
$ cd /home/ailton/Work/riptide/case-studies/protocol-v2 && NO_COLOR=1 RIPTIDE_ENGINE_BIN=/home/ailton/Work/riptide/riptide/target/release/riptide-engine node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js lint .riptide/adapters/drift.toml
Summary
   PASS :2   WARN :0   FAIL :0   SKIP :0
  Verdict: PASS (exit 0)
```

### SPL Selected Target

Readiness:

```text
$ cd /home/ailton/Work/riptide/case-studies/solana-program-library && NO_COLOR=1 RIPTIDE_ENGINE_BIN=/home/ailton/Work/riptide/riptide/target/release/riptide-engine node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js readiness .
- Observed support level: L7 - campaign-ready inputs present
- Status: partial
- harness: No .riptide harness was discovered. Some adapters may still be inspectable, but local E2E execution will need a harness entry point.
```

Lint:

```text
$ cd /home/ailton/Work/riptide/case-studies/solana-program-library && NO_COLOR=1 RIPTIDE_ENGINE_BIN=/home/ailton/Work/riptide/riptide/target/release/riptide-engine node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js lint .riptide/adapters/solana-program-library.toml
Source kind: (no [lineage] block)
   PASS  [semantics-clean] [semantics].class = "token.v1"
   SKIP  [lineage-missing] [lineage]
      adapter has no [lineage] block — machine validation is unavailable, nothing to check.
Summary
   PASS :1   WARN :0   FAIL :0   SKIP :1
  Verdict: PASS (exit 0)
```

## Readiness-Only Rows

These rows were checked with fresh `readiness` and `lint` but were not direct-run
targets in this bounded T04 cut.

| Target | Readiness stdout | Lint stdout | Boundary |
| --- | --- | --- | --- |
| Stablecoin protocol | `Observed support level: L7 - campaign-ready inputs present`; `Status: ready`; `E2E evidence kind: risk-slice` | `PASS :2   WARN :0   FAIL :0   SKIP :0`; `Verdict: PASS (exit 0)` | PSM slice only; vault, liquidation, flash-mint, oracle, governance, and emergency shutdown are outside the slice. |
| Liquid-staking program | `Observed support level: L7 - campaign-ready inputs present`; `Status: ready`; `E2E evidence kind: risk-slice` | `PASS :2   WARN :0   FAIL :0   SKIP :0`; `Verdict: PASS (exit 0)` | Source-derived IDL subset; full stake-account, validator-management, admin, and multi-step crank coverage are outside the slice. |
| Marinade liquid-stake fork | `Observed support level: L7 - campaign-ready inputs present`; `Status: ready`; `E2E evidence kind: risk-slice` | `PASS :2   WARN :0   FAIL :0   SKIP :0`; `Verdict: PASS (exit 0)` | Deposit-led reserve and mSOL supply state movement; validator-management and delayed-unstake completion are future work. |
| Perpetuals | `Observed support level: L7 - campaign-ready inputs present`; `Status: ready`; `E2E evidence kind: risk-slice` | `PASS :2   WARN :0   FAIL :0   SKIP :0`; `Verdict: PASS (exit 0)` | Collateral slice only; liquidation, collateral removal, open-position lifecycle, and adverse oracle trajectories are outside the slice. |

Corpus readiness was also refreshed:

```text
$ cd /home/ailton/Work/riptide/riptide && NO_COLOR=1 RIPTIDE_ENGINE_BIN=/home/ailton/Work/riptide/riptide/target/release/riptide-engine node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js readiness --case-studies /home/ailton/Work/riptide/case-studies --out /home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t04/case-study-readiness
- Repositories inspected: 13
- Verdict summary: blocked=6, pass=6, warn=1
- Launch claim summary: blocked=6, readiness-only=7
```

## Generated Artifact Policy

Generated artifacts intentionally kept:

- `reports/real-world-scale/artifacts/semantic-amm/raydium`
- `reports/real-world-scale/artifacts/t04/raydium-run`
- `reports/real-world-scale/artifacts/t04/raydium-campaign`
- `reports/real-world-scale/artifacts/t04/lending-safe`
- `reports/real-world-scale/artifacts/t04/lending-campaign`
- `reports/real-world-scale/artifacts/t04/mango-run`
- `reports/real-world-scale/artifacts/t04/mango-campaign`
- `reports/real-world-scale/artifacts/t04/whirlpool-run`
- `reports/real-world-scale/artifacts/t04/whirlpool-campaign`
- `reports/real-world-scale/artifacts/t04/case-study-readiness`

Sibling case-study workspaces were not normalized, reverted, or cleaned. All
new direct/campaign outputs used the Sprint 34 report artifact root when the CLI
supported an output override.

## Recommendation

The next feature sprint should prioritize remaining semantic/readiness closure
over more raw scenarios:

1. Keep Raydium wording scoped to CP-Swap semantic AMM local-slice evidence; use
   additional Raydium scenarios only when they are separately mapped and run.
2. Treat Whirlpool as base `amm.v1` proxy evidence until a CLMM semantic class or
   explicit extension models tick/range/position/fee-growth behavior.
3. Add harness/state-movement repair for Drift protocol-v2, where lint passes
   but readiness blocks on no passing state movement.
4. Clarify reviewable artifact surfaces: direct run output is not a review pack;
   campaign roots and evidence packs are reviewable today.
5. Add `[lineage]` plus harness guidance for SPL Token if it is meant to move
   from readiness-only to execution evidence.
