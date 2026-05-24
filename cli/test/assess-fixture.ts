import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  CampaignRetentionManifest,
  CampaignSummaryJson
} from "../src/campaign/aggregation.js";
import {
  buildRiskSurfaceDocument,
  serializeRiskSurface,
  type BuildRiskSurfaceInput,
  type RiskSurfaceDocument
} from "../src/campaign/surface.js";
import type { ParameterDistribution } from "../src/campaign/schema.js";
import {
  buildAssessmentModel,
  buildCorrectnessAssessmentModel,
  summarizeGuidedSimRun,
  type AssessmentModel,
  type CartographyAssessmentModel,
  type GuidedSimRunDocument
} from "../src/assess/model.js";

/**
 * Shared assessment-model fixtures for the T02 (renderer) and T03 (narrative)
 * suites. Not a `*.test.ts` file, so the test runner does not execute it
 * directly; it is imported by both suites so they exercise the same models.
 */

const FLAGSHIP_SURFACE_PATH = path.resolve(
  process.cwd(),
  "..",
  "fixtures",
  "campaigns",
  "lending",
  "whale-shock-cartography",
  "expected-risk-surface.json"
);

/** The flagship lending cartography model: real Sprint 39 surface, failures present, bounded safe region. */
export async function loadFlagshipModel(): Promise<CartographyAssessmentModel> {
  const surfaceRaw = await readFile(FLAGSHIP_SURFACE_PATH, "utf8");
  const surface = JSON.parse(surfaceRaw) as RiskSurfaceDocument;
  return buildAssessmentModel({
    campaignRootLabel: "tmp/flagship-run/campaign_40a5f239691a",
    summary: flagshipSummary(surface),
    surface,
    surfaceRawBytes: surfaceRaw,
    retentionManifest: flagshipManifest(surface)
  });
}

/** Write the flagship campaign root to a temp dir (for `ingestAssessment`-style round-trips). */
export async function writeFlagshipRoot(): Promise<{ root: string; surfaceRaw: string }> {
  const surfaceRaw = await readFile(FLAGSHIP_SURFACE_PATH, "utf8");
  const surface = JSON.parse(surfaceRaw) as RiskSurfaceDocument;
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-assess-fixture-"));
  await writeFile(
    path.join(root, "campaign-summary.json"),
    JSON.stringify(flagshipSummary(surface), null, 2) + "\n",
    "utf8"
  );
  await writeFile(path.join(root, "risk-surface.json"), surfaceRaw, "utf8");
  await writeFile(
    path.join(root, "retention-manifest.json"),
    JSON.stringify(flagshipManifest(surface), null, 2) + "\n",
    "utf8"
  );
  return { root, surfaceRaw };
}

function discrete(values: Array<string | number>): ParameterDistribution {
  return { distribution: "discrete", values, weights: values.map(() => 1) };
}

function run(
  status: "pass" | "fail",
  sampledParameters: Record<string, string | number>
): BuildRiskSurfaceInput["runs"][number] {
  return {
    runIndex: 0,
    status,
    sampledParameters,
    badDebt: status === "fail" ? 1200 : 0,
    utilization: 1,
    tvl: 1000,
    availableLiquidity: 500,
    riskScore: status === "fail" ? 7 : 0
  };
}

/**
 * A synthetic clean model: a real surface built from all-passing runs, so the
 * narrative must read as a non-finding ("no declared invariant fired"), never a
 * finding. Identity fields line up across summary / surface / manifest.
 */
export function buildCleanModel(): CartographyAssessmentModel {
  const campaign: BuildRiskSurfaceInput["campaign"] = {
    campaignId: "campaign_clean0000",
    campaignDigest: "clean-digest",
    name: "calm-baseline",
    semanticClass: "lending.v1",
    riskObjective: "liquidation-safety",
    seedPolicyDisplay: "fixed:20260523",
    runBudget: 6,
    requestedRuns: 6
  };
  const surface = buildRiskSurfaceDocument({
    campaign,
    parameters: { whale_share_bps: discrete([2500, 5000]) },
    runs: [
      run("pass", { whale_share_bps: 2500 }),
      run("pass", { whale_share_bps: 2500 }),
      run("pass", { whale_share_bps: 2500 }),
      run("pass", { whale_share_bps: 5000 }),
      run("pass", { whale_share_bps: 5000 }),
      run("pass", { whale_share_bps: 5000 })
    ]
  });
  const surfaceRaw = serializeRiskSurface(surface);
  return buildAssessmentModel({
    campaignRootLabel: "calm-baseline",
    summary: cleanSummary(surface),
    surface,
    surfaceRawBytes: surfaceRaw,
    retentionManifest: identityManifest(surface)
  });
}

