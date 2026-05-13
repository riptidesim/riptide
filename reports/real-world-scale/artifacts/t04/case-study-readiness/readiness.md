# Riptide Case-Study Corpus Readiness

- Schema: case-study-readiness.v1
- Generated at: 1970-01-01T00:00:00.000Z (fixed for deterministic diffs)
- Case-study root: /home/ailton/Work/riptide/case-studies
- Repositories inspected: 13
- Verdict summary: blocked=6, pass=6, warn=1
- Launch claim summary: blocked=6, readiness-only=7

This report inventories local case-study workspaces and runs static readiness inspection. Dynamic validation gates remain explicit command results and do not upgrade a launch claim unless they have been executed.

## Gate Contract

| Gate | Default | Contract | Command shape |
|------|---------|----------|---------------|
| inventory-only | yes | Discover immediate child repositories under the case-study root that contain a .riptide workspace. | `find <case-studies-root> -maxdepth 2 -type d -name .riptide \| sort` |
| static-health | yes | Run readiness inspection without building, fetching, or executing simulations. | `riptide readiness <repo> --json` |
| adapter-lint | no | Run static adapter lint against the repo-local adapter TOML and its declared lineage. | `riptide lint <adapter>` |
| direct-baseline-run | no | Run a repo-local baseline run-config through riptide run with the repo-local adapter. | `riptide run <run-config> --adapter <adapter>` |
| guided-sim-run-review | no | Run a repo-local guided simulation manifest and review the produced guided artifact. | `riptide sim run <manifest> --out <artifact-dir>; riptide sim review <artifact-dir>` |
| campaign-validate-plan-run | no | Validate, plan, execute, and review a repo-local campaign input without inferring campaign readiness from static files alone. | `riptide campaign validate <campaign>; riptide campaign plan <campaign>; riptide campaign run <campaign>` |
| fresh-clone-eligibility | no | Confirm the public install and smoke path from a clean clone before making launch claims. | `git clone <repo> /tmp/riptide-fresh-clone; ./install.sh; riptide --help; riptide readiness <case-study>` |

## Verdicts

| Verdict | Meaning |
|---------|---------|
| pass | The gate executed and met the contract with no blocker. |
| warn | The gate executed and produced useful evidence, but a bounded caveat remains. |
| fail | The gate executed and found a concrete validation failure. |
| skipped | The gate was not executed in this report, or the surface is not applicable to this repo. |
| blocked | The gate could not run honestly until a prerequisite or local artifact is supplied. |

## Launch Claim Levels

| Claim level | Meaning |
|-------------|---------|
| demo-ready | Fresh static checks plus rerunnable direct or guided evidence support a live demo boundary. |
| beta-ready | Static checks and at least one executed validation gate support cautious external testing, but not a launch demo claim. |
| readiness-only | The repo is inventory/readiness evidence only until adapter lint or execution gates are run. |
| blocked | The repo lacks a required local prerequisite or has a blocker that prevents honest readiness evidence. |

## Corpus Matrix

