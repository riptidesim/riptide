# Sprint 35 Semantic AMM Evidence

Captured: 2026-05-13

This report records the Phase 3 evidence boundary for semantic AMM work. It is
local deterministic simulation evidence only. It is not audit signoff, complete
protocol safety, live-mainnet coverage, or broad Raydium/Whirlpool support.

## Verdict Summary

| Target | Classification | Evidence | Boundary |
| --- | --- | --- | --- |
| Raydium CP-Swap | `amm.v1` semantic AMM local-slice evidence | Lint/direct run/campaign/review completed for the bounded CP-Swap smoke slice. Retained campaign artifact records `amm.v1` roles and derived observations. | Covers the local adapter, harness, scenario, run budget, and retained artifacts only. It does not claim full Raydium coverage. |
| Whirlpool | Base `amm.v1` proxy evidence | Existing adapter lint reports `semantics-clean`; the retained campaign root reviews cleanly and records `amm.v1` role/derived-observation metadata. | Not full CLMM coverage. Tick arrays, ranges, position lifecycle, fee growth, rewards, V2/token-extension, and two-hop semantics need a future `clmm.v1` or explicit extension. |

## Raydium CP-Swap

Allowed claim: **Raydium CP-Swap semantic AMM local-slice evidence**.

Artifact roots:

- Direct run and pack: `/home/ailton/Work/riptide/case-studies/raydium-cp-swap/.riptide/pack/baseline/manifest.json`
- Campaign root: `/home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/semantic-amm/raydium/campaign_c691a3a7933c`
- Campaign summary: `/home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/semantic-amm/raydium/campaign_c691a3a7933c/campaign-summary.md`
- Retained semantic result: `/home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/semantic-amm/raydium/campaign_c691a3a7933c/runs/run_000000_5d7d52662d22/simulation-result.json`

Command evidence:

```text
$ cd /home/ailton/Work/riptide/case-studies/raydium-cp-swap && NO_COLOR=1 RIPTIDE_ENGINE_BIN=/home/ailton/Work/riptide/riptide/target/release/riptide-engine node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js run .riptide/scenarios/swap-pressure/run-config.json --adapter .riptide/adapters/raydium-cp-swap.toml --harness .riptide/harness --seed-root 1337
sweep swap-pressure: all_pass, 5/5 complete in 5.8s
1 pass · 0 fail · 0 error · 0 skip
```

```text
$ cd /home/ailton/Work/riptide/case-studies/raydium-cp-swap && NO_COLOR=1 RIPTIDE_ENGINE_BIN=/home/ailton/Work/riptide/riptide/target/release/riptide-engine node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js campaign run .riptide/campaigns/raydium-cp-swap-smoke.campaign.toml --max-runs 2 --out /home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/semantic-amm/raydium --harness .riptide/harness
Campaign complete: raydium-cp-swap-smoke
Runs: 2/2 completed, 0 setup errors, 0 skipped runs
Artifacts: /home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/semantic-amm/raydium/campaign_c691a3a7933c
```

```text
$ cd /home/ailton/Work/riptide/case-studies/raydium-cp-swap && NO_COLOR=1 RIPTIDE_ENGINE_BIN=/home/ailton/Work/riptide/riptide/target/release/riptide-engine node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js review /home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/semantic-amm/raydium/campaign_c691a3a7933c --quiet
pass: campaign-summary.json exists and parses
pass: retention-manifest.json exists and parses
pass: retained case digest verified: 61391e33445457aa3841395d86a566b68a65af45664ab904352eac5f4be0134e
pass: median maps to run_000000_5d7d52662d22
pass: rerun.sh is present and sh -n parseable
```

Semantic roles recorded in the retained run:

```text
fee_config -> account.amm_config
lp_supply -> account.pool_state
pool -> account.pool_state
reserve_a -> account.input_vault
reserve_b -> account.output_vault
```

The retained result includes derived observation definitions for
`constant_product`, `liquidity_value`, `lp_share_value`, `price_impact_bps`,
`reserve_ratio`, and `spot_price`.

## Whirlpool

Allowed claim: **base `amm.v1` proxy evidence for the current local slice**.

Artifact roots:

- Adapter: `/home/ailton/Work/riptide/case-studies/whirlpools/.riptide/adapters/whirlpool.toml`
- Campaign root: `/home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t04/whirlpool-campaign/campaign_a0852f66871d`
- Retained result: `/home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t04/whirlpool-campaign/campaign_a0852f66871d/runs/run_000000_41c052cc85f5/simulation-result.json`

Command evidence:

```text
$ cd /home/ailton/Work/riptide/case-studies/whirlpools && node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js lint .riptide/adapters/whirlpool.toml
PASS  [mapped-surface-clean] 3 instruction(s), 11 field ref(s)
PASS  [semantics-clean] [semantics].class = "amm.v1"
Summary
   PASS :2   WARN :0   FAIL :0   SKIP :0
  Verdict: PASS (exit 0)
```

```text
$ cd /home/ailton/Work/riptide/case-studies/whirlpools && NO_COLOR=1 RIPTIDE_ENGINE_BIN=/home/ailton/Work/riptide/riptide/target/release/riptide-engine node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js review /home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t04/whirlpool-campaign/campaign_a0852f66871d --quiet
pass: campaign-summary.json exists and parses
pass: retention-manifest.json exists and parses
pass: retained case digest verified: e7aec84d1a781d73d8f1936adc4430458624eb147594df18b7b91b4440dc25e8
pass: median maps to run_000000_41c052cc85f5
pass: rerun.sh is present and sh -n parseable
```

The current `amm.v1` proxy roles are pool, reserves, LP/liquidity, position
liquidity, and fee config. The retained result includes derived observations for
`constant_product`, `liquidity_value`, `lp_share_value`, `price_impact_bps`,
`reserve_ratio`, and `spot_price`.

Missing CLMM concepts:

- tick-array state, initialized ticks, and liquidity net/gross by tick;
- tick spacing, lower/upper ranges, and position-range lifecycle semantics;
- `sqrt_price` and tick movement as price-range semantics;
- fee growth global/checkpoint/outside accounting;
- rewards, reward growth, V2/token-extension, position-bundle, metadata, and two-hop paths.

## Report Surface Sync

The older Whirlpool campaign summary under `reports/real-world-scale/artifacts/t04`
was regenerated with the current class-aware summary renderer. It now says:

```text
No amm.v1 semantic warning signal or invariant failure was retained in this campaign run.
```

and the scenario-family table no longer renders lending-only `Bad debt`,
`Max utilization`, or `Min TVL` columns for the `amm.v1` campaign summary.

No Studio source or shipped Studio assets were touched in Phase 3.

## Remaining Boundaries

- Raydium evidence is the bounded CP-Swap smoke slice only.
- Whirlpool evidence is base AMM proxy evidence only; full concentrated-liquidity
  coverage needs a future CLMM semantic design and execution pass.
- Existing campaign reviews validate retained evidence and rerun recipes; they do
  not execute retained reruns and do not certify complete protocol safety.
- No push, publish, live RPC write, mainnet write, or durable hash retune was part
  of this Phase 3 work.