/**
 * A failing model whose safe-region threshold is intentionally relaxed to 50%.
 * The whole populated region is "safe" by threshold, but one bin still has a
 * non-zero invariant-failure rate, so the narrative must not call it a
 * non-finding.
 */
export function buildThresholdNonZeroSafeRegionModel(): CartographyAssessmentModel {
  const campaign: BuildRiskSurfaceInput["campaign"] = {
    campaignId: "campaign_thresholdsafe",
    campaignDigest: "threshold-safe-digest",
    name: "relaxed-threshold",
    semanticClass: "lending.v1",
    riskObjective: "liquidation-safety",
    seedPolicyDisplay: "fixed:20260523",
    runBudget: 4,
    requestedRuns: 4
  };
  const surface = buildRiskSurfaceDocument({
    campaign,
    parameters: { whale_share_bps: discrete([2500, 7500]) },
    runs: [
      run("pass", { whale_share_bps: 2500 }),
      run("pass", { whale_share_bps: 2500 }),
      run("pass", { whale_share_bps: 7500 }),
      run("fail", { whale_share_bps: 7500 })
    ],
    config: { safeRegionFailureRateThreshold: 0.5 }
  });
  const surfaceRaw = serializeRiskSurface(surface);
  return buildAssessmentModel({
    campaignRootLabel: "relaxed-threshold",
    summary: thresholdNonZeroSummary(surface),
    surface,
    surfaceRawBytes: surfaceRaw,
    retentionManifest: identityManifest(surface)
  });
}

// --- summary / manifest builders -------------------------------------------

function flagshipSummary(surface: RiskSurfaceDocument): CampaignSummaryJson {
  return {
    schema_version: "campaign-summary.v1",
    campaign: campaignBlock(surface, "fixtures/adapters/lending-cartography.toml"),
    artifacts: standardArtifacts(),
    totals: {
      requested_runs: 80,
      completed_runs: 80,
      passed_runs: 47,
      invariant_failed_runs: 33,
      setup_errors: 0,
      skipped_runs: 0,
      invariant_failure_rate: 0.4125
    },
    first_failure_ticks: { count: 0, min: null, median: null, max: null, distribution: {} },
    scenario_families: {
      "bank-run": passingFamily(22),
      "price-shock": {
        planned_runs: 58,
        completed_runs: 58,
        passed_runs: 25,
        invariant_failed_runs: 33,
        setup_errors: 0,
        skipped_runs: 0,
        first_failure_tick_min: 1,
        total_bad_debt_max: 4320,
        max_utilization_observed: 19.2,
        min_tvl_observed: 1183
      }
    },
    parameters: {
      shock_profile: {
        distribution: "discrete(price-shock|bank-run)",
        sampled_count: 80,
        min: null,
        median: null,
        max: null,
        values: ["price-shock", "bank-run"]
      },
      whale_share_bps: {
        distribution: "uniform(500..3000, integer)",
        unit: "bps",
        sampled_count: 80,
        min: 500,
        median: 1750,
        max: 3000,
        values: [500, 1125, 1750, 2375, 3000]
      }
    },
    lending: {
      observations_used: ["bad_debt", "utilization", "tvl"],
      completed_runs_with_metrics: 80,
      total_bad_debt: { min: 0, median: 1440, max: 4320 },
      total_liquidations: { min: 0, median: 0, max: 0 },
      liquidity_stress: {
        min_tvl_observed: 1183,
        max_utilization_observed: 19.2,
        min_available_liquidity_observed: null
      },
      liquidation_safety_failures: {
        failed_runs: 33,
        invariant_names: ["bad_debt_threshold"]
      }
    },
    retention: { selected: [], warnings: [] },
    warnings: [],
    claim_boundary: "Simulation evidence over the declared, fixed-seed parameter region."
  };
}