| Repo | Verdict | Claim | Support | Adapters | Scenarios | Guided sim | Campaigns | Run evidence | Next action |
|------|---------|-------|---------|----------|-----------|------------|-----------|--------------|-------------|
| amm | blocked | blocked | L1 (blocked) | 1 | 0 | 0 | 0 | 0 | Add or point readiness at local Anchor/Rust program sources, target/idl JSON, or target/deploy SBF artifacts. |
| anchor-uniswap-v2 | blocked | blocked | L3 (blocked) | 1 | 0 | 0 | 0 | 0 | Run a smoke scenario and keep .riptide/run-collection.json plus scenario artifacts in the workspace. |
| liquid-staking-program | pass | readiness-only | L7 (ready) | 1 | 5 | 0 | 1 | 2 | Record the inspected support level and evidence paths in readiness documentation. |
| mango-v4 | pass | readiness-only | L7 (ready) | 1 | 5 | 0 | 1 | 2 | Record the inspected support level and evidence paths in readiness documentation. |
| marinade-liquid-stake-fork | pass | readiness-only | L7 (ready) | 1 | 5 | 0 | 1 | 2 | Record the inspected support level and evidence paths in readiness documentation. |
| perp_smith | blocked | blocked | L3 (blocked) | 1 | 1 | 0 | 1 | 2 | Adjust the scenario, personas, or adapter dispatch so the run produces a passing state_movement coverage check. |
| perpetuals | pass | readiness-only | L7 (ready) | 1 | 5 | 0 | 1 | 2 | Record the inspected support level and evidence paths in readiness documentation. |
| protocol-v2 | blocked | blocked | L3 (blocked) | 1 | 4 | 0 | 1 | 2 | Adjust the scenario, personas, or adapter dispatch so the run produces a passing state_movement coverage check. |
| raydium-cp-swap | blocked | blocked | L4 (blocked) | 1 | 1 | 0 | 1 | 2 | Add a [semantics] block using the existing amm.v1 core class and rerun until semantics_evaluated passes. |
| solana-perpetual-dex-smart-contract | blocked | blocked | L4 (blocked) | 1 | 1 | 0 | 1 | 2 | Add a [semantics] block using the existing perps-margin.v1 core class and rerun until semantics_evaluated passes. |
| solana-program-library | warn | readiness-only | L7 (partial) | 1 | 5 | 0 | 1 | 2 | Record the inspected support level and evidence paths in readiness documentation. |
| stablecoin-protocol | pass | readiness-only | L7 (ready) | 1 | 5 | 0 | 1 | 2 | Record the inspected support level and evidence paths in readiness documentation. |
| whirlpools | pass | readiness-only | L7 (ready) | 1 | 5 | 0 | 1 | 2 | Record the inspected support level and evidence paths in readiness documentation. |

## Row Details

### amm

- Path: /home/ailton/Work/riptide/case-studies/amm
- Verdict: blocked
- Launch claim: blocked
- Support: L1 (blocked)
- Blocker: missing-build-or-program-artifacts: No Anchor, Rust program source, IDL, or SBF artifact was discovered yet. This means adapter work has no local program surface to bind to.
- Next action: Add or point readiness at local Anchor/Rust program sources, target/idl JSON, or target/deploy SBF artifacts.
- Missing surfaces: campaigns, guided_sim_manifests, last_run, run_collections, scenarios
- Artifacts: none

| Gate | Executed | Verdict | Artifacts | Next action |
|------|----------|---------|-----------|-------------|
| inventory-only | yes | pass | .riptide | Record the repo in the corpus matrix. |
| static-health | yes | blocked | .riptide, .riptide/adapters/amm.toml, /home/ailton/Work/riptide/case-studies/amm | Add or point readiness at local Anchor/Rust program sources, target/idl JSON, or target/deploy SBF artifacts. |
| adapter-lint | no | skipped | .riptide/adapters/amm.toml | Run adapter lint in the validation lane before upgrading the launch claim. |
| direct-baseline-run | no | skipped | .riptide/adapters/amm.toml | Add a baseline run-config and adapter before attempting a direct baseline run. |
| guided-sim-run-review | no | skipped | none | No guided-sim manifest is present; keep this gate skipped unless guided support is added. |
| campaign-validate-plan-run | no | skipped | none | No campaign input is present; keep this gate skipped unless a campaign is added. |
| fresh-clone-eligibility | no | skipped | none | Run the fresh-clone evaluator path before using the corpus report as promotional launch evidence. |

### anchor-uniswap-v2

- Path: /home/ailton/Work/riptide/case-studies/anchor-uniswap-v2
- Verdict: blocked
- Launch claim: blocked
- Support: L3 (blocked)
- Blocker: adapter-without-run-evidence: An adapter exists, but no run collection or last-run evidence was discovered. This is not yet E2E support.
- Next action: Run a smoke scenario and keep .riptide/run-collection.json plus scenario artifacts in the workspace.
- Missing surfaces: campaigns, guided_sim_manifests, last_run, run_collections, scenarios
- Artifacts: none

