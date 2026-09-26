// `riptide validate`: the structural gate on an Assessment directory, driven
// through the runner against a fixture Workspace whose Engine Output is
// rendered by `riptide assess` and whose Assessment Context is the Skill
// bundle's example sidecar.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CommandIO } from "../src/contract/index.js";
import { runAssess } from "../src/commands/assess.js";
import { runSimSurface } from "../src/commands/sim.js";
import { runValidate } from "../src/commands/validate.js";

const EXAMPLE_CONTEXT = path.resolve(
  process.cwd(),
  "..",
  "riptide-assess-skill",
  "examples",
  "assessment-context.json"
);
const ASSESSMENT_DIR = ".riptide/assessment";

interface Envelope {
  schema_version: string;
  command: string;
  ok: boolean;
  data?: Record<string, unknown>;
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

async function validate(cwd: string, dir = ASSESSMENT_DIR): Promise<{ exitCode: number; envelope: Envelope }> {
  const result = await drive(cwd, (io) => runValidate(dir, { json: true }, io));
  assert.equal(result.stderr, "");
  return { exitCode: result.exitCode, envelope: JSON.parse(result.stdout) as Envelope };
}

async function assertRejected(cwd: string, code: string): Promise<Envelope> {
  const { exitCode, envelope } = await validate(cwd);
  assert.equal(envelope.schema_version, "riptide-command.v1");
  assert.equal(envelope.command, "validate");
  assert.equal(envelope.ok, false);
  assert.equal(exitCode, 1);
  const problems = envelope.data?.problems as Array<{ code: string; message: string; next: string }>;
  const problem = problems.find((entry) => entry.code === code);
  assert.ok(problem, `expected ${code}, got ${JSON.stringify(problems)}`);
  assert.doesNotMatch(problem.message, /\n/);
  assert.ok(problem.next.length > 0);
  assert.deepEqual(envelope.error, problems[0]);
  return envelope;
}

/** A Workspace with surfaced guided-sim evidence and Engine Output rendered into `.riptide/assessment`. */
async function renderedWorkspace(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "riptide-validate-"));
  const simDir = path.join(cwd, ".riptide", "sim");
  const runDir = path.join(simDir, "artifacts", "smoke");
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(simDir, "Riptide.toml"),
    [
      "[sim.sweep]",
      'name = "collateral_price_drop_bps"',
      "values = [0, 300]",
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
  const iterations = [0, 0, 300, 300].map((drop, index) => ({
    iteration: index,
    seed: index.toString(16).padStart(64, "0"),
    status: "passed",
    panic: false,
    parameters: { collateral_price_drop_bps: drop },
    metrics: { bad_debt: drop * 10 + index },
    tx_outcomes: [
      { label: "deposit_collateral", ok: true },
      { label: "liquidate", ok: true }
    ],
    ...(index === 3 ? { invariant_fires: ["solvency"] } : {})
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
    runSimSurface(".riptide/sim/artifacts/smoke", { sim: ".riptide/sim", json: true }, io)
  );
  assert.equal(surfaced.exitCode, 0, surfaced.stdout);
  await mkdir(path.join(cwd, ASSESSMENT_DIR));
  const assessed = await drive(cwd, (io) =>
    runAssess(".riptide", { json: true, out: ASSESSMENT_DIR }, io)
  );
  assert.equal(assessed.exitCode, 0, assessed.stdout);
  return cwd;
}

/** A complete Assessment: Engine Output, the example Assessment Context, and the composed report. */
async function validWorkspace(): Promise<string> {
  const cwd = await renderedWorkspace();
  await writeFile(assessmentFile(cwd, "assessment-context.json"), await readFile(EXAMPLE_CONTEXT, "utf8"));
  await writeFile(assessmentFile(cwd, "assessment.md"), await composeReport(cwd));
  return cwd;
}

function assessmentFile(cwd: string, name: string): string {
  return path.join(cwd, ASSESSMENT_DIR, name);
}

/** Compose assessment.md the way the Skill's Report stage does: Context sections, then the Engine's render. */
async function composeReport(
  cwd: string,
  sections = ["Scope Declaration", "Coverage", "Gaps", "Engine Output"]
): Promise<string> {
  const engineMarkdown = await readFile(assessmentFile(cwd, "assessment.md"), "utf8");
  const { assessment_digest } = JSON.parse(
    await readFile(assessmentFile(cwd, "assessment.json"), "utf8")
  ) as { assessment_digest: string };
  const bodies: Record<string, string> = {
    "Scope Declaration": "Depth: default\n\n- target is programs/lending",
    Coverage: "Instructions: 3 of 4 exercised. Actors: 2 of 3 exercised.",
    Gaps: "- withdraw_collateral\n- admin",
    "Engine Output": `Assessment digest: \`${assessment_digest}\`\n\n${engineMarkdown}`
  };
  return sections.map((section) => `## ${section}\n\n${bodies[section]}\n`).join("\n");
}

async function editContext(cwd: string, edit: (context: Record<string, any>) => void): Promise<void> {
  const context = JSON.parse(await readFile(assessmentFile(cwd, "assessment-context.json"), "utf8"));
  edit(context);
  await writeFile(assessmentFile(cwd, "assessment-context.json"), JSON.stringify(context, null, 2));
}

test("validate --json: a complete Assessment passes the gate", async () => {
  const cwd = await validWorkspace();
  const { exitCode, envelope } = await validate(cwd);

  assert.equal(exitCode, 0, JSON.stringify(envelope.error));
  assert.equal(envelope.ok, true);
  assert.equal(envelope.command, "validate");
  assert.deepEqual(envelope.data, {
    schema_version: "validate-cli.v1",
    assessment_dir: ASSESSMENT_DIR,
    context_schema_version: "assessment-context.v1",
    assessment_digest: (
      JSON.parse(await readFile(assessmentFile(cwd, "assessment.json"), "utf8")) as {
        assessment_digest: string;
      }
    ).assessment_digest,
    depth: "default",
    coverage: {
      instructions: { exercised: 3, not_exercised: 1 },
      actors: { exercised: 2, not_exercised: 1 }
    },
    gaps: 2
  });
});

test("validate: writing the Assessment Context leaves the Engine Output bytes untouched", async () => {
  const cwd = await validWorkspace();
  assert.equal((await validate(cwd)).exitCode, 0);

  await mkdir(path.join(cwd, "fresh"));
  const fresh = await drive(cwd, (io) => runAssess(".riptide", { json: true, out: "fresh" }, io));
  assert.equal(fresh.exitCode, 0, fresh.stdout);
  assert.equal(
    await readFile(assessmentFile(cwd, "assessment.json"), "utf8"),
    await readFile(path.join(cwd, "fresh", "assessment.json"), "utf8")
  );
  assert.ok(
    (await readFile(assessmentFile(cwd, "assessment.md"), "utf8")).includes(
      await readFile(path.join(cwd, "fresh", "assessment.md"), "utf8")
    ),
    "the composed report must carry the Engine's render verbatim"
  );
});

test("validate: without --json a pass goes to stdout and a failure to stderr", async () => {
  const cwd = await validWorkspace();
  const passed = await drive(cwd, (io) => runValidate(ASSESSMENT_DIR, {}, io));
  assert.equal(passed.exitCode, 0);
  assert.equal(passed.stdout, `riptide validate: PASS ${ASSESSMENT_DIR}\n`);
  assert.equal(passed.stderr, "");

  await rm(assessmentFile(cwd, "assessment-context.json"));
  const failed = await drive(cwd, (io) => runValidate(ASSESSMENT_DIR, {}, io));
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.stdout, "");
  assert.match(failed.stderr, /FAIL \.riptide\/assessment/);
  assert.match(failed.stderr, /validate_context_missing/);
  assert.match(failed.stderr, /next: /);
});

test("validate --json: a missing directory or file is a coded error", async () => {
  const cwd = await validWorkspace();
  const missingDir = await validate(cwd, "nowhere");
  assert.equal(missingDir.exitCode, 1);
  assert.equal(missingDir.envelope.error?.code, "validate_dir_not_found");
  assert.ok(missingDir.envelope.error?.next);

  await rm(assessmentFile(cwd, "assessment-context.json"));
  await assertRejected(cwd, "validate_context_missing");

  await rm(assessmentFile(cwd, "assessment.md"));
  await assertRejected(cwd, "validate_report_missing");

  await rm(assessmentFile(cwd, "assessment.json"));
  await assertRejected(cwd, "validate_engine_output_missing");
});

test("validate --json: every problem is reported, not only the first", async () => {
  const cwd = await validWorkspace();
  await rm(assessmentFile(cwd, "assessment-context.json"));
  await rm(assessmentFile(cwd, "assessment.md"));

  const envelope = await assertRejected(cwd, "validate_context_missing");
  const codes = (envelope.data?.problems as Array<{ code: string }>).map((problem) => problem.code);
  assert.deepEqual(codes, ["validate_context_missing", "validate_report_missing"]);
});

test("validate --json: an Assessment Context that is not JSON or not this schema version is rejected", async () => {
  const cwd = await validWorkspace();
  await writeFile(assessmentFile(cwd, "assessment-context.json"), "{");
  await assertRejected(cwd, "validate_context_malformed");

  await writeFile(assessmentFile(cwd, "assessment-context.json"), JSON.stringify({ depth: "default" }));
  await assertRejected(cwd, "validate_context_schema_unsupported");

  await writeFile(
    assessmentFile(cwd, "assessment-context.json"),
    JSON.stringify({ schema_version: "assessment-context.v0" })
  );
  await assertRejected(cwd, "validate_context_schema_unsupported");
});

test("validate --json: an invalid Assessment Context names the failing field", async () => {
  const cases: Array<[string, (context: Record<string, any>) => void]> = [
    ["depth", (context) => (context.depth = "quick")],
    ["engine_version", (context) => delete context.engine_version],
    ["skill_version", (context) => (context.skill_version = "  ")],
    ["scope_declaration.0.override", (context) => delete context.scope_declaration[0].override],
    ["coverage.actors", (context) => delete context.coverage.actors],
    ["coverage.instructions.not_exercised", (context) => context.coverage.instructions.not_exercised.push("borrow")],
    ["gaps.1.unblock", (context) => delete context.gaps[1].unblock],
    ["gaps", (context) => delete context.gaps]
  ];
  for (const [field, edit] of cases) {
    const cwd = await validWorkspace();
    await editContext(cwd, edit);
    const envelope = await assertRejected(cwd, "validate_context_schema_invalid");
    assert.ok(
      (envelope.data?.problems as Array<{ message: string }>).some((problem) =>
        problem.message.includes(` ${field}: `)
      ),
      `${field}: ${JSON.stringify(envelope.data?.problems)}`
    );
  }
});

test("validate --json: an unexercised instruction or actor without a Gap is rejected", async () => {
  const cwd = await validWorkspace();
  await editContext(cwd, (context) => {
    context.gaps = context.gaps.filter((gap: { subject: string }) => gap.subject !== "admin");
  });
  const envelope = await assertRejected(cwd, "validate_gap_missing");
  assert.match(envelope.error!.message, /actor "admin"/);
});

test("validate --json: a composed report missing a required section is rejected", async () => {
  for (const section of ["Scope Declaration", "Coverage", "Gaps", "Engine Output"]) {
    const cwd = await renderedWorkspace();
    await writeFile(assessmentFile(cwd, "assessment-context.json"), await readFile(EXAMPLE_CONTEXT, "utf8"));
    const sections = ["Scope Declaration", "Coverage", "Gaps", "Engine Output"].filter((s) => s !== section);
    await writeFile(assessmentFile(cwd, "assessment.md"), await composeReport(cwd, sections));
    const envelope = await assertRejected(cwd, "validate_report_section_missing");
    assert.match(envelope.error!.message, new RegExp(`## ${section}\``));
  }
});

test("validate --json: the Scope Declaration must open the composed report", async () => {
  const cwd = await renderedWorkspace();
  await writeFile(assessmentFile(cwd, "assessment-context.json"), await readFile(EXAMPLE_CONTEXT, "utf8"));
  await writeFile(
    assessmentFile(cwd, "assessment.md"),
    await composeReport(cwd, ["Coverage", "Scope Declaration", "Gaps", "Engine Output"])
  );
  await assertRejected(cwd, "validate_report_section_order");
});

test("validate --json: a composed report that does not cite the Engine Output digest is rejected", async () => {
  const cwd = await validWorkspace();
  const { assessment_digest } = JSON.parse(await readFile(assessmentFile(cwd, "assessment.json"), "utf8")) as {
    assessment_digest: string;
  };
  const report = await readFile(assessmentFile(cwd, "assessment.md"), "utf8");
  await writeFile(assessmentFile(cwd, "assessment.md"), report.replaceAll(assessment_digest, "not-the-digest"));
  await assertRejected(cwd, "validate_report_engine_output_unlinked");
});

test("validate --json: edited Engine Output is rejected", async () => {
  const cwd = await validWorkspace();
  const json = await readFile(assessmentFile(cwd, "assessment.json"), "utf8");
  const edited = JSON.parse(json) as Record<string, unknown>;
  edited.claim_boundary = "proven safe";
  await writeFile(assessmentFile(cwd, "assessment.json"), JSON.stringify(edited));
  await assertRejected(cwd, "validate_engine_output_modified");

  await writeFile(assessmentFile(cwd, "assessment.json"), JSON.stringify(JSON.parse(json), null, 2));
  await assertRejected(cwd, "validate_engine_output_modified");

  await writeFile(assessmentFile(cwd, "assessment.json"), "{}");
  await assertRejected(cwd, "validate_engine_output_modified");
});
