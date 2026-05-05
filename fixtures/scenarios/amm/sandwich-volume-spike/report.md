# Riptide Simulation Report

## Run metadata

- **Adapter**: `fixtures/adapters/amm.toml`
- **Seed**: 4603
- **Ticks**: 32
- **Agents**: 15 (12× AMM high-rate (smoke), 2× AMM baseline (smoke), 1× AMM low-rate (smoke))
- **Scenario**: sandwich-volume-spike
- **Output**: `fixtures/scenarios/amm/sandwich-volume-spike`

## Summary

| Metric | Value |
|--------|-------|
| lp_position.lp_shares_avg | 4.3354 |
| lp_position.lp_shares_max | 8.9333 |
| lp_position.lp_shares_min | 0 |
| pool.cumulative_fees_avg | 0 |
| pool.cumulative_fees_max | 0 |
| pool.cumulative_fees_min | 0 |
| pool.cumulative_volume_avg | 0 |
| pool.cumulative_volume_max | 0 |
| pool.cumulative_volume_min | 0 |
| pool.fee_bps_avg | 29.0909 |
| pool.fee_bps_max | 30 |
| pool.fee_bps_min | 0 |
| pool.k_last_avg | 1010246428015.1515 |
| pool.k_last_max | 1083072561000 |
| pool.k_last_min | 0 |
| pool.last_swap_price_avg | 1010177.2727 |
| pool.last_swap_price_max | 1082927 |
| pool.last_swap_price_min | 0 |
| pool.reserve_a_avg | 969729.4848 |
| pool.reserve_a_max | 1000067 |
| pool.reserve_a_min | 0 |
| pool.reserve_b_avg | 1010212.1212 |
| pool.reserve_b_max | 1083000 |
| pool.reserve_b_min | 0 |
| pool.total_lp_supply_avg | 1939458.9697 |
| pool.total_lp_supply_max | 2000134 |
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
- T1: AMM high-rate (smoke) (agent-006) — swap → failed
- T1: AMM high-rate (smoke) (agent-007) — swap → failed
- T1: AMM high-rate (smoke) (agent-008) — swap → failed
- T1: AMM high-rate (smoke) (agent-009) — swap → failed
- T1: AMM high-rate (smoke) (agent-010) — swap → failed

## Simulation boundaries

- In-process LiteSVM backend (no external validator).
- Generic adapters expose only adapter-defined actions/observations; no default TVL/health semantics are inferred.
- Pool-wide TVL/utilization metrics are zeroed on the generic path until a protocol-specific aggregate is declared.
- Custom actions do not mutate engine cash/PnL by default; only on-chain account observations are authoritative.

## How to reproduce

```sh
riptide run fixtures/scenarios/amm/sandwich-volume-spike/run-config.json
```