| Gate | Executed | Verdict | Artifacts | Next action |
|------|----------|---------|-----------|-------------|
| inventory-only | yes | pass | .riptide | Record the repo in the corpus matrix. |
| static-health | yes | blocked | .riptide, .riptide/adapters/ammv2.toml, /home/ailton/Work/riptide/case-studies/anchor-uniswap-v2, Anchor.toml, ... (+9 more) | Run a smoke scenario and keep .riptide/run-collection.json plus scenario artifacts in the workspace. |
| adapter-lint | no | skipped | .riptide/adapters/ammv2.toml | Run adapter lint in the validation lane before upgrading the launch claim. |
| direct-baseline-run | no | skipped | .riptide/adapters/ammv2.toml | Add a baseline run-config and adapter before attempting a direct baseline run. |
| guided-sim-run-review | no | skipped | none | No guided-sim manifest is present; keep this gate skipped unless guided support is added. |
| campaign-validate-plan-run | no | skipped | none | No campaign input is present; keep this gate skipped unless a campaign is added. |
| fresh-clone-eligibility | no | skipped | none | Run the fresh-clone evaluator path before using the corpus report as promotional launch evidence. |

### liquid-staking-program

- Path: /home/ailton/Work/riptide/case-studies/liquid-staking-program
- Verdict: pass
- Launch claim: readiness-only
- Support: L7 (ready)
- Blocker: none
- Next action: Record the inspected support level and evidence paths in readiness documentation.
- Missing surfaces: guided_sim_manifests
- Artifacts: .riptide/campaigns/campaign_7df6a9007e6b/runs/run_000000_913b346c7856/report.md, .riptide/campaigns/campaign_7df6a9007e6b/runs/run_000001_0670e52aadb9/report.md, .riptide/campaigns/campaign_7df6a9007e6b/runs/run_000002_f053539fd8cb/report.md, .riptide/campaigns/campaign_7df6a9007e6b/runs/run_000003_1cef918e9c30/report.md, ... (+121 more)

| Gate | Executed | Verdict | Artifacts | Next action |
|------|----------|---------|-----------|-------------|
| inventory-only | yes | pass | .riptide | Record the repo in the corpus matrix. |
| static-health | yes | pass | .riptide, .riptide/adapters/marinade-finance.toml, .riptide/campaigns/marinade-liquid-staking-broad.campaign.toml, .riptide/idl/marinade_finance.source-derived.json, ... (+56 more) | Record the inspected support level and evidence paths in readiness documentation. |
| adapter-lint | no | skipped | .riptide/adapters/marinade-finance.toml | Run adapter lint in the validation lane before upgrading the launch claim. |
| direct-baseline-run | no | skipped | .riptide/adapters/marinade-finance.toml, .riptide/scenarios/delayed-withdrawal-queue/run-config.json | Run the baseline scenario from a fresh shell before claiming direct execution support. |
| guided-sim-run-review | no | skipped | none | No guided-sim manifest is present; keep this gate skipped unless guided support is added. |
| campaign-validate-plan-run | no | skipped | .riptide/campaigns/marinade-liquid-staking-broad.campaign.toml | Run campaign validate, plan, and run before claiming campaign execution support. |
| fresh-clone-eligibility | no | skipped | none | Run the fresh-clone evaluator path before using the corpus report as promotional launch evidence. |

### mango-v4

- Path: /home/ailton/Work/riptide/case-studies/mango-v4
- Verdict: pass
- Launch claim: readiness-only
- Support: L7 (ready)
- Blocker: none
- Next action: Record the inspected support level and evidence paths in readiness documentation.
- Missing surfaces: guided_sim_manifests
- Artifacts: .riptide/campaigns/campaign_26ed10054503/runs/run_000000_44713dd4efda/report.md, .riptide/campaigns/campaign_26ed10054503/runs/run_000001_4b92df2fcc69/report.md, .riptide/campaigns/campaign_26ed10054503/runs/run_000002_695eebcd82e0/report.md, .riptide/campaigns/campaign_26ed10054503/runs/run_000003_f866846a93ca/report.md, ... (+119 more)

