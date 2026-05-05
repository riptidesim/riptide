# Riptide Scenario Family Catalog

Source of truth: `fixtures/scenarios/catalog.toml`.

The public matrix targets a 5x5 catalog: five canonical family slugs for each protocol class. Entries below are sorted by class order, then family slug.

## Matrix

| Class | Count | Target | Families |
|---|---:|---:|---|
| Lending | 5 | 5 | `lending/oracle-lag-baseline`<br>`lending/shock-magnitude-sweep`<br>`lending/utilization-climb`<br>`lending/whale-share-sweep`<br>`lending/whale-shock-grid` |
| Stablecoin | 2 | 5 | `stablecoin/hedge-loss-magnitude-sweep`<br>`stablecoin/redemption-run-sweep` |
| Liquid Staking | 2 | 5 | `liquid-staking/slash-magnitude-sweep`<br>`liquid-staking/withdrawal-queue-run-sweep` |
| Perpetuals | 1 | 5 | `perpetuals/funding-stress` |
| AMM | 1 | 5 | `amm/price-impact` |

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
| `stablecoin/hedge-loss-magnitude-sweep` | Hedge Loss Magnitude Sweep | `smoke-shape` | `fixtures/scenarios/stablecoin/hedge-loss-magnitude-sweep` | `7d30598688f866df1f0ddeac8cd9b1d9d48d3fbb65de15819b0369cc22d37198` | apply_hedge_loss is not runtime-dispatchable in the generic primitive. |
| `stablecoin/redemption-run-sweep` | Redemption Run Sweep | `smoke-shape` | `fixtures/scenarios/stablecoin/redemption-run-sweep` | `cb51ab5341a33db14dae6a6b2f8dd8d8a86ac27888c606ef60cf1d21662a9a27` |  |

## Liquid Staking

| Family | Name | Claim | Fixture | Result hash | Notes |
|---|---|---|---|---|---|
| `liquid-staking/slash-magnitude-sweep` | Slash Magnitude Sweep | `smoke-shape` | `fixtures/scenarios/liquid-staking/slash-magnitude-sweep` | `c6a53f6c2f928fc3ada11a6e2d0e77ab56b440821f347c299585155676993277` | apply_slash is not runtime-dispatchable in the generic primitive. |
| `liquid-staking/withdrawal-queue-run-sweep` | Withdrawal Queue Run Sweep | `smoke-shape` | `fixtures/scenarios/liquid-staking/withdrawal-queue-run-sweep` | `4a607ef5e859550a4bb3284e5e20e0e3e26796f4a80acdfcb7472495504e1787` |  |

## Perpetuals

| Family | Name | Claim | Fixture | Result hash | Notes |
|---|---|---|---|---|---|
| `perpetuals/funding-stress` | Funding Stress | `smoke-shape` | `fixtures/scenarios/perpetuals/funding-stress` | `4ba22a50bafa12a900571c2495670d391b40f11cc7dcc2138079b82a715041e7` | Funding and insurance accounting remain proxy-level. |

## AMM

| Family | Name | Claim | Fixture | Result hash | Notes |
|---|---|---|---|---|---|
| `amm/price-impact` | Price Impact | `smoke-shape` | `fixtures/scenarios/amm/price-impact` | `5c375fd05174e7e4c3815009e9c18cb44616b991517097fc73446e5b849679d6` | MEV and slippage are not fully modeled. |

## Presentation Artifacts

- `fixtures/analysis/lending/hero-grid/` is derived from `lending/whale-shock-grid` and is not a counted scenario family.

