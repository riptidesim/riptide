# Riptide Case-Study Corpus Readiness

- Schema: case-study-readiness.v1
- Generated at: 1970-01-01T00:00:00.000Z (fixed for deterministic diffs)
- Case-study root: /home/ailton/Work/riptide/case-studies
- Repositories inspected: 10
- Verdict summary: blocked=10
- Launch claim summary: blocked=10

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
| anchor-uniswap-v2 | blocked | blocked | L3 (blocked) | 1 | 1 | 1 | 0 | 2 | Regenerate or restore the run artifacts so each run collection points at readable simulation-result.json and report.md files. |
| lending | blocked | blocked | L5 (blocked) | 1 | 2 | 0 | 1 | 2 | Add .riptide/slices/<name>.toml declaring the risk path, semantic class, actions, accounts, observations, invariants, scenarios, and boundaries. |
| liquid-staking-program | blocked | blocked | L3 (blocked) | 1 | 1 | 0 | 0 | 2 | Regenerate or restore the run artifacts so each run collection points at readable simulation-result.json and report.md files. |
| mango-v4 | blocked | blocked | L3 (blocked) | 1 | 1 | 0 | 0 | 2 | Regenerate or restore the run artifacts so each run collection points at readable simulation-result.json and report.md files. |
| marinade-liquid-stake-fork | blocked | blocked | L3 (blocked) | 1 | 1 | 0 | 0 | 2 | Regenerate or restore the run artifacts so each run collection points at readable simulation-result.json and report.md files. |
| perpetuals | blocked | blocked | L3 (blocked) | 1 | 1 | 0 | 0 | 2 | Regenerate or restore the run artifacts so each run collection points at readable simulation-result.json and report.md files. |
| protocol-v2 | blocked | blocked | L3 (blocked) | 1 | 1 | 0 | 0 | 2 | Regenerate or restore the run artifacts so each run collection points at readable simulation-result.json and report.md files. |
| solana-program-library | blocked | blocked | L3 (blocked) | 1 | 1 | 0 | 0 | 2 | Regenerate or restore the run artifacts so each run collection points at readable simulation-result.json and report.md files. |
| stablecoin-protocol | blocked | blocked | L3 (blocked) | 1 | 1 | 0 | 0 | 2 | Regenerate or restore the run artifacts so each run collection points at readable simulation-result.json and report.md files. |
| whirlpools | blocked | blocked | L3 (blocked) | 1 | 1 | 0 | 0 | 2 | Regenerate or restore the run artifacts so each run collection points at readable simulation-result.json and report.md files. |

## Row Details

### anchor-uniswap-v2

- Path: /home/ailton/Work/riptide/case-studies/anchor-uniswap-v2
- Verdict: blocked
- Launch claim: blocked
- Support: L3 (blocked)
- Blocker: run-artifacts-unreadable: Run collection .riptide/run-collection.json exists, but artifact readability did not pass. Treat it as partial evidence until simulation-result.json and report.md are readable.
- Next action: Regenerate or restore the run artifacts so each run collection points at readable simulation-result.json and report.md files.
- Missing surfaces: campaigns
- Artifacts: .riptide/last-run.json, .riptide/run-collection.json

| Gate | Executed | Verdict | Artifacts | Next action |
|------|----------|---------|-----------|-------------|
| inventory-only | yes | pass | .riptide | Record the repo in the corpus matrix. |
| static-health | yes | blocked | .riptide, .riptide/adapters/ammv2.toml, .riptide/run-collection.json, /home/ailton/Work/riptide/case-studies/anchor-uniswap-v2, ... (+10 more) | Regenerate or restore the run artifacts so each run collection points at readable simulation-result.json and report.md files. |
| adapter-lint | no | skipped | .riptide/adapters/ammv2.toml | Run adapter lint in the validation lane before upgrading the launch claim. |
| direct-baseline-run | no | skipped | .riptide/adapters/ammv2.toml, .riptide/scenarios/baseline/run-config.json | Run the baseline scenario from a fresh shell before claiming direct execution support. |
| guided-sim-run-review | no | skipped | .riptide/sim/Riptide.toml | Run and review the guided-sim manifest before using guided evidence in the launch claim. |
| campaign-validate-plan-run | no | skipped | none | No campaign input is present; keep this gate skipped unless a campaign is added. |
| fresh-clone-eligibility | no | skipped | none | Run the fresh-clone evaluator path before using the corpus report as promotional launch evidence. |