| Gate | Executed | Verdict | Artifacts | Next action |
|------|----------|---------|-----------|-------------|
| inventory-only | yes | pass | .riptide | Record the repo in the corpus matrix. |
| static-health | yes | pass | .riptide, .riptide/adapters/mango-v4.toml, .riptide/campaigns/mango-v4-broad-perps.campaign.toml, .riptide/run-collection.json, ... (+204 more) | Record the inspected support level and evidence paths in readiness documentation. |
| adapter-lint | no | skipped | .riptide/adapters/mango-v4.toml | Run adapter lint in the validation lane before upgrading the launch claim. |
| direct-baseline-run | no | skipped | .riptide/adapters/mango-v4.toml, .riptide/scenarios/collateral-turnover/run-config.json | Run the baseline scenario from a fresh shell before claiming direct execution support. |
| guided-sim-run-review | no | skipped | none | No guided-sim manifest is present; keep this gate skipped unless guided support is added. |
| campaign-validate-plan-run | no | skipped | .riptide/campaigns/mango-v4-broad-perps.campaign.toml | Run campaign validate, plan, and run before claiming campaign execution support. |
| fresh-clone-eligibility | no | skipped | none | Run the fresh-clone evaluator path before using the corpus report as promotional launch evidence. |

### marinade-liquid-stake-fork

- Path: /home/ailton/Work/riptide/case-studies/marinade-liquid-stake-fork
- Verdict: pass
- Launch claim: readiness-only
- Support: L7 (ready)
- Blocker: none
- Next action: Record the inspected support level and evidence paths in readiness documentation.
- Missing surfaces: guided_sim_manifests
- Artifacts: .riptide/campaigns/campaign_12d188fb5fff/runs/run_000000_b11b5e699033/report.md, .riptide/campaigns/campaign_12d188fb5fff/runs/run_000001_fcf62062476d/report.md, .riptide/campaigns/campaign_12d188fb5fff/runs/run_000002_52990c855a70/report.md, .riptide/campaigns/campaign_12d188fb5fff/runs/run_000003_f7ddf9d0f1d9/report.md, ... (+119 more)

| Gate | Executed | Verdict | Artifacts | Next action |
|------|----------|---------|-----------|-------------|
| inventory-only | yes | pass | .riptide | Record the repo in the corpus matrix. |
| static-health | yes | pass | .riptide, .riptide/adapters/marinade-forking-smart-contract.toml, .riptide/campaigns/liquid-staking-broad.campaign.toml, .riptide/run-collection.json, ... (+55 more) | Record the inspected support level and evidence paths in readiness documentation. |
| adapter-lint | no | skipped | .riptide/adapters/marinade-forking-smart-contract.toml | Run adapter lint in the validation lane before upgrading the launch claim. |
| direct-baseline-run | no | skipped | .riptide/adapters/marinade-forking-smart-contract.toml, .riptide/scenarios/delayed-unstake-queue/run-config.json | Run the baseline scenario from a fresh shell before claiming direct execution support. |
| guided-sim-run-review | no | skipped | none | No guided-sim manifest is present; keep this gate skipped unless guided support is added. |
| campaign-validate-plan-run | no | skipped | .riptide/campaigns/liquid-staking-broad.campaign.toml | Run campaign validate, plan, and run before claiming campaign execution support. |
| fresh-clone-eligibility | no | skipped | none | Run the fresh-clone evaluator path before using the corpus report as promotional launch evidence. |

### perp_smith

- Path: /home/ailton/Work/riptide/case-studies/perp_smith
- Verdict: blocked
- Launch claim: blocked
- Support: L3 (blocked)
- Blocker: run-without-state-movement: Run collection .riptide/run-collection.json exists, but no passing state-movement check was observed. A passing run with no state movement is not meaningful economic stress evidence yet.
- Next action: Adjust the scenario, personas, or adapter dispatch so the run produces a passing state_movement coverage check.
- Missing surfaces: guided_sim_manifests
- Artifacts: .riptide/campaigns/campaign_865f1c38764c/runs/run_000000_0ca537e5e4e6/report.md, .riptide/campaigns/campaign_865f1c38764c/runs/run_000001_db92fd3889a7/report.md, .riptide/campaigns/campaign_865f1c38764c/runs/run_000002_25ac91f9556a/report.md, .riptide/campaigns/campaign_865f1c38764c/runs/run_000003_c13b4f1d3ff9/report.md, ... (+57 more)

