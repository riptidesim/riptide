import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildRiskSurfaceDocument,
  serializeRiskSurface,
  RISK_SURFACE_HASH_PREFIX,
  type BuildRiskSurfaceInput,
  type RiskSurfaceRunInput
} from "../src/campaign/surface.js";
import { canonicalJson, sha256Hex } from "../src/state-pack/json.js";
import type { ParameterDistribution } from "../src/campaign/schema.js";
import {
  executeCampaign,
  parseCampaignToml
} from "../src/campaign/index.js";
import type { SimulationResult } from "../src/compiler/schema.js";
import {
  resolveArtifactsDir,
  type RunOneContext
} from "../src/run/loop.js";

const LENDING_CAMPAIGN: BuildRiskSurfaceInput["campaign"] = {
  campaignId: "campaign_test",
  campaignDigest: "deadbeef",
  name: "unit-cartography",
  semanticClass: "lending.v1",
  riskObjective: "liquidation-safety",
  seedPolicyDisplay: "fixed:1",
  runBudget: 8,
  requestedRuns: 8
};

function discrete(values: Array<string | number>): ParameterDistribution {
  return { distribution: "discrete", values, weights: values.map(() => 1) };
}

function run(
  runIndex: number,
  status: RiskSurfaceRunInput["status"],
  sampledParameters: Record<string, string | number>,
  metrics: Partial<Pick<RiskSurfaceRunInput, "badDebt" | "utilization" | "tvl" | "availableLiquidity" | "riskScore">> = {}
): RiskSurfaceRunInput {
  return {
    runIndex,
    status,
    sampledParameters,
    badDebt: metrics.badDebt ?? 0,
    utilization: metrics.utilization ?? 1,
    tvl: metrics.tvl ?? 1000,
    availableLiquidity: metrics.availableLiquidity ?? 500,
    riskScore: metrics.riskScore ?? 0
  };
}

test("campaign-surface producer: bins a 2D sweep into a complete, ordered grid with failure rates and linear percentiles", () => {
  const doc = buildRiskSurfaceDocument({
    campaign: LENDING_CAMPAIGN,
    parameters: {
      shock_profile: discrete(["calm", "storm"]),
      whale_share_bps: discrete([2500, 7500])
    },
    runs: [
      run(0, "pass", { shock_profile: "calm", whale_share_bps: 2500 }),
      run(1, "pass", { shock_profile: "calm", whale_share_bps: 2500 }),
      run(2, "pass", { shock_profile: "calm", whale_share_bps: 7500 }),
      run(3, "fail", { shock_profile: "calm", whale_share_bps: 7500 }),
      run(4, "pass", { shock_profile: "storm", whale_share_bps: 2500 }),
      run(5, "fail", { shock_profile: "storm", whale_share_bps: 2500 }),
      run(6, "fail", { shock_profile: "storm", whale_share_bps: 7500 }, { badDebt: 1000 }),
      run(7, "fail", { shock_profile: "storm", whale_share_bps: 7500 }, { badDebt: 2000 })
    ]
  });

  // Axes sorted by name; 2 bins each.
  assert.deepEqual(doc.axes.map((axis) => axis.name), ["shock_profile", "whale_share_bps"]);
  assert.equal(doc.axes[0]!.kind, "discrete");
  assert.deepEqual(doc.axes[0]!.bins.map((bin) => bin.value), ["calm", "storm"]);

  // Complete 2x2 grid, ordered lexicographically by (shock, whale) bin index.
  assert.equal(doc.cells.length, 4);
  assert.deepEqual(
    doc.cells.map((cell) => cell.coords.map((coord) => coord.bin_index)),
    [[0, 0], [0, 1], [1, 0], [1, 1]]
  );
  assert.deepEqual(doc.cells.map((cell) => cell.invariant_failure_rate), [0, 0.5, 0.5, 1]);
  assert.deepEqual(doc.cells.map((cell) => cell.run_count), [2, 2, 2, 2]);
  assert.deepEqual(doc.cells.map((cell) => cell.sparse), [false, false, false, false]);

  // Linear (type-7) percentiles on the (storm, 7500) cell: bad_debt [1000, 2000].
  const stormHigh = doc.cells[3]!.metrics.bad_debt!;
  assert.deepEqual(stormHigh, { count: 2, p10: 1100, p50: 1500, p90: 1900 });

  assert.deepEqual(doc.metrics, ["bad_debt", "utilization", "tvl", "available_liquidity"]);
  assert.deepEqual(doc.warnings, []);
});

