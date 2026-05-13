# Riptide Simulation Report

## Run metadata

- **Adapter**: `/home/ailton/Work/riptide/riptide/fixtures/replays/liquid-staking-depeg-redemption-run/adapter.toml`
- **Seed**: 0
- **Ticks**: 6
- **Agents**: 6 (1× admin-actor, 1× staker-0, 1× staker-1, 1× staker-2, 1× staker-3, 1× staker-4)
- **Scenario**: replay:liquid-staking-depeg-redemption-run
- **Output**: `/home/ailton/Work/riptide/riptide/fixtures/replays/liquid-staking-depeg-redemption-run/riptide-output/replays/liquid-staking-depeg-redemption-run`

## Summary

| Metric | Value |
|--------|-------|
| pool.cumulative_slashed_avg | 1142.8571 |
| pool.cumulative_slashed_max | 2000 |
| pool.cumulative_slashed_min | 0 |
| pool.exchange_rate_bps_avg | 8857.1429 |
| pool.exchange_rate_bps_max | 10000 |
| pool.exchange_rate_bps_min | 8000 |
| pool.lst_supply_avg | 6785.7143 |
| pool.lst_supply_max | 10000 |
| pool.lst_supply_min | 2500 |
| pool.pending_unstake_assets_avg | 2057.1429 |
| pool.pending_unstake_assets_max | 4800 |
| pool.pending_unstake_assets_min | 0 |
| pool.pending_unstake_count_avg | 1.7143 |
| pool.pending_unstake_count_max | 4 |
| pool.pending_unstake_count_min | 0 |
| pool.reserve_buffer_avg | 1485.7143 |
| pool.reserve_buffer_max | 2000 |
| pool.reserve_buffer_min | 800 |
| pool.total_assets_avg | 8342.8571 |
| pool.total_assets_max | 10000 |
| pool.total_assets_min | 6800 |
| stake_account.claimable_assets_avg | 28.5714 |
| stake_account.claimable_assets_max | 200 |
| stake_account.claimable_assets_min | 0 |
| stake_account.cumulative_claimed_avg | 57.1429 |
| stake_account.cumulative_claimed_max | 200 |
| stake_account.cumulative_claimed_min | 0 |
| stake_account.lst_balance_avg | 1130.9524 |
| stake_account.lst_balance_max | 1666.6667 |
| stake_account.lst_balance_min | 416.6667 |
| stake_account.pending_unstake_assets_avg | 342.8571 |
| stake_account.pending_unstake_assets_max | 800 |
| stake_account.pending_unstake_assets_min | 0 |

**Agent lifecycle**: 6 active, 0 liquidated, 0 depleted

## Invariants

| Invariant | Firings | First tick |
|-----------|---------|------------|
| no_slash_during_healthy_run | 4 | T3 |
| no_queue_formation | 3 | T4 |

## Notable events

- T3: Engine — invariant_violation:no_slash_during_healthy_run → failed
- T4: Engine — invariant_violation:no_slash_during_healthy_run → failed
- T4: Engine — invariant_violation:no_queue_formation → failed
- T5: Engine — invariant_violation:no_slash_during_healthy_run → failed
- T5: Engine — invariant_violation:no_queue_formation → failed
- T6: Engine — invariant_violation:no_slash_during_healthy_run → failed
- T6: Engine — invariant_violation:no_queue_formation → failed

## Simulation boundaries

- Replay mode bypasses persona compilation and dispatches a declared instruction trajectory directly.
- Trajectory args are supplied inline per event; generic adapters may still fall back to adapter literals for unmapped constants.
- initial-state.json, when present, is applied as a pre-tick bootstrap instruction list before tick 0 is recorded.
- Agent balance/PnL fields are bookkeeping-only in replay mode; authoritative outputs are primitive snapshots, events, and invariant rollups.

## How to reproduce

```sh
riptide replay fixtures/replays/liquid-staking-depeg-redemption-run/config.json
```
