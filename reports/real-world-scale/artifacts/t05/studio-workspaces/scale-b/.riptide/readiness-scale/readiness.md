# Riptide Readiness Report

- Repository: scale-b | /home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t05/studio-workspaces/scale-b | branch main | commit 6c6211699945
- Observed support level: L3 - Riptide workspace initialized
- Status: blocked
- Next level: L4 - generic E2E observed
- E2E evidence kind: none

## Missing Inputs
- Missing inputs: generic_e2e_run
- adapter: The .riptide workspace has no adapter TOML. Add an adapter that maps local program instructions and state into Riptide. Evidence: .riptide.
- harness: No .riptide harness was discovered. Some adapters may still be inspectable, but local E2E execution will need a harness entry point.
- scenario: No scenario artifacts were discovered under .riptide/scenarios. Runs need at least one scenario to become evidence.

## Next Actions
- next action (adapter): Author .riptide/adapters/<protocol>.toml with instruction, account, observation, and lineage mappings.

## Evidence
- missing: campaign-ready inputs (campaign_ready_inputs). Notes: input presence only; readiness does not execute campaigns.
- missing: adapter summaries (custom:readiness.adapters).
- missing: run collection summaries (custom:readiness.run_collections).
- missing: slice manifests (custom:readiness.slices).
- missing: generic E2E run evidence (generic_e2e_run).
- missing: risk-slice E2E run evidence (risk_slice_e2e_run).
- missing: semantic E2E run evidence (semantic_e2e_run).
- present: build, IDL, or program artifacts (build_or_program_artifacts). Paths: fixtures/idls/admin_mock_oracle.json, fixtures/idls/amm.json, fixtures/idls/liquid-staking.json, fixtures/idls/perpetuals.json, fixtures/idls/resource-grinder.json, fixtures/idls/stablecoin.json. Notes: idl-artifacts; riptide-workspace.
- present: candidate (candidate_record). Paths: /home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t05/studio-workspaces/scale-b. Notes: readiness inspection was requested for this local path.
- present: local repository (local_repo). Paths: /home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t05/studio-workspaces/scale-b. Notes: branch: main; commit: 6c62116999457592c0260247a5571c61977aa476; dirty: true; remote: https://github.com/riptidesim/riptide.git.
- present: .riptide workspace (riptide_workspace). Paths: .riptide. Notes: 0 adapter(s); 0 harness(es); 0 scenario artifact(s); 0 slice manifest(s).

## Slices
- No validated slice is present in this report.

## Not Currently Wired
- Campaign execution is not currently wired into readiness; L7 checks input presence only.
- Risk-slice coverage is not currently wired until a valid repo-local .riptide/slices/<name>.toml and matching run evidence are present.

## Boundaries
- campaign: Campaign-ready status is an input check only and is not inferred from smoke, semantic, or slice runs.
- slice: No declared risk slice was validated, so the report does not claim coverage of a specific economic path.

## Warnings
- repo has uncommitted or untracked local changes; readiness evidence may include local-only work

## Semantic Hygiene
- No semantic hygiene findings.
