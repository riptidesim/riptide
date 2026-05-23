import test from "node:test";
import assert from "node:assert/strict";

import { buildRiskSurfaceDocument, type BuildRiskSurfaceInput } from "../src/campaign/surface.js";
import { renderRiskSurfaceNarrative } from "../src/report/surface-narrative.js";
import type { ParameterDistribution } from "../src/campaign/schema.js";

const CAMPAIGN: BuildRiskSurfaceInput["campaign"] = {
  campaignId: "campaign_render",
  campaignDigest: "deadbeef",
  name: "render-cartography",
  semanticClass: "lending.v1",
  riskObjective: "liquidation-safety",
  seedPolicyDisplay: "fixed:20260523",
  runBudget: 12,
  requestedRuns: 12
};

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
    badDebt: 0,
    utilization: 1,
    tvl: 1000,
    availableLiquidity: 500,
    riskScore: 0
  };
}

/** A 2x3 gradient: storm + higher whale share -> higher failure rate. */
function gradientSurface() {
  const input: BuildRiskSurfaceInput = {
    campaign: CAMPAIGN,
    parameters: {
      shock_profile: discrete(["calm", "storm"]),
      whale_share_bps: discrete([2500, 5000, 7500])
    },
    runs: [
      run("pass", { shock_profile: "calm", whale_share_bps: 2500 }),
      run("pass", { shock_profile: "calm", whale_share_bps: 2500 }),
      run("pass", { shock_profile: "calm", whale_share_bps: 5000 }),
      run("pass", { shock_profile: "calm", whale_share_bps: 5000 }),
      run("pass", { shock_profile: "calm", whale_share_bps: 7500 }),
      run("fail", { shock_profile: "calm", whale_share_bps: 7500 }),
      run("pass", { shock_profile: "storm", whale_share_bps: 2500 }),
      run("fail", { shock_profile: "storm", whale_share_bps: 2500 }),
      run("fail", { shock_profile: "storm", whale_share_bps: 5000 }),
      run("fail", { shock_profile: "storm", whale_share_bps: 5000 }),
      run("fail", { shock_profile: "storm", whale_share_bps: 7500 }),
      run("fail", { shock_profile: "storm", whale_share_bps: 7500 })
    ]
  };
  return buildRiskSurfaceDocument(input);
}

test("surface-narrative: renders a 2D heatmap over the two most-sensitive axes with shading glyphs", () => {
  const md = renderRiskSurfaceNarrative(gradientSurface());

  assert.match(md, /## Risk Surface/);
  assert.match(md, /### Parameter sensitivity/);
  assert.match(md, /### Failure-rate heatmap/);
  assert.match(md, /### Safe region \(failure rate ≤ 5\.0%\)/);

  // shock_profile is the more sensitive axis -> rows; whale_share_bps -> columns.
  assert.match(md, /shock_profile ↓ \\ whale_share_bps →/);
  // The calm/2500 cell is all-pass (lightest glyph); both storm-high cells are 100%.
  assert.match(md, /░ 0\.0%/);
  assert.match(md, /█ 100\.0%/);
  // Legend present so the glyphs are cold-readable.
  assert.match(md, /`░` 0–25%/);
});

test("surface-narrative: byte-deterministic across two renders of a fixed surface", () => {
  const doc = gradientSurface();
  assert.equal(renderRiskSurfaceNarrative(doc), renderRiskSurfaceNarrative(doc));
});

test("surface-narrative: 1D surface renders a per-bin column, no 2D grid", () => {
  const doc = buildRiskSurfaceDocument({
    campaign: CAMPAIGN,
    parameters: { whale_share_bps: discrete([2500, 7500]) },
    runs: [run("pass", { whale_share_bps: 2500 }), run("fail", { whale_share_bps: 7500 })]
  });
  const md = renderRiskSurfaceNarrative(doc);
  assert.match(md, /Axis: `whale_share_bps` \(most sensitive\)\./);
  assert.doesNotMatch(md, /↓ \\/);
});

test("surface-narrative: no-safe-region surface states it explicitly, never a blank section", () => {
  const doc = buildRiskSurfaceDocument({
    campaign: CAMPAIGN,
    parameters: { whale_share_bps: discrete([2500, 7500]) },
    runs: [
      run("fail", { whale_share_bps: 2500 }),
      run("fail", { whale_share_bps: 2500 }),
      run("fail", { whale_share_bps: 7500 }),
      run("fail", { whale_share_bps: 7500 })
    ]
  });
  const md = renderRiskSurfaceNarrative(doc);
  assert.match(md, /No cell stayed at or under the 5% failure-rate threshold/);
});