### lending

- Path: /home/ailton/Work/riptide/case-studies/lending
- Verdict: blocked
- Launch claim: blocked
- Support: L5 (blocked)
- Blocker: missing-risk-slice-manifest: Semantic E2E evidence exists, but no valid risk-slice manifest was discovered. Declare the economic path before claiming risk-slice E2E support.
- Next action: Add .riptide/slices/<name>.toml declaring the risk path, semantic class, actions, accounts, observations, invariants, scenarios, and boundaries.
- Missing surfaces: guided_sim_manifests
- Artifacts: .riptide/campaigns/campaign_c3fb488bb7b2/runs/run_000000_b8cdb68921c4/report.md, .riptide/campaigns/campaign_c3fb488bb7b2/runs/run_000001_0a210a8ead4f/report.md, .riptide/last-run.json, .riptide/pack/baseline/manifest.json, ... (+7 more)

| Gate | Executed | Verdict | Artifacts | Next action |
|------|----------|---------|-----------|-------------|
| inventory-only | yes | pass | .riptide | Record the repo in the corpus matrix. |
| static-health | yes | blocked | .riptide, .riptide/adapters/lending.toml, .riptide/campaigns/deposit-flow.campaign.toml, .riptide/run-collection.json, ... (+32 more) | Add .riptide/slices/<name>.toml declaring the risk path, semantic class, actions, accounts, observations, invariants, scenarios, and boundaries. |
| adapter-lint | no | skipped | .riptide/adapters/lending.toml | Run adapter lint in the validation lane before upgrading the launch claim. |
| direct-baseline-run | no | skipped | .riptide/adapters/lending.toml, .riptide/scenarios/baseline/run-config.json | Run the baseline scenario from a fresh shell before claiming direct execution support. |
| guided-sim-run-review | no | skipped | none | No guided-sim manifest is present; keep this gate skipped unless guided support is added. |
| campaign-validate-plan-run | no | skipped | .riptide/campaigns/deposit-flow.campaign.toml | Run campaign validate, plan, and run before claiming campaign execution support. |
| fresh-clone-eligibility | no | skipped | none | Run the fresh-clone evaluator path before using the corpus report as promotional launch evidence. |

### liquid-staking-program

- Path: /home/ailton/Work/riptide/case-studies/liquid-staking-program
- Verdict: blocked
- Launch claim: blocked
- Support: L3 (blocked)
- Blocker: run-artifacts-unreadable: Run collection .riptide/run-collection.json exists, but artifact readability did not pass. Treat it as partial evidence until simulation-result.json and report.md are readable.
- Next action: Regenerate or restore the run artifacts so each run collection points at readable simulation-result.json and report.md files.
- Missing surfaces: campaigns, guided_sim_manifests
- Artifacts: .riptide/last-run.json, .riptide/run-collection.json

| Gate | Executed | Verdict | Artifacts | Next action |
|------|----------|---------|-----------|-------------|
| inventory-only | yes | pass | .riptide | Record the repo in the corpus matrix. |
| static-health | yes | blocked | .riptide, .riptide/adapters/marinade-finance.toml, .riptide/run-collection.json, /home/ailton/Work/riptide/case-studies/liquid-staking-program, ... (+53 more) | Regenerate or restore the run artifacts so each run collection points at readable simulation-result.json and report.md files. |
| adapter-lint | no | skipped | .riptide/adapters/marinade-finance.toml | Run adapter lint in the validation lane before upgrading the launch claim. |
| direct-baseline-run | no | skipped | .riptide/adapters/marinade-finance.toml, .riptide/scenarios/baseline/run-config.json | Run the baseline scenario from a fresh shell before claiming direct execution support. |
| guided-sim-run-review | no | skipped | none | No guided-sim manifest is present; keep this gate skipped unless guided support is added. |
| campaign-validate-plan-run | no | skipped | none | No campaign input is present; keep this gate skipped unless a campaign is added. |
| fresh-clone-eligibility | no | skipped | none | Run the fresh-clone evaluator path before using the corpus report as promotional launch evidence. |
### mango-v4

