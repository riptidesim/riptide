# Riptide Simulation Report

## Run metadata

- **Adapter**: `/home/ailton/Work/riptide/riptide/fixtures/adapters/amm.toml`
- **Seed**: 1651452681
- **Ticks**: 30
- **Agents**: 15 (5× AMM high-rate (smoke), 5× AMM baseline (smoke), 5× AMM low-rate (smoke))
- **Scenario**: price-impact
- **Output**: `/home/ailton/Work/riptide/riptide/fixtures/scenarios/amm/price-impact`

## Summary

| Metric | Value |
|--------|-------|
| lp_position.lp_shares_avg | 14.8129 |
| lp_position.lp_shares_max | 29.2000 |
| lp_position.lp_shares_min | 0 |
| pool.cumulative_fees_avg | 0 |
| pool.cumulative_fees_max | 0 |
| pool.cumulative_fees_min | 0 |
| pool.cumulative_volume_avg | 0 |
| pool.cumulative_volume_max | 0 |
| pool.cumulative_volume_min | 0 |
| pool.fee_bps_avg | 29.0323 |
| pool.fee_bps_max | 30 |
| pool.fee_bps_min | 0 |
| pool.k_last_avg | 1116471777758.0645 |
| pool.k_last_max | 1294283386000 |
| pool.k_last_min | 0 |
| pool.last_swap_price_avg | 1116205.2258 |
| pool.last_swap_price_max | 1293716 |
| pool.last_swap_price_min | 0 |
| pool.reserve_a_avg | 967853.0323 |
| pool.reserve_a_max | 1000219 |
| pool.reserve_a_min | 0 |
| pool.reserve_b_avg | 1116338.7097 |
| pool.reserve_b_max | 1294000 |
| pool.reserve_b_min | 0 |
| pool.total_lp_supply_avg | 1935706.0645 |
| pool.total_lp_supply_max | 2000438 |
| pool.total_lp_supply_min | 0 |

**Agent lifecycle**: 15 active, 0 liquidated, 0 depleted

## Invariants

No invariant violations detected in this run.

## Notable events

- T1: AMM high-rate (smoke) (agent-001) — swap → failed
- T1: AMM high-rate (smoke) (agent-002) — swap → failed
- T1: AMM high-rate (smoke) (agent-003) — swap → failed
- T1: AMM high-rate (smoke) (agent-004) — swap → failed
- T1: AMM high-rate (smoke) (agent-005) — swap → failed
- T1: AMM baseline (smoke) (agent-007) — swap → failed
- T1: AMM baseline (smoke) (agent-009) — swap → failed
- T2: AMM high-rate (smoke) (agent-001) — swap → failed
- T2: AMM high-rate (smoke) (agent-002) — swap → failed
- T2: AMM high-rate (smoke) (agent-003) — swap → failed

## Simulation boundaries

- In-process LiteSVM backend (no external validator).
- Generic adapters expose only adapter-defined actions/observations; no default TVL/health semantics are inferred.
- Pool-wide TVL/utilization metrics are zeroed on the generic path until a protocol-specific aggregate is declared.
- Custom actions do not mutate engine cash/PnL by default; only on-chain account observations are authoritative.

## How to reproduce

```sh
exec riptide run fixtures/scenarios/amm/price-impact/run-config.json --adapter fixtures/adapters/amm.toml
```
