import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runAssess, type AssessCommandDeps } from "../src/commands/assess.js";
import {
  buildCartographyArtifacts,
  emitCartographyRoot,
  iterationStatus,
  mapIterationsToRuns,
  type GuidedSimRunDocument
} from "../src/sim/cartography.js";

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
      cartography: CARTO
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
    assert.match(md, /not produced by `riptide campaign run`/);
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