- Path: /home/ailton/Work/riptide/case-studies/mango-v4
- Verdict: blocked
- Launch claim: blocked
- Support: L3 (blocked)
- Blocker: run-artifacts-unreadable: Run collection .riptide/run-collection.json exists, but artifact readability did not pass. Treat it as partial evidence until simulation-result.json and report.md are readable.
- Next action: Regenerate or restore the run artifacts so each run collection points at readable simulation-result.json and report.md files.
- Missing surfaces: campaigns, guided_sim_manifests
- Artifacts: .riptide/last-run.json, .riptide/run-collection.json

| Gate | Executed | Verdict | Artifacts | Next action |
|------|----------|---------|-----------|-------------|
| inventory-only | yes | pass | .riptide | Record the repo in the corpus matrix. |
| static-health | yes | blocked | .riptide, .riptide/adapters/mango-v4.toml, .riptide/run-collection.json, /home/ailton/Work/riptide/case-studies/mango-v4, ... (+202 more) | Regenerate or restore the run artifacts so each run collection points at readable simulation-result.json and report.md files. |
| adapter-lint | no | skipped | .riptide/adapters/mango-v4.toml | Run adapter lint in the validation lane before upgrading the launch claim. |
| direct-baseline-run | no | skipped | .riptide/adapters/mango-v4.toml, .riptide/scenarios/baseline/run-config.json | Run the baseline scenario from a fresh shell before claiming direct execution support. |
| guided-sim-run-review | no | skipped | none | No guided-sim manifest is present; keep this gate skipped unless guided support is added. |
| campaign-validate-plan-run | no | skipped | none | No campaign input is present; keep this gate skipped unless a campaign is added. |
| fresh-clone-eligibility | no | skipped | none | Run the fresh-clone evaluator path before using the corpus report as promotional launch evidence. |

### marinade-liquid-stake-fork

- Path: /home/ailton/Work/riptide/case-studies/marinade-liquid-stake-fork
- Verdict: blocked
- Launch claim: blocked
- Support: L3 (blocked)
- Blocker: run-artifacts-unreadable: Run collection .riptide/run-collection.json exists, but artifact readability did not pass. Treat it as partial evidence until simulation-result.json and report.md are readable.
- Next action: Regenerate or restore the run artifacts so each run collection points at readable simulation-result.json and report.md files.
- Missing surfaces: campaigns, guided_sim_manifests
- Artifacts: .riptide/last-run.json, .riptide/run-collection.json

| Gate | Executed | Verdict | Artifacts | Next action |
|------|----------|---------|-----------|-------------|
| inventory-only | yes | pass | .riptide | Record the repo in the corpus matrix. |
| static-health | yes | blocked | .riptide, .riptide/adapters/marinade-forking-smart-contract.toml, .riptide/run-collection.json, /home/ailton/Work/riptide/case-studies/marinade-liquid-stake-fork, ... (+53 more) | Regenerate or restore the run artifacts so each run collection points at readable simulation-result.json and report.md files. |
| adapter-lint | no | skipped | .riptide/adapters/marinade-forking-smart-contract.toml | Run adapter lint in the validation lane before upgrading the launch claim. |
| direct-baseline-run | no | skipped | .riptide/adapters/marinade-forking-smart-contract.toml, .riptide/scenarios/baseline/run-config.json | Run the baseline scenario from a fresh shell before claiming direct execution support. |
| guided-sim-run-review | no | skipped | none | No guided-sim manifest is present; keep this gate skipped unless guided support is added. |
| campaign-validate-plan-run | no | skipped | none | No campaign input is present; keep this gate skipped unless a campaign is added. |
| fresh-clone-eligibility | no | skipped | none | Run the fresh-clone evaluator path before using the corpus report as promotional launch evidence. |

### perpetuals

- Path: /home/ailton/Work/riptide/case-studies/perpetuals
- Verdict: blocked
- Launch claim: blocked
- Support: L3 (blocked)
- Blocker: run-artifacts-unreadable: Run collection .riptide/run-collection.json exists, but artifact readability did not pass. Treat it as partial evidence until simulation-result.json and report.md are readable.
- Next action: Regenerate or restore the run artifacts so each run collection points at readable simulation-result.json and report.md files.
- Missing surfaces: campaigns, guided_sim_manifests
- Artifacts: .riptide/last-run.json, .riptide/run-collection.json

