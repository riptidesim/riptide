# Riptide Simulation Report

## Run metadata

- **Adapter**: `/home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t05/studio-workspaces/scale-a/fixtures/adapters/lending.toml`
- **Seed**: 1715464038
- **Ticks**: 22
- **Agents**: 10 (1× Whale, 9× Steady LP)
- **Scenario**: price-shock
- **Output**: `/home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t05/studio-workspaces/scale-a/.riptide/campaigns/campaign_2a93d0358025/runs/run_000000_2e458233cab5`

## Summary

| Metric | Value |
|--------|-------|
| final_tvl | 1763 |
| final_utilization | 0 |
| largest_single_tick_drawdown | 0.4007 |
| total_bad_debt | 720 |
| total_liquidations | 1 |

**Agent lifecycle**: 9 active, 1 liquidated, 0 depleted

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
exec riptide run .riptide/campaigns/campaign_2a93d0358025/runs/run_000000_2e458233cab5/run-config.json --adapter fixtures/adapters/lending.toml
```
