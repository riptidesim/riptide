# Riptide Simulation Report

## Run metadata

- **Adapter**: `/home/ailton/Work/riptide/riptide/fixtures/adapters/stablecoin.toml`
- **Seed**: 28412426
- **Ticks**: 24
- **Agents**: 20 (7× Cautious minter, 7× Leverage looper, 4× Panic redeemer, 2× Arb redeemer)
- **Scenario**: baseline
- **Output**: `/home/ailton/Work/riptide/riptide/fixtures/scenarios/stablecoin/hedge-loss-magnitude-sweep`

## Summary

| Metric | Value |
|--------|-------|
| pool.collateral_assets_avg | 126 |
| pool.collateral_assets_max | 248 |
| pool.collateral_assets_min | 0 |
| pool.cumulative_hedge_loss_bps_avg | 0 |
| pool.cumulative_hedge_loss_bps_max | 0 |
| pool.cumulative_hedge_loss_bps_min | 0 |
| pool.effective_collateral_ratio_bps_avg | 52820.5200 |
| pool.effective_collateral_ratio_bps_max | 200000 |
| pool.effective_collateral_ratio_bps_min | 0 |
| pool.pending_redemption_assets_avg | 0 |
| pool.pending_redemption_assets_max | 0 |
| pool.pending_redemption_assets_min | 0 |
| pool.pending_redemption_count_avg | 0 |
| pool.pending_redemption_count_max | 0 |
| pool.pending_redemption_count_min | 0 |
| pool.reserve_buffer_assets_avg | 0 |
| pool.reserve_buffer_assets_max | 0 |
| pool.reserve_buffer_assets_min | 0 |
| pool.stable_supply_avg | 27.4800 |
| pool.stable_supply_max | 64 |
| pool.stable_supply_min | 0 |
| position.claimable_collateral_avg | 0 |
| position.claimable_collateral_max | 0 |
| position.claimable_collateral_min | 0 |
| position.collateral_deposited_avg | 6.3000 |
| position.collateral_deposited_max | 12.4000 |
| position.collateral_deposited_min | 0 |
| position.cumulative_claimed_avg | 0 |
| position.cumulative_claimed_max | 0 |
| position.cumulative_claimed_min | 0 |
| position.pending_redeem_assets_avg | 0 |
| position.pending_redeem_assets_max | 0 |
| position.pending_redeem_assets_min | 0 |
| position.stable_minted_avg | 1.3740 |
| position.stable_minted_max | 3.2000 |
| position.stable_minted_min | 0 |

**Agent lifecycle**: 20 active, 0 liquidated, 0 depleted

## Invariants

No invariant violations detected in this run.

## Notable events

- T1: Leverage looper (agent-009) — mint_stable → failed
- T1: Leverage looper (agent-010) — mint_stable → failed
- T1: Leverage looper (agent-011) — mint_stable → failed
- T1: Leverage looper (agent-013) — mint_stable → failed
- T1: Leverage looper (agent-014) — mint_stable → failed
- T1: Panic redeemer (agent-015) — request_redeem → failed
- T1: Panic redeemer (agent-016) — request_redeem → failed
- T1: Panic redeemer (agent-017) — request_redeem → failed
- T1: Panic redeemer (agent-018) — request_redeem → failed
- T1: Arb redeemer (agent-019) — request_redeem → failed

## Simulation boundaries

- In-process LiteSVM backend (no external validator).
- Generic adapters expose only adapter-defined actions/observations; no default TVL/health semantics are inferred.
- Pool-wide TVL/utilization metrics are zeroed on the generic path until a protocol-specific aggregate is declared.
- Custom actions do not mutate engine cash/PnL by default; only on-chain account observations are authoritative.

## How to reproduce

```sh
exec riptide run fixtures/scenarios/stablecoin/hedge-loss-magnitude-sweep/run-config.json --adapter fixtures/adapters/stablecoin.toml
```