| Gate | Executed | Verdict | Artifacts | Next action |
|------|----------|---------|-----------|-------------|
| inventory-only | yes | pass | .riptide | Record the repo in the corpus matrix. |
| static-health | yes | blocked | .riptide, .riptide/adapters/perpetuals.toml, .riptide/run-collection.json, /home/ailton/Work/riptide/case-studies/perpetuals, ... (+47 more) | Regenerate or restore the run artifacts so each run collection points at readable simulation-result.json and report.md files. |
| adapter-lint | no | skipped | .riptide/adapters/perpetuals.toml | Run adapter lint in the validation lane before upgrading the launch claim. |
| direct-baseline-run | no | skipped | .riptide/adapters/perpetuals.toml, .riptide/scenarios/baseline/run-config.json | Run the baseline scenario from a fresh shell before claiming direct execution support. |
| guided-sim-run-review | no | skipped | none | No guided-sim manifest is present; keep this gate skipped unless guided support is added. |
| campaign-validate-plan-run | no | skipped | none | No campaign input is present; keep this gate skipped unless a campaign is added. |
| fresh-clone-eligibility | no | skipped | none | Run the fresh-clone evaluator path before using the corpus report as promotional launch evidence. |

### protocol-v2

- Path: /home/ailton/Work/riptide/case-studies/protocol-v2
- Verdict: blocked
- Launch claim: blocked
- Support: L3 (blocked)
- Blocker: run-artifacts-unreadable: Run collection .riptide/run-collection.json exists, but artifact readability did not pass. Treat it as partial evidence until simulation-result.json and report.md are readable.
- Next action: Regenerate or restore the run artifacts so each run collection points at readable simulation-result.json and report.md files.
- Missing surfaces: campaigns, guided_sim_manifests
- Artifacts: .riptide/last-run.json, .riptide/run-collection.json

| Gate | Executed | Verdict | Artifacts | Next action |
|------|----------|---------|-----------|-------------|
| inventory-only | yes | pass | .riptide | Record the repo in the corpus matrix. |
| static-health | yes | blocked | .riptide, .riptide/adapters/drift.toml, .riptide/run-collection.json, /home/ailton/Work/riptide/case-studies/protocol-v2, ... (+189 more) | Regenerate or restore the run artifacts so each run collection points at readable simulation-result.json and report.md files. |
| adapter-lint | no | skipped | .riptide/adapters/drift.toml | Run adapter lint in the validation lane before upgrading the launch claim. |
| direct-baseline-run | no | skipped | .riptide/adapters/drift.toml, .riptide/scenarios/baseline/run-config.json | Run the baseline scenario from a fresh shell before claiming direct execution support. |
| guided-sim-run-review | no | skipped | none | No guided-sim manifest is present; keep this gate skipped unless guided support is added. |
| campaign-validate-plan-run | no | skipped | none | No campaign input is present; keep this gate skipped unless a campaign is added. |
| fresh-clone-eligibility | no | skipped | none | Run the fresh-clone evaluator path before using the corpus report as promotional launch evidence. |

### solana-program-library

- Path: /home/ailton/Work/riptide/case-studies/solana-program-library
- Verdict: blocked
- Launch claim: blocked
- Support: L3 (blocked)
- Blocker: run-artifacts-unreadable: Run collection .riptide/run-collection.json exists, but artifact readability did not pass. Treat it as partial evidence until simulation-result.json and report.md are readable.
- Next action: Regenerate or restore the run artifacts so each run collection points at readable simulation-result.json and report.md files.
- Missing surfaces: campaigns, guided_sim_manifests
- Artifacts: .riptide/last-run.json, .riptide/run-collection.json

| Gate | Executed | Verdict | Artifacts | Next action |
|------|----------|---------|-----------|-------------|
| inventory-only | yes | pass | .riptide | Record the repo in the corpus matrix. |
| static-health | yes | blocked | .riptide, .riptide/adapters/solana-program-library.toml, .riptide/run-collection.json, /home/ailton/Work/riptide/case-studies/solana-program-library, ... (+2 more) | Regenerate or restore the run artifacts so each run collection points at readable simulation-result.json and report.md files. |
| adapter-lint | no | skipped | .riptide/adapters/solana-program-library.toml | Run adapter lint in the validation lane before upgrading the launch claim. |
| direct-baseline-run | no | skipped | .riptide/adapters/solana-program-library.toml, .riptide/scenarios/baseline/run-config.json | Run the baseline scenario from a fresh shell before claiming direct execution support. |
| guided-sim-run-review | no | skipped | none | No guided-sim manifest is present; keep this gate skipped unless guided support is added. |
| campaign-validate-plan-run | no | skipped | none | No campaign input is present; keep this gate skipped unless a campaign is added. |
| fresh-clone-eligibility | no | skipped | none | Run the fresh-clone evaluator path before using the corpus report as promotional launch evidence. |

