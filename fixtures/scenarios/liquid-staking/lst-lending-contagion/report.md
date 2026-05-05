# Riptide Simulation Report

## Run metadata

- **Adapter**: `fixtures/adapters/liquid-staking.toml`
- **Seed**: 2904003
- **Ticks**: 24
- **Agents**: 20 (4× Steady staker, 4× Yield maximizer, 9× Panic exiter, 3× Arb redeemer)
- **Scenario**: baseline
- **Output**: `fixtures/scenarios/liquid-staking/lst-lending-contagion`

## Summary

| Metric | Value |
|--------|-------|
| pool.cumulative_slashed_avg | 0 |
| pool.cumulative_slashed_max | 0 |
| pool.cumulative_slashed_min | 0 |
| pool.exchange_rate_bps_avg | 9600 |
| pool.exchange_rate_bps_max | 10000 |
| pool.exchange_rate_bps_min | 0 |
| pool.lst_supply_avg | 96 |
| pool.lst_supply_max | 192 |
| pool.lst_supply_min | 0 |
| pool.pending_unstake_assets_avg | 0 |
| pool.pending_unstake_assets_max | 0 |
| pool.pending_unstake_assets_min | 0 |
| pool.pending_unstake_count_avg | 0 |
| pool.pending_unstake_count_max | 0 |
| pool.pending_unstake_count_min | 0 |
| pool.reserve_buffer_avg | 0 |
| pool.reserve_buffer_max | 0 |
| pool.reserve_buffer_min | 0 |
| pool.total_assets_avg | 96 |
| pool.total_assets_max | 192 |
| pool.total_assets_min | 0 |
| stake_account.claimable_assets_avg | 0 |
| stake_account.claimable_assets_max | 0 |
| stake_account.claimable_assets_min | 0 |
| stake_account.cumulative_claimed_avg | 0 |
| stake_account.cumulative_claimed_max | 0 |
| stake_account.cumulative_claimed_min | 0 |
| stake_account.lst_balance_avg | 4.8000 |
| stake_account.lst_balance_max | 9.6000 |
| stake_account.lst_balance_min | 0 |
| stake_account.pending_unstake_assets_avg | 0 |
| stake_account.pending_unstake_assets_max | 0 |
| stake_account.pending_unstake_assets_min | 0 |

**Agent lifecycle**: 20 active, 0 liquidated, 0 depleted

## Invariants

No invariant violations detected in this run.

## Notable events

- T1: Panic exiter (agent-009) — request_unstake → failed
- T1: Panic exiter (agent-010) — request_unstake → failed
- T1: Panic exiter (agent-011) — request_unstake → failed
- T1: Panic exiter (agent-012) — request_unstake → failed
- T1: Panic exiter (agent-013) — request_unstake → failed
- T1: Panic exiter (agent-014) — request_unstake → failed
- T1: Panic exiter (agent-015) — request_unstake → failed
- T1: Panic exiter (agent-016) — request_unstake → failed
- T1: Panic exiter (agent-017) — request_unstake → failed
- T1: Arb redeemer (agent-018) — request_unstake → failed

## Simulation boundaries

- In-process LiteSVM backend (no external validator).
- Generic adapters expose only adapter-defined actions/observations; no default TVL/health semantics are inferred.
- Pool-wide TVL/utilization metrics are zeroed on the generic path until a protocol-specific aggregate is declared.
- Custom actions do not mutate engine cash/PnL by default; only on-chain account observations are authoritative.

## How to reproduce

```sh
riptide run fixtures/scenarios/liquid-staking/lst-lending-contagion/run-config.json
```
