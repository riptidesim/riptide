# Riptide Simulation Report

## Run metadata

- **Adapter**: `/home/ailton/Work/riptide/riptide/fixtures/adapters/lending.toml`
- **Seed**: 42
- **Ticks**: 30
- **Agents**: 15 (10× Leveraged Borrower, 5× Steady LP)
- **Scenario**: baseline
- **Output**: `fixtures/scenarios/lending/utilization-climb`

## Summary

| Metric | Value |
|--------|-------|
| final_tvl | 1500 |
| final_utilization | 45.3333 |
| largest_single_tick_drawdown | 0.0036 |
| total_bad_debt | 0 |
| total_liquidations | 0 |

**Agent lifecycle**: 15 active, 0 liquidated, 0 depleted

## Invariants

No invariant violations detected in this run.

## Notable events

- T4: Steady LP (agent-011) — liquidate → failed
- T4: Steady LP (agent-012) — liquidate → failed
- T4: Steady LP (agent-013) — liquidate → failed
- T4: Steady LP (agent-014) — liquidate → failed
- T4: Steady LP (agent-015) — liquidate → failed
- T5: Steady LP (agent-011) — liquidate → failed
- T5: Steady LP (agent-012) — liquidate → failed
- T5: Steady LP (agent-013) — liquidate → failed
- T5: Steady LP (agent-014) — liquidate → failed
- T5: Steady LP (agent-015) — liquidate → failed

## Simulation boundaries

- In-process LiteSVM backend (no external validator).
- No slippage, fees, or MEV modeled.
- Oracle prices are scenario-driven, not external feeds.
- Agents funded via deterministic airdrop, not realistic onboarding.

## How to reproduce

```sh
riptide run .riptide/scenarios/lending/utilization-climb/run-config.json --adapter /home/ailton/Work/riptide/riptide/fixtures/adapters/lending.toml
```
