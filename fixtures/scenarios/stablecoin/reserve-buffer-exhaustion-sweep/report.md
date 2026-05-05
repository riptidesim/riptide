# Riptide Simulation Report

## Run metadata

- **Adapter**: `fixtures/scenarios/stablecoin/reserve-buffer-exhaustion-sweep/adapter.toml`
- **Seed**: 4302
- **Ticks**: 5
- **Agents**: 24 (4× Cautious minter, 4× Leverage looper, 12× Panic redeemer, 4× Arb redeemer)
- **Scenario**: baseline
- **Output**: `fixtures/scenarios/stablecoin/reserve-buffer-exhaustion-sweep`

## Summary

| Metric | Value |
|--------|-------|
| pool.collateral_assets_avg | 4000 |
| pool.collateral_assets_max | 8000 |
| pool.collateral_assets_min | 0 |
| pool.cumulative_hedge_loss_bps_avg | 0 |
| pool.cumulative_hedge_loss_bps_max | 0 |
| pool.cumulative_hedge_loss_bps_min | 0 |
| pool.effective_collateral_ratio_bps_avg | 17500 |
| pool.effective_collateral_ratio_bps_max | 35000 |
| pool.effective_collateral_ratio_bps_min | 0 |
| pool.pending_redemption_assets_avg | 500 |
| pool.pending_redemption_assets_max | 1000 |
| pool.pending_redemption_assets_min | 0 |
| pool.pending_redemption_count_avg | 0.5000 |
| pool.pending_redemption_count_max | 1 |
| pool.pending_redemption_count_min | 0 |
| pool.reserve_buffer_assets_avg | 0 |
| pool.reserve_buffer_assets_max | 0 |
| pool.reserve_buffer_assets_min | 0 |
| pool.stable_supply_avg | 1000 |
| pool.stable_supply_max | 2000 |
| pool.stable_supply_min | 0 |
| position.claimable_collateral_avg | 41.6667 |
| position.claimable_collateral_max | 83.3333 |
| position.claimable_collateral_min | 0 |
| position.collateral_deposited_avg | 166.6667 |
| position.collateral_deposited_max | 333.3333 |
| position.collateral_deposited_min | 0 |
| position.cumulative_claimed_avg | 0 |
| position.cumulative_claimed_max | 0 |
| position.cumulative_claimed_min | 0 |
| position.pending_redeem_assets_avg | 20.8333 |
| position.pending_redeem_assets_max | 41.6667 |
| position.pending_redeem_assets_min | 0 |
| position.stable_minted_avg | 41.6667 |
| position.stable_minted_max | 83.3333 |
| position.stable_minted_min | 0 |

**Agent lifecycle**: 24 active, 0 liquidated, 0 depleted

## Invariants

| Invariant | Firings | First tick |
|-----------|---------|------------|
| no_redemption_queue_formation | 3 | T3 |

## Notable events

- T3: Engine — scheduled:initialize_pool → success
- T3: Engine — scheduled:seed_collateral → success
- T3: Engine — scheduled:seed_supply → success
- T3: Engine — scheduled:drain_reserve → success
- T3: Engine — scheduled:force_queue → success
- T3: Engine — invariant_violation:no_redemption_queue_formation → failed
- T4: Engine — invariant_violation:no_redemption_queue_formation → failed
- T5: Engine — invariant_violation:no_redemption_queue_formation → failed

## Simulation boundaries

- In-process LiteSVM backend (no external validator).
- Generic adapters expose only adapter-defined actions/observations; no default TVL/health semantics are inferred.
- Pool-wide TVL/utilization metrics are zeroed on the generic path until a protocol-specific aggregate is declared.
- Custom actions do not mutate engine cash/PnL by default; only on-chain account observations are authoritative.

## How to reproduce

```sh
riptide run fixtures/scenarios/stablecoin/reserve-buffer-exhaustion-sweep/run-config.json
```
