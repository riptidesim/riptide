# Riptide Simulation Report

## Run metadata

- **Adapter**: `/home/ailton/Work/riptide/riptide/fixtures/adapters/perpetuals.toml`
- **Seed**: 2097143840
- **Ticks**: 30
- **Agents**: 12 (4× Perps high-rate (smoke), 4× Perps baseline (smoke), 4× Perps low-rate (smoke))
- **Scenario**: funding-stress
- **Output**: `/home/ailton/Work/riptide/riptide/fixtures/scenarios/perpetuals/funding-stress`

## Summary

| Metric | Value |
|--------|-------|
| market.cumulative_socialized_loss_avg | 0 |
| market.cumulative_socialized_loss_max | 0 |
| market.cumulative_socialized_loss_min | 0 |
| market.liquidation_threshold_bps_avg | 483.8710 |
| market.liquidation_threshold_bps_max | 500 |
| market.liquidation_threshold_bps_min | 0 |
| market.max_leverage_bps_avg | 96774.1935 |
| market.max_leverage_bps_max | 100000 |
| market.max_leverage_bps_min | 0 |
| market.total_collateral_avg | 129.8710 |
| market.total_collateral_max | 253 |
| market.total_collateral_min | 0 |
| market.total_oi_long_avg | 0 |
| market.total_oi_long_max | 0 |
| market.total_oi_long_min | 0 |
| market.total_oi_short_avg | 0 |
| market.total_oi_short_max | 0 |
| market.total_oi_short_min | 0 |
| position.collateral_avg | 10.8226 |
| position.collateral_max | 21.0833 |
| position.collateral_min | 0 |
| position.entry_price_avg | 0 |
| position.entry_price_max | 0 |
| position.entry_price_min | 0 |
| position.leverage_bps_avg | 0 |
| position.leverage_bps_max | 0 |
| position.leverage_bps_min | 0 |
| position.liquidated_false_count | 372 |
| position.liquidated_true_count | 0 |
| position.notional_avg | 0 |
| position.notional_max | 0 |
| position.notional_min | 0 |
| position.side_avg | 0 |
| position.side_max | 0 |
| position.side_min | 0 |

**Agent lifecycle**: 12 active, 0 liquidated, 0 depleted

## Invariants

No invariant violations detected in this run.

## Notable events

- T1: Perps low-rate (smoke) (agent-009) — withdraw → failed
- T1: Perps low-rate (smoke) (agent-012) — withdraw → failed
- T5: Perps low-rate (smoke) (agent-011) — withdraw → failed
- T6: Perps low-rate (smoke) (agent-011) — withdraw → failed
- T6: Perps low-rate (smoke) (agent-012) — withdraw → failed
- T13: Perps low-rate (smoke) (agent-011) — withdraw → failed
- T15: Perps low-rate (smoke) (agent-010) — withdraw → failed
- T26: Perps low-rate (smoke) (agent-011) — withdraw → failed
- T30: Perps low-rate (smoke) (agent-010) — withdraw → failed

## Simulation boundaries

- In-process LiteSVM backend (no external validator).
- Generic adapters expose only adapter-defined actions/observations; no default TVL/health semantics are inferred.
- Pool-wide TVL/utilization metrics are zeroed on the generic path until a protocol-specific aggregate is declared.
- Custom actions do not mutate engine cash/PnL by default; only on-chain account observations are authoritative.

## How to reproduce

```sh
exec riptide run fixtures/scenarios/perpetuals/funding-stress/run-config.json --adapter fixtures/adapters/perpetuals.toml
```