test("campaign-surface producer: sensitivity ranks by failure-rate spread with deterministic name tie-break", () => {
  const doc = buildRiskSurfaceDocument({
    campaign: LENDING_CAMPAIGN,
    parameters: {
      shock_profile: discrete(["calm", "storm"]),
      whale_share_bps: discrete([2500, 7500])
    },
    runs: [
      run(0, "pass", { shock_profile: "calm", whale_share_bps: 2500 }),
      run(1, "pass", { shock_profile: "calm", whale_share_bps: 2500 }),
      run(2, "pass", { shock_profile: "calm", whale_share_bps: 7500 }),
      run(3, "fail", { shock_profile: "calm", whale_share_bps: 7500 }),
      run(4, "pass", { shock_profile: "storm", whale_share_bps: 2500 }),
      run(5, "fail", { shock_profile: "storm", whale_share_bps: 2500 }),
      run(6, "fail", { shock_profile: "storm", whale_share_bps: 7500 }),
      run(7, "fail", { shock_profile: "storm", whale_share_bps: 7500 })
    ]
  });

  // Both axes have a 0.25 -> 0.75 marginal spread (0.5); the tie breaks by name asc.
  assert.deepEqual(
    doc.sensitivity.ranking.map((entry) => [entry.rank, entry.axis, entry.failure_rate_spread]),
    [[1, "shock_profile", 0.5], [2, "whale_share_bps", 0.5]]
  );
  assert.equal(doc.sensitivity.ranking[0]!.min_bin_failure_rate, 0.25);
  assert.equal(doc.sensitivity.ranking[0]!.max_bin_failure_rate, 0.75);
  assert.equal(doc.sensitivity.ranking[0]!.monotonic, "increasing");
  assert.match(doc.sensitivity.method, /marginal/i);
});

test("campaign-surface sensitivity: elasticity is the signed per-bin-step slope, null when one bin populated", () => {
  const doc = buildRiskSurfaceDocument({
    campaign: LENDING_CAMPAIGN,
    parameters: {
      whale_share_bps: discrete([2500, 5000, 7500]),
      // A second varying axis keeps whale_share_bps a genuine swept axis while
      // only its first bin is populated, exercising the null-elasticity path.
      shock_profile: discrete(["calm", "storm"])
    },
    runs: [
      // whale_share_bps marginal across its 3 bins: 0% -> 50% -> 100% (slope +0.5/step).
      run(0, "pass", { whale_share_bps: 2500, shock_profile: "calm" }),
      run(1, "pass", { whale_share_bps: 2500, shock_profile: "storm" }),
      run(2, "pass", { whale_share_bps: 5000, shock_profile: "calm" }),
      run(3, "fail", { whale_share_bps: 5000, shock_profile: "storm" }),
      run(4, "fail", { whale_share_bps: 7500, shock_profile: "calm" }),
      run(5, "fail", { whale_share_bps: 7500, shock_profile: "storm" })
    ]
  });

  const whale = doc.sensitivity.ranking.find((entry) => entry.axis === "whale_share_bps")!;
  assert.equal(whale.elasticity, 0.5, "first->last populated bin: (1.0 - 0.0) / (2 - 0) = 0.5");
  assert.equal(whale.monotonic, "increasing");

  // shock_profile: calm bins 1/3 fail, storm 2/3 fail -> two populated bins one
  // index apart, so elasticity is the rise across that single step, computed from
  // the already-6-decimal-rounded per-bin rates (0.666667 - 0.333333).
  const shock = doc.sensitivity.ranking.find((entry) => entry.axis === "shock_profile")!;
  assert.equal(shock.elasticity, roundTo6(0.666667 - 0.333333));
});

