# Riptide Simulation Report

## Run metadata

- **Adapter**: `fixtures/adapters/amm.toml`
- **Seed**: 4602
- **Ticks**: 32
- **Agents**: 15 (3× AMM high-rate (smoke), 8× AMM baseline (smoke), 4× AMM low-rate (smoke))
- **Scenario**: jit-liquidity-exit
- **Output**: `fixtures/scenarios/amm/jit-liquidity-exit`

## Summary

| Metric | Value |
|--------|-------|
| lp_position.lp_shares_avg | 17.0626 |
| lp_position.lp_shares_max | 33.7333 |
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
| pool.k_last_avg | 1129822012515.1516 |
| pool.k_last_max | 1317333201000 |
| pool.k_last_min | 0 |
| pool.last_swap_price_avg | 1129510.8182 |
| pool.last_swap_price_max | 1316666 |
| pool.last_swap_price_min | 0 |
| pool.reserve_a_avg | 969824.9394 |
| pool.reserve_a_max | 1000253 |
| pool.reserve_a_min | 0 |
| pool.reserve_b_avg | 1129666.6667 |
| pool.reserve_b_max | 1317000 |
| pool.reserve_b_min | 0 |
| pool.total_lp_supply_avg | 1939649.8788 |
| pool.total_lp_supply_max | 2000506 |
| pool.total_lp_supply_min | 0 |

**Agent lifecycle**: 15 active, 0 liquidated, 0 depleted

## Invariants

No invariant violations detected in this run.

## Notable events

- T1: AMM high-rate (smoke) (agent-001) — swap → failed
- T1: AMM high-rate (smoke) (agent-002) — swap → failed
- T1: AMM high-rate (smoke) (agent-003) — swap → failed
- T1: AMM baseline (smoke) (agent-006) — swap → failed
- T1: AMM baseline (smoke) (agent-010) — swap → failed
- T2: AMM high-rate (smoke) (agent-001) — swap → failed
- T2: AMM high-rate (smoke) (agent-002) — swap → failed
- T2: AMM high-rate (smoke) (agent-003) — swap → failed
- T2: AMM baseline (smoke) (agent-004) — swap → failed
- T2: AMM baseline (smoke) (agent-007) — swap → failed

## Simulation boundaries

- In-process LiteSVM backend (no external validator).
- Generic adapters expose only adapter-defined actions/observations; no default TVL/health semantics are inferred.
- Pool-wide TVL/utilization metrics are zeroed on the generic path until a protocol-specific aggregate is declared.
- Custom actions do not mutate engine cash/PnL by default; only on-chain account observations are authoritative.

## How to reproduce

```sh
riptide run fixtures/scenarios/amm/jit-liquidity-exit/run-config.json
```
