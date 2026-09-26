// `riptide validate`: the structural gate on the directory the Skill delivers,
// driven through the runner. Assessments use a fixture Workspace whose Engine
// Output is rendered by `riptide assess` and whose Assessment Context is the
// Skill bundle's example sidecar; Out-of-Scope Notes and Blocker Reports use
// the bundle's example files.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CommandIO } from "../src/contract/index.js";
import { runAssess } from "../src/commands/assess.js";
import { runSimSurface } from "../src/commands/sim.js";
import { runValidate } from "../src/commands/validate.js";

const EXAMPLES = path.resolve(process.cwd(), "..", "riptide-assess-skill", "examples");
const EXAMPLE_CONTEXT = path.join(EXAMPLES, "assessment-context.json");
const ASSESSMENT_DIR = ".riptide/assessment";
const EXAMPLE_SEED = "0000000000000000000000000000000000000000000000000000000000000003";
const EXAMPLE_REPLAY = `npx --yes @riptide/cli@0.12.0 sim debug .riptide/sim --seed ${EXAMPLE_SEED}`;

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

function problemOf(envelope: Envelope, code: string): { code: string; message: string; next: string } {
  const problems = envelope.data?.problems as Array<{ code: string; message: string; next: string }>;
  return problems.find((problem) => problem.code === code)!;
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
  sections = ["Scope Declaration", "Coverage", "Gaps", "Invariants", "Breaches", "Engine Output"]
): Promise<string> {
  const engineMarkdown = await readFile(assessmentFile(cwd, "assessment.md"), "utf8");
  const { assessment_digest } = JSON.parse(
    await readFile(assessmentFile(cwd, "assessment.json"), "utf8")
  ) as { assessment_digest: string };
  const bodies: Record<string, string> = {
    "Scope Declaration": "Depth: default\n\n- target is programs/lending",
    Coverage: "Instructions: 3 of 4 exercised. Actors: 2 of 3 exercised.",
    Gaps: "- withdraw_collateral\n- admin\n- debt_below_max_borrow",
    Invariants:
      "- debt_below_collateral (floor): fired, held\n" +
      "- debt_below_max_borrow (floor): did-not-fire, Gap\n" +
      "- utilization_bound (agent-authored): fired, breached",
    Breaches: `### utilization_bound\n\nReplay: \`${EXAMPLE_REPLAY}\`\n\n**T4** the first \`borrow\` pushes utilization past the bound.`,
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
    kind: "assessment",
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
    gaps: 3,
    family: "lending",
    invariants: { floor: 2, agent: 1, held: 1, breached: 1, gap: 1 },
    breaches: 1
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
  assert.equal(passed.stdout, `riptide validate: PASS ${ASSESSMENT_DIR} (assessment)\n`);
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

  const noEngineOutput = await validWorkspace();
  await rm(assessmentFile(noEngineOutput, "assessment.json"));
  await assertRejected(noEngineOutput, "validate_engine_output_missing");

  await rm(assessmentFile(cwd, "assessment.json"));
  await assertRejected(cwd, "validate_output_missing");
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
    ["gaps", (context) => delete context.gaps],
    ["family", (context) => (context.family = "orderbook")],
    ["invariants", (context) => delete context.invariants],
    ["invariants.0.provenance", (context) => (context.invariants[0].provenance = "library")],
    ["invariants.1.firing_check", (context) => (context.invariants[1].firing_check = "passed")],
    ["invariants.2.outcome", (context) => (context.invariants[2].outcome = "safe")],
    ["invariants.2.id", (context) => (context.invariants[2].id = "debt_below_collateral")],
    ["breaches", (context) => delete context.breaches],
    ["breaches.0.invariant_id", (context) => delete context.breaches[0].invariant_id],
    ["breaches.0.seed", (context) => (context.breaches[0].seed = "not-hex")],
    ["breaches.0.replay_command", (context) => (context.breaches[0].replay_command = 3)]
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

test("validate --json: an invariant reported as held or breached without a fired Firing Check is rejected", async () => {
  for (const [firing_check, outcome] of [
    ["did-not-fire", "held"],
    ["not-run", "held"],
    ["did-not-fire", "breached"]
  ]) {
    const cwd = await validWorkspace();
    await editContext(cwd, (context) => {
      context.invariants[2].firing_check = firing_check;
      context.invariants[2].outcome = outcome;
    });
    const envelope = await assertRejected(cwd, "validate_invariant_not_fired");
    assert.match(envelope.error!.message, new RegExp(`"utilization_bound" is reported as ${outcome} but its Firing Check is ${firing_check}`));
    assert.match(envelope.error!.next, /outcome to "gap"/);
  }
});

test("validate --json: an invariant reported as a Gap needs a Gap", async () => {
  const cwd = await validWorkspace();
  await editContext(cwd, (context) => {
    context.gaps = context.gaps.filter((gap: { subject: string }) => gap.subject !== "debt_below_max_borrow");
  });
  const envelope = await assertRejected(cwd, "validate_gap_missing");
  assert.match(envelope.error!.message, /invariant "debt_below_max_borrow"/);
});

test("validate --json: every Floor Invariant of the family must be reported", async () => {
  const cwd = await validWorkspace();
  await editContext(cwd, (context) => {
    context.invariants = context.invariants.filter((inv: { id: string }) => inv.id !== "debt_below_collateral");
  });
  const envelope = await assertRejected(cwd, "validate_floor_invariant_missing");
  assert.match(envelope.error!.message, /"debt_below_collateral" of the lending family/);
  assert.match(envelope.error!.next, /riptide sim generate/);

  const generic = await validWorkspace();
  await editContext(generic, (context) => (context.family = "generic"));
  const problems = (await assertRejected(generic, "validate_floor_invariant_missing")).data!.problems as Array<{
    code: string;
    message: string;
  }>;
  assert.ok(problems.some((problem) => problem.message.includes('"supply_covers_balances" of the generic family')));
});

test("validate --json: a Floor Invariant labelled agent-authored, or an agent invariant labelled floor, is rejected", async () => {
  const cwd = await validWorkspace();
  await editContext(cwd, (context) => (context.invariants[0].provenance = "agent"));
  let envelope = await assertRejected(cwd, "validate_invariant_provenance_mismatch");
  assert.match(envelope.error!.message, /"debt_below_collateral" is a Floor Invariant of the lending family but is labelled agent-authored/);

  await editContext(cwd, (context) => {
    context.invariants[0].provenance = "floor";
    context.invariants[2].provenance = "floor";
  });
  envelope = await assertRejected(cwd, "validate_invariant_provenance_mismatch");
  assert.match(envelope.error!.message, /"utilization_bound" is not a Floor Invariant/);
});

test("validate --json: the composed report names every invariant under Invariants", async () => {
  const cwd = await validWorkspace();
  const report = await readFile(assessmentFile(cwd, "assessment.md"), "utf8");
  await writeFile(assessmentFile(cwd, "assessment.md"), report.replace("- utilization_bound (agent-authored): fired, breached", ""));
  const envelope = await assertRejected(cwd, "validate_report_invariant_unlisted");
  assert.match(envelope.error!.message, /"utilization_bound"/);
});

test("validate --json: a composed report missing a required section is rejected", async () => {
  for (const section of ["Scope Declaration", "Coverage", "Gaps", "Invariants", "Engine Output"]) {
    const cwd = await renderedWorkspace();
    await writeFile(assessmentFile(cwd, "assessment-context.json"), await readFile(EXAMPLE_CONTEXT, "utf8"));
    const sections = ["Scope Declaration", "Coverage", "Gaps", "Invariants", "Breaches", "Engine Output"].filter(
      (s) => s !== section
    );
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
    await composeReport(cwd, ["Coverage", "Scope Declaration", "Gaps", "Invariants", "Breaches", "Engine Output"])
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

test("validate --json: a Breach with no replay command is rejected", async () => {
  for (const edit of [
    (breach: Record<string, unknown>) => delete breach.replay_command,
    (breach: Record<string, unknown>) => (breach.replay_command = "  ")
  ]) {
    const cwd = await validWorkspace();
    await editContext(cwd, (context) => edit(context.breaches[0]));
    const envelope = await assertRejected(cwd, "validate_breach_replay_missing");
    assert.match(envelope.error!.message, /Breach of invariant "utilization_bound" at seed 0+3 has no replay command/);
    assert.ok(envelope.error!.next.includes(EXAMPLE_REPLAY), envelope.error!.next);
  }
});

test("validate --json: a Breach with no Causal Trace is rejected", async () => {
  for (const edit of [
    (breach: Record<string, unknown>) => delete breach.causal_trace,
    (breach: Record<string, unknown>) => (breach.causal_trace = "")
  ]) {
    const cwd = await validWorkspace();
    await editContext(cwd, (context) => edit(context.breaches[0]));
    const envelope = await assertRejected(cwd, "validate_breach_causal_trace_missing");
    assert.match(envelope.error!.message, /Breach of invariant "utilization_bound" at seed 0+3 has no Causal Trace/);
    assert.match(envelope.error!.next, /riptide sim debug \.riptide\/sim --seed 0+3 --json/);
  }
});

test("validate --json: a Causal Trace that cites no tick is rejected", async () => {
  const cwd = await validWorkspace();
  await editContext(cwd, (context) => {
    context.breaches[0].causal_trace = "Utilization crossed the bound after heavy borrowing.";
  });
  const envelope = await assertRejected(cwd, "validate_breach_causal_trace_uncited");
  assert.match(envelope.error!.message, /cites no tick/);
  assert.match(envelope.error!.next, /\*\*T<n>\*\*/);
});

test("validate --json: a Causal Trace that cites no exercised instruction's transaction is rejected", async () => {
  const cwd = await validWorkspace();
  await editContext(cwd, (context) => {
    context.breaches[0].causal_trace = "**T4** utilization crosses the bound after heavy activity.";
  });
  const envelope = await assertRejected(cwd, "validate_breach_causal_trace_uncited");
  assert.match(envelope.error!.message, /cites no transaction/);
  assert.match(envelope.error!.next, /deposit_collateral, borrow, liquidate/);
});

test("validate --json: a replay command that is not the seed's replay against the pinned Engine is rejected", async () => {
  for (const replay of [
    `riptide sim debug .riptide/sim --seed ${EXAMPLE_SEED}`,
    `npx --yes @riptide/cli@0.11.0 sim debug .riptide/sim --seed ${EXAMPLE_SEED}`,
    EXAMPLE_REPLAY.replace(/3$/, "4"),
    `${EXAMPLE_REPLAY} --json`
  ]) {
    const cwd = await validWorkspace();
    await editContext(cwd, (context) => (context.breaches[0].replay_command = replay));
    const envelope = await assertRejected(cwd, "validate_breach_replay_unpinned");
    assert.ok(envelope.error!.next.includes(EXAMPLE_REPLAY), envelope.error!.next);
  }
});

test("validate --json: a breached invariant needs a Breach, and a Breach needs a breached invariant", async () => {
  const cwd = await validWorkspace();
  await editContext(cwd, (context) => (context.breaches = []));
  let envelope = await assertRejected(cwd, "validate_breach_missing");
  assert.match(envelope.error!.message, /invariant "utilization_bound" is reported as breached but has no Breach/);

  const held = await validWorkspace();
  await editContext(held, (context) => (context.breaches[0].invariant_id = "debt_below_collateral"));
  assert.match(
    problemOf(await assertRejected(held, "validate_breach_invariant_mismatch"), "validate_breach_invariant_mismatch").message,
    /"debt_below_collateral", which is reported as held/
  );

  const unknown = await validWorkspace();
  await editContext(unknown, (context) => (context.breaches[0].invariant_id = "no_such_invariant"));
  assert.match(
    problemOf(await assertRejected(unknown, "validate_breach_invariant_mismatch"), "validate_breach_invariant_mismatch").message,
    /"no_such_invariant", which is not a reported invariant/
  );
});

test("validate --json: a composed report lists every Breach with its replay command under Breaches", async () => {
  const missing = await renderedWorkspace();
  await writeFile(assessmentFile(missing, "assessment-context.json"), await readFile(EXAMPLE_CONTEXT, "utf8"));
  await writeFile(
    assessmentFile(missing, "assessment.md"),
    await composeReport(missing, ["Scope Declaration", "Coverage", "Gaps", "Invariants", "Engine Output"])
  );
  let envelope = await assertRejected(missing, "validate_report_section_missing");
  assert.match(envelope.error!.message, /## Breaches`/);

  const misplaced = await renderedWorkspace();
  await writeFile(assessmentFile(misplaced, "assessment-context.json"), await readFile(EXAMPLE_CONTEXT, "utf8"));
  await writeFile(
    assessmentFile(misplaced, "assessment.md"),
    await composeReport(misplaced, ["Scope Declaration", "Coverage", "Breaches", "Gaps", "Invariants", "Engine Output"])
  );
  await assertRejected(misplaced, "validate_report_section_order");

  const unlisted = await validWorkspace();
  const report = await readFile(assessmentFile(unlisted, "assessment.md"), "utf8");
  await writeFile(assessmentFile(unlisted, "assessment.md"), report.replace(`Replay: \`${EXAMPLE_REPLAY}\``, "Replay: see above"));
  envelope = await assertRejected(unlisted, "validate_report_breach_unlisted");
  assert.ok(envelope.error!.next.includes(EXAMPLE_REPLAY));
});

test("validate --json: an Assessment with no Breach needs no Breaches section", async () => {
  const cwd = await renderedWorkspace();
  await writeFile(assessmentFile(cwd, "assessment-context.json"), await readFile(EXAMPLE_CONTEXT, "utf8"));
  await editContext(cwd, (context) => {
    context.invariants[2].outcome = "held";
    context.breaches = [];
  });
  await writeFile(
    assessmentFile(cwd, "assessment.md"),
    await composeReport(cwd, ["Scope Declaration", "Coverage", "Gaps", "Invariants", "Engine Output"])
  );
  const { exitCode, envelope } = await validate(cwd);
  assert.equal(exitCode, 0, JSON.stringify(envelope.data?.problems));
  assert.equal(envelope.data?.breaches, 0);
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

test("validate --json: an Assessment with zero Coverage is rejected in favour of a Blocker Report", async () => {
  const cwd = await validWorkspace();
  await editContext(cwd, (context) => {
    const { exercised } = context.coverage.instructions;
    context.coverage.instructions.not_exercised.push(...exercised);
    context.coverage.instructions.exercised = [];
    for (const name of exercised) context.gaps.push({ subject: name, reason: "did not execute", unblock: "a build" });
  });
  const envelope = await assertRejected(cwd, "validate_coverage_zero");
  assert.equal(envelope.data?.kind, "assessment");
  assert.match(envelope.error!.next, /Blocker Report/);
});

/** A directory holding one short-circuit output: the bundle's example sidecar and a composed report. */
async function shortCircuitDir(kind: "out-of-scope-note" | "blocker-report", markdown?: string): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), `riptide-validate-${kind}-`));
  await mkdir(path.join(cwd, ASSESSMENT_DIR), { recursive: true });
  await writeFile(assessmentFile(cwd, `${kind}.json`), await readFile(path.join(EXAMPLES, `${kind}.json`), "utf8"));
  await writeFile(assessmentFile(cwd, `${kind}.md`), markdown ?? (await composeShortCircuit(kind)));
  return cwd;
}

async function composeShortCircuit(
  kind: "out-of-scope-note" | "blocker-report",
  extraSections: string[] = []
): Promise<string> {
  const example = JSON.parse(await readFile(path.join(EXAMPLES, `${kind}.json`), "utf8"));
  const bodies: Array<[string, string]> =
    kind === "out-of-scope-note"
      ? [
          ["Classification", example.classification.evidence.map((line: string) => `- ${line}`).join("\n")],
          ["Code-Level Auditing", example.referrals.map((line: string) => `- ${line}`).join("\n")]
        ]
      : [
          ["Scope Declaration", "Depth: default\n\n- target is programs/lending"],
          ["Blocker", `\`${example.blocker.command}\`\n\n${example.blocker.error}`],
          [
            "Gaps",
            example.gaps
              .map((gap: { subject: string; reason: string; unblock: string }) => `- ${gap.subject}: ${gap.reason}; unblock: ${gap.unblock}`)
              .join("\n")
          ]
        ];
  return [...bodies, ...extraSections.map((section): [string, string] => [section, "claims"])]
    .map(([section, body]) => `## ${section}\n\n${body}\n`)
    .join("\n");
}

async function editShortCircuit(
  cwd: string,
  kind: "out-of-scope-note" | "blocker-report",
  edit: (output: Record<string, any>) => void
): Promise<void> {
  const output = JSON.parse(await readFile(assessmentFile(cwd, `${kind}.json`), "utf8"));
  edit(output);
  await writeFile(assessmentFile(cwd, `${kind}.json`), JSON.stringify(output, null, 2));
}

test("validate --json: the example Out-of-Scope Note passes the gate", async () => {
  const cwd = await shortCircuitDir("out-of-scope-note");
  const { exitCode, envelope } = await validate(cwd);
  assert.equal(exitCode, 0, JSON.stringify(envelope.data));
  assert.deepEqual(envelope.data, {
    schema_version: "validate-cli.v1",
    kind: "out-of-scope-note",
    assessment_dir: ASSESSMENT_DIR,
    note_schema_version: "out-of-scope-note.v1",
    evidence: 3,
    referrals: 2
  });

  const text = await drive(cwd, (io) => runValidate(ASSESSMENT_DIR, {}, io));
  assert.equal(text.stdout, `riptide validate: PASS ${ASSESSMENT_DIR} (out-of-scope-note)\n`);
});

test("validate --json: the example Blocker Report passes the gate", async () => {
  const cwd = await shortCircuitDir("blocker-report");
  const { exitCode, envelope } = await validate(cwd);
  assert.equal(exitCode, 0, JSON.stringify(envelope.data));
  assert.deepEqual(envelope.data, {
    schema_version: "validate-cli.v1",
    kind: "blocker-report",
    assessment_dir: ASSESSMENT_DIR,
    report_schema_version: "blocker-report.v1",
    depth: "default",
    gaps: 5
  });
});

test("validate --json: an Out-of-Scope Note must carry a non-economic verdict, evidence and a referral", async () => {
  const cases: Array<[string, (note: Record<string, any>) => void]> = [
    ["classification.verdict", (note) => (note.classification.verdict = "economic-protocol")],
    ["classification.evidence", (note) => (note.classification.evidence = [])],
    ["classification.override", (note) => delete note.classification.override],
    ["referrals", (note) => (note.referrals = [])],
    ["target", (note) => delete note.target]
  ];
  for (const [field, edit] of cases) {
    const cwd = await shortCircuitDir("out-of-scope-note");
    await editShortCircuit(cwd, "out-of-scope-note", edit);
    const envelope = await assertRejected(cwd, "validate_output_schema_invalid");
    assert.equal(envelope.data?.kind, "out-of-scope-note");
    assert.ok(
      (envelope.data?.problems as Array<{ message: string }>).some((problem) => problem.message.includes(` ${field}: `)),
      `${field}: ${JSON.stringify(envelope.data?.problems)}`
    );
  }
});

test("validate --json: a Blocker Report names a Gap for every unexercised instruction and actor, in its report too", async () => {
  const unGapped = await shortCircuitDir("blocker-report");
  await editShortCircuit(unGapped, "blocker-report", (report) => {
    report.gaps = report.gaps.filter((gap: { subject: string }) => gap.subject !== "keeper");
  });
  const missing = await assertRejected(unGapped, "validate_gap_missing");
  assert.match(missing.error!.message, /actor "keeper"/);

  const unnamed = await shortCircuitDir(
    "blocker-report",
    (await composeShortCircuit("blocker-report")).replace(/^- liquidate: .*$/m, "")
  );
  const envelope = await assertRejected(unnamed, "validate_report_gap_unnamed");
  assert.match(envelope.error!.message, /"liquidate"/);

  const noGaps = await shortCircuitDir("blocker-report");
  await editShortCircuit(noGaps, "blocker-report", (report) => {
    report.gaps = [];
    report.not_exercised = { instructions: [], actors: [] };
  });
  await assertRejected(noGaps, "validate_output_schema_invalid");
});

test("validate --json: neither short-circuit output may carry a risk surface", async () => {
  for (const kind of ["out-of-scope-note", "blocker-report"] as const) {
    const withEngineOutput = await shortCircuitDir(kind);
    await writeFile(assessmentFile(withEngineOutput, "risk-surface.json"), "{}");
    await assertRejected(withEngineOutput, "validate_engine_output_present");

    for (const section of ["Coverage", "Engine Output", "Risk Surface", "Invariants", "Breaches", "Delta"]) {
      const cwd = await shortCircuitDir(kind, await composeShortCircuit(kind, [section]));
      const envelope = await assertRejected(cwd, "validate_report_risk_surface");
      assert.match(envelope.error!.message, new RegExp(`\`${section}\``));
    }

    for (const field of ["invariants", "breaches", "coverage", "risk_surface"]) {
      const cwd = await shortCircuitDir(kind);
      await editShortCircuit(cwd, kind, (output) => (output[field] = []));
      await assertRejected(cwd, "validate_output_schema_invalid");
    }
  }
});

test("validate --json: a short-circuit report missing a required section is rejected", async () => {
  const note = await shortCircuitDir("out-of-scope-note", "## Classification\n\n- an NFT mint\n");
  const envelope = await assertRejected(note, "validate_report_section_missing");
  assert.match(envelope.error!.message, /## Code-Level Auditing`/);

  const blocker = await shortCircuitDir("blocker-report");
  await rm(assessmentFile(blocker, "blocker-report.md"));
  await assertRejected(blocker, "validate_report_missing");
});

test("validate --json: a directory holding more than one output, or none, is rejected", async () => {
  const cwd = await shortCircuitDir("out-of-scope-note");
  await writeFile(assessmentFile(cwd, "blocker-report.json"), await readFile(path.join(EXAMPLES, "blocker-report.json"), "utf8"));
  const ambiguous = await assertRejected(cwd, "validate_output_ambiguous");
  assert.equal(ambiguous.data?.kind, null);

  const empty = await mkdtemp(path.join(os.tmpdir(), "riptide-validate-empty-"));
  await mkdir(path.join(empty, ASSESSMENT_DIR), { recursive: true });
  await assertRejected(empty, "validate_output_missing");
});
