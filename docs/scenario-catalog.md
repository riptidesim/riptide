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
| `stablecoin/collateral-cascade-replay` | Collateral Cascade Replay | `stress` | `fixtures/scenarios/stablecoin/collateral-cascade-replay` | `a13abbebbdbd20c7f4e6023e23a397b5e6100346c35f3bfb54dc3c7613a5c58d` | Fixture-local scheduled apply_hedge_loss fires the declared no_hedge_loss_during_healthy_run invariant; the paired replay owns the frozen single-trajectory proof. |
| `stablecoin/hedge-loss-magnitude-sweep` | Hedge Loss Magnitude Sweep | `smoke-shape` | `fixtures/scenarios/stablecoin/hedge-loss-magnitude-sweep` | `7d30598688f866df1f0ddeac8cd9b1d9d48d3fbb65de15819b0369cc22d37198` | apply_hedge_loss is not runtime-dispatchable in the generic primitive. |
| `stablecoin/mint-concentration-sweep` | Mint Concentration Sweep | `smoke-shape` | `fixtures/scenarios/stablecoin/mint-concentration-sweep` | `95bf3734bfb54c6436dcc54d7acdca3a5f0ce14d2510f1ce0377ad08c16a76cc` | stablecoin-fork does not enforce mint caps or top-N mint-share limits; this fixture exercises the deterministic concentration shape only. |
| `stablecoin/redemption-run-sweep` | Redemption Run Sweep | `smoke-shape` | `fixtures/scenarios/stablecoin/redemption-run-sweep` | `cb51ab5341a33db14dae6a6b2f8dd8d8a86ac27888c606ef60cf1d21662a9a27` |  |
| `stablecoin/reserve-buffer-exhaustion-sweep` | Reserve Buffer Exhaustion Sweep | `stress` | `fixtures/scenarios/stablecoin/reserve-buffer-exhaustion-sweep` | `609cb30259b2e9a33234495c33c0378dd573461b0a44bbd0f56c88861a53ac73` | Fixture-local scheduled redeems drain the reserve buffer and fire the declared no_redemption_queue_formation invariant when a queued claim appears. |

## Liquid Staking

| Family | Name | Claim | Fixture | Result hash | Notes |
|---|---|---|---|---|---|
| `liquid-staking/lst-lending-contagion` | LST Lending Contagion | `smoke-shape` | `fixtures/scenarios/liquid-staking/lst-lending-contagion` | `d633b2f4ed3390c6138833ccc683af8e2ce8f57ea59a65219cf7639694b82853` | LST-only stress shape; cross-program contagion lives in the paired replay artifact. |
| `liquid-staking/reserve-refill-lag-sweep` | Reserve Refill Lag Sweep | `smoke-shape` | `fixtures/scenarios/liquid-staking/reserve-refill-lag-sweep` | `551fa63e3ed6c0d2f1796c8e038060e051771b9c72aaaa491669f048f0df88fe` | The LST runtime exposes reserve_buffer but no explicit refill-lag knob; this fixture exercises the deterministic flow shape only. |
| `liquid-staking/slash-magnitude-sweep` | Slash Magnitude Sweep | `smoke-shape` | `fixtures/scenarios/liquid-staking/slash-magnitude-sweep` | `c6a53f6c2f928fc3ada11a6e2d0e77ab56b440821f347c299585155676993277` | apply_slash is not runtime-dispatchable in the generic primitive. |
| `liquid-staking/slash-redemption-cascade` | Slash Redemption Cascade | `smoke-shape` | `fixtures/scenarios/liquid-staking/slash-redemption-cascade` | `6704be9b355292b965dc738c7b696a73c247e6312862120a7bf4415408824be7` | apply_slash is replay-only for this adapter; the committed fixture stages the slash-plus-redemption population shape without a direct slash mutation. |
| `liquid-staking/withdrawal-queue-run-sweep` | Withdrawal Queue Run Sweep | `smoke-shape` | `fixtures/scenarios/liquid-staking/withdrawal-queue-run-sweep` | `4a607ef5e859550a4bb3284e5e20e0e3e26796f4a80acdfcb7472495504e1787` |  |

## Perpetuals

