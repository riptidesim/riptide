# Riptide Simulation Report

## Run metadata

- **Adapter**: `/home/ailton/Work/riptide/riptide/fixtures/replays/lst-lending-contagion-proof/config.json`
- **Seed**: 0
- **Ticks**: 4
- **Agents**: 16 (1× liquid_staking:admin-actor, 1× liquid_staking:staker-0, 1× liquid_staking:staker-1, 1× liquid_staking:staker-2, 1× liquid_staking:staker-3, 1× liquid_staking:staker-4, 1× lending:otc-liquidator-0, 1× lending:otc-liquidator-1, 1× lending:otc-liquidator-2, 1× lending:otc-liquidator-3, 1× lending:otc-liquidator-4, 1× lending:whale-0, 1× lending:whale-1, 1× lending:whale-2, 1× lending:whale-3, 1× lending:whale-4)
- **Scenario**: replay:multi:lst-lending-contagion-proof-upstream
- **Output**: `/home/ailton/Work/riptide/riptide/fixtures/replays/lst-lending-contagion-proof/riptide-output/replays/lst-lending-contagion-proof`

## Summary

| Metric | Value |
|--------|-------|
| lending.summary.final_tvl | 500 |
| lending.summary.final_utilization | 0 |
| lending.summary.largest_single_tick_drawdown | 0.4000 |
| lending.summary.total_bad_debt | 3600 |
| liquid_staking.summary.pool.cumulative_slashed_avg | 1600 |
| liquid_staking.summary.pool.cumulative_slashed_max | 4000 |
| liquid_staking.summary.pool.cumulative_slashed_min | 0 |
| liquid_staking.summary.pool.exchange_rate_bps_avg | 8400 |
| liquid_staking.summary.pool.exchange_rate_bps_max | 10000 |
| liquid_staking.summary.pool.exchange_rate_bps_min | 6000 |
| liquid_staking.summary.pool.lst_supply_avg | 10000 |
| liquid_staking.summary.pool.lst_supply_max | 10000 |
| liquid_staking.summary.pool.lst_supply_min | 10000 |
| liquid_staking.summary.pool.pending_unstake_assets_avg | 0 |
| liquid_staking.summary.pool.pending_unstake_assets_max | 0 |
| liquid_staking.summary.pool.pending_unstake_assets_min | 0 |
| liquid_staking.summary.pool.pending_unstake_count_avg | 0 |
| liquid_staking.summary.pool.pending_unstake_count_max | 0 |
| liquid_staking.summary.pool.pending_unstake_count_min | 0 |
| liquid_staking.summary.pool.reserve_buffer_avg | 2000 |
| liquid_staking.summary.pool.reserve_buffer_max | 2000 |
| liquid_staking.summary.pool.reserve_buffer_min | 2000 |
| liquid_staking.summary.pool.total_assets_avg | 8400 |
| liquid_staking.summary.pool.total_assets_max | 10000 |
| liquid_staking.summary.pool.total_assets_min | 6000 |
| liquid_staking.summary.stake_account.claimable_assets_avg | 0 |
| liquid_staking.summary.stake_account.claimable_assets_max | 0 |
| liquid_staking.summary.stake_account.claimable_assets_min | 0 |
| liquid_staking.summary.stake_account.cumulative_claimed_avg | 0 |
| liquid_staking.summary.stake_account.cumulative_claimed_max | 0 |
| liquid_staking.summary.stake_account.cumulative_claimed_min | 0 |
| liquid_staking.summary.stake_account.lst_balance_avg | 1666.6667 |
| liquid_staking.summary.stake_account.lst_balance_max | 1666.6667 |
| liquid_staking.summary.stake_account.lst_balance_min | 1666.6667 |
| liquid_staking.summary.stake_account.pending_unstake_assets_avg | 0 |
| liquid_staking.summary.stake_account.pending_unstake_assets_max | 0 |
| liquid_staking.summary.stake_account.pending_unstake_assets_min | 0 |

**Agent lifecycle**: 16 active, 0 liquidated, 0 depleted

## Invariants

| Invariant | Firings | First tick |
|-----------|---------|------------|
| liquid_staking:no_slash_during_healthy_run | 2 | T3 |
| lending:no_bad_debt | 1 | T4 |

## Notable events

- T3: Engine — invariant_violation:liquid_staking:no_slash_during_healthy_run → failed
- T4: Engine — invariant_violation:liquid_staking:no_slash_during_healthy_run → failed
- T4: Engine — invariant_violation:lending:no_bad_debt → failed

## Simulation boundaries

- Multi-component replay boots two declared components into one shared LiteSVM world.
- Per-tick ordering: each component runs in declaration order; bridges sourced from a component are applied to their downstream target before the next component ticks.
- Bridges are scalar observation -> scalar oracle write with an explicit transform; no arbitrary cross-program transaction graph.
- Qualified snapshot keys `<component>.<field>` expose per-component state to invariants without ambiguity.

## How to reproduce

```sh
riptide replay fixtures/replays/lst-lending-contagion-proof/config.json
```
