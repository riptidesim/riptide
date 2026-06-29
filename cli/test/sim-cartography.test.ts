import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runAssess, type AssessCommandDeps } from "../src/commands/assess.js";
import {
  buildCartographyArtifacts,
  emitCartographyRoot,
  formatSweepFlags,
  iterationStatus,
  mapIterationsToRuns,
  readSweepConfig,
  sweepAxes,
  type GuidedSimRunDocument
} from "../src/sim/cartography.js";
import { renderRiskSurfaceNarrative } from "../src/report/surface-narrative.js";
import type { RiskSurfaceDocument } from "../src/campaign/surface.js";

/**
 * A synthetic guided-sim sweep over `rate_shock_bps`: 4 values x 3 seeds, where
 * the solvency invariant fires with rising frequency as the shock climbs, one
 * iteration carries a returned execution error, and bad_debt / liquidations are
 * recorded. Fixed inputs so the surface bytes are pinnable.
 */
function syntheticSweepDoc(): GuidedSimRunDocument {
  const values = [0, 100, 300, 500];
  const seedsPerValue = 3;
  const iterations = [];
  let idx = 0;
  for (const v of values) {
    for (let s = 0; s < seedsPerValue; s += 1) {
      const fires = v >= 300 && s < (v === 500 ? 3 : 1) ? ["solvency"] : [];
      // The single 100-bps replicate s===2 simulates a returned execution error
      // (runner marks it "failed") — it must NOT count as an invariant failure.
      const returnedError = v === 100 && s === 2;
      iterations.push({
        iteration: idx,
        seed: idx.toString(16).padStart(64, "0"),
        status: returnedError ? "failed" : "passed",
        panic: false,
        parameters: { rate_shock_bps: v },
        metrics: { bad_debt: v * 10 + s, liquidations: Math.max(0, Math.floor((v - 200) / 100)) },
        tx_outcomes: [
          { label: "open_swap", ok: true },
          { label: "settle_period", ok: true },
          { label: "liquidate_position", ok: true },
          { label: "invariant:solvency:held", ok: true }
        ],
        ...(fires.length ? { invariant_fires: fires } : {})
      });
      idx += 1;
    }
  }
  return {
    status: "passed",
    base_seed: "52".repeat(32),
    retained_failing_seed: null,
    iterations
  };
}

const SWEEP = { name: "rate_shock_bps", values: [0, 100, 300, 500], seedsPerValue: 3 };
const CARTO = { class: "lending.v1", riskObjective: "solvency" };

test("sim cartography: returned execution errors are `error`, only invariant fires are `fail`", () => {
  assert.equal(
    iterationStatus({ iteration: 0, seed: "x", status: "failed", invariant_fires: [] }),
    "error",
    "a non-panic returned error must not inflate the invariant-failure rate"
  );
  assert.equal(
    iterationStatus({ iteration: 0, seed: "x", status: "panic", panic: true }),
    "error"
  );
  assert.equal(
    iterationStatus({ iteration: 0, seed: "x", status: "passed", invariant_fires: ["solvency"] }),
    "fail",
    "a declared invariant fire is the economic-failure signal"
  );
  assert.equal(iterationStatus({ iteration: 0, seed: "x", status: "passed" }), "pass");
});

