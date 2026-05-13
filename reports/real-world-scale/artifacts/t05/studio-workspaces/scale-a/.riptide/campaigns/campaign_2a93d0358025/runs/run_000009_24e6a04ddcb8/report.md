# Riptide Simulation Report

## Run metadata

- **Adapter**: `/home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t05/studio-workspaces/scale-a/fixtures/adapters/lending.toml`
- **Seed**: 1501259560
- **Ticks**: 20
- **Agents**: 20 (4× Whale, 16× Steady LP)
- **Scenario**: bank-run
- **Output**: `/home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t05/studio-workspaces/scale-a/.riptide/campaigns/campaign_2a93d0358025/runs/run_000009_24e6a04ddcb8`

## Summary

| Metric | Value |
|--------|-------|
| final_tvl | 2000 |
| final_utilization | 6.4000 |
| largest_single_tick_drawdown | 0.5994 |
| total_bad_debt | 0 |
| total_liquidations | 0 |

**Agent lifecycle**: 20 active, 0 liquidated, 0 depleted

## Invariants

No invariant violations detected in this run.

## Notable events

- T2: Steady LP (agent-005) — liquidate → failed — position_healthy · code 7 · The position is healthy and cannot be liquidated.
- T2: Steady LP (agent-006) — liquidate → failed — position_healthy · code 7 · The position is healthy and cannot be liquidated.
- T2: Steady LP (agent-007) — liquidate → failed — position_healthy · code 7 · The position is healthy and cannot be liquidated.
- T2: Steady LP (agent-008) — liquidate → failed — position_healthy · code 7 · The position is healthy and cannot be liquidated.
- T2: Steady LP (agent-009) — liquidate → failed — position_healthy · code 7 · The position is healthy and cannot be liquidated.
- T2: Steady LP (agent-010) — liquidate → failed — position_healthy · code 7 · The position is healthy and cannot be liquidated.
- T2: Steady LP (agent-011) — liquidate → failed — position_healthy · code 7 · The position is healthy and cannot be liquidated.
- T2: Steady LP (agent-012) — liquidate → failed — position_healthy · code 7 · The position is healthy and cannot be liquidated.
- T2: Steady LP (agent-013) — liquidate → failed — position_healthy · code 7 · The position is healthy and cannot be liquidated.
- T2: Steady LP (agent-014) — liquidate → failed — position_healthy · code 7 · The position is healthy and cannot be liquidated.

## Simulation boundaries

- In-process LiteSVM backend (no external validator).
- No slippage, fees, or MEV modeled.
- Oracle prices are scenario-driven, not external feeds.
- Agents funded via deterministic airdrop, not realistic onboarding.

## How to reproduce

```sh
exec riptide run .riptide/campaigns/campaign_2a93d0358025/runs/run_000009_24e6a04ddcb8/run-config.json --adapter fixtures/adapters/lending.toml
```
