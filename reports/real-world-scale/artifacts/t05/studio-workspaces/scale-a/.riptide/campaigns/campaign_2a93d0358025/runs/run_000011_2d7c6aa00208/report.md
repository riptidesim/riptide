# Riptide Simulation Report

## Run metadata

- **Adapter**: `/home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t05/studio-workspaces/scale-a/fixtures/adapters/lending.toml`
- **Seed**: 872116291
- **Ticks**: 20
- **Agents**: 10 (1× Whale, 9× Steady LP)
- **Scenario**: bank-run
- **Output**: `/home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t05/studio-workspaces/scale-a/.riptide/campaigns/campaign_2a93d0358025/runs/run_000011_2d7c6aa00208`

## Summary

| Metric | Value |
|--------|-------|
| final_tvl | 1000 |
| final_utilization | 3.2000 |
| largest_single_tick_drawdown | 0.5995 |
| total_bad_debt | 0 |
| total_liquidations | 0 |

**Agent lifecycle**: 10 active, 0 liquidated, 0 depleted

## Invariants

No invariant violations detected in this run.

## Notable events

- T2: Steady LP (agent-002) — liquidate → failed — position_healthy · code 7 · The position is healthy and cannot be liquidated.
- T2: Steady LP (agent-003) — liquidate → failed — position_healthy · code 7 · The position is healthy and cannot be liquidated.
- T2: Steady LP (agent-004) — liquidate → failed — position_healthy · code 7 · The position is healthy and cannot be liquidated.
- T2: Steady LP (agent-005) — liquidate → failed — position_healthy · code 7 · The position is healthy and cannot be liquidated.
- T2: Steady LP (agent-006) — liquidate → failed — position_healthy · code 7 · The position is healthy and cannot be liquidated.
- T2: Steady LP (agent-007) — liquidate → failed — position_healthy · code 7 · The position is healthy and cannot be liquidated.
- T2: Steady LP (agent-008) — liquidate → failed — position_healthy · code 7 · The position is healthy and cannot be liquidated.
- T2: Steady LP (agent-009) — liquidate → failed — position_healthy · code 7 · The position is healthy and cannot be liquidated.
- T2: Steady LP (agent-010) — liquidate → failed — position_healthy · code 7 · The position is healthy and cannot be liquidated.
- T3: Steady LP (agent-002) — liquidate → failed — position_healthy · code 7 · The position is healthy and cannot be liquidated.

## Simulation boundaries

- In-process LiteSVM backend (no external validator).
- No slippage, fees, or MEV modeled.
- Oracle prices are scenario-driven, not external feeds.
- Agents funded via deterministic airdrop, not realistic onboarding.

## How to reproduce

```sh
exec riptide run .riptide/campaigns/campaign_2a93d0358025/runs/run_000011_2d7c6aa00208/run-config.json --adapter fixtures/adapters/lending.toml
```
