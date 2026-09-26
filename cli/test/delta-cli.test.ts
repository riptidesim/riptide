// `riptide delta` and Workspace reuse, driven through the runners on a fixture
// Workspace holding two Assessments of the same region: `001` from a first run
// and `002` from a rerun after the program changed. Each Assessment's Engine
// Output is rendered by `riptide assess`; its Assessment Context starts from
// the Skill bundle's example sidecar.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CommandIO } from "../src/contract/index.js";
import { runAssess } from "../src/commands/assess.js";
import { runDelta } from "../src/commands/delta.js";
import { runSimSurface } from "../src/commands/sim.js";
import { runValidate } from "../src/commands/validate.js";
import { assessmentDigestOf } from "../src/assess/model.js";
import { canonicalJson, type JsonValue } from "../src/state-pack/json.js";

const EXAMPLE_CONTEXT = path.resolve(
  process.cwd(),
  "..",
  "riptide-assess-skill",
  "skill",
  "examples",
  "assessment-context.json"
);
const PREVIOUS = ".riptide/assessments/001";
const CURRENT = ".riptide/assessments/002";

interface Envelope {
  schema_version: string;
  command: string;
  ok: boolean;
  data?: Record<string, any>;
  error?: { code: string; message: string; next: string };
}

interface Driven {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function drive(cwd: string, run: (io: Required<CommandIO>) => Promise<number>): Promise<Driven> {
  let stdout = "";
  let stderr = "";
  const exitCode = await run({
    cwd,
    stdoutWrite: (chunk) => {
      stdout += chunk;
    },
    stderrWrite: (chunk) => {
      stderr += chunk;
    }
  });
  return { exitCode, stdout, stderr };
}

async function delta(cwd: string, previous = PREVIOUS, current = CURRENT): Promise<Driven & { envelope: Envelope }> {
  const result = await drive(cwd, (io) => runDelta(previous, current, { json: true }, io));
  assert.equal(result.stderr, "");
  return { ...result, envelope: JSON.parse(result.stdout) as Envelope };
}

async function validate(cwd: string, dir: string): Promise<{ exitCode: number; envelope: Envelope }> {
  const result = await drive(cwd, (io) => runValidate(dir, { json: true }, io));
  assert.equal(result.stderr, "");
  return { exitCode: result.exitCode, envelope: JSON.parse(result.stdout) as Envelope };
}

function problemCodes(envelope: Envelope): string[] {
  return (envelope.data?.problems as Array<{ code: string }>).map((problem) => problem.code);
}

/** One sweep over collateral_price_drop_bps; `fires` names the iterations whose invariant fired. */
async function runSweep(cwd: string, fires: number[], badDebtShift: number, values = [0, 300]): Promise<void> {
  const simDir = path.join(cwd, ".riptide", "sim");
  const runDir = path.join(simDir, "artifacts", "sweep");
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(simDir, "Riptide.toml"),
    [
      "[sim.sweep]",
      'name = "collateral_price_drop_bps"',
      `values = [${values.join(", ")}]`,
      "seeds_per_value = 2",
      "",
      "[sim.cartography]",
      'class = "lending.v1"',
      'risk_objective = "solvency"',
      "",
      "[sim.positive_control]",
      'parameter = "collateral_price_drop_bps"',
      "value = 0",
      "",
      "[sim.lifecycle]",
      'required_flows = ["deposit_collateral", "liquidate"]',
      ""
    ].join("\n"),
    "utf8"
  );
  const drops = values.flatMap((value) => [value, value]);
  const iterations = drops.map((drop, index) => ({
    iteration: index,
    seed: index.toString(16).padStart(64, "0"),
    status: "passed",
    panic: false,
    parameters: { collateral_price_drop_bps: drop },
    metrics: { bad_debt: drop * 10 + index + (drop > 0 ? badDebtShift : 0) },
    tx_outcomes: [
      { label: "deposit_collateral", ok: true },
      { label: "liquidate", ok: true }
    ],
    ...(fires.includes(index) ? { invariant_fires: ["solvency"] } : {})
  }));
  await writeFile(
    path.join(runDir, "guided-sim-run.json"),
    JSON.stringify({
      schema_version: 1,
      status: "passed",
      base_seed: "52".repeat(32),
      retained_failing_seed: null,
      iterations
    }),
    "utf8"
  );
  const surfaced = await drive(cwd, (io) =>
    runSimSurface(".riptide/sim/artifacts/sweep", { sim: ".riptide/sim", json: true }, io)
  );
  assert.equal(surfaced.exitCode, 0, surfaced.stdout);
}

