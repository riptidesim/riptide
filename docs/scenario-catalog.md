# Riptide Scenario Family Catalog

Source of truth: `fixtures/scenarios/catalog.toml`.

The public matrix targets a 5x5 catalog: five canonical family slugs for each protocol class. Entries below are sorted by class order, then family slug.

## Matrix

| Class | Count | Target | Families |
|---|---:|---:|---|
| Lending | 5 | 5 | `lending/oracle-lag-baseline`<br>`lending/shock-magnitude-sweep`<br>`lending/utilization-climb`<br>`lending/whale-share-sweep`<br>`lending/whale-shock-grid` |
| Stablecoin | 5 | 5 | `stablecoin/collateral-cascade-replay`<br>`stablecoin/hedge-loss-magnitude-sweep`<br>`stablecoin/mint-concentration-sweep`<br>`stablecoin/redemption-run-sweep`<br>`stablecoin/reserve-buffer-exhaustion-sweep` |
| Liquid Staking | 5 | 5 | `liquid-staking/lst-lending-contagion`<br>`liquid-staking/reserve-refill-lag-sweep`<br>`liquid-staking/slash-magnitude-sweep`<br>`liquid-staking/slash-redemption-cascade`<br>`liquid-staking/withdrawal-queue-run-sweep` |
| Perpetuals | 5 | 5 | `perpetuals/funding-stress`<br>`perpetuals/insurance-socialized-loss`<br>`perpetuals/max-leverage-boundary-sweep`<br>`perpetuals/open-interest-skew-squeeze`<br>`perpetuals/oracle-shock-liquidation-cascade` |
| AMM | 5 | 5 | `amm/fee-growth-lp-accounting`<br>`amm/jit-liquidity-exit`<br>`amm/price-impact`<br>`amm/reserve-depletion-sweep`<br>`amm/sandwich-volume-spike` |

## Claim Levels

- `smoke-shape`: deterministic and runnable; no declared invariant fires, so the fixture exercises shape only.
- `stress`: at least one declared invariant fires under at least one parameter point; no canonical replay artifact yet.
- `failure-shape`: reproduces a failure-shape target with declared invariants firing at named ticks.

## Lending

| Family | Name | Claim | Fixture | Result hash | Notes |
|---|---|---|---|---|---|
| `lending/oracle-lag-baseline` | Oracle Lag Baseline | `smoke-shape` | `fixtures/scenarios/lending/oracle-lag-baseline` | `1ef6e3061bf1d58172c172302a46e2489c147af61c560a28f9186c25e4a2ee68` | No oracle-lag knob is modeled yet; this is the baseline comparison cell. |
| `lending/shock-magnitude-sweep` | Shock Magnitude Sweep | `smoke-shape` | `fixtures/scenarios/lending/shock-magnitude-sweep` | `afcfe40b023fb8b5d127740591ad40b86ea8b3e5f8575b4412095a94e3894646` | The run records bad-debt shape but the committed fixture declares no invariant firing. |
| `lending/utilization-climb` | Utilization Climb | `smoke-shape` | `fixtures/scenarios/lending/utilization-climb` | `073b906af9b3cc4ec1d876f89a8b5a5da3029de5666ee0ac7642517101d679a9` |  |
| `lending/whale-share-sweep` | Whale Share Sweep | `smoke-shape` | `fixtures/scenarios/lending/whale-share-sweep` | `4a285324ca5678f315fdfff643dfa5eac12c46ce41528f24307fa265f70a727d` | The run records bad-debt shape but the committed fixture declares no invariant firing. |
| `lending/whale-shock-grid` | Whale Shock Grid | `smoke-shape` | `fixtures/scenarios/lending/whale-shock-grid` | `60f72adee15451af60f559cdfb9609813b54c34565f7c76fe7e5cf8495a42470` | This is the active post-collapse canary; derived presentation artifacts live outside the counted family tree. |

## Stablecoin