test("campaign-surface safe-region: no cell under threshold yields an explicit none status, never a silent empty", () => {
  const doc = buildRiskSurfaceDocument({
    campaign: LENDING_CAMPAIGN,
    parameters: { whale_share_bps: discrete([2500, 7500]) },
    runs: [
      run(0, "fail", { whale_share_bps: 2500 }),
      run(1, "fail", { whale_share_bps: 2500 }),
      run(2, "fail", { whale_share_bps: 7500 }),
      run(3, "fail", { whale_share_bps: 7500 })
    ]
  });

  assert.equal(doc.safe_region.status, "none");
  assert.deepEqual(doc.safe_region.bounds, []);
  assert.equal(doc.safe_region.worst_case_failure_rate, null);
  assert.match(doc.safe_region.message, /No cell stayed at or under/);
  assert.doesNotMatch(doc.safe_region.message, /production/i);
});

test("campaign-surface safe-region: bounds do not envelope unsafe diagonal cells", () => {
  const doc = buildRiskSurfaceDocument({
    campaign: LENDING_CAMPAIGN,
    parameters: {
      axis_a: discrete(["low", "high"]),
      axis_b: discrete([1, 2])
    },
    runs: [
      run(0, "pass", { axis_a: "low", axis_b: 1 }),
      run(1, "fail", { axis_a: "low", axis_b: 2 }),
      run(2, "fail", { axis_a: "high", axis_b: 1 }),
      run(3, "pass", { axis_a: "high", axis_b: 2 })
    ]
  });

  assert.equal(doc.safe_region.status, "found");
  assert.equal(doc.safe_region.worst_case_failure_rate, 0);
  assert.match(doc.safe_region.message, /single representable region/);
  const axisA = doc.safe_region.bounds.find((bound) => bound.axis === "axis_a")!;
  const axisB = doc.safe_region.bounds.find((bound) => bound.axis === "axis_b")!;
  assert.deepEqual(axisA.allowed_values, ["low"]);
  assert.deepEqual(axisB.allowed_values, [1]);
});

test("campaign-surface safe-region: the threshold is a config field that widens the safe region", () => {
  const input: BuildRiskSurfaceInput = {
    campaign: LENDING_CAMPAIGN,
    parameters: { whale_share_bps: discrete([2500, 7500]) },
    runs: [
      run(0, "pass", { whale_share_bps: 2500 }),
      run(1, "pass", { whale_share_bps: 2500 }),
      // 7500 bin sits at a 50% failure rate.
      run(2, "pass", { whale_share_bps: 7500 }),
      run(3, "fail", { whale_share_bps: 7500 })
    ]
  };

  // Default 5% threshold: only the all-pass 2500 bin qualifies.
  const strict = buildRiskSurfaceDocument(input);
  assert.equal(strict.config.safe_region_failure_rate_threshold, 0.05);
  assert.equal(strict.safe_region.status, "found");
  assert.deepEqual(
    strict.safe_region.bounds.find((bound) => bound.axis === "whale_share_bps")!.allowed_values,
    [2500]
  );

  // A 50% threshold admits the 7500 bin too: the whole populated region is safe.
  const relaxed = buildRiskSurfaceDocument({
    ...input,
    config: { safeRegionFailureRateThreshold: 0.5 }
  });
  assert.equal(relaxed.config.safe_region_failure_rate_threshold, 0.5);
  assert.equal(relaxed.safe_region.status, "entire-region");
  assert.equal(relaxed.safe_region.worst_case_failure_rate, 0.5);
});

