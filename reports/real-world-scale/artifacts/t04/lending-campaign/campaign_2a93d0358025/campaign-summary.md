# Campaign Summary: solend-shape-liquidation-safety

## Scope

This report describes observations within this campaign only. It does not certify complete protocol safety.

- **Class:** lending.v1
- **Objective:** liquidation-safety
- **Campaign ID:** campaign_2a93d0358025
- **Campaign digest:** `2a93d03580255a41454b9b05a87dd34c30981447ed7f787d420ffda8ebf51581`
- **Run budget:** 16
- **Runs requested here:** 3
- **Adapter:** `../../../adapters/lending.toml`

## Outcome

- **Completed runs:** 3
- **Setup errors:** 0
- **Invariant-failed runs:** 0
- **Invariant failure rate:** 0%
- **First failure ticks:** none observed

No error-severity invariant violation was observed, but lending risk metrics did move. Treat the retained risk case as campaign-scoped evidence, not as a safety proof.

## Key Risk Signal

Retained case `worst_bad_debt` -> `run_000002_2465e1b314c3` produced bad debt 4320 with 6 liquidation(s). Parameters: shock_profile=price-shock, whale_share_bps=2953.

## Scenario Families

| Family | Planned | Completed | Failed | Setup errors | First failure tick | Bad debt max | Max utilization | Min TVL |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| oracle_lag_baseline | 1 | 1 | 0 | 0 |  | 720 | 6.4 | 1000 |
| whale_share_sweep | 1 | 1 | 0 | 0 |  | 3600 | 16 | 2000 |
| whale_shock_grid | 1 | 1 | 0 | 0 |  | 4320 | 16.8 | 1384 |

## Parameters

| Parameter | Distribution | Unit | Samples | Observed range |
|---|---|---|---:|---|
| oracle_lag_ticks | discrete(0|2|4) | ticks | 1 | 2 |
| shock_profile | discrete(price-shock|bank-run) |  | 3 | non-numeric or not sampled |
| whale_share_bps | uniform(500..3000, integer) | bps | 2 | 2633 -> 2953 |

## Lending Observations

Observed semantic/lending surfaces: `summary.total_bad_debt`, `timeseries.cumulative_bad_debt`, `timeseries.tvl`, `timeseries.utilization`, `summary.total_liquidations`, `run invariant fires`.

- **Bad debt max:** 4320
- **Total liquidations max:** 6
- **Max utilization observed:** 16.8
- **Minimum TVL observed:** 1000
- **Liquidation-safety failed runs:** 0

## Retained Evidence

| Label | Status | Run | Score | Risk signals | Reason |
|---|---|---|---:|---|---|
| first_failure | warning |  |  |  | no invariant failure tick was observed within this campaign |
| worst_bad_debt | selected | `run_000002_2465e1b314c3` | 4320 | warn_signals=collection_worst_health_factor, bad_debt=4320, liquidations=6, max_utilization=16.8, min_tvl=1384 | highest lending bad debt observed within this campaign |
| worst_liquidity | selected | `run_000002_2465e1b314c3` | 16.8 | warn_signals=collection_worst_health_factor, bad_debt=4320, liquidations=6, max_utilization=16.8, min_tvl=1384 | highest utilization, then lowest TVL, observed within this campaign |
| median | selected | `run_000001_60f464f418c7` | 29600.5 | warn_signals=collection_worst_health_factor, bad_debt=3600, liquidations=5, max_utilization=16, min_tvl=2000 | middle completed run by deterministic campaign risk score |
| surprising_outlier | selected | `run_000000_2e458233cab5` | 17121 | warn_signals=collection_worst_health_factor, bad_debt=720, liquidations=1, max_utilization=6.4, min_tvl=1000 | largest absolute distance from the median campaign risk score |

## Warnings

- first_failure: no invariant failure tick was observed within this campaign

## Artifact Index

- `campaign-summary.json`
- `campaign-summary.md`
- `parameters.csv`
- `runs.jsonl`
- `retention-manifest.json`
- `retained/<label>-<run-id>/case.json`
- `retained/<label>-<run-id>/rerun.sh`

## Recommendation

Review retained bad-debt evidence and rerun the selected case before changing scenario or protocol assumptions.

Claim boundary: All conclusions are observations within this campaign's declared inputs, scenario families, parameters, seed policy, and run budget. They are not proof of complete protocol safety.
