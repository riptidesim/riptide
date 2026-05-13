# Campaign Summary: mango-v4-broad-perps

## Scope

This report describes observations within this campaign only. It does not certify complete protocol safety.

- **Class:** perps-margin.v1
- **Objective:** custom:mango-v4-perps-margin-broad
- **Campaign ID:** campaign_26ed10054503
- **Campaign digest:** `26ed100545030627ba3a7466c854d46558509b1b694dc25c120acf1801f6ef82`
- **Run budget:** 60
- **Runs requested here:** 3
- **Adapter:** `../adapters/mango-v4.toml`

## Outcome

- **Completed runs:** 3
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
| liquidation_cascade | 1 | 1 | 0 | 0 |  |  |  |  |
| oracle_shock_margin | 1 | 1 | 0 | 0 |  |  |  |  |
| orderbook_keeper_pressure | 1 | 1 | 0 | 0 |  |  |  |  |

## Parameters

| Parameter | Distribution | Unit | Samples | Observed range |
|---|---|---|---:|---|
| oracle_lag_ticks | discrete(0|4|8|16) | ticks | 2 | 4 -> 8 |
| shock_profile | discrete(baseline|funding-skew|oracle-down-15|oracle-down-35) |  | 3 | non-numeric or not sampled |
| whale_share_bps | discrete(500|1500|3000|5000) | bps | 3 | 1500 -> 3000 |

## Retained Evidence

| Label | Status | Run | Score | Risk signals | Reason |
|---|---|---|---:|---|---|
| first_failure | warning |  |  |  | no invariant failure tick was observed within this campaign |
| worst_bad_debt | warning |  |  |  | unsupported for class perps-margin.v1; bad-debt metrics are lending.v1-specific in v1 |
| worst_liquidity | warning |  |  |  | unsupported for class perps-margin.v1; liquidity-stress metrics are lending.v1-specific in v1 |
| median | selected | `run_000001_4b92df2fcc69` | 0 | no numeric risk metric | middle completed run by deterministic campaign risk score; tie: 3 runs shared the same deterministic risk score; selected lowest run index 1 |
| surprising_outlier | selected | `run_000000_44713dd4efda` | 0 | no numeric risk metric | largest absolute distance from the median campaign risk score; tie: 3 runs shared the same distance from median risk score; selected lowest run index 0 |

## Warnings

- first_failure: no invariant failure tick was observed within this campaign
- worst_bad_debt: unsupported for class perps-margin.v1; bad-debt metrics are lending.v1-specific in v1
- worst_liquidity: unsupported for class perps-margin.v1; liquidity-stress metrics are lending.v1-specific in v1

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
