# Campaign Summary: raydium-cp-swap-smoke

## Scope

This report describes observations within this campaign only. It does not certify complete protocol safety.

- **Class:** amm.v1
- **Objective:** custom:raydium-cp-swap-pressure
- **Campaign ID:** campaign_c691a3a7933c
- **Campaign digest:** `c691a3a7933ceb5c5af399d915d6ca96697621934b6cdab359e93a0a1fd43c4f`
- **Run budget:** 20
- **Runs requested here:** 2
- **Adapter:** `../adapters/raydium-cp-swap.toml`

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
| swap_pressure | 2 | 2 | 0 | 0 |  |  |  |  |

## Parameters

| Parameter | Distribution | Unit | Samples | Observed range |
|---|---|---|---:|---|

## Retained Evidence

| Label | Status | Run | Score | Risk signals | Reason |
|---|---|---|---:|---|---|
| first_failure | warning |  |  |  | no invariant failure tick was observed within this campaign |
| median | selected | `run_000000_5d7d52662d22` | 0 | no numeric risk metric | middle completed run by deterministic campaign risk score; tie: 2 runs shared the same deterministic risk score; selected lowest run index 0 |
| surprising_outlier | warning |  |  |  | at least three completed runs are needed for the simple outlier heuristic |

## Warnings

- first_failure: no invariant failure tick was observed within this campaign
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