| Gate | Executed | Verdict | Artifacts | Next action |
|------|----------|---------|-----------|-------------|
| inventory-only | yes | pass | .riptide | Record the repo in the corpus matrix. |
| static-health | yes | blocked | .riptide, .riptide/adapters/eterna.toml, .riptide/campaigns/eterna-funding-smoke.campaign.toml, .riptide/run-collection.json, ... (+34 more) | Adjust the scenario, personas, or adapter dispatch so the run produces a passing state_movement coverage check. |
| adapter-lint | no | skipped | .riptide/adapters/eterna.toml | Run adapter lint in the validation lane before upgrading the launch claim. |
| direct-baseline-run | no | skipped | .riptide/adapters/eterna.toml, .riptide/scenarios/funding-settlement/run-config.json | Run the baseline scenario from a fresh shell before claiming direct execution support. |
| guided-sim-run-review | no | skipped | none | No guided-sim manifest is present; keep this gate skipped unless guided support is added. |
| campaign-validate-plan-run | no | skipped | .riptide/campaigns/eterna-funding-smoke.campaign.toml | Run campaign validate, plan, and run before claiming campaign execution support. |
| fresh-clone-eligibility | no | skipped | none | Run the fresh-clone evaluator path before using the corpus report as promotional launch evidence. |

### perpetuals

- Path: /home/ailton/Work/riptide/case-studies/perpetuals
- Verdict: pass
- Launch claim: readiness-only
- Support: L7 (ready)
- Blocker: none
- Next action: Record the inspected support level and evidence paths in readiness documentation.
- Missing surfaces: guided_sim_manifests
- Artifacts: .riptide/campaigns/campaign_f972ee1c6cba/runs/run_000000_3578260e704f/report.md, .riptide/campaigns/campaign_f972ee1c6cba/runs/run_000001_99710cea19db/report.md, .riptide/campaigns/campaign_f972ee1c6cba/runs/run_000002_67f102800246/report.md, .riptide/campaigns/campaign_f972ee1c6cba/runs/run_000003_a619e5b51f09/report.md, ... (+160 more)

| Gate | Executed | Verdict | Artifacts | Next action |
|------|----------|---------|-----------|-------------|
| inventory-only | yes | pass | .riptide | Record the repo in the corpus matrix. |
| static-health | yes | pass | .riptide, .riptide/adapters/perpetuals.toml, .riptide/campaigns/perpetuals-broad.campaign.toml, .riptide/idl/perpetuals.json, ... (+50 more) | Record the inspected support level and evidence paths in readiness documentation. |
| adapter-lint | no | skipped | .riptide/adapters/perpetuals.toml | Run adapter lint in the validation lane before upgrading the launch claim. |
| direct-baseline-run | no | skipped | .riptide/adapters/perpetuals.toml, .riptide/scenarios/baseline/run-config.json | Run the baseline scenario from a fresh shell before claiming direct execution support. |
| guided-sim-run-review | no | skipped | none | No guided-sim manifest is present; keep this gate skipped unless guided support is added. |
| campaign-validate-plan-run | no | skipped | .riptide/campaigns/perpetuals-broad.campaign.toml | Run campaign validate, plan, and run before claiming campaign execution support. |
| fresh-clone-eligibility | no | skipped | none | Run the fresh-clone evaluator path before using the corpus report as promotional launch evidence. |

### protocol-v2

- Path: /home/ailton/Work/riptide/case-studies/protocol-v2
- Verdict: blocked
- Launch claim: blocked
- Support: L3 (blocked)
- Blocker: run-without-state-movement: Run collection .riptide/run-collection.json exists, but no passing state-movement check was observed. A passing run with no state movement is not meaningful economic stress evidence yet.
- Next action: Adjust the scenario, personas, or adapter dispatch so the run produces a passing state_movement coverage check.
- Missing surfaces: guided_sim_manifests
- Artifacts: .riptide/campaigns/campaign_d1a0740da32c/runs/run_000000_4b5bddebe78b/report.md, .riptide/campaigns/campaign_d1a0740da32c/runs/run_000001_c899dbb0f1ba/report.md, .riptide/campaigns/campaign_d1a0740da32c/runs/run_000002_0de11bf67560/report.md, .riptide/campaigns/campaign_d1a0740da32c/runs/run_000003_de7923a2fe8c/report.md, ... (+118 more)

