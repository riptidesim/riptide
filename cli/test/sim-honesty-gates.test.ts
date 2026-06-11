import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runAssess, type AssessCommandDeps } from "../src/commands/assess.js";
import {
  buildCartographyArtifacts,
  emitCartographyRoot,
  type GuidedSimRunDocument
} from "../src/sim/cartography.js";
import {
  evaluateDeterminism,
  evaluateLifecycle,
  evaluatePositiveControl
} from "../src/sim/honesty-gates.js";

const SWEEP = { name: "nav_markdown_bps", values: [0, 1000, 3000, 5000], seedsPerValue: 2 };
const CARTO = { class: "lending.v1", riskObjective: "investor dilution" };

const CORE_FLOWS = ["initialize_fund", "deposit", "initiate_withdrawal", "finalize_withdrawal"];

/**
 * A healthy synthetic sweep: control value 0 present and clean, every iteration
 * executes the full lifecycle, no invariant fires.
 */
function healthyDoc(): GuidedSimRunDocument {
  const iterations = [];
  let idx = 0;
  for (const v of SWEEP.values) {
    for (let s = 0; s < SWEEP.seedsPerValue; s += 1) {
      iterations.push({
        iteration: idx,
        seed: idx.toString(16).padStart(64, "0"),
        status: "passed",
        panic: false,
        parameters: { nav_markdown_bps: v },
        metrics: { dilution_loss: 0, bad_debt: 0 },
        tx_outcomes: [
          ...CORE_FLOWS.map((label) => ({ label, ok: true })),
          { label: "invariant:investor_dilution:held", ok: true }
        ]
      });
      idx += 1;
    }
  }
  return { status: "passed", base_seed: "ab".repeat(32), retained_failing_seed: null, iterations };
}

/** Like {@link healthyDoc} but the lifecycle never executed (the `--flows 1` no-op). */
function noOpDoc(): GuidedSimRunDocument {
  const doc = healthyDoc();
  for (const it of doc.iterations) {
    // Only the invariant-check transaction "ran"; no core flow succeeded.
    it.tx_outcomes = [{ label: "invariant:investor_dilution:held", ok: true }];
  }
  return doc;
}

async function assessRoot(root: string): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const deps: AssessCommandDeps = {
    stdoutWrite: (chunk) => {
      stdout += chunk;
    },
    stderrWrite: (chunk) => {
      stderr += chunk;
    },
    color: false
  };
  const code = await runAssess(root, { quiet: true }, deps);
  return { code, stdout, stderr };
}

// ---------------------------------------------------------------------------
// Unit gate logic
// ---------------------------------------------------------------------------

test("positive-control gate: passes when the declared control is present and clean", () => {
  const r = evaluatePositiveControl(healthyDoc(), { parameter: "nav_markdown_bps", value: 0 });
  assert.equal(r.status, "pass");
});

test("positive-control gate: fails when no control is declared", () => {
  const r = evaluatePositiveControl(healthyDoc(), null);
  assert.equal(r.status, "fail");
  assert.match(r.detail, /no positive control declared/);
});

test("positive-control gate: fails when the control coordinate fired an invariant", () => {
  const doc = healthyDoc();
  doc.iterations[0]!.invariant_fires = ["investor_dilution"];
  const r = evaluatePositiveControl(doc, { parameter: "nav_markdown_bps", value: 0 });
  assert.equal(r.status, "fail");
  assert.match(r.detail, /did not yield the known-correct baseline/);
});

test("lifecycle gate: passes when all declared flows executed", () => {
  const r = evaluateLifecycle(healthyDoc(), { required_flows: CORE_FLOWS });
  assert.equal(r.status, "pass");
});

test("lifecycle gate: flags a no-op as `no-op, not robustness`", () => {
  const r = evaluateLifecycle(noOpDoc(), { required_flows: CORE_FLOWS });
  assert.equal(r.status, "fail");
  assert.match(r.detail, /no-op, not robustness/);
});

test("determinism gate: drift between recorded and on-disk surface hash fails", () => {
  assert.equal(evaluateDeterminism("a".repeat(64), "a".repeat(64)).status, "pass");
  const r = evaluateDeterminism("a".repeat(64), "b".repeat(64));
  assert.equal(r.status, "fail");
  assert.match(r.detail, /determinism drift/);
});