/** Render Engine Output into `dir`, keeping the Engine's own assessment.md for every later compose. */
async function render(cwd: string, dir: string): Promise<Driven> {
  await mkdir(path.join(cwd, dir), { recursive: true });
  const context = JSON.parse(await readFile(EXAMPLE_CONTEXT, "utf8")) as { engine_version: string };
  const input = path.join(cwd, ".riptide", "assessment-input.json");
  await writeFile(
    input,
    JSON.stringify({
      reproductionCommands: [`npx --yes @riptidesim/cli@${context.engine_version} assess .riptide --json --out ${dir}`]
    }),
    "utf8"
  );
  const rendered = await drive(cwd, (io) => runAssess(".riptide", { json: true, out: dir, input }, io));
  if (rendered.exitCode === 0) {
    await writeFile(engineRender(cwd, dir), await readFile(path.join(cwd, dir, "assessment.md"), "utf8"));
  }
  return rendered;
}

function engineRender(cwd: string, dir: string): string {
  return path.join(cwd, `engine-${path.basename(dir)}.md`);
}

/**
 * The rerun after a program change: `withdraw_collateral` is now exercised
 * (its Gap closed), `repay` is a new exercised instruction, `flash_borrow` is
 * a new instruction left as a Gap, and `utilization_bound` now held.
 */
function currentContext(example: Record<string, any>): Record<string, any> {
  const context = structuredClone(example);
  context.coverage.instructions = {
    exercised: ["deposit_collateral", "borrow", "liquidate", "withdraw_collateral", "repay"],
    not_exercised: ["flash_borrow"]
  };
  context.gaps = context.gaps.filter((gap: { subject: string }) => gap.subject !== "withdraw_collateral");
  context.gaps.push({
    subject: "flash_borrow",
    reason: "its callback program is not in the Workspace",
    unblock: "a deterministic callback program in the setup seam"
  });
  context.invariants[2].outcome = "held";
  context.breaches = [];
  return context;
}

async function writeContext(cwd: string, dir: string, context: Record<string, any>): Promise<void> {
  await writeFile(path.join(cwd, dir, "assessment-context.json"), `${JSON.stringify(context, null, 2)}\n`);
}

async function readContext(cwd: string, dir: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path.join(cwd, dir, "assessment-context.json"), "utf8"));
}

/** Compose assessment.md the way the Skill's Report stage does, with the Delta when the context has one. */
async function compose(cwd: string, dir: string, sections?: string[]): Promise<void> {
  const context = await readContext(cwd, dir);
  const engineMarkdown = await readFile(engineRender(cwd, dir), "utf8");
  const { assessment_digest } = JSON.parse(await readFile(path.join(cwd, dir, "assessment.json"), "utf8")) as {
    assessment_digest: string;
  };
  const bodies: Record<string, string> = {
    "Scope Declaration": "Depth: default",
    Coverage: `Instructions: ${context.coverage.instructions.exercised.join(", ")}`,
    Gaps: context.gaps.map((gap: { subject: string }) => `- ${gap.subject}`).join("\n"),
    Invariants: context.invariants
      .map((inv: { id: string; outcome: string }) => `- ${inv.id}: ${inv.outcome}`)
      .join("\n"),
    Breaches: context.breaches
      .map((breach: { invariant_id: string; replay_command: string }) => `### ${breach.invariant_id}\n\n\`${breach.replay_command}\``)
      .join("\n"),
    Delta: context.delta ? `Against Assessment ${context.delta.previous}.` : "",
    "Engine Output": `Assessment digest: \`${assessment_digest}\`\n\n${engineMarkdown}`
  };
  const order = sections ?? [
    "Scope Declaration",
    "Coverage",
    "Gaps",
    "Invariants",
    ...(context.breaches.length > 0 ? ["Breaches"] : []),
    ...(context.delta ? ["Delta"] : []),
    "Engine Output"
  ];
  await writeFile(
    path.join(cwd, dir, "assessment.md"),
    order.map((section) => `## ${section}\n\n${bodies[section]}\n`).join("\n")
  );
}