function cleanSummary(surface: RiskSurfaceDocument): CampaignSummaryJson {
  return {
    schema_version: "campaign-summary.v1",
    campaign: campaignBlock(surface, "fixtures/adapters/lending-cartography.toml"),
    artifacts: standardArtifacts(),
    totals: {
      requested_runs: 6,
      completed_runs: 6,
      passed_runs: 6,
      invariant_failed_runs: 0,
      setup_errors: 0,
      skipped_runs: 0,
      invariant_failure_rate: 0
    },
    first_failure_ticks: { count: 0, min: null, median: null, max: null, distribution: {} },
    scenario_families: { "price-shock": passingFamily(6) },
    parameters: {
      whale_share_bps: {
        distribution: "discrete(2500|5000)",
        unit: "bps",
        sampled_count: 6,
        min: 2500,
        median: 3750,
        max: 5000,
        values: [2500, 5000]
      }
    },
    lending: {
      observations_used: ["bad_debt", "utilization", "tvl"],
      completed_runs_with_metrics: 6,
      total_bad_debt: { min: 0, median: 0, max: 0 },
      total_liquidations: { min: 0, median: 0, max: 0 },
      liquidity_stress: {
        min_tvl_observed: 1000,
        max_utilization_observed: 1,
        min_available_liquidity_observed: 500
      },
      liquidation_safety_failures: { failed_runs: 0, invariant_names: ["bad_debt_threshold"] }
    },
    retention: { selected: [], warnings: [] },
    warnings: [],
    claim_boundary: "Simulation evidence over the declared, fixed-seed parameter region."
  };
}

function thresholdNonZeroSummary(surface: RiskSurfaceDocument): CampaignSummaryJson {
  return {
    schema_version: "campaign-summary.v1",
    campaign: campaignBlock(surface, "fixtures/adapters/lending-cartography.toml"),
    artifacts: standardArtifacts(),
    totals: {
      requested_runs: 4,
      completed_runs: 4,
      passed_runs: 3,
      invariant_failed_runs: 1,
      setup_errors: 0,
      skipped_runs: 0,
      invariant_failure_rate: 0.25
    },
    first_failure_ticks: { count: 0, min: null, median: null, max: null, distribution: {} },
    scenario_families: {
      "price-shock": {
        planned_runs: 4,
        completed_runs: 4,
        passed_runs: 3,
        invariant_failed_runs: 1,
        setup_errors: 0,
        skipped_runs: 0,
        first_failure_tick_min: 1,
        total_bad_debt_max: 1200,
        max_utilization_observed: 7,
        min_tvl_observed: 1000
      }
    },
    parameters: {
      whale_share_bps: {
        distribution: "discrete(2500|7500)",
        unit: "bps",
        sampled_count: 4,
        min: 2500,
        median: 5000,
        max: 7500,
        values: [2500, 7500]
      }
    },
    lending: {
      observations_used: ["bad_debt", "utilization", "tvl"],
      completed_runs_with_metrics: 4,
      total_bad_debt: { min: 0, median: 0, max: 1200 },
      total_liquidations: { min: 0, median: 0, max: 0 },
      liquidity_stress: {
        min_tvl_observed: 1000,
        max_utilization_observed: 7,
        min_available_liquidity_observed: 500
      },
      liquidation_safety_failures: { failed_runs: 1, invariant_names: ["bad_debt_threshold"] }
    },
    retention: { selected: [], warnings: [] },
    warnings: [],
    claim_boundary: "Simulation evidence over the declared, fixed-seed parameter region."
  };
}

function campaignBlock(
  surface: RiskSurfaceDocument,
  adapter: string
): CampaignSummaryJson["campaign"] {
  return {
    campaign_id: surface.campaign.campaign_id,
    campaign_digest: surface.campaign.campaign_digest,
    name: surface.campaign.name,
    class: surface.campaign.class,
    risk_objective: surface.campaign.risk_objective,
    run_budget: surface.campaign.run_budget,
    requested_runs: surface.campaign.requested_runs,
    seed_policy: surface.campaign.seed_policy,
    replay_retention: [],
    adapter,
    output_dir: surface.campaign.campaign_id
  };
}

