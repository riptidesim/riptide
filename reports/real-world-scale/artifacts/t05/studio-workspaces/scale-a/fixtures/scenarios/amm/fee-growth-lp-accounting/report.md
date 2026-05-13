# Riptide Simulation Report

## Run metadata

- **Adapter**: `fixtures/adapters/amm.toml`
- **Seed**: 4604
- **Ticks**: 36
- **Agents**: 15 (6× AMM high-rate (smoke), 6× AMM baseline (smoke), 3× AMM low-rate (smoke))
- **Scenario**: fee-growth-lp-accounting
- **Output**: `fixtures/scenarios/amm/fee-growth-lp-accounting`

## Summary

| Metric | Value |
|--------|-------|
| lp_position.lp_shares_avg | 14.1189 |
| lp_position.lp_shares_max | 28.8000 |
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
| pool.k_last_avg | 1105989777554.0540 |
| pool.k_last_max | 1270274320000 |
| pool.k_last_min | 0 |
| pool.last_swap_price_avg | 1105739.4865 |
| pool.last_swap_price_max | 1269725 |
| pool.last_swap_price_min | 0 |
| pool.reserve_a_avg | 973078.8649 |
| pool.reserve_a_max | 1000216 |
| pool.reserve_a_min | 0 |
| pool.reserve_b_avg | 1105864.8649 |
| pool.reserve_b_max | 1270000 |
| pool.reserve_b_min | 0 |
| pool.total_lp_supply_avg | 1946157.7297 |
| pool.total_lp_supply_max | 2000432 |
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
- T1: AMM baseline (smoke) (agent-008) — swap → failed
- T1: AMM baseline (smoke) (agent-011) — swap → failed
- T1: AMM baseline (smoke) (agent-012) — swap → failed
- T2: AMM high-rate (smoke) (agent-001) — swap → failed

## Simulation boundaries

- In-process LiteSVM backend (no external validator).
- Generic adapters expose only adapter-defined actions/observations; no default TVL/health semantics are inferred.
- Pool-wide TVL/utilization metrics are zeroed on the generic path until a protocol-specific aggregate is declared.
- Custom actions do not mutate engine cash/PnL by default; only on-chain account observations are authoritative.

## How to reproduce

```sh
riptide run fixtures/scenarios/amm/fee-growth-lp-accounting/run-config.json
```
