# Riptide Simulation Report

## Run metadata

- **Adapter**: `/home/ailton/Work/riptide/riptide/fixtures/adapters/lending.toml`
- **Seed**: 2095041311
- **Ticks**: 10
- **Agents**: 5 (3× Cautious Yield Farmer, 2× Steady LP)
- **Scenario**: price-shock
- **Output**: `/home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t04/lending-safe/configs`

## Summary

| Metric | Value |
|--------|-------|
| final_tvl | 816 |
| final_utilization | 0 |
| largest_single_tick_drawdown | 0.4023 |
| total_bad_debt | 0 |
| total_liquidations | 0 |

**Agent lifecycle**: 5 active, 0 liquidated, 0 depleted

## Invariants

No invariant violations detected in this run.

## Notable events

No notable events.

## Simulation boundaries

- In-process LiteSVM backend (no external validator).
- No slippage, fees, or MEV modeled.
- Oracle prices are scenario-driven, not external feeds.
- Agents funded via deterministic airdrop, not realistic onboarding.

## How to reproduce

```sh
exec riptide run examples/configs/safe.json --adapter fixtures/adapters/lending.toml
```