function roundTo6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

test("campaign-surface producer: safe region reports per-axis bounds under the threshold", () => {
  const doc = buildRiskSurfaceDocument({
    campaign: LENDING_CAMPAIGN,
    parameters: {
      shock_profile: discrete(["calm", "storm"]),
      whale_share_bps: discrete([2500, 7500])
    },
    runs: [
      run(0, "pass", { shock_profile: "calm", whale_share_bps: 2500 }),
      run(1, "pass", { shock_profile: "calm", whale_share_bps: 2500 }),
      run(2, "pass", { shock_profile: "calm", whale_share_bps: 7500 }),
      run(3, "fail", { shock_profile: "calm", whale_share_bps: 7500 }),
      run(4, "fail", { shock_profile: "storm", whale_share_bps: 2500 }),
      run(5, "fail", { shock_profile: "storm", whale_share_bps: 2500 }),
      run(6, "fail", { shock_profile: "storm", whale_share_bps: 7500 }),
      run(7, "fail", { shock_profile: "storm", whale_share_bps: 7500 })
    ]
  });

  assert.equal(doc.safe_region.status, "found");
  assert.equal(doc.safe_region.threshold, 0.05);
  assert.equal(doc.safe_region.worst_case_failure_rate, 0);
  const shockBound = doc.safe_region.bounds.find((bound) => bound.axis === "shock_profile")!;
  assert.deepEqual(shockBound.allowed_values, ["calm"]);
  const whaleBound = doc.safe_region.bounds.find((bound) => bound.axis === "whale_share_bps")!;
  assert.deepEqual(whaleBound.allowed_values, [2500]);
  assert.match(doc.safe_region.message, /declared, fixed-seed parameter region/);
  assert.doesNotMatch(doc.safe_region.message, /production/i);
});

test("campaign-surface producer: all-pass campaign yields a zero-failure entire-region safe surface", () => {
  const doc = buildRiskSurfaceDocument({
    campaign: LENDING_CAMPAIGN,
    parameters: { whale_share_bps: discrete([2500, 7500]) },
    runs: [
      run(0, "pass", { whale_share_bps: 2500 }),
      run(1, "pass", { whale_share_bps: 2500 }),
      run(2, "pass", { whale_share_bps: 7500 }),
      run(3, "pass", { whale_share_bps: 7500 })
    ]
  });

  assert.deepEqual(doc.cells.map((cell) => cell.invariant_failure_rate), [0, 0]);
  assert.equal(doc.safe_region.status, "entire-region");
  assert.equal(doc.safe_region.worst_case_failure_rate, 0);
});

test("campaign-surface producer: a single swept axis produces a 1D surface", () => {
  const doc = buildRiskSurfaceDocument({
    campaign: LENDING_CAMPAIGN,
    parameters: {
      shock_profile: { distribution: "fixed", value: "price-shock" },
      whale_share_bps: { distribution: "uniform", min: 0, max: 8000, integer: true }
    },
    runs: [
      run(0, "pass", { shock_profile: "price-shock", whale_share_bps: 100 }),
      run(1, "fail", { shock_profile: "price-shock", whale_share_bps: 7000 })
    ]
  });

  // The fixed axis collapses to one bin and is not swept; only the continuous axis remains.
  assert.deepEqual(doc.axes.map((axis) => axis.name), ["whale_share_bps"]);
  assert.equal(doc.axes[0]!.kind, "continuous");
  assert.equal(doc.axes[0]!.binning.method, "fixed-width");
  assert.equal(doc.cells.length, 4); // DEFAULT_CONTINUOUS_BIN_COUNT bins.
  assert.deepEqual(doc.cells.map((cell) => cell.coords.length), [1, 1, 1, 1]);
});

