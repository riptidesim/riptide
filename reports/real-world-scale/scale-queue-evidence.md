# Sprint 34 Phase 2 Scale Campaign And Studio Queue Evidence

Captured by:

```text
$ cd /home/ailton/Work/riptide/riptide && bash scripts/ci/scale-campaign-smoke.sh
```

## Scale Target

- Target: committed lending campaign `fixtures/campaigns/lending/solend-shape-liquidation-safety/campaign.toml`
- Bound: `8` runs from the deterministic campaign plan
- Runtime expectation: less than 2 minutes on this workstation
- Artifact expectation: less than 100M under `reports/real-world-scale/artifacts/t05`

Observed:

```text
Scale runs: 8
Scale elapsed seconds: 1
Scale artifact size: 1.2M
```

Scale stdout:

```text
Campaign complete: solend-shape-liquidation-safety

Result
  Outcome: no invariant failures observed, no setup errors
  Runs: 8/8 completed, 0 setup errors, 0 skipped runs
  Risk signals: bad debt max=4320, liquidations max=6, max utilization=16.8
  Coverage: 8 partial; confidence 8 low

Workload
  Size: 1x oracle_lag_baseline (10 agents x 22 ticks), 3x whale_share_sweep (20 agents x 20 ticks), 4x whale_shock_grid (20 agents x 20 ticks)
  Simulation time: 459ms
  Configs: 8 created, 0 reused

Next
  riptide review reports/real-world-scale/artifacts/t05/scale-campaign/campaign_2a93d0358025

Evidence
  Summary: reports/real-world-scale/artifacts/t05/scale-campaign/campaign_2a93d0358025/campaign-summary.md
  Artifacts: reports/real-world-scale/artifacts/t05/scale-campaign/campaign_2a93d0358025
  Retained cases: worst_bad_debt -> run_000002_2465e1b314c3, worst_liquidity -> run_000002_2465e1b314c3, median -> run_000007_381d169f4cb7, surprising_outlier -> run_000006_a756808d330f
  Retention warnings: first_failure

Details
  Objective: liquidation-safety (lending.v1)
  Campaign ID: campaign_2a93d0358025
  Digest: 2a93d0358025...f51581

Boundary
  No invariant violation observed means none was observed in this campaign, not proof of complete safety.
```

## Studio Queue Stress

- Studio URL: `http://127.0.0.1:43383`
- Workspaces: `current` -> `/home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t05/studio-workspaces/scale-a`, `scale-b` -> `/home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t05/studio-workspaces/scale-b`
- Queue after submit: `queued=4, running=1`
- Final queue statuses: `cancelled=1, failed=1, succeeded=3`
- Persisted job records: `current=3`, `scale-b=2`
- Studio workspace artifact size: `15M`

Queued jobs:

| Label | Job id | Workspace | Expected terminal behavior |
| --- | --- | --- | --- |
| campaign run | `fd729d2b-fbf9-43f5-a5e3-2312f0216b67` | `current` | succeeds and writes `.riptide/campaigns/campaign_2a93d0358025` |
| review | `9d02a937-dc9b-477c-863d-d87d7379a6d1` | `current` | succeeds and writes `.riptide/studio/scale-review.md` |
| failing review | `09c4895f-3894-4f82-9bec-84341e39ed66` | `current` | fails on missing pack |
| readiness | `130b2c3c-8809-47c1-92f9-62ac48f6b5cc` | `scale-b` | succeeds and writes `.riptide/readiness-scale/readiness.json` |
| cancelled plan | `809abd98-83ab-4de8-897d-7b01295ef4c9` | `scale-b` | cancelled before dispatch or terminalized as cancelled |

Artifact isolation checks:

```text
present: /home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t05/studio-workspaces/scale-a/.riptide/campaigns/campaign_2a93d0358025/campaign-summary.json
present: /home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t05/studio-workspaces/scale-a/.riptide/studio/scale-review.md
present: /home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t05/studio-workspaces/scale-b/.riptide/readiness-scale/readiness.json
absent:  /home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t05/studio-workspaces/scale-b/.riptide/campaigns/campaign_2a93d0358025
```

Failure/cancel behavior:

- The missing-pack review job is persisted as a failed job.
- The campaign-plan job is cancelled through `POST /api/studio/jobs/:id/cancel`.
- Queue concurrency remains sequential; this script verifies queue depth and
  isolation rather than enabling unbounded parallel execution.

Raw JSON artifacts:

- `reports/real-world-scale/artifacts/t05/jobs-after-submit.json`
- `reports/real-world-scale/artifacts/t05/jobs-final.json`
- `reports/real-world-scale/artifacts/t05/job-cancel-response.json`
- `reports/real-world-scale/artifacts/t05/studio-workspaces.json`
