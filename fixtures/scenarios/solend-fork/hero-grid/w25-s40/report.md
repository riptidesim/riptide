# Riptide Simulation Report

## Run metadata

- **Adapter**: `/home/ailton/Work/riptide/riptide/fixtures/adapters/solend-fork.toml`
- **Seed**: 42
- **Ticks**: 20
- **Agents**: 20 (5× Whale, 15× Steady LP)
- **Scenario**: price-shock
- **Output**: `fixtures/scenarios/solend-fork/hero-grid/w25-s40`

## Summary

| Metric | Value |
|--------|-------|
| final_tvl | 2950 |
| final_utilization | 0 |
| largest_single_tick_drawdown | 0.4004 |
| total_bad_debt | 3600 |
| total_liquidations | 5 |

**Agent lifecycle**: 15 active, 5 liquidated, 0 depleted

## Invariants

No invariant violations detected in this run.

## Notable events

- T4: Steady LP (agent-002) — liquidate → failed
- T4: Steady LP (agent-003) — liquidate → failed
- T4: Steady LP (agent-004) — liquidate → failed
- T4: Steady LP (agent-006) — liquidate → failed
- T4: Steady LP (agent-007) — liquidate → failed
- T4: Steady LP (agent-008) — liquidate → failed
- T4: Steady LP (agent-010) — liquidate → failed
- T4: Steady LP (agent-011) — liquidate → failed
- T4: Steady LP (agent-012) — liquidate → failed
- T4: Steady LP (agent-014) — liquidate → failed

## Simulation boundaries

- In-process LiteSVM backend (no external validator).
- No slippage, fees, or MEV modeled.
- Oracle prices are scenario-driven, not external feeds.
- Agents funded via deterministic airdrop, not realistic onboarding.

## How to reproduce

```sh
riptide run .riptide/scenarios/solend-fork/hero-grid/w25-s40/run-config.json --adapter /home/ailton/Work/riptide/riptide/fixtures/adapters/solend-fork.toml
```
