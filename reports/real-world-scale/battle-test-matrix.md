# Sprint 34 Phase 2 Battle-Test Matrix

Captured: 2026-05-13

This matrix defines the first real-world/prod-adjacent battle-test boundary
before execution. Verdicts use the hard vocabulary `runs`, `blocked`,
`needs-feature`, and `out-of-scope`.

`runs` means the local artifact set is expected to execute through a declared
Riptide path during T04. It is not a claim that Riptide supports the live
protocol. Live/prod-adjacent work is limited to public source, local IDL/SBF
artifacts, local `.riptide` workspaces, committed fixtures, and local
simulation/review output. No row authorizes private keys, deployments, RPC
writes, account mutation, publishing, or audit-equivalent wording.

## Verdict Vocabulary

| Verdict | Meaning |
| --- | --- |
| `runs` | T04 should run a concrete local command path end to end and capture stdout. |
| `blocked` | T04 should capture the exact repo artifact/setup blocker without forcing the row green. |
| `needs-feature` | Local artifacts may exist, but the honest next step is a missing Riptide primitive. |
| `out-of-scope` | The row is known but intentionally not a Sprint 34 Phase 2 execution target. |

## Target Matrix

| Target | Repo | Live/prod-adjacent rationale | Local artifact availability | Expected Riptide path | Expected blocker | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| Raydium CP-Swap local slice | `/home/ailton/Work/riptide/case-studies/raydium-cp-swap` | Public Raydium CP-Swap AMM code with a local adapter targeting `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C`. This is prod-adjacent source/artifact evidence only. | `.riptide/adapters/raydium-cp-swap.toml`, `.riptide/scenarios/swap-pressure/run-config.json`, `.riptide/campaigns/raydium-cp-swap-smoke.campaign.toml`, `.riptide/harness`, `target/idl/raydium_cp_swap.json`, and `target/deploy/raydium_cp_swap.so` are present. | `doctor`, `readiness`, `lint`, `run` with harness, `campaign validate`, `campaign plan`, bounded `campaign run`, and `review` of generated artifacts. | None expected for the local generic SBF/IDL smoke path. Missing semantic AMM coverage remains a claim boundary, not an execution blocker. | `runs` |
| Anchor Uniswap V2 control | `/home/ailton/Work/riptide/case-studies/anchor-uniswap-v2` | Public AMM sample/control workspace used in earlier guided-sim evidence. Useful as an AMM comparison target. | `target/idl/ammv2.json`, `target/deploy/ammv2.so`, and `.riptide/adapters/ammv2.toml` are present. Current `.riptide` guided/campaign artifacts are deleted or absent in the live sibling checkout. | `readiness` and `lint` only unless the missing guided/campaign artifacts are restored by a later owner. | Repo-artifact blocker: the adapter is still a thin TODO bootstrap with no accounts/actions/personas, and the live sibling checkout has pre-existing `.riptide` deletions. | `blocked` |
| Committed lending campaign and replay controls | `/home/ailton/Work/riptide/riptide` | Stable committed Solend-shaped lending fixtures and replay packs prove Riptide's bundled path without relying on a dirty sibling lending checkout. | `fixtures/campaigns/lending/solend-shape-liquidation-safety/campaign.toml`, `examples/configs/safe.json`, `fixtures/adapters/lending.toml`, and `fixtures/replays/lst-lending-contagion-proof/config.json` are present. | `doctor`, `run`, `campaign run --max-runs`, `replay`, hash assertion, and `review`. | `review` of proof packs may intentionally exit 1 when provenance/proof metadata is absent; capture exact output instead of treating it as support failure. | `runs` |
| Mango V4 external adapter candidate | `/home/ailton/Work/riptide/case-studies/mango-v4` | Public production DeFi perps/margin codebase; high-value external target. | `.riptide/adapters/mango-v4.toml`, `.riptide/scenarios/*`, `.riptide/campaigns/mango-v4-broad-perps.campaign.toml`, `.riptide/harness`, `mango_v4.json`, `target/deploy/mango_v4.so`, and prior run/campaign evidence are present in the live sibling checkout. | `readiness`, `lint`, direct `run` with harness, bounded `campaign run`, and campaign `review`. | No T04 execution blocker for the bounded local slice. Boundary: the validated slice constrains market state and does not claim order placement, matched fills, funding accrual, PnL settlement, bankruptcy, or liquidation coverage. | `runs` |
| Whirlpool CLMM external adapter candidate | `/home/ailton/Work/riptide/case-studies/whirlpools` | Public CLMM/AMM codebase; useful to pressure AMM/CLMM adapter breadth. | `.riptide/adapters/whirlpool.toml`, `.riptide/scenarios/*`, `.riptide/campaigns/whirlpool-amm-broad.campaign.toml`, `.riptide/harness`, `target/idl/whirlpool.json`, `target/deploy/whirlpool.so`, and prior run/campaign evidence are present. | `readiness`, `lint`, direct `run` with harness, bounded `campaign run`, and campaign `review`. | No T04 execution blocker for the bounded local slice. Boundary: pool creation, position opening, NFT metadata, token-2022, rewards, and two-hop routing stay outside the repeatable slice. | `runs` |
| Drift protocol-v2 external adapter candidate | `/home/ailton/Work/riptide/case-studies/protocol-v2` | Public production Drift perps codebase; high-value future external target. | `.riptide/adapters/drift.toml`, scenarios, campaign input, `sdk/src/idl/drift.json`, and `target/deploy/drift.so` are present. | `readiness` and `lint` blocker capture. | Repo-artifact/setup blocker: lint passes, but readiness reports existing run evidence without passing state movement and no `.riptide/harness`; the next action is scenario/persona/adapter dispatch or harness work. | `blocked` |
| SPL selected target candidate | `/home/ailton/Work/riptide/case-studies/solana-program-library` | Public Solana program corpus; current slice targets classic SPL Token transfer only. | `.riptide/adapters/solana-program-library.toml`, SPL token campaign/scenarios, `target/deploy/spl_token.so`, and `target/idl/spl_token.json` are present; no harness and no adapter `[lineage]` block. | `readiness` and `lint` static evidence only in Phase 2. | Repo-artifact/evidence blocker for stronger claims: readiness is partial because no harness is discovered; lint passes semantics but skips machine lineage validation. | `blocked` |
| Stablecoin protocol candidate | `/home/ailton/Work/riptide/case-studies/stablecoin-protocol` | Stablecoin protocol shape is relevant to risk simulation breadth. | `.riptide/adapters/stablecoin.toml`, `.riptide/scenarios/*`, `.riptide/campaigns/stablecoin-broad.campaign.toml`, `.riptide/harness`, `target/idl/stablecoin.json`, `target/deploy/stablecoin.so`, and prior run/campaign evidence are present. | `readiness` and `lint` in Phase 2; direct execution is deferred behind the bounded first execution cut. | No static blocker observed. Boundary: readiness/lint only in this phase; vault, liquidation, flash-mint, oracle, governance, and emergency shutdown are outside the current repeatable PSM slice. | `out-of-scope` |
| Liquid staking candidates | `/home/ailton/Work/riptide/case-studies/liquid-staking-program` and `/home/ailton/Work/riptide/case-studies/marinade-liquid-stake-fork` | Liquid staking risk is central to the bundled LST contagion replay family and future external coverage. | Both local workspaces now have valid adapters, campaigns, harnesses, run collections, and semantic `lst.v1` readiness evidence. `liquid-staking-program` uses `.riptide/idl/marinade_finance.source-derived.json`; the fork uses `target/idl/marinade_forking_smart_contract.json`. | `readiness` and `lint` in Phase 2; direct execution is deferred behind the bounded first execution cut. | No static blocker observed for the bounded slices. Boundary: full stake-account, validator-management, admin, delayed-unstake completion, and multi-step crank coverage remain outside the current repeatable slices. | `out-of-scope` |
| Perpetuals external adapter candidate | `/home/ailton/Work/riptide/case-studies/perpetuals` | Public/prod-adjacent perps-style target for later breadth. | `.riptide/adapters/perpetuals.toml`, `.riptide/scenarios/*`, `.riptide/campaigns/perpetuals-broad.campaign.toml`, `.riptide/harness`, `.riptide/idl/perpetuals.json`, `target/deploy/perpetuals.so`, and prior run/campaign evidence are present. | `readiness` and `lint` in Phase 2; direct execution is deferred behind the bounded first execution cut. | No static blocker observed for the bounded collateral slice. Boundary: liquidation, collateral removal, open-position lifecycle, and adverse oracle trajectories remain future work. | `out-of-scope` |
| Dynamic current-state imports for live pools | Any live Raydium/Drift/Mango/Whirlpool mainnet pool/account set | Useful future proof of production-adjacent state replay. | No captured account pack is part of this Phase 2 target set. | None in Phase 2. | Missing Riptide primitive/evidence boundary: current-state `pack-state` coverage and account-group mapping are not part of this phase. | `needs-feature` |

## T04 Execution Cut

T04 should execute the `runs` rows first, then capture blocker evidence for a
small representative set of `blocked` rows. The execution report must separate:

- repo-artifact blockers: missing IDL, missing SBF, incomplete adapter mapping,
  deleted/absent `.riptide` guided or campaign artifacts, missing mocks.
- missing Riptide primitives: current-state pack coverage, dynamic account
  groups, transaction-template actions, or deeper semantic class support.

Any generated target artifacts are allowed only when the command intentionally
writes them under a declared output root. Sibling case-study dirty state must be
preserved and documented rather than normalized.
