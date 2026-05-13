# Riptide Simulation Report

## Run metadata

- **Adapter**: `fixtures/adapters/perpetuals.toml`
- **Seed**: 4504
- **Ticks**: 34
- **Agents**: 12 (6× Perps high-rate (smoke), 4× Perps baseline (smoke), 2× Perps low-rate (smoke))
- **Scenario**: insurance-socialized-loss
- **Output**: `fixtures/scenarios/perpetuals/insurance-socialized-loss`

## Summary

| Metric | Value |
|--------|-------|
| market.cumulative_socialized_loss_avg | 0 |
| market.cumulative_socialized_loss_max | 0 |
| market.cumulative_socialized_loss_min | 0 |
| market.liquidation_threshold_bps_avg | 485.7143 |
| market.liquidation_threshold_bps_max | 500 |
| market.liquidation_threshold_bps_min | 0 |
| market.max_leverage_bps_avg | 97142.8571 |
| market.max_leverage_bps_max | 100000 |
| market.max_leverage_bps_min | 0 |
| market.total_collateral_avg | 176.3143 |
| market.total_collateral_max | 343 |
| market.total_collateral_min | 0 |
| market.total_oi_long_avg | 0 |
| market.total_oi_long_max | 0 |
| market.total_oi_long_min | 0 |
| market.total_oi_short_avg | 0 |
| market.total_oi_short_max | 0 |
| market.total_oi_short_min | 0 |
| position.collateral_avg | 14.6929 |
| position.collateral_max | 28.5833 |
| position.collateral_min | 0 |
| position.entry_price_avg | 0 |
| position.entry_price_max | 0 |
| position.entry_price_min | 0 |
| position.leverage_bps_avg | 0 |
| position.leverage_bps_max | 0 |
| position.leverage_bps_min | 0 |
| position.liquidated_false_count | 420 |
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

- T1: Perps low-rate (smoke) (agent-011) — withdraw → failed
- T1: Perps low-rate (smoke) (agent-012) — withdraw → failed
- T2: Perps low-rate (smoke) (agent-012) — withdraw → failed

## Simulation boundaries

- In-process LiteSVM backend (no external validator).
- Generic adapters expose only adapter-defined actions/observations; no default TVL/health semantics are inferred.
- Pool-wide TVL/utilization metrics are zeroed on the generic path until a protocol-specific aggregate is declared.
- Custom actions do not mutate engine cash/PnL by default; only on-chain account observations are authoritative.

## How to reproduce

```sh
riptide run fixtures/scenarios/perpetuals/insurance-socialized-loss/run-config.json
```