/** A Workspace with the first Assessment delivered and the rerun's Engine Output and Assessment Context written. */
async function rerunWorkspace(options: { values?: number[]; depth?: "default" | "deep" } = {}): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "riptide-delta-"));
  const example = JSON.parse(await readFile(EXAMPLE_CONTEXT, "utf8")) as Record<string, any>;

  await runSweep(cwd, [3], 0);
  assert.equal((await render(cwd, PREVIOUS)).exitCode, 0);
  // The first Assessment is the example Assessment Context, where `utilization_bound` breached.
  await writeContext(cwd, PREVIOUS, example);
  await compose(cwd, PREVIOUS);
  assert.equal((await validate(cwd, PREVIOUS)).exitCode, 0);

  await runSweep(cwd, [2, 3], 50, options.values);
  const rendered = await render(cwd, CURRENT);
  assert.equal(rendered.exitCode, 0, rendered.stdout);
  const context = currentContext(example);
  if (options.depth) context.depth = options.depth;
  await writeContext(cwd, CURRENT, context);
  return cwd;
}

/** Record the Engine's Delta into the rerun's Assessment Context and compose its report. */
async function recordDelta(cwd: string): Promise<Record<string, any>> {
  const { envelope } = await delta(cwd);
  assert.equal(envelope.ok, true, JSON.stringify(envelope.error));
  const context = await readContext(cwd, CURRENT);
  context.delta = envelope.data!.delta;
  await writeContext(cwd, CURRENT, context);
  await compose(cwd, CURRENT);
  return context;
}

function move(envelope: Envelope, metric: string): { metric: string; previous: unknown; current: unknown } | undefined {
  return (envelope.data!.delta.metric_moves as Array<{ metric: string; previous: unknown; current: unknown }>).find(
    (entry) => entry.metric === metric
  );
}

test("delta --json: compares two Assessments of the same region", async () => {
  const cwd = await rerunWorkspace();
  const { exitCode, envelope } = await delta(cwd);

  assert.equal(exitCode, 0, JSON.stringify(envelope.error));
  assert.equal(envelope.schema_version, "riptide-command.v1");
  assert.equal(envelope.command, "delta");
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data!.schema_version, "delta-cli.v1");

  const digestOf = async (dir: string) =>
    (JSON.parse(await readFile(path.join(cwd, dir, "assessment.json"), "utf8")) as { assessment_digest: string })
      .assessment_digest;
  assert.deepEqual(envelope.data!.previous, { assessment_dir: PREVIOUS, assessment_digest: await digestOf(PREVIOUS) });
  assert.deepEqual(envelope.data!.current, { assessment_dir: CURRENT, assessment_digest: await digestOf(CURRENT) });
  assert.equal(envelope.data!.region.depth, "default");

  const result = envelope.data!.delta;
  assert.equal(result.previous, "001");
  assert.deepEqual(result.gaps_opened, ["flash_borrow"]);
  assert.deepEqual(result.gaps_closed, ["withdraw_collateral"]);
  assert.deepEqual(result.new_instructions, [
    { instruction: "flash_borrow", exercised: false },
    { instruction: "repay", exercised: true }
  ]);

  assert.deepEqual(move(envelope, "totals.invariant_failed_runs"), {
    metric: "totals.invariant_failed_runs",
    previous: 1,
    current: 2
  });
  assert.deepEqual(move(envelope, "cell[collateral_price_drop_bps=300].invariant_failure_rate"), {
    metric: "cell[collateral_price_drop_bps=300].invariant_failure_rate",
    previous: 0.5,
    current: 1
  });
  assert.deepEqual(move(envelope, "invariant[utilization_bound].outcome"), {
    metric: "invariant[utilization_bound].outcome",
    previous: "breached",
    current: "held"
  });
  assert.ok(move(envelope, "cell[collateral_price_drop_bps=300].bad_debt.p50"), "a moved metric percentile is reported");
  assert.equal(move(envelope, "cell[collateral_price_drop_bps=0].invariant_failure_rate"), undefined, "an unmoved metric is not reported");
  assert.equal(move(envelope, "totals.completed_runs"), undefined);
  assert.equal(move(envelope, "invariant[debt_below_collateral].outcome"), undefined);

  const metrics = (result.metric_moves as Array<{ metric: string }>).map((entry) => entry.metric);
  assert.deepEqual(metrics, [...metrics].sort(), "metric moves are sorted by metric");
});