| Family | Name | Claim | Fixture | Result hash | Notes |
|---|---|---|---|---|---|
| `stablecoin/collateral-cascade-replay` | Collateral Cascade Replay | `stress` | `fixtures/scenarios/stablecoin/collateral-cascade-replay` | `696a8640854bee9512651534a8b12a5babd9849e146fa7ecd324e4ba46c21bb5` | Fixture-local scheduled apply_hedge_loss fires the declared no_hedge_loss_during_healthy_run invariant; the paired replay owns the frozen single-trajectory proof. |
| `stablecoin/hedge-loss-magnitude-sweep` | Hedge Loss Magnitude Sweep | `smoke-shape` | `fixtures/scenarios/stablecoin/hedge-loss-magnitude-sweep` | `7d30598688f866df1f0ddeac8cd9b1d9d48d3fbb65de15819b0369cc22d37198` | apply_hedge_loss is not runtime-dispatchable in the generic primitive. |
| `stablecoin/mint-concentration-sweep` | Mint Concentration Sweep | `smoke-shape` | `fixtures/scenarios/stablecoin/mint-concentration-sweep` | `8a724206ffc7fc0f954320ac76585c55b45d6af103a01cd7e11ffc295edd0774` | stablecoin-fork does not enforce mint caps or top-N mint-share limits; this fixture exercises the deterministic concentration shape only. |
| `stablecoin/redemption-run-sweep` | Redemption Run Sweep | `smoke-shape` | `fixtures/scenarios/stablecoin/redemption-run-sweep` | `cb51ab5341a33db14dae6a6b2f8dd8d8a86ac27888c606ef60cf1d21662a9a27` |  |
| `stablecoin/reserve-buffer-exhaustion-sweep` | Reserve Buffer Exhaustion Sweep | `stress` | `fixtures/scenarios/stablecoin/reserve-buffer-exhaustion-sweep` | `bb49c50d9323440c6d7a6d95961d336e0edab2038d4fd15151c52a379e500531` | Fixture-local scheduled redeems drain the reserve buffer and fire the declared no_redemption_queue_formation invariant when a queued claim appears. |

## Liquid Staking

| Family | Name | Claim | Fixture | Result hash | Notes |
|---|---|---|---|---|---|
| `liquid-staking/lst-lending-contagion` | LST Lending Contagion | `smoke-shape` | `fixtures/scenarios/liquid-staking/lst-lending-contagion` | `3ff135f4e26ce3e3cc6c57d120a41be535a5eb20b831596016486f13ed29c693` | LST-only stress shape; cross-program contagion lives in the paired replay artifact. |
| `liquid-staking/reserve-refill-lag-sweep` | Reserve Refill Lag Sweep | `smoke-shape` | `fixtures/scenarios/liquid-staking/reserve-refill-lag-sweep` | `5064414fc99fda634c1df2c9db144510c9a006ba660d6984b7a76eec3c538eb0` | The LST runtime exposes reserve_buffer but no explicit refill-lag knob; this fixture exercises the deterministic flow shape only. |
| `liquid-staking/slash-magnitude-sweep` | Slash Magnitude Sweep | `smoke-shape` | `fixtures/scenarios/liquid-staking/slash-magnitude-sweep` | `c6a53f6c2f928fc3ada11a6e2d0e77ab56b440821f347c299585155676993277` | apply_slash is not runtime-dispatchable in the generic primitive. |
| `liquid-staking/slash-redemption-cascade` | Slash Redemption Cascade | `smoke-shape` | `fixtures/scenarios/liquid-staking/slash-redemption-cascade` | `1db82eff106b261040f6d75b90605ce880d603a036c7a3e4f5fac0ed79a384a5` | apply_slash is replay-only for this adapter; the committed fixture stages the slash-plus-redemption population shape without a direct slash mutation. |
| `liquid-staking/withdrawal-queue-run-sweep` | Withdrawal Queue Run Sweep | `smoke-shape` | `fixtures/scenarios/liquid-staking/withdrawal-queue-run-sweep` | `4a607ef5e859550a4bb3284e5e20e0e3e26796f4a80acdfcb7472495504e1787` |  |

## Perpetuals

