# Riptide Simulation Report

## Run metadata

- **Adapter**: `/home/ailton/Work/riptide/riptide/fixtures/adapters/solend-fork.toml`
- **Seed**: 42
- **Ticks**: 20
- **Agents**: 20 (1× Whale, 19× Steady LP)
- **Scenario**: price-shock
- **Output**: `fixtures/scenarios/solend-fork/hero-grid/w5-s20`

## Summary

| Metric | Value |
|--------|-------|
| final_tvl | 3214 |
| final_utilization | 0 |
| largest_single_tick_drawdown | 0.4004 |
| total_bad_debt | 720 |
| total_liquidations | 1 |

**Agent lifecycle**: 19 active, 1 liquidated, 0 depleted

## Invariants

No invariant violations detected in this run.

## Notable events

- T4: Steady LP (agent-002) — liquidate → failed
- T4: Steady LP (agent-003) — liquidate → failed
- T4: Steady LP (agent-004) — liquidate → failed
- T4: Steady LP (agent-005) — liquidate → failed
- T4: Steady LP (agent-006) — liquidate → failed
- T4: Steady LP (agent-007) — liquidate → failed
- T4: Steady LP (agent-008) — liquidate → failed
- T4: Steady LP (agent-009) — liquidate → failed
- T4: Steady LP (agent-010) — liquidate → failed
- T4: Steady LP (agent-011) — liquidate → failed

## Simulation boundaries

- In-process LiteSVM backend (no external validator).
- No slippage, fees, or MEV modeled.
- Oracle prices are scenario-driven, not external feeds.
- Agents funded via deterministic airdrop, not realistic onboarding.

## How to reproduce

```sh
riptide run .riptide/scenarios/solend-fork/hero-grid/w5-s20/run-config.json --adapter /home/ailton/Work/riptide/riptide/fixtures/adapters/solend-fork.toml
```