test("delta --json: the same two Assessments always give byte-identical output", async () => {
  const cwd = await rerunWorkspace();
  const first = await delta(cwd);
  const second = await delta(cwd);
  assert.equal(first.exitCode, 0);
  assert.equal(second.stdout, first.stdout);

  const reversed = await delta(cwd, CURRENT, PREVIOUS);
  assert.equal(reversed.exitCode, 0);
  assert.deepEqual(reversed.envelope.data!.delta.gaps_opened, ["withdraw_collateral"]);
  assert.deepEqual(reversed.envelope.data!.delta.gaps_closed, ["flash_borrow"]);
  assert.deepEqual(move(reversed.envelope, "totals.invariant_failed_runs"), {
    metric: "totals.invariant_failed_runs",
    previous: 2,
    current: 1
  });
});

test("delta --json: a recorded Delta does not change the delta", async () => {
  const cwd = await rerunWorkspace();
  const before = await delta(cwd);
  await recordDelta(cwd);
  const after = await delta(cwd);
  assert.equal(after.stdout, before.stdout);
});

test("delta --json: Assessments over different regions are not compared", async () => {
  const sweep = await rerunWorkspace({ values: [0, 300, 600] });
  const widened = await delta(sweep);
  assert.equal(widened.exitCode, 1);
  assert.equal(widened.envelope.ok, false);
  assert.equal(widened.envelope.error!.code, "delta_region_mismatch");
  assert.match(widened.envelope.error!.next, /rerun the region/);
  assert.notDeepEqual(widened.envelope.data!.previous_region, widened.envelope.data!.current_region);

  const deeper = await rerunWorkspace({ depth: "deep" });
  const deep = await delta(deeper);
  assert.equal(deep.envelope.error!.code, "delta_region_mismatch");
  assert.equal(deep.envelope.data!.current_region.depth, "deep");
});

test("delta --json: an Assessment compared with itself, or one missing its files, is a coded error", async () => {
  const cwd = await rerunWorkspace();
  const same = await delta(cwd, CURRENT, CURRENT);
  assert.equal(same.exitCode, 1);
  assert.equal(same.envelope.error!.code, "delta_same_assessment");

  const missing = await delta(cwd, ".riptide/assessments/000", CURRENT);
  assert.equal(missing.exitCode, 1);
  assert.equal(missing.envelope.error!.code, "delta_assessment_invalid");
  assert.ok(
    (missing.envelope.data!.problems as Array<{ code: string }>).some((p) => p.code === "validate_engine_output_missing")
  );

  await rm(path.join(cwd, CURRENT, "assessment-context.json"));
  const noContext = await delta(cwd);
  assert.equal(noContext.envelope.error!.code, "delta_assessment_invalid");
  assert.match(noContext.envelope.error!.message, /\.riptide\/assessments\/002/);
  for (const problem of noContext.envelope.data!.problems as Array<{ message: string; next: string }>) {
    assert.doesNotMatch(problem.message, /\n/);
    assert.ok(problem.next.length > 0);
  }
});

test("delta --json: Engine Output of another schema version is a coded error, not a crash", async () => {
  const cwd = await rerunWorkspace();
  const file = path.join(cwd, PREVIOUS, "assessment.json");
  const { assessment_digest: _digest, ...facts } = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  const older = { ...facts, schema_version: "assessment.v0" };
  await writeFile(file, canonicalJson({ ...older, assessment_digest: assessmentDigestOf(older) } as JsonValue));

  const { exitCode, envelope } = await delta(cwd);
  assert.equal(exitCode, 1);
  assert.equal(envelope.error!.code, "delta_assessment_invalid");
  assert.ok(problemCodes(envelope).includes("delta_engine_output_unsupported"), JSON.stringify(envelope.data?.problems));
});