function standardArtifacts(): CampaignSummaryJson["artifacts"] {
  return {
    runs_jsonl: "runs.jsonl",
    parameters_csv: "parameters.csv",
    retention_manifest: "retention-manifest.json",
    markdown_summary: "campaign-summary.md",
    risk_surface: "risk-surface.json"
  };
}

function flagshipManifest(surface: RiskSurfaceDocument): CampaignRetentionManifest {
  return identityManifest(surface);
}

function identityManifest(surface: RiskSurfaceDocument): CampaignRetentionManifest {
  return {
    schema_version: "campaign-retention-manifest.v1",
    campaign_id: surface.campaign.campaign_id,
    campaign_digest: surface.campaign.campaign_digest,
    campaign_name: surface.campaign.name,
    class: surface.campaign.class,
    risk_objective: surface.campaign.risk_objective,
    requested_labels: [],
    artifacts: { risk_surface: "risk-surface.json" },
    entries: [],
    warnings: []
  };
}

function passingFamily(completedRuns: number): CampaignSummaryJson["scenario_families"][string] {
  return {
    planned_runs: completedRuns,
    completed_runs: completedRuns,
    passed_runs: completedRuns,
    invariant_failed_runs: 0,
    setup_errors: 0,
    skipped_runs: 0,
    first_failure_tick_min: null,
    total_bad_debt_max: 0,
    max_utilization_observed: 8.8,
    min_tvl_observed: 2000
  };
}

// --- correctness-shape (surface-less) fixtures ------------------------------

/**
 * A guided-sim-run.json document with Defunds-shaped families (happy + negative
 * controls). `unexpected`/`panics`/`status` are overridable so suites can build
 * both the clean (non-finding) and dirty (finding) cases. `flows` scales the
 * total so the deterministic "most flows wins" selection can be exercised.
 */
function guidedSimDoc(
  options: { flows?: number; unexpected?: number; panics?: number; status?: string } = {}
): GuidedSimRunDocument {
  const unexpected = options.unexpected ?? 0;
  const panics = options.panics ?? 0;
  const flowCounts = {
    payout_session_happy_path: 6,
    payout_session_negative_controls: 8,
    withdrawal_finalize_token_happy_path: 6
  };
  const iteration = (index: number): GuidedSimRunDocument["iterations"][number] => ({
    iteration: index,
    seed: `seed-${index}`,
    status: "passed",
    dispatched_flows: 20,
    flow_counts: flowCounts,
    service_ticks: 0,
    error: null,
    panic: false
  });
  return {
    schema_version: 1,
    status: options.status ?? "passed",
    iterations_requested: 2,
    flows_per_iteration: 20,
    base_seed: "1337",
    retained_failing_seed: null,
    totals: {
      iterations: 2,
      flows: options.flows ?? 40,
      tx_success: 24,
      expected_errors: 16,
      unexpected_errors: unexpected,
      compute_units: 0,
      service_ticks: 0,
      errors: unexpected,
      panics
    },
    iterations: [iteration(0), iteration(1)]
  };
}

/** A clean correctness model: guided sim with 0 unexpected / 0 panics → a bounded non-finding. */
export function buildCleanCorrectnessModel(): AssessmentModel {
  const evidence = {
    guided_sim: summarizeGuidedSimRun(guidedSimDoc({}), {
      label: "defunds-guided-main",
      path: "sim/artifacts/defunds-guided-main/guided-sim-run.json",
      sha256: "a".repeat(64)
    }),
    runs: [],
    packs: []
  };
  return buildCorrectnessAssessmentModel({
    campaignRootLabel: "case-study/.riptide",
    protocolName: "defunds-fixture",
    evidence
  });
}