test("sim cartography: reads multi-axis sweep manifests for runner forwarding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "carto-multi-axis-"));
  try {
    const manifestPath = path.join(root, "Riptide.toml");
    await writeFile(
      manifestPath,
      `
[sim.sweep]
seeds_per_value = 2

[[sim.sweep.axes]]
name = "rate_shock_bps"
values = [0, 300]

[[sim.sweep.axes]]
name = "collateral_ratio"
values = [1.2, 1.5, 2.0]
`,
      "utf8"
    );

    const sweep = await readSweepConfig(manifestPath);
    assert.ok(sweep);
    assert.equal(sweep.name, "rate_shock_bps");
    assert.deepEqual(sweepAxes(sweep), [
      { name: "rate_shock_bps", values: [0, 300] },
      { name: "collateral_ratio", values: [1.2, 1.5, 2.0] }
    ]);
    assert.deepEqual(formatSweepFlags(sweep), [
      "rate_shock_bps=0,300",
      "collateral_ratio=1.2,1.5,2"
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sim cartography: only records observations the sweep actually measured", () => {
  const doc = syntheticSweepDoc();
  const { campaignSummary } = buildCartographyArtifacts({
    runDoc: doc,
    sweep: SWEEP,
    cartography: CARTO
  });
  const lending = campaignSummary.lending;
  assert.ok(lending);
  // liquidations and bad_debt are recorded; utilization/tvl/available_liquidity are not.
  assert.deepEqual(lending.observations_used, ["bad_debt", "liquidations"]);
  // total_liquidations is mapped from the recorded metric, not a null placeholder.
  assert.notEqual(lending.total_liquidations.max, null);
  // The cartography producer stamps its provenance on the summary adapter.
  assert.equal(campaignSummary.campaign.adapter, "guided-sim");
});

test("sim cartography: a returned-error iteration is excluded from the failure rate", () => {
  const doc = syntheticSweepDoc();
  const runs = mapIterationsToRuns(doc, "rate_shock_bps");
  const errors = runs.filter((r) => r.status === "error").length;
  const fails = runs.filter((r) => r.status === "fail").length;
  assert.equal(errors, 1, "the single returned-error replicate maps to error");
  // 300-bps: 1 of 3 fires; 500-bps: 3 of 3 fire => 4 invariant failures.
  assert.equal(fails, 4);
});

test("sim cartography: guided-sim root assesses as cartography, discloses provenance, never as a plain campaign", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "carto-prov-"));
  try {
    const artifacts = buildCartographyArtifacts({
      runDoc: syntheticSweepDoc(),
      sweep: SWEEP,
      cartography: CARTO,
      // Declare an honest baseline + lifecycle so the execution-honesty gates
      // pass and the assessment emits (the gates are exercised in their own
      // suite). The synthetic sweep runs rate_shock_bps=0 as the control and
      // executes the three core flows every iteration.
      positiveControl: { parameter: "rate_shock_bps", value: 0 },
      lifecycle: { required_flows: ["open_swap", "settle_period", "liquidate_position"] }
    });
    await emitCartographyRoot(artifacts, root);

    let stdout = "";
    const deps: AssessCommandDeps = {
      stdoutWrite: (chunk) => {
        stdout += chunk;
      },
      stderrWrite: () => {},
      color: false
    };
    const exitCode = await runAssess(root, { quiet: true }, deps);
    assert.equal(exitCode, 0, stdout);

    const md = await readFile(path.join(root, "assessment.md"), "utf8");
    // Cartography shape (heatmap), not the correctness no-heatmap degradation.
    assert.match(md, /## Risk Surface/);
    assert.doesNotMatch(md, /correctness-dominated assessment, so there is no risk-surface heatmap/);
    // Provenance is disclosed on the first screen and names the true source.
    assert.match(md, /campaign-cartography artifacts via `riptide sim surface`/);
    assert.match(md, /guided-simulation parameter sweep converted into campaign-cartography artifacts/i);
    // Evidence tiers are guided-sim-labelled, never bare campaign tiers.
    assert.match(md, /guided-sim sweep/);
    assert.match(md, /guided-sim adversarial sweep/);
    assert.doesNotMatch(md, /\| focused campaign \|/);
    // The reproduction path is the guided-sim pipeline, not a campaign run.
    assert.match(md, /riptide sim run \(sweep\) -> riptide sim surface -> riptide assess/);
    // Scope names the real exercised flows (from tx labels), excluding the
    // invariant-check transaction, instead of an opaque single dispatch.
    assert.match(md, /guided-sim flow `open_swap`/);
    assert.match(md, /guided-sim flow `liquidate_position`/);
    assert.doesNotMatch(md, /guided-sim flow `invariant:/);

    // The model JSON (hashed facts) carries the guided-sim adapter marker.
    const model = JSON.parse(await readFile(path.join(root, "assessment.json"), "utf8")) as {
      campaign: { adapter: string };
      surface: unknown;
    };
    assert.equal(model.campaign.adapter, "guided-sim");
    assert.notEqual(model.surface, null, "cartography model embeds the risk surface");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sim cartography: risk-surface.json bytes are stable for a fixed sweep (R6.4 determinism pin)", async () => {
  const a = buildCartographyArtifacts({ runDoc: syntheticSweepDoc(), sweep: SWEEP, cartography: CARTO });
  const b = buildCartographyArtifacts({ runDoc: syntheticSweepDoc(), sweep: SWEEP, cartography: CARTO });
  assert.equal(a.riskSurfaceJson, b.riskSurfaceJson, "same sweep input -> byte-identical surface");
  const digest = createHash("sha256").update(a.riskSurfaceJson, "utf8").digest("hex");
  assert.equal(digest, SURFACE_SHA256, "guided-sim cartography surface bytes drifted from the recorded pin");
});

// Recorded gate hash for the synthetic sweep above. Regenerate intentionally if
// the surface schema or this fixture changes.
const SURFACE_SHA256 = "c6f363ad604426e3bb5af4d8c9d00bb376b805ea21332094ceed8cf6e2ea238e";

/**
 * A synthetic 2-D guided-sim sweep over `rate_shock_bps` x `collateral_ratio`
 * (2 x 3 values, 2 seeds each = 12 iterations). The solvency invariant fires
 * only in the high-shock / low-collateral region, so the surface carries an
 * *interaction* the marginal 1-D slices flatten: failure climbs with the shock
 * but is tempered as the collateral ratio rises. Crucially, EVERY iteration
 * records BOTH axes — the placeability invariant — so the 2x3 grid is fully
 * populated (no run dropped for a missing axis coordinate).
 */
function synthetic2dSweepDoc(): GuidedSimRunDocument {
  const shocks = [0, 300];
  const ratios = [1.2, 1.5, 2.0];
  const seedsPerValue = 2;
  const iterations = [];
  let idx = 0;
  for (const shock of shocks) {
    for (const ratio of ratios) {
      // Fires per (shock, ratio) cell, out of 2 replicates:
      //   shock 0   -> never                 (the safe row)
      //   shock 300 -> 2 at cr<=1.5, 1 at cr 2.0  (the interaction corner)
      const firesInCell = shock === 0 ? 0 : ratio <= 1.5 ? 2 : 1;
      for (let s = 0; s < seedsPerValue; s += 1) {
        const fires = s < firesInCell ? ["solvency"] : [];
        iterations.push({
          iteration: idx,
          seed: idx.toString(16).padStart(64, "0"),
          status: "passed",
          panic: false,
          parameters: { rate_shock_bps: shock, collateral_ratio: ratio },
          metrics: { bad_debt: shock * 10 + (2 - ratio) * 100 + s },
          tx_outcomes: [
            { label: "open_swap", ok: true },
            { label: "liquidate_position", ok: true }
          ],
          ...(fires.length ? { invariant_fires: fires } : {})
        });
        idx += 1;
      }
    }
  }
  return {
    status: "passed",
    base_seed: "5151".repeat(16),
    retained_failing_seed: null,
    iterations
  };
}

// Multi-axis sweep config in the producer's normalized form (the `axes` list is
// what `readSweepConfig` yields for an `[[sim.sweep.axes]]` manifest).
const SWEEP_2D = {
  name: "rate_shock_bps",
  values: [0, 300],
  seedsPerValue: 2,
  axes: [
    { name: "rate_shock_bps", values: [0, 300] },
    { name: "collateral_ratio", values: [1.2, 1.5, 2.0] }
  ]
};

test("sim cartography: a 2-D sweep maps both axes into a full 2-D surface + rows x columns heatmap", () => {
  const artifacts = buildCartographyArtifacts({
    runDoc: synthetic2dSweepDoc(),
    sweep: SWEEP_2D,
    cartography: CARTO
  });
  const surface = JSON.parse(artifacts.riskSurfaceJson) as RiskSurfaceDocument;

  // Both declared axes survive into the surface (each varies over >= 2 bins).
  assert.deepEqual(
    surface.axes.map((a) => a.name).slice().sort(),
    ["collateral_ratio", "rate_shock_bps"]
  );

  // Full 2 x 3 cell grid, every cell populated by its 2 replicates: no run was
  // dropped for a missing axis (R2.2 — `mapIterationsToRuns` carried BOTH axes
  // into `sampledParameters`, so `placeRun` placed all 12 iterations).
  assert.equal(surface.cells.length, 6);
  assert.ok(
    surface.cells.every((c) => c.run_count === 2),
    "every (shock, ratio) cell holds its 2 replicates — no run dropped for a missing axis"
  );

  // Both axes are ranked for sensitivity; the shock dominates (rank 1, -> rows).
  assert.deepEqual(
    surface.sensitivity.ranking.map((r) => r.axis).slice().sort(),
    ["collateral_ratio", "rate_shock_bps"]
  );
  assert.equal(surface.sensitivity.ranking[0]!.axis, "rate_shock_bps");

  // The per-axis marginal summaries carry BOTH axes (R2.3).
  assert.deepEqual(
    Object.keys(artifacts.campaignSummary.parameters).slice().sort(),
    ["collateral_ratio", "rate_shock_bps"]
  );

  // The safe region names bounds on BOTH axes (the safe corner is the shock=0 row).
  assert.notEqual(surface.safe_region.status, "none");
  assert.deepEqual(
    surface.safe_region.bounds.map((b) => b.axis).slice().sort(),
    ["collateral_ratio", "rate_shock_bps"]
  );

  // The heatmap renders as a single 2-D rows x columns grid (rank-1 axis ->
  // rows, rank-2 -> columns), NOT two stacked 1-D gradients.
  const narrative = renderRiskSurfaceNarrative(surface);
  assert.match(
    narrative,
    /Rows: `rate_shock_bps` \(most sensitive, rank 1\)\. Columns: `collateral_ratio` \(rank 2\)\./
  );
  assert.match(narrative, /rate_shock_bps ↓ \\ collateral_ratio →/);
  // The high-shock / low-collateral corner is the worst cell; the safe shock=0
  // row reads 0%. (Both rows present => a real 2-D grid.)
  assert.match(narrative, /\| 0 \| ░ 0\.0% \| ░ 0\.0% \| ░ 0\.0% \|/);
  assert.match(narrative, /\| 300 \| █ 100\.0% \| █ 100\.0% \| ▓ 50\.0% \|/);
});
