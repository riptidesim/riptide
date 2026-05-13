# Campaign Review: solend-shape-liquidation-safety

## Outcome

- Campaign ID: `campaign_2a93d0358025`
- Campaign digest: `2a93d03580255a41454b9b05a87dd34c30981447ed7f787d420ffda8ebf51581`
- Completed runs: 16
- Invariant-failed runs: 0
- Setup errors: 0

## Retained Cases

| Label | Run | Parameters | Risk result | Rerun |
|---|---|---|---|---|
| worst_bad_debt | `run_000002_2465e1b314c3` | shock_profile=price-shock, whale_share_bps=2953 | warn_signals=collection_worst_health_factor, bad_debt=4320, liquidations=6, max_utilization=16.8 | `exec riptide run .riptide/campaigns/campaign_2a93d0358025/runs/run_000002_2465e1b314c3/run-config.json` |
| worst_liquidity | `run_000014_17ea751a56c9` | shock_profile=price-shock, whale_share_bps=2761 | warn_signals=collection_worst_health_factor, bad_debt=4320, liquidations=6, max_utilization=19.2 | `exec riptide run .riptide/campaigns/campaign_2a93d0358025/runs/run_000014_17ea751a56c9/run-config.json` |
| median | `run_000007_381d169f4cb7` | shock_profile=bank-run, whale_share_bps=1286 | warn_signals=collection_worst_health_factor+ltv_below_max, bad_debt=0, liquidations=0, max_utilization=3.0917874396135265 | `exec riptide run .riptide/campaigns/campaign_2a93d0358025/runs/run_000007_381d169f4cb7/run-config.json` |
| surprising_outlier | `run_000014_17ea751a56c9` | shock_profile=price-shock, whale_share_bps=2761 | warn_signals=collection_worst_health_factor, bad_debt=4320, liquidations=6, max_utilization=19.2 | `exec riptide run .riptide/campaigns/campaign_2a93d0358025/runs/run_000014_17ea751a56c9/run-config.json` |

## Validation

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

## Boundary

This review validates campaign-retained evidence and rerun recipes. It does not claim complete protocol safety beyond the campaign inputs, run budget, and retained artifacts.