/** A correctness model with explicit blocked/not-assessed coverage rows folded in from inputs. */
export function buildCorrectnessModelWithBlockedCoverage(): AssessmentModel {
  const evidence = {
    guided_sim: summarizeGuidedSimRun(guidedSimDoc({}), {
      label: "defunds-guided-main",
      path: "sim/artifacts/defunds-guided-main/guided-sim-run.json",
      sha256: "a".repeat(64)
    }),
    runs: [],
    packs: []
  };
  return buildCorrectnessAssessmentModel({
    campaignRootLabel: "case-study/.riptide",
    protocolName: "defunds-fixture",
    evidence,
    inputs: {
      riskPlan: {
        p0_flows: [
          "Token withdrawal finalization",
          "Positive NAV, whitelist-admin, and fee-authority flows"
        ],
        p1_flows: ["Legacy pay_fund_investors path"]
      },
      coverage: [
        {
          priority: "P0",
          flow: "Token withdrawal finalization",
          status: "covered by guided sim",
          evidence_tier: "guided sim",
          commands: ["riptide sim run .riptide/sim --out .riptide/sim/artifacts/defunds-guided-main"],
          artifacts: [".riptide/sim/artifacts/defunds-guided-main/guided-sim-run.json"],
          notes: "Finalize, burn shares, release claim ledger, debit vault, and pay investor."
        },
        {
          priority: "P0",
          flow: "Positive NAV, whitelist-admin, and fee-authority flows",
          status: "blocked",
          evidence_tier: "blocked",
          commands: [],
          artifacts: [],
          notes:
            "Requires hard-coded Defunds NAV authority or platform-authority signer material not available in this checkout."
        },
        {
          priority: "P1",
          flow: "Legacy pay_fund_investors path",
          status: "not assessed",
          evidence_tier: "none",
          commands: [],
          artifacts: [],
          notes: "New payout-session flow was prioritized because it is the chunked payout path under review."
        }
      ]
    }
  });
}

/** A correctness model with an unexpected error + panic → a finding, blocked verdict. */
export function buildFindingCorrectnessModel(): AssessmentModel {
  const evidence = {
    guided_sim: summarizeGuidedSimRun(guidedSimDoc({ unexpected: 2, panics: 1, status: "failed" }), {
      label: "defunds-guided-main",
      path: "sim/artifacts/defunds-guided-main/guided-sim-run.json",
      sha256: "b".repeat(64)
    }),
    runs: [],
    packs: []
  };
  return buildCorrectnessAssessmentModel({
    campaignRootLabel: "case-study/.riptide",
    protocolName: "defunds-fixture",
    evidence
  });
}

/**
 * Write a Defunds-shaped, surface-less workspace to a temp dir: a smoke guided
 * sim (fewer flows) plus a main guided sim (more flows) so the deterministic
 * "most flows wins" selection is exercised, a run-collection, and a pack.
 */
export async function writeCorrectnessWorkspace(
  options: { dotRiptideRoot?: boolean; runArtifactsDir?: string } = {}
): Promise<{ root: string; cleanupRoot: string }> {
  const cleanupRoot = await mkdtemp(path.join(os.tmpdir(), "riptide-assess-correctness-"));
  const root = options.dotRiptideRoot ? path.join(cleanupRoot, ".riptide") : cleanupRoot;
  await mkdir(root, { recursive: true });

  const smokeDir = path.join(root, "sim", "artifacts", "defunds-guided-smoke");
  const mainDir = path.join(root, "sim", "artifacts", "defunds-guided-main");
  await mkdir(smokeDir, { recursive: true });
  await mkdir(mainDir, { recursive: true });
  await writeFile(
    path.join(smokeDir, "guided-sim-run.json"),
    JSON.stringify(guidedSimDoc({ flows: 20 }), null, 2) + "\n",
    "utf8"
  );
  await writeFile(
    path.join(mainDir, "guided-sim-run.json"),
    JSON.stringify(guidedSimDoc({ flows: 80 }), null, 2) + "\n",
    "utf8"
  );

  await writeFile(
    path.join(root, "run-collection.json"),
    JSON.stringify(
      {
        schema_version: 1,
        scenarios: [
          {
            name: "deposit-delegated-accounting",
            status: "pass",
            artifacts_dir: options.runArtifactsDir ?? "runs/deposit-delegated-accounting",
            interpretation: { summary: "No failure observed in this run." }
          }
        ]
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  const packDir = path.join(root, "pack", "deposit-delegated-accounting");
  await mkdir(packDir, { recursive: true });
  await writeFile(
    path.join(packDir, "manifest.json"),
    JSON.stringify({ schema_version: 1, kind: "simulation-run", canonical_hash: "c".repeat(64) }, null, 2) + "\n",
    "utf8"
  );

  return { root, cleanupRoot };
}
