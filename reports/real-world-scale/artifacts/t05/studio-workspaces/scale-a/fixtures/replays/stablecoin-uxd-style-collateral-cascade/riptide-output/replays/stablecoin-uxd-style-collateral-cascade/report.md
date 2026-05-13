# Riptide Simulation Report

## Run metadata

- **Adapter**: `/home/ailton/Work/riptide/riptide/fixtures/replays/stablecoin-uxd-style-collateral-cascade/adapter.toml`
- **Seed**: 0
- **Ticks**: 6
- **Agents**: 6 (1× admin-actor, 1× staker-0, 1× staker-1, 1× staker-2, 1× staker-3, 1× staker-4)
- **Scenario**: replay:stablecoin-uxd-style-collateral-cascade
- **Output**: `/home/ailton/Work/riptide/riptide/fixtures/replays/stablecoin-uxd-style-collateral-cascade/riptide-output/replays/stablecoin-uxd-style-collateral-cascade`

## Summary

| Metric | Value |
|--------|-------|
| pool.collateral_assets_avg | 7528.5714 |
| pool.collateral_assets_max | 10000 |
| pool.collateral_assets_min | 5300 |
| pool.cumulative_hedge_loss_bps_avg | 2285.7143 |
| pool.cumulative_hedge_loss_bps_max | 4000 |
| pool.cumulative_hedge_loss_bps_min | 0 |
| pool.effective_collateral_ratio_bps_avg | 9294.8571 |
| pool.effective_collateral_ratio_bps_max | 13333 |
| pool.effective_collateral_ratio_bps_min | 5333 |
| pool.pending_redemption_assets_avg | 1928.5714 |
| pool.pending_redemption_assets_max | 4500 |
| pool.pending_redemption_assets_min | 0 |
| pool.pending_redemption_count_avg | 1.2857 |
| pool.pending_redemption_count_max | 3 |
| pool.pending_redemption_count_min | 0 |
| pool.reserve_buffer_assets_avg | 1357.1429 |
| pool.reserve_buffer_assets_max | 2000 |
| pool.reserve_buffer_assets_min | 500 |
| pool.stable_supply_avg | 4928.5714 |
| pool.stable_supply_max | 7500 |
| pool.stable_supply_min | 1500 |
| position.claimable_collateral_avg | 35.7143 |
| position.claimable_collateral_max | 250 |
| position.claimable_collateral_min | 0 |
| position.collateral_deposited_avg | 1559.5238 |
| position.collateral_deposited_max | 1666.6667 |
| position.collateral_deposited_min | 1416.6667 |
| position.cumulative_claimed_avg | 71.4286 |
| position.cumulative_claimed_max | 250 |
| position.cumulative_claimed_min | 0 |
| position.pending_redeem_assets_avg | 321.4286 |
| position.pending_redeem_assets_max | 750 |
| position.pending_redeem_assets_min | 0 |
| position.stable_minted_avg | 821.4286 |
| position.stable_minted_max | 1250 |
| position.stable_minted_min | 250 |

**Agent lifecycle**: 6 active, 0 liquidated, 0 depleted

## Invariants

| Invariant | Firings | First tick |
|-----------|---------|------------|
| no_hedge_loss_during_healthy_run | 4 | T3 |
| full_backing | 4 | T3 |
| no_redemption_queue_formation | 3 | T4 |

## Notable events

- T3: Engine — invariant_violation:no_hedge_loss_during_healthy_run → failed
- T3: Engine — invariant_violation:full_backing → failed
- T4: Engine — invariant_violation:no_hedge_loss_during_healthy_run → failed
- T4: Engine — invariant_violation:full_backing → failed
- T4: Engine — invariant_violation:no_redemption_queue_formation → failed
- T5: Engine — invariant_violation:no_hedge_loss_during_healthy_run → failed
- T5: Engine — invariant_violation:full_backing → failed
- T5: Engine — invariant_violation:no_redemption_queue_formation → failed
- T6: Engine — invariant_violation:no_hedge_loss_during_healthy_run → failed
- T6: Engine — invariant_violation:full_backing → failed

## Simulation boundaries

- Replay mode bypasses persona compilation and dispatches a declared instruction trajectory directly.
- Trajectory args are supplied inline per event; generic adapters may still fall back to adapter literals for unmapped constants.
- initial-state.json, when present, is applied as a pre-tick bootstrap instruction list before tick 0 is recorded.
- Agent balance/PnL fields are bookkeeping-only in replay mode; authoritative outputs are primitive snapshots, events, and invariant rollups.

## How to reproduce

```sh
riptide replay fixtures/replays/stablecoin-uxd-style-collateral-cascade/config.json
```