| Family | Name | Claim | Fixture | Result hash | Notes |
|---|---|---|---|---|---|
| `perpetuals/funding-stress` | Funding Stress | `smoke-shape` | `fixtures/scenarios/perpetuals/funding-stress` | `4ba22a50bafa12a900571c2495670d391b40f11cc7dcc2138079b82a715041e7` | Funding and insurance accounting remain proxy-level. |
| `perpetuals/insurance-socialized-loss` | Insurance Socialized Loss | `smoke-shape` | `fixtures/scenarios/perpetuals/insurance-socialized-loss` | `d2a313de921d1cce3ae8d595175bac6beb1aeae385bb8fa8114138a98392c50d` | perps-lite does not yet model insurance-fund depletion or socialized-loss allocation; this fixture exercises the deterministic shape only. |
| `perpetuals/max-leverage-boundary-sweep` | Max Leverage Boundary Sweep | `smoke-shape` | `fixtures/scenarios/perpetuals/max-leverage-boundary-sweep` | `770d539788acb3688c6fe85be5ff5e2801c4285fbaa21d253b92bbd860b8d565` | perps-lite does not runtime-dispatch open_position from personas; leverage remains a proxy observation in this fixture. |
| `perpetuals/open-interest-skew-squeeze` | Open Interest Skew Squeeze | `smoke-shape` | `fixtures/scenarios/perpetuals/open-interest-skew-squeeze` | `90d1132d28665834ff0a23a000686299421fe0140f75c713467787166e573d8d` | perps-lite does not yet model funding-rate updates; this fixture exercises the deterministic OI-skew shape only. |
| `perpetuals/oracle-shock-liquidation-cascade` | Oracle Shock Liquidation Cascade | `smoke-shape` | `fixtures/scenarios/perpetuals/oracle-shock-liquidation-cascade` | `314443c6cf722b50508a6dd4c4f1c4cb55a7253fbb4f2b420269693b1042a218` | The shipping perps adapter has no runtime oracle shock or liquidate_position dispatch; this fixture is the deterministic margin-pressure shape only. |

## AMM

| Family | Name | Claim | Fixture | Result hash | Notes |
|---|---|---|---|---|---|
| `amm/fee-growth-lp-accounting` | Fee Growth LP Accounting | `smoke-shape` | `fixtures/scenarios/amm/fee-growth-lp-accounting` | `1f10e0ea42af88a9fd5f0e484928ca1ff6ddea6bc3ccf30c43e035a26e447818` | The shared AMM adapter keeps cumulative_fees at zero under the current amount path; this fixture exercises LP accounting shape only. |
| `amm/jit-liquidity-exit` | JIT Liquidity Exit | `smoke-shape` | `fixtures/scenarios/amm/jit-liquidity-exit` | `8bfe9500ec000978542f57c218c5d4a959ad75293ad117729cc779c40fadcac8` | AMM-lite does not model JIT MEV or front-running advantage; this fixture exercises deterministic timing shape only. |
| `amm/price-impact` | Price Impact | `smoke-shape` | `fixtures/scenarios/amm/price-impact` | `5c375fd05174e7e4c3815009e9c18cb44616b991517097fc73446e5b849679d6` | MEV and slippage are not fully modeled. |
| `amm/reserve-depletion-sweep` | Reserve Depletion Sweep | `smoke-shape` | `fixtures/scenarios/amm/reserve-depletion-sweep` | `4ff739559534e55f7557584bd17228a6d9b757a81e3dc47e3eab6eb81160a327` | No reserve-floor invariant fires in the cold run; this fixture exercises directional reserve-pressure shape only. |
| `amm/sandwich-volume-spike` | Sandwich Volume Spike | `smoke-shape` | `fixtures/scenarios/amm/sandwich-volume-spike` | `8ef7e8815fb79405dcb42c8b7c4dacbf3ed2da96724b180476be07f4dfec77a0` | AMM-lite does not model mempool ordering or frontrun fee extraction; this fixture exercises deterministic volume-spike shape only. |

## Presentation Artifacts

- `fixtures/analysis/lending/hero-grid/` is derived from `lending/whale-shock-grid` and is not a counted scenario family.