### stablecoin-protocol

- Path: /home/ailton/Work/riptide/case-studies/stablecoin-protocol
- Verdict: blocked
- Launch claim: blocked
- Support: L3 (blocked)
- Blocker: run-artifacts-unreadable: Run collection .riptide/run-collection.json exists, but artifact readability did not pass. Treat it as partial evidence until simulation-result.json and report.md are readable.
- Next action: Regenerate or restore the run artifacts so each run collection points at readable simulation-result.json and report.md files.
- Missing surfaces: campaigns, guided_sim_manifests
- Artifacts: .riptide/last-run.json, .riptide/run-collection.json

| Gate | Executed | Verdict | Artifacts | Next action |
|------|----------|---------|-----------|-------------|
| inventory-only | yes | pass | .riptide | Record the repo in the corpus matrix. |
| static-health | yes | blocked | .riptide, .riptide/adapters/stablecoin.toml, .riptide/run-collection.json, /home/ailton/Work/riptide/case-studies/stablecoin-protocol, ... (+17 more) | Regenerate or restore the run artifacts so each run collection points at readable simulation-result.json and report.md files. |
| adapter-lint | no | skipped | .riptide/adapters/stablecoin.toml | Run adapter lint in the validation lane before upgrading the launch claim. |
| direct-baseline-run | no | skipped | .riptide/adapters/stablecoin.toml, .riptide/scenarios/baseline/run-config.json | Run the baseline scenario from a fresh shell before claiming direct execution support. |
| guided-sim-run-review | no | skipped | none | No guided-sim manifest is present; keep this gate skipped unless guided support is added. |
| campaign-validate-plan-run | no | skipped | none | No campaign input is present; keep this gate skipped unless a campaign is added. |
| fresh-clone-eligibility | no | skipped | none | Run the fresh-clone evaluator path before using the corpus report as promotional launch evidence. |

### whirlpools

- Path: /home/ailton/Work/riptide/case-studies/whirlpools
- Verdict: blocked
- Launch claim: blocked
- Support: L3 (blocked)
- Blocker: run-artifacts-unreadable: Run collection .riptide/run-collection.json exists, but artifact readability did not pass. Treat it as partial evidence until simulation-result.json and report.md are readable.
- Next action: Regenerate or restore the run artifacts so each run collection points at readable simulation-result.json and report.md files.
- Missing surfaces: campaigns, guided_sim_manifests
- Artifacts: .riptide/last-run.json, .riptide/run-collection.json

| Gate | Executed | Verdict | Artifacts | Next action |
|------|----------|---------|-----------|-------------|
| inventory-only | yes | pass | .riptide | Record the repo in the corpus matrix. |
| static-health | yes | blocked | .riptide, .riptide/adapters/whirlpool.toml, .riptide/run-collection.json, /home/ailton/Work/riptide/case-studies/whirlpools, ... (+161 more) | Regenerate or restore the run artifacts so each run collection points at readable simulation-result.json and report.md files. |
| adapter-lint | no | skipped | .riptide/adapters/whirlpool.toml | Run adapter lint in the validation lane before upgrading the launch claim. |
| direct-baseline-run | no | skipped | .riptide/adapters/whirlpool.toml, .riptide/scenarios/baseline/run-config.json | Run the baseline scenario from a fresh shell before claiming direct execution support. |
| guided-sim-run-review | no | skipped | none | No guided-sim manifest is present; keep this gate skipped unless guided support is added. |
| campaign-validate-plan-run | no | skipped | none | No campaign input is present; keep this gate skipped unless a campaign is added. |
| fresh-clone-eligibility | no | skipped | none | Run the fresh-clone evaluator path before using the corpus report as promotional launch evidence. |