| Family | Name | Claim | Fixture | Result hash | Notes |
|---|---|---|---|---|---|
| `perpetuals/funding-stress` | Funding Stress | `smoke-shape` | `fixtures/scenarios/perpetuals/funding-stress` | `4ba22a50bafa12a900571c2495670d391b40f11cc7dcc2138079b82a715041e7` | Funding and insurance accounting remain proxy-level. |
| `perpetuals/insurance-socialized-loss` | Insurance Socialized Loss | `smoke-shape` | `fixtures/scenarios/perpetuals/insurance-socialized-loss` | `8c47b8ebd6e0a4eed60be0d3243bb165bee2d2ba297bab463ab423748d73c3d0` | perps-lite does not yet model insurance-fund depletion or socialized-loss allocation; this fixture exercises the deterministic shape only. |
| `perpetuals/max-leverage-boundary-sweep` | Max Leverage Boundary Sweep | `smoke-shape` | `fixtures/scenarios/perpetuals/max-leverage-boundary-sweep` | `9be81b41f8b6b87daa2b7a6769733ce488b7895bc442d328f3fb3ecca436bd0f` | perps-lite does not runtime-dispatch open_position from personas; leverage remains a proxy observation in this fixture. |
| `perpetuals/open-interest-skew-squeeze` | Open Interest Skew Squeeze | `smoke-shape` | `fixtures/scenarios/perpetuals/open-interest-skew-squeeze` | `852cc0d00e2378b239e19a0c02f924b209524e1da56a2681ff7587016ae58dbb` | perps-lite does not yet model funding-rate updates; this fixture exercises the deterministic OI-skew shape only. |
| `perpetuals/oracle-shock-liquidation-cascade` | Oracle Shock Liquidation Cascade | `smoke-shape` | `fixtures/scenarios/perpetuals/oracle-shock-liquidation-cascade` | `83abd8077db2dc9f744734afde0e7d5520f5052aa0fe96f4e72a8dda9273e4d9` | The shipping perps adapter has no runtime oracle shock or liquidate_position dispatch; this fixture is the deterministic margin-pressure shape only. |

## AMM

| Family | Name | Claim | Fixture | Result hash | Notes |
|---|---|---|---|---|---|
| `amm/fee-growth-lp-accounting` | Fee Growth LP Accounting | `smoke-shape` | `fixtures/scenarios/amm/fee-growth-lp-accounting` | `0b2c9e4f94eb79e9b92a518b8a55a0433ab15f7f6b140c067c9dfa34f4b03c07` | The shared AMM adapter keeps cumulative_fees at zero under the current amount path; this fixture exercises LP accounting shape only. |
| `amm/jit-liquidity-exit` | JIT Liquidity Exit | `smoke-shape` | `fixtures/scenarios/amm/jit-liquidity-exit` | `d753ad689de2ae0b616d9941b27997a4cf258e14df4907ee88d96daf7ca94e74` | AMM-lite does not model JIT MEV or front-running advantage; this fixture exercises deterministic timing shape only. |
| `amm/price-impact` | Price Impact | `smoke-shape` | `fixtures/scenarios/amm/price-impact` | `5c375fd05174e7e4c3815009e9c18cb44616b991517097fc73446e5b849679d6` | MEV and slippage are not fully modeled. |
| `amm/reserve-depletion-sweep` | Reserve Depletion Sweep | `smoke-shape` | `fixtures/scenarios/amm/reserve-depletion-sweep` | `6726cb355cea393c5fe36eeca97318badd4bd4ce2fedddba54842f1d4c4b3377` | No reserve-floor invariant fires in the cold run; this fixture exercises directional reserve-pressure shape only. |
| `amm/sandwich-volume-spike` | Sandwich Volume Spike | `smoke-shape` | `fixtures/scenarios/amm/sandwich-volume-spike` | `446067fd86eff33d8780fb65f36b0f974c836c3a22d72a9533eb97b326ea78fe` | AMM-lite does not model mempool ordering or frontrun fee extraction; this fixture exercises deterministic volume-spike shape only. |

## Presentation Artifacts

- `fixtures/analysis/lending/hero-grid/` is derived from `lending/whale-shock-grid` and is not a counted scenario family.