| Gate | Executed | Verdict | Artifacts | Next action |
|------|----------|---------|-----------|-------------|
| inventory-only | yes | pass | .riptide | Record the repo in the corpus matrix. |
| static-health | yes | blocked | .riptide, .riptide/adapters/drift.toml, .riptide/campaigns/drift-perps-broad.campaign.toml, .riptide/run-collection.json, ... (+190 more) | Adjust the scenario, personas, or adapter dispatch so the run produces a passing state_movement coverage check. |
| adapter-lint | no | skipped | .riptide/adapters/drift.toml | Run adapter lint in the validation lane before upgrading the launch claim. |
| direct-baseline-run | no | skipped | .riptide/adapters/drift.toml, .riptide/scenarios/drift-funding-keepers/run-config.json | Run the baseline scenario from a fresh shell before claiming direct execution support. |
| guided-sim-run-review | no | skipped | none | No guided-sim manifest is present; keep this gate skipped unless guided support is added. |
| campaign-validate-plan-run | no | skipped | .riptide/campaigns/drift-perps-broad.campaign.toml | Run campaign validate, plan, and run before claiming campaign execution support. |
| fresh-clone-eligibility | no | skipped | none | Run the fresh-clone evaluator path before using the corpus report as promotional launch evidence. |

### raydium-cp-swap

- Path: /home/ailton/Work/riptide/case-studies/raydium-cp-swap
- Verdict: blocked
- Launch claim: blocked
- Support: L4 (blocked)
- Blocker: generic-e2e-without-semantic-mapping: Generic E2E run evidence exists, but no semantic E2E evidence was observed. This means the repo may execute locally without yet mapping economic meaning.
- Next action: Add a [semantics] block using the existing amm.v1 core class and rerun until semantics_evaluated passes.
- Missing surfaces: guided_sim_manifests
- Artifacts: .riptide/campaigns/campaign_c691a3a7933c/runs/run_000000_5d7d52662d22/report.md, .riptide/campaigns/campaign_c691a3a7933c/runs/run_000001_37cd9a6bfe2b/report.md, .riptide/campaigns/campaign_c691a3a7933c/runs/run_000002_6b3a7e7d0366/report.md, .riptide/campaigns/campaign_c691a3a7933c/runs/run_000003_e787d9fa8165/report.md, ... (+54 more)

| Gate | Executed | Verdict | Artifacts | Next action |
|------|----------|---------|-----------|-------------|
| inventory-only | yes | pass | .riptide | Record the repo in the corpus matrix. |
| static-health | yes | blocked | .riptide, .riptide/adapters/raydium-cp-swap.toml, .riptide/campaigns/raydium-cp-swap-smoke.campaign.toml, .riptide/run-collection.json, ... (+36 more) | Add a [semantics] block using the existing amm.v1 core class and rerun until semantics_evaluated passes. |
| adapter-lint | no | skipped | .riptide/adapters/raydium-cp-swap.toml | Run adapter lint in the validation lane before upgrading the launch claim. |
| direct-baseline-run | no | skipped | .riptide/adapters/raydium-cp-swap.toml, .riptide/scenarios/swap-pressure/run-config.json | Run the baseline scenario from a fresh shell before claiming direct execution support. |
| guided-sim-run-review | no | skipped | none | No guided-sim manifest is present; keep this gate skipped unless guided support is added. |
| campaign-validate-plan-run | no | skipped | .riptide/campaigns/raydium-cp-swap-smoke.campaign.toml | Run campaign validate, plan, and run before claiming campaign execution support. |
| fresh-clone-eligibility | no | skipped | none | Run the fresh-clone evaluator path before using the corpus report as promotional launch evidence. |

### solana-perpetual-dex-smart-contract