test("campaign-surface producer: no swept axes collapses to one aggregate cell with a warning", () => {
  const doc = buildRiskSurfaceDocument({
    campaign: LENDING_CAMPAIGN,
    parameters: {
      shock_profile: { distribution: "fixed", value: "price-shock" },
      borrower_count: { distribution: "fixed", value: 1 }
    },
    runs: [
      run(0, "pass", { shock_profile: "price-shock", borrower_count: 1 }),
      run(1, "fail", { shock_profile: "price-shock", borrower_count: 1 })
    ]
  });

  assert.deepEqual(doc.axes, []);
  assert.equal(doc.cells.length, 1);
  assert.deepEqual(doc.cells[0]!.coords, []);
  assert.equal(doc.cells[0]!.run_count, 2);
  assert.equal(doc.cells[0]!.invariant_failure_rate, 0.5);
  assert.deepEqual(doc.sensitivity.ranking, []);
  assert.match(doc.warnings.join("\n"), /no varying parameters/);
});

test("campaign-surface producer: sparse cells are flagged in warnings, never dropped", () => {
  const doc = buildRiskSurfaceDocument({
    campaign: LENDING_CAMPAIGN,
    parameters: { whale_share_bps: discrete([2500, 7500]) },
    runs: [
      run(0, "fail", { whale_share_bps: 2500 })
      // No run lands in the 7500 bin.
    ]
  });

  assert.equal(doc.cells.length, 2);
  const populated = doc.cells.find((cell) => cell.run_count === 1)!;
  assert.equal(populated.sparse, true, "a 1-run cell is below the default min of 2");
  const empty = doc.cells.find((cell) => cell.run_count === 0)!;
  assert.equal(empty.sparse, true);
  assert.match(doc.warnings.join("\n"), /fewer than 2 run/);
  assert.match(doc.warnings.join("\n"), /received no runs/);
});

test("campaign-surface producer: generic (non-lending) classes use the risk_score metric", () => {
  const doc = buildRiskSurfaceDocument({
    campaign: { ...LENDING_CAMPAIGN, semanticClass: "amm.v1" },
    parameters: { whale_share_bps: discrete([2500, 7500]) },
    runs: [
      run(0, "pass", { whale_share_bps: 2500 }, { riskScore: 10 }),
      run(1, "pass", { whale_share_bps: 7500 }, { riskScore: 20 })
    ]
  });

  assert.deepEqual(doc.metrics, ["risk_score"]);
  assert.ok(doc.cells.every((cell) => Object.keys(cell.metrics).join() === "risk_score"));
});

test("campaign-surface producer: output is byte-deterministic and carries a verifiable self-digest", () => {
  const input: BuildRiskSurfaceInput = {
    campaign: LENDING_CAMPAIGN,
    parameters: {
      shock_profile: discrete(["calm", "storm"]),
      whale_share_bps: discrete([2500, 7500])
    },
    runs: [
      run(0, "pass", { shock_profile: "calm", whale_share_bps: 2500 }),
      run(1, "fail", { shock_profile: "storm", whale_share_bps: 7500 }, { badDebt: 1234.5678901 })
    ]
  };
  const first = serializeRiskSurface(buildRiskSurfaceDocument(input));
  const second = serializeRiskSurface(buildRiskSurfaceDocument(input));
  assert.equal(first, second, "two builds of identical input must be byte-identical");
  assert.ok(first.endsWith("\n"), "canonical JSON is newline-terminated");

  const doc = buildRiskSurfaceDocument(input);
  const { surface_digest, ...rest } = doc;
  const expected = sha256Hex(`${RISK_SURFACE_HASH_PREFIX}\n${canonicalJson(rest as never)}`);
  assert.equal(surface_digest, expected, "embedded surface_digest matches a recompute over the body");
  assert.match(surface_digest, /^[a-f0-9]{64}$/);
});

