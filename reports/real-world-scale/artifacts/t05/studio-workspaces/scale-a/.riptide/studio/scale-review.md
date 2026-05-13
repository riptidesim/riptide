# Campaign Review: solend-shape-liquidation-safety

## Executive Summary

solend-shape-liquidation-safety completed 16 of 16 requested runs with no invariant failures or setup errors observed. Retained cases still show the highest-risk frontier inside this bounded campaign, not complete protocol safety.

- **Outcome:** no invariant failures observed, no setup errors
- **Campaign ID:** `campaign_2a93d0358025`
- **Risk objective:** liquidation-safety
- **Run budget:** 16 planned, 16 completed
- **Boundary:** Simulation evidence from retained campaign artifacts, not audit signoff or complete protocol safety.

## Outcome

| Check | Result | Evidence |
|---|---|---|
| Completed runs | pass | 16 / 16 requested |
| Invariant failures | pass | 0 runs |
| Setup errors | pass | 0 setup errors |
| Retained cases | pass | 4 selected for review |

## Risk Map

| Signal | Observed | Reviewer meaning |
|---|---|---|
| Invariant-failed runs | 0 | Runs where a declared invariant fired inside the campaign budget. |
| Setup errors | 0 | Runs that failed before producing reviewable simulation evidence. |
| Bad debt range | min=0, median=1440, max=4320 | Worst observed uncovered debt across completed campaign runs. |
| Liquidation range | min=0, median=2, max=6 | Liquidation pressure observed across completed campaign runs. |
| Liquidity stress | max_utilization=19.2, min_tvl=606 | Frontier of liquidity pressure among retained and completed cases. |
| Retained evidence | 4 cases | Selected cases to rerun first when a reviewer wants source evidence. |

## Invariant Explanation

No error-severity invariant failure was retained. Semantic warning signals still marked the campaign frontier: `collection_worst_health_factor`, `ltv_below_max`.

## Scenario Parameters

| Parameter | Distribution | Samples | Observed range |
|---|---|---:|---|
| fixed_one | fixed(1) | 0 | - |
| oracle_lag_ticks | discrete(0\|2\|4) | 4 | min=0 ticks, median=1 ticks, max=2 ticks |
| shock_profile | discrete(price-shock\|bank-run) | 16 | bank-run, price-shock |
| whale_share_bps | uniform(500..3000, integer) | 12 | min=549 bps, median=2016.5 bps, max=2953 bps |

## Relevant Events

Retained cases are the campaign events to inspect first. Each row links the sampled parameters, risk result, source artifact, and exact rerun recipe.

| Label | Run | Parameters | Risk result | Source artifact | Rerun |
|---|---|---|---|---|---|
| worst_bad_debt | `run_000002_2465e1b314c3` | shock_profile=price-shock, whale_share_bps=2953 | warn_signals=collection_worst_health_factor, bad_debt=4320, liquidations=6, max_utilization=16.8 | `runs/run_000002_2465e1b314c3/report.md` | `exec riptide run .riptide/campaigns/campaign_2a93d0358025/runs/run_000002_2465e1b314c3/run-config.json` |
| worst_liquidity | `run_000014_17ea751a56c9` | shock_profile=price-shock, whale_share_bps=2761 | warn_signals=collection_worst_health_factor, bad_debt=4320, liquidations=6, max_utilization=19.2 | `runs/run_000014_17ea751a56c9/report.md` | `exec riptide run .riptide/campaigns/campaign_2a93d0358025/runs/run_000014_17ea751a56c9/run-config.json` |
| median | `run_000007_381d169f4cb7` | shock_profile=bank-run, whale_share_bps=1286 | warn_signals=collection_worst_health_factor+ltv_below_max, bad_debt=0, liquidations=0, max_utilization=3.0917874396135265 | `runs/run_000007_381d169f4cb7/report.md` | `exec riptide run .riptide/campaigns/campaign_2a93d0358025/runs/run_000007_381d169f4cb7/run-config.json` |
| surprising_outlier | `run_000014_17ea751a56c9` | shock_profile=price-shock, whale_share_bps=2761 | warn_signals=collection_worst_health_factor, bad_debt=4320, liquidations=6, max_utilization=19.2 | `runs/run_000014_17ea751a56c9/report.md` | `exec riptide run .riptide/campaigns/campaign_2a93d0358025/runs/run_000014_17ea751a56c9/run-config.json` |

## Rerun Command

Review the campaign root:

```sh
riptide review .riptide/campaigns/campaign_2a93d0358025
```

Rerun commands for retained cases are listed in Relevant Events. The review command validated their `rerun.sh` files with `sh -n`; it did not execute them.

## Technical Appendix

### Reproducibility

- Campaign digest: `2a93d03580255a41454b9b05a87dd34c30981447ed7f787d420ffda8ebf51581`
- Campaign root: `/home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t05/studio-workspaces/scale-a/.riptide/campaigns/campaign_2a93d0358025`
- Summary: `/home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t05/studio-workspaces/scale-a/.riptide/campaigns/campaign_2a93d0358025/campaign-summary.json`
- Retention manifest: `/home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t05/studio-workspaces/scale-a/.riptide/campaigns/campaign_2a93d0358025/retention-manifest.json`

### Validation

- pass: campaign-summary.json exists and parses
- pass: retention-manifest.json exists and parses
- pass: retained case digest verified: 023322bca36df67908f84519170b4d92b9b15494c7915c4a01a58647af744eb0
- pass: worst_bad_debt maps to run_000002_2465e1b314c3
- pass: rerun.sh is present and sh -n parseable
- pass: retained case digest verified: ad55bcc40df71b54b1a4b8f4b25c604629bf10c43f257ad2a969ff910db52408
- pass: worst_liquidity maps to run_000014_17ea751a56c9
- pass: rerun.sh is present and sh -n parseable
- pass: retained case digest verified: afb21aecb5d24417e2ba4bcf3398a86295c76064e5c5efaa2179e00c5c9093ec
- pass: median maps to run_000007_381d169f4cb7
- pass: rerun.sh is present and sh -n parseable
- pass: retained case digest verified: 16106d19e45e7d0a74068fe34fc87b10978c4318f87b9efb306e93557dc6dcbb
- pass: surprising_outlier maps to run_000014_17ea751a56c9
- pass: rerun.sh is present and sh -n parseable

### Warnings

- first_failure: no invariant failure tick was observed within this campaign

### Evidence Boundaries

- This review validates campaign-retained evidence and rerun recipes.
- It does not claim complete protocol safety beyond the campaign inputs, run budget, and retained artifacts.
