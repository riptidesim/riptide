# Campaign Summary: solend-shape-liquidation-safety

## Scope

This report describes observations within this campaign only. It does not certify complete protocol safety.

- **Class:** lending.v1
- **Objective:** liquidation-safety
- **Campaign ID:** campaign_2a93d0358025
- **Campaign digest:** `2a93d03580255a41454b9b05a87dd34c30981447ed7f787d420ffda8ebf51581`
- **Run budget:** 16
- **Runs requested here:** 16
- **Adapter:** `../../../adapters/lending.toml`

## Outcome

- **Completed runs:** 16
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
| oracle_lag_baseline | 4 | 4 | 0 | 0 |  | 720 | 6.4 | 606 |
| whale_share_sweep | 5 | 5 | 0 | 0 |  | 4320 | 19.2 | 1992 |
| whale_shock_grid | 7 | 7 | 0 | 0 |  | 4320 | 16.8 | 1149 |

## Parameters

| Parameter | Distribution | Unit | Samples | Observed range |
|---|---|---|---:|---|
| oracle_lag_ticks | discrete(0|2|4) | ticks | 4 | 0 -> 2 |
| shock_profile | discrete(price-shock|bank-run) |  | 16 | non-numeric or not sampled |
| whale_share_bps | uniform(500..3000, integer) | bps | 12 | 549 -> 2953 |

## Lending Observations

Observed semantic/lending surfaces: `summary.total_bad_debt`, `timeseries.cumulative_bad_debt`, `timeseries.tvl`, `timeseries.utilization`, `summary.total_liquidations`, `run invariant fires`.

- **Bad debt max:** 4320
- **Total liquidations max:** 6
- **Max utilization observed:** 19.2
- **Minimum TVL observed:** 606
- **Liquidation-safety failed runs:** 0

## Retained Evidence

| Label | Status | Run | Score | Risk signals | Reason |
|---|---|---|---:|---|---|
| first_failure | warning |  |  |  | no invariant failure tick was observed within this campaign |
| worst_bad_debt | selected | `run_000002_2465e1b314c3` | 4320 | warn_signals=collection_worst_health_factor, bad_debt=4320, liquidations=6, max_utilization=16.8, min_tvl=1384 | highest lending bad debt observed within this campaign; tie: 2 runs shared the same bad-debt score; selected lowest run index 2 |
| worst_liquidity | selected | `run_000014_17ea751a56c9` | 19.2 | warn_signals=collection_worst_health_factor, bad_debt=4320, liquidations=6, max_utilization=19.2, min_tvl=2000 | highest utilization, then lowest TVL, observed within this campaign |
| median | selected | `run_000007_381d169f4cb7` | 23092.28744 | warn_signals=collection_worst_health_factor+ltv_below_max, bad_debt=0, liquidations=0, max_utilization=3.091787, min_tvl=2000 | middle completed run by deterministic campaign risk score |
| surprising_outlier | selected | `run_000014_17ea751a56c9` | 33520.5 | warn_signals=collection_worst_health_factor, bad_debt=4320, liquidations=6, max_utilization=19.2, min_tvl=2000 | largest absolute distance from the median campaign risk score |

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