test("campaign-surface end-to-end: campaign run writes a non-empty, deterministic, additive risk-surface.json", async () => {
  const root = await cartographyFixtureRoot();
  const spec = parseCampaignToml(
    await readFile(path.join(root, "campaign.toml"), "utf8"),
    path.join(root, "campaign.toml")
  );

  const runOne = async (ctx: RunOneContext) => {
    const config = JSON.parse(await readFile(ctx.scenario.runConfigPath, "utf8")) as {
      campaign?: { sampled_parameters?: Record<string, unknown> };
    };
    const sampled = config.campaign?.sampled_parameters ?? {};
    const whale = Number(sampled.whale_share_bps ?? 0);
    const storm = sampled.shock_profile === "storm";
    const willFail = storm && whale >= 6000;
    const simulation = simulationResult({
      totalBadDebt: willFail ? whale : 0,
      maxUtilization: storm ? 2 : 1,
      minTvl: willFail ? 300 : 900
    });
    const artifactsDir = await writeArtifacts(ctx, simulation);
    return willFail
      ? {
          kind: "fail" as const,
          wallClockS: 0.01,
          artifactsDir,
          result: simulation,
          fires: [{ name: "bad_debt_bound", tick: 2 }]
        }
      : { kind: "pass" as const, wallClockS: 0.01, artifactsDir, result: simulation };
  };

  const first = await executeCampaign(spec, { cwd: root, outputRoot: path.join(root, "out-a"), runOne });

  const surfaceRaw = await readFile(first.artifactPaths.riskSurfaceJsonPath, "utf8");
  assert.ok(surfaceRaw.length > 0, "risk-surface.json is non-empty");
  const surface = JSON.parse(surfaceRaw) as {
    schema_version: string;
    axes: Array<{ name: string }>;
    cells: Array<{ invariant_failure_rate: number; run_count: number }>;
    sensitivity: { ranking: Array<{ axis: string }> };
    safe_region: { status: string };
    surface_digest: string;
  };
  assert.deepEqual(
    Object.keys(surface).sort(),
    [
      "axes",
      "campaign",
      "cells",
      "claim_boundary",
      "config",
      "metrics",
      "safe_region",
      "schema_version",
      "sensitivity",
      "surface_digest",
      "warnings"
    ]
  );
  assert.equal(surface.schema_version, "risk-surface.v1");
  assert.deepEqual(surface.axes.map((axis) => axis.name).sort(), ["shock_profile", "whale_share_bps"]);
  assert.equal(surface.sensitivity.ranking.length, 2);
  assert.ok(surface.cells.every((cell) => cell.invariant_failure_rate >= 0 && cell.invariant_failure_rate <= 1));
  assert.ok(["found", "none", "entire-region"].includes(surface.safe_region.status));

  // Additive contract: existing campaign-summary.json artifacts remain stable,
  // with risk_surface appended as the new discoverable artifact path.
  const summary = JSON.parse(await readFile(first.artifactPaths.summaryJsonPath, "utf8")) as {
    artifacts: Record<string, string>;
  };
  assert.deepEqual(summary.artifacts, {
    runs_jsonl: "runs.jsonl",
    parameters_csv: "parameters.csv",
    retention_manifest: "retention-manifest.json",
    markdown_summary: "campaign-summary.md",
    risk_surface: "risk-surface.json"
  });

  const manifest = JSON.parse(await readFile(first.artifactPaths.retentionManifestPath, "utf8")) as {
    artifacts: Record<string, string>;
  };
  assert.deepEqual(manifest.artifacts, { risk_surface: "risk-surface.json" });

  // Determinism: a second identical campaign emits byte-identical surface bytes.
  const second = await executeCampaign(spec, { cwd: root, outputRoot: path.join(root, "out-b"), runOne });
  const secondRaw = await readFile(second.artifactPaths.riskSurfaceJsonPath, "utf8");
  assert.equal(secondRaw, surfaceRaw, "risk-surface.json is byte-identical across two runs");
});