// ---------------------------------------------------------------------------
// Emit-time enforcement at the `assess` boundary (the three negative tests)
// ---------------------------------------------------------------------------

test("assess blocks a guided-sim surface with no positive control", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "honesty-noctrl-"));
  try {
    const artifacts = buildCartographyArtifacts({
      runDoc: healthyDoc(),
      sweep: SWEEP,
      cartography: CARTO,
      positiveControl: null,
      lifecycle: { required_flows: CORE_FLOWS }
    });
    await emitCartographyRoot(artifacts, root);
    const { code, stderr } = await assessRoot(root);
    assert.equal(code, 1, stderr);
    assert.match(stderr, /execution-honesty gates blocked/);
    assert.match(stderr, /positive_control/);
    // The block happens before emit: no assessment is written.
    await assert.rejects(readFile(path.join(root, "assessment.md"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assess blocks a guided-sim surface whose lifecycle never executed (no-op)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "honesty-noop-"));
  try {
    const artifacts = buildCartographyArtifacts({
      runDoc: noOpDoc(),
      sweep: SWEEP,
      cartography: CARTO,
      positiveControl: { parameter: "nav_markdown_bps", value: 0 },
      lifecycle: { required_flows: CORE_FLOWS }
    });
    await emitCartographyRoot(artifacts, root);
    const { code, stderr } = await assessRoot(root);
    assert.equal(code, 1, stderr);
    assert.match(stderr, /lifecycle_executed/);
    assert.match(stderr, /no-op, not robustness/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assess blocks a guided-sim surface with a determinism drift (tampered risk-surface.json)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "honesty-drift-"));
  try {
    const artifacts = buildCartographyArtifacts({
      runDoc: healthyDoc(),
      sweep: SWEEP,
      cartography: CARTO,
      positiveControl: { parameter: "nav_markdown_bps", value: 0 },
      lifecycle: { required_flows: CORE_FLOWS }
    });
    await emitCartographyRoot(artifacts, root);
    // Simulate a non-deterministic re-run: the surface on disk stays internally
    // valid (its self-digest verifies), but it no longer matches the
    // determinism fingerprint the producer recorded at surface time. The
    // determinism gate must catch that drift.
    const summaryPath = path.join(root, "campaign-summary.json");
    const summary = JSON.parse(await readFile(summaryPath, "utf8")) as {
      execution_honesty: { surface_sha256: string };
    };
    summary.execution_honesty.surface_sha256 = "f".repeat(64);
    await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
    const { code, stderr } = await assessRoot(root);
    assert.equal(code, 1, stderr);
    assert.match(stderr, /determinism drift/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assess emits when all execution-honesty gates pass, and surfaces gate status", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "honesty-pass-"));
  try {
    const artifacts = buildCartographyArtifacts({
      runDoc: healthyDoc(),
      sweep: SWEEP,
      cartography: CARTO,
      positiveControl: { parameter: "nav_markdown_bps", value: 0 },
      lifecycle: { required_flows: CORE_FLOWS }
    });
    await emitCartographyRoot(artifacts, root);
    const { code, stdout, stderr } = await assessRoot(root);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /Execution honesty/);
    const markdown = await readFile(path.join(root, "assessment.md"), "utf8");
    assert.match(markdown, /## Execution Honesty/);
    assert.match(markdown, /positive_control/);
    const json = JSON.parse(await readFile(path.join(root, "assessment.json"), "utf8")) as {
      execution_honesty?: { status?: string };
    };
    assert.equal(json.execution_honesty?.status, "pass");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assess blocks when existing assessment artifacts drift from freshly rendered bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "honesty-assess-drift-"));
  try {
    const artifacts = buildCartographyArtifacts({
      runDoc: healthyDoc(),
      sweep: SWEEP,
      cartography: CARTO,
      positiveControl: { parameter: "nav_markdown_bps", value: 0 },
      lifecycle: { required_flows: CORE_FLOWS }
    });
    await emitCartographyRoot(artifacts, root);
    const first = await assessRoot(root);
    assert.equal(first.code, 0, first.stderr);

    await writeFile(path.join(root, "assessment.md"), "tampered\n", "utf8");
    const second = await assessRoot(root);
    assert.equal(second.code, 1, second.stderr);
    assert.match(second.stderr, /assessment\.md drift/);
    assert.match(second.stderr, /determinism/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
