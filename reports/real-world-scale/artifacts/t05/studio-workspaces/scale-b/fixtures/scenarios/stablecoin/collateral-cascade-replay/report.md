# Riptide Simulation Report

## Run metadata

- **Adapter**: `fixtures/scenarios/stablecoin/collateral-cascade-replay/adapter.toml`
- **Seed**: 4301
- **Ticks**: 5
- **Agents**: 20 (6× Cautious minter, 6× Leverage looper, 6× Panic redeemer, 2× Arb redeemer)
- **Scenario**: baseline
- **Output**: `fixtures/scenarios/stablecoin/collateral-cascade-replay`

## Summary

| Metric | Value |
|--------|-------|
| pool.collateral_assets_avg | 2650 |
| pool.collateral_assets_max | 5300 |
| pool.collateral_assets_min | 0 |
| pool.cumulative_hedge_loss_bps_avg | 2000 |
| pool.cumulative_hedge_loss_bps_max | 4000 |
| pool.cumulative_hedge_loss_bps_min | 0 |
| pool.effective_collateral_ratio_bps_avg | 4416.5000 |
| pool.effective_collateral_ratio_bps_max | 8833 |
| pool.effective_collateral_ratio_bps_min | 0 |
| pool.pending_redemption_assets_avg | 0 |
| pool.pending_redemption_assets_max | 0 |
| pool.pending_redemption_assets_min | 0 |
| pool.pending_redemption_count_avg | 0 |
| pool.pending_redemption_count_max | 0 |
| pool.pending_redemption_count_min | 0 |
| pool.reserve_buffer_assets_avg | 250 |
| pool.reserve_buffer_assets_max | 500 |
| pool.reserve_buffer_assets_min | 0 |
| pool.stable_supply_avg | 3000 |
| pool.stable_supply_max | 6000 |
| pool.stable_supply_min | 0 |
| position.claimable_collateral_avg | 37.5000 |
| position.claimable_collateral_max | 75 |
| position.claimable_collateral_min | 0 |
| position.collateral_deposited_avg | 212.5000 |
| position.collateral_deposited_max | 425 |
| position.collateral_deposited_min | 0 |
| position.cumulative_claimed_avg | 0 |
| position.cumulative_claimed_max | 0 |
| position.cumulative_claimed_min | 0 |
| position.pending_redeem_assets_avg | 0 |
| position.pending_redeem_assets_max | 0 |
| position.pending_redeem_assets_min | 0 |
| position.stable_minted_avg | 150 |
| position.stable_minted_max | 300 |
| position.stable_minted_min | 0 |

**Agent lifecycle**: 20 active, 0 liquidated, 0 depleted

## Invariants

| Invariant | Firings | First tick |
|-----------|---------|------------|
| no_hedge_loss_during_healthy_run | 3 | T3 |

## Notable events

- T3: Engine — scheduled:initialize_pool → success
- T3: Engine — scheduled:seed_collateral → success
- T3: Engine — scheduled:seed_supply → success
- T3: Engine — scheduled:apply_hedge_loss → success
- T3: Engine — scheduled:post_redeem_after_haircut → success
- T3: Engine — invariant_violation:no_hedge_loss_during_healthy_run → failed
- T4: Engine — invariant_violation:no_hedge_loss_during_healthy_run → failed
- T5: Engine — invariant_violation:no_hedge_loss_during_healthy_run → failed

## Simulation boundaries

- In-process LiteSVM backend (no external validator).
- Generic adapters expose only adapter-defined actions/observations; no default TVL/health semantics are inferred.
- Pool-wide TVL/utilization metrics are zeroed on the generic path until a protocol-specific aggregate is declared.
- Custom actions do not mutate engine cash/PnL by default; only on-chain account observations are authoritative.

## How to reproduce

```sh
riptide run fixtures/scenarios/stablecoin/collateral-cascade-replay/run-config.json
```