async function writeArtifacts(ctx: RunOneContext, result: SimulationResult): Promise<string> {
  const artifactsDir = resolveArtifactsDir(ctx);
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(
    path.join(artifactsDir, "simulation-result.json"),
    JSON.stringify(result, null, 2) + "\n",
    "utf8"
  );
  await writeFile(path.join(artifactsDir, "report.md"), "# Report\n", "utf8");
  return artifactsDir;
}

function simulationResult(metrics: {
  totalBadDebt: number;
  maxUtilization: number;
  minTvl: number;
}): SimulationResult {
  return {
    run_config: {
      agents: 1,
      ticks: 4,
      scenario: "unit",
      seed: 1,
      personas: ["whale"],
      validator_url: "unused",
      output_path: ".riptide/runs/unit"
    },
    seed: 1,
    total_ticks: 4,
    timeseries: [
      { tick: 0, active_agents: 1, tvl: 1000, utilization: 0, cumulative_bad_debt: 0, cumulative_liquidations: 0 },
      {
        tick: 4,
        active_agents: 1,
        tvl: metrics.minTvl,
        utilization: metrics.maxUtilization,
        cumulative_bad_debt: metrics.totalBadDebt,
        cumulative_liquidations: metrics.totalBadDebt > 0 ? 1 : 0
      }
    ],
    events: [],
    agents: [],
    summary: {
      agents_active: 1,
      agents_liquidated: 0,
      agents_depleted: 0,
      final_tvl: metrics.minTvl,
      final_utilization: metrics.maxUtilization,
      total_bad_debt: metrics.totalBadDebt,
      total_liquidations: metrics.totalBadDebt > 0 ? 1 : 0,
      invariants_fired: [
        { name: "bad_debt_bound", field: "bad_debt", op: "<=", value: 0, firings: 0 }
      ]
    },
    simulation_boundaries: ["unit test"]
  };
}

async function cartographyFixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-campaign-cartography-"));
  await mkdir(path.join(root, "fixtures", "adapters"), { recursive: true });
  await mkdir(path.join(root, "fixtures", "personas"), { recursive: true });
  await mkdir(path.join(root, "fixtures", "scenarios", "lending", "oracle-lag-baseline"), {
    recursive: true
  });
  await writeFile(path.join(root, "fixtures", "adapters", "lending.toml"), "", "utf8");
  await writeFile(path.join(root, "fixtures", "personas", "whale.toml"), "", "utf8");
  await writeFile(
    path.join(root, "fixtures", "scenarios", "lending", "oracle-lag-baseline", "run-config.json"),
    JSON.stringify(
      {
        agents: 4,
        ticks: 4,
        scenario: "price-shock",
        personas: ["whale", "steady-lp", "steady-lp", "steady-lp"],
        validator_url: "unused",
        output_path: "template-output"
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(path.join(root, "campaign.toml"), cartographyCampaignToml(), "utf8");
  return root;
}

function cartographyCampaignToml(): string {
  return `
[campaign]
name = "lending-cartography"
adapter = "fixtures/adapters/lending.toml"
class = "lending.v1"
risk_objective = "liquidation-safety"
run_budget = 16
seed_policy = "fixed:20260523"

[campaign.scenarios]
selection = "weighted"
families = ["oracle_shock"]

[campaign.scenarios.oracle_shock]
source = "fixtures/scenarios/lending/oracle-lag-baseline"
weight = 1
parameters = ["shock_profile", "whale_share_bps"]

[campaign.personas]
base = "fixtures/personas"
families = ["retail_borrowers"]

[campaign.personas.retail_borrowers]
source = "whale.toml"
count = "borrower_count"

[campaign.parameters.shock_profile]
distribution = "discrete"
values = ["calm", "storm"]
weights = [1, 1]

[campaign.parameters.whale_share_bps]
distribution = "discrete"
values = [2500, 5000, 7500]
weights = [1, 1, 1]

[campaign.parameters.borrower_count]
distribution = "fixed"
value = 1
`;
}