- Path: /home/ailton/Work/riptide/case-studies/solana-perpetual-dex-smart-contract
- Verdict: blocked
- Launch claim: blocked
- Support: L4 (blocked)
- Blocker: generic-e2e-without-semantic-mapping: Generic E2E run evidence exists, but no semantic E2E evidence was observed. This means the repo may execute locally without yet mapping economic meaning.
- Next action: Add a [semantics] block using the existing perps-margin.v1 core class and rerun until semantics_evaluated passes.
- Missing surfaces: guided_sim_manifests
- Artifacts: .riptide/campaigns/campaign_9491da581162/runs/run_000000_aed5fb53c896/report.md, .riptide/campaigns/campaign_9491da581162/runs/run_000001_7397751dd317/report.md, .riptide/campaigns/campaign_9491da581162/runs/run_000002_c027827f0773/report.md, .riptide/campaigns/campaign_9491da581162/runs/run_000003_830d27c35bea/report.md, ... (+56 more)

| Gate | Executed | Verdict | Artifacts | Next action |
|------|----------|---------|-----------|-------------|
| inventory-only | yes | pass | .riptide | Record the repo in the corpus matrix. |
| static-health | yes | blocked | .riptide, .riptide/adapters/perpetual-dex.toml, .riptide/campaigns/perpetual-dex-price-smoke.campaign.toml, .riptide/run-collection.json, ... (+31 more) | Add a [semantics] block using the existing perps-margin.v1 core class and rerun until semantics_evaluated passes. |
| adapter-lint | no | skipped | .riptide/adapters/perpetual-dex.toml | Run adapter lint in the validation lane before upgrading the launch claim. |
| direct-baseline-run | no | skipped | .riptide/adapters/perpetual-dex.toml, .riptide/scenarios/price-oracle/run-config.json | Run the baseline scenario from a fresh shell before claiming direct execution support. |
| guided-sim-run-review | no | skipped | none | No guided-sim manifest is present; keep this gate skipped unless guided support is added. |
| campaign-validate-plan-run | no | skipped | .riptide/campaigns/perpetual-dex-price-smoke.campaign.toml | Run campaign validate, plan, and run before claiming campaign execution support. |
| fresh-clone-eligibility | no | skipped | none | Run the fresh-clone evaluator path before using the corpus report as promotional launch evidence. |

### solana-program-library

- Path: /home/ailton/Work/riptide/case-studies/solana-program-library
- Verdict: warn
- Launch claim: readiness-only
- Support: L7 (partial)
- Blocker: none
- Next action: Record the inspected support level and evidence paths in readiness documentation.
- Missing surfaces: guided_sim_manifests
- Artifacts: .riptide/campaigns/campaign_951e228b86d3/runs/run_000000_1aa5d3e4d9c1/report.md, .riptide/campaigns/campaign_951e228b86d3/runs/run_000001_585bd3176068/report.md, .riptide/campaigns/campaign_951e228b86d3/runs/run_000002_a8fc90f59903/report.md, .riptide/campaigns/campaign_951e228b86d3/runs/run_000003_4c5d3b1d19f1/report.md, ... (+118 more)

| Gate | Executed | Verdict | Artifacts | Next action |
|------|----------|---------|-----------|-------------|
| inventory-only | yes | pass | .riptide | Record the repo in the corpus matrix. |
| static-health | yes | warn | .riptide, .riptide/adapters/solana-program-library.toml, .riptide/campaigns/spl-token-transfer-broad.campaign.toml, .riptide/run-collection.json, ... (+4 more) | Record the inspected support level and evidence paths in readiness documentation. |
| adapter-lint | no | skipped | .riptide/adapters/solana-program-library.toml | Run adapter lint in the validation lane before upgrading the launch claim. |
| direct-baseline-run | no | skipped | .riptide/adapters/solana-program-library.toml, .riptide/scenarios/burst-transfer-surge/run-config.json | Run the baseline scenario from a fresh shell before claiming direct execution support. |
| guided-sim-run-review | no | skipped | none | No guided-sim manifest is present; keep this gate skipped unless guided support is added. |
| campaign-validate-plan-run | no | skipped | .riptide/campaigns/spl-token-transfer-broad.campaign.toml | Run campaign validate, plan, and run before claiming campaign execution support. |
| fresh-clone-eligibility | no | skipped | none | Run the fresh-clone evaluator path before using the corpus report as promotional launch evidence. |

