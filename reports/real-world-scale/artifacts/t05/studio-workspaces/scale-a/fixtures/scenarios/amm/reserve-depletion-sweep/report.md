# Riptide Simulation Report

## Run metadata

- **Adapter**: `fixtures/adapters/amm.toml`
- **Seed**: 4601
- **Ticks**: 36
- **Agents**: 15 (10× AMM high-rate (smoke), 3× AMM baseline (smoke), 2× AMM low-rate (smoke))
- **Scenario**: reserve-depletion-sweep
- **Output**: `fixtures/scenarios/amm/reserve-depletion-sweep`

## Summary

| Metric | Value |
|--------|-------|
| lp_position.lp_shares_avg | 7.7261 |
| lp_position.lp_shares_max | 16.2667 |
| lp_position.lp_shares_min | 0 |
| pool.cumulative_fees_avg | 0 |
| pool.cumulative_fees_max | 0 |
| pool.cumulative_fees_min | 0 |
| pool.cumulative_volume_avg | 0 |
| pool.cumulative_volume_max | 0 |
| pool.cumulative_volume_min | 0 |
| pool.fee_bps_avg | 29.1892 |
| pool.fee_bps_max | 30 |
| pool.fee_bps_min | 0 |
| pool.k_last_avg | 1048982895756.7567 |
| pool.k_last_max | 1158141276000 |
| pool.k_last_min | 0 |
| pool.last_swap_price_avg | 1048854.4865 |
| pool.last_swap_price_max | 1157858 |
| pool.last_swap_price_min | 0 |
| pool.reserve_a_avg | 973030.9189 |
| pool.reserve_a_max | 1000122 |
| pool.reserve_a_min | 0 |
| pool.reserve_b_avg | 1048918.9189 |
| pool.reserve_b_max | 1158000 |
| pool.reserve_b_min | 0 |
| pool.total_lp_supply_avg | 1946061.8378 |
| pool.total_lp_supply_max | 2000244 |
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
riptide run fixtures/scenarios/amm/reserve-depletion-sweep/run-config.json
```
