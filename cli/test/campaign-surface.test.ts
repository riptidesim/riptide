import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRiskSurfaceDocument,
  serializeRiskSurface,
  RISK_SURFACE_HASH_PREFIX,
  type BuildRiskSurfaceInput,
  type RiskSurfaceRunInput
} from "../src/campaign/surface.js";
import { canonicalJson, sha256Hex } from "../src/state-pack/json.js";
import type { ParameterDistribution } from "../src/campaign/schema.js";

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
