# Campaign Summary: whirlpool-amm-broad

## Scope

This report describes observations within this campaign only. It does not certify complete protocol safety.

- **Class:** amm.v1
- **Objective:** liquidity-exit
- **Campaign ID:** campaign_a0852f66871d
- **Campaign digest:** `a0852f66871d39aa63a89f15915871a544ed8e9e6d5e2346212eaaa5e1dd5dcd`
- **Run budget:** 60
- **Runs requested here:** 2
- **Adapter:** `../adapters/whirlpool.toml`

## Outcome

- **Completed runs:** 2
- **Setup errors:** 0
- **Invariant-failed runs:** 0
- **Invariant failure rate:** 0%
- **First failure ticks:** none observed

No invariant violation was observed within this campaign. That means only that the declared campaign inputs did not produce an invariant violation in this run budget.

## Key Risk Signal

No non-zero lending risk metric or invariant failure was retained in this campaign run.

## Scenario Families

| Family | Planned | Completed | Failed | Setup errors | First failure tick | Bad debt max | Max utilization | Min TVL |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| fee_growth_churn | 1 | 1 | 0 | 0 |  |  |  |  |
| whale_exit_pressure | 1 | 1 | 0 | 0 |  |  |  |  |

## Parameters

| Parameter | Distribution | Unit | Samples | Observed range |
|---|---|---|---:|---|
| oracle_lag_ticks | discrete(0|4|8|12|20) | ticks | 1 | 4 |
| whale_share_bps | discrete(0|1250|2500|5000|7500) | bps | 2 | 0 -> 5000 |

## Retained Evidence

| Label | Status | Run | Score | Risk signals | Reason |
|---|---|---|---:|---|---|
| first_failure | warning |  |  |  | no invariant failure tick was observed within this campaign |
| worst_liquidity | warning |  |  |  | unsupported for class amm.v1; liquidity-stress metrics are lending.v1-specific in v1 |
| median | selected | `run_000000_41c052cc85f5` | 0 | no numeric risk metric | middle completed run by deterministic campaign risk score; tie: 2 runs shared the same deterministic risk score; selected lowest run index 0 |
| surprising_outlier | warning |  |  |  | at least three completed runs are needed for the simple outlier heuristic |

## Warnings

- first_failure: no invariant failure tick was observed within this campaign
- worst_liquidity: unsupported for class amm.v1; liquidity-stress metrics are lending.v1-specific in v1
- surprising_outlier: at least three completed runs are needed for the simple outlier heuristic

## Artifact Index

- `campaign-summary.json`
- `campaign-summary.md`
- `parameters.csv`
- `runs.jsonl`
- `retention-manifest.json`
- `retained/<label>-<run-id>/case.json`
- `retained/<label>-<run-id>/rerun.sh`

## Recommendation

Use this as campaign-scoped evidence only; broaden scenario families, budgets, and retained reads before making release decisions.

Claim boundary: All conclusions are observations within this campaign's declared inputs, scenario families, parameters, seed policy, and run budget. They are not proof of complete protocol safety.