### stablecoin-protocol

- Path: /home/ailton/Work/riptide/case-studies/stablecoin-protocol
- Verdict: pass
- Launch claim: readiness-only
- Support: L7 (ready)
- Blocker: none
- Next action: Record the inspected support level and evidence paths in readiness documentation.
- Missing surfaces: guided_sim_manifests
- Artifacts: .riptide/campaigns/campaign_aa41be1ea6c1/runs/run_000000_0aa1db8b3ead/report.md, .riptide/campaigns/campaign_aa41be1ea6c1/runs/run_000001_4aad876f17f8/report.md, .riptide/campaigns/campaign_aa41be1ea6c1/runs/run_000002_0bf58464be40/report.md, .riptide/campaigns/campaign_aa41be1ea6c1/runs/run_000003_a790fe616a9a/report.md, ... (+121 more)

| Gate | Executed | Verdict | Artifacts | Next action |
|------|----------|---------|-----------|-------------|
| inventory-only | yes | pass | .riptide | Record the repo in the corpus matrix. |
| static-health | yes | pass | .riptide, .riptide/adapters/stablecoin.toml, .riptide/campaigns/stablecoin-broad.campaign.toml, .riptide/run-collection.json, ... (+19 more) | Record the inspected support level and evidence paths in readiness documentation. |
| adapter-lint | no | skipped | .riptide/adapters/stablecoin.toml | Run adapter lint in the validation lane before upgrading the launch claim. |
| direct-baseline-run | no | skipped | .riptide/adapters/stablecoin.toml, .riptide/scenarios/peg-fee-drag/run-config.json | Run the baseline scenario from a fresh shell before claiming direct execution support. |
| guided-sim-run-review | no | skipped | none | No guided-sim manifest is present; keep this gate skipped unless guided support is added. |
| campaign-validate-plan-run | no | skipped | .riptide/campaigns/stablecoin-broad.campaign.toml | Run campaign validate, plan, and run before claiming campaign execution support. |
| fresh-clone-eligibility | no | skipped | none | Run the fresh-clone evaluator path before using the corpus report as promotional launch evidence. |

### whirlpools

- Path: /home/ailton/Work/riptide/case-studies/whirlpools
- Verdict: pass
- Launch claim: readiness-only
- Support: L7 (ready)
- Blocker: none
- Next action: Record the inspected support level and evidence paths in readiness documentation.
- Missing surfaces: guided_sim_manifests
- Artifacts: .riptide/campaigns/campaign_a0852f66871d/runs/run_000000_41c052cc85f5/report.md, .riptide/campaigns/campaign_a0852f66871d/runs/run_000001_8e5af07005a7/report.md, .riptide/campaigns/campaign_a0852f66871d/runs/run_000002_47f10b098163/report.md, .riptide/campaigns/campaign_a0852f66871d/runs/run_000003_cb2335d0d5a3/report.md, ... (+120 more)

| Gate | Executed | Verdict | Artifacts | Next action |
|------|----------|---------|-----------|-------------|
| inventory-only | yes | pass | .riptide | Record the repo in the corpus matrix. |
| static-health | yes | pass | .riptide, .riptide/adapters/whirlpool.toml, .riptide/campaigns/whirlpool-amm-broad.campaign.toml, .riptide/run-collection.json, ... (+163 more) | Record the inspected support level and evidence paths in readiness documentation. |
| adapter-lint | no | skipped | .riptide/adapters/whirlpool.toml | Run adapter lint in the validation lane before upgrading the launch claim. |
| direct-baseline-run | no | skipped | .riptide/adapters/whirlpool.toml, .riptide/scenarios/balanced-depth/run-config.json | Run the baseline scenario from a fresh shell before claiming direct execution support. |
| guided-sim-run-review | no | skipped | none | No guided-sim manifest is present; keep this gate skipped unless guided support is added. |
| campaign-validate-plan-run | no | skipped | .riptide/campaigns/whirlpool-amm-broad.campaign.toml | Run campaign validate, plan, and run before claiming campaign execution support. |
| fresh-clone-eligibility | no | skipped | none | Run the fresh-clone evaluator path before using the corpus report as promotional launch evidence. |