test("delta: without --json the moves go to stdout", async () => {
  const cwd = await rerunWorkspace();
  const result = await drive(cwd, (io) => runDelta(PREVIOUS, CURRENT, {}, io));
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^riptide delta: \.riptide\/assessments\/001 → \.riptide\/assessments\/002\n/);
  assert.match(result.stdout, /totals\.invariant_failed_runs: 1 → 2/);
  assert.match(result.stdout, /gaps opened: flash_borrow/);
});

test("validate --json: a rerun with a Delta computed by the Engine passes the gate", async () => {
  const cwd = await rerunWorkspace();
  await recordDelta(cwd);
  const { exitCode, envelope } = await validate(cwd, CURRENT);
  assert.equal(exitCode, 0, JSON.stringify(envelope.data?.problems));
  assert.equal(envelope.data!.delta_previous, "001");

  const first = await validate(cwd, PREVIOUS);
  assert.equal(first.exitCode, 0);
  assert.equal(first.envelope.data!.delta_previous, null);
});

test("validate --json: a rerun over the previous Assessment's region needs a Delta", async () => {
  const cwd = await rerunWorkspace();
  await compose(cwd, CURRENT);
  const { exitCode, envelope } = await validate(cwd, CURRENT);
  assert.equal(exitCode, 1);
  assert.equal(envelope.error!.code, "validate_delta_missing");
  assert.match(envelope.error!.message, /001/);
  assert.match(envelope.error!.next, /riptide delta \.riptide\/assessments\/001 \.riptide\/assessments\/002 --json/);
});

test("validate --json: a rerun over a new region needs no Delta", async () => {
  const cwd = await rerunWorkspace({ values: [0, 300, 600] });
  await compose(cwd, CURRENT);
  const { exitCode, envelope } = await validate(cwd, CURRENT);
  assert.equal(exitCode, 0, JSON.stringify(envelope.data?.problems));
  assert.equal(envelope.data!.delta_previous, null);
});

test("validate --json: a Delta the agent edited, or one against the wrong Assessment, is rejected", async () => {
  const cwd = await rerunWorkspace();
  const context = await recordDelta(cwd);

  context.delta.gaps_closed = [];
  await writeContext(cwd, CURRENT, context);
  let { envelope } = await validate(cwd, CURRENT);
  assert.ok(problemCodes(envelope).includes("validate_delta_mismatch"), JSON.stringify(envelope.data?.problems));
  assert.match(envelope.error!.next, /riptide delta/);

  context.delta = { ...(await recordDelta(cwd)).delta, previous: "000" };
  await writeContext(cwd, CURRENT, context);
  ({ envelope } = await validate(cwd, CURRENT));
  assert.ok(problemCodes(envelope).includes("validate_delta_previous_mismatch"), JSON.stringify(envelope.data?.problems));
});

test("validate --json: a Delta needs a Delta section before the Engine Output", async () => {
  const cwd = await rerunWorkspace();
  await recordDelta(cwd);
  await compose(cwd, CURRENT, ["Scope Declaration", "Coverage", "Gaps", "Invariants", "Engine Output"]);
  let { envelope } = await validate(cwd, CURRENT);
  assert.ok(problemCodes(envelope).includes("validate_report_section_missing"), JSON.stringify(envelope.data?.problems));
  assert.match(envelope.error!.message, /## Delta/);

  await compose(cwd, CURRENT, ["Scope Declaration", "Coverage", "Gaps", "Invariants", "Engine Output", "Delta"]);
  ({ envelope } = await validate(cwd, CURRENT));
  assert.ok(problemCodes(envelope).includes("validate_report_section_order"), JSON.stringify(envelope.data?.problems));
});

test("assess --json: an Assessment already written is never overwritten", async () => {
  const cwd = await rerunWorkspace();
  const before = await readFile(path.join(cwd, PREVIOUS, "assessment.json"), "utf8");
  const again = await render(cwd, PREVIOUS);
  assert.equal(again.exitCode, 1);
  const envelope = JSON.parse(again.stdout) as Envelope;
  assert.equal(envelope.error!.code, "assess_out_holds_assessment");
  assert.match(envelope.error!.next, /new Assessment directory beside \.riptide\/assessments\/001/);
  assert.equal(await readFile(path.join(cwd, PREVIOUS, "assessment.json"), "utf8"), before);
});
