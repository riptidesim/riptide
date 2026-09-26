// `init`, `readiness`, `review` and `assess` under `--json`: one command
// envelope on stdout, and the error shape (code, message, next) on every
// failure path the Skill can hit. Driven through the runners against
// fixture Workspaces.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CommandIO } from "../src/contract/index.js";
import { runAssess } from "../src/commands/assess.js";
import { runInit, type InitOptions } from "../src/commands/init.js";
import { runReadiness } from "../src/commands/readiness.js";
import type { HealthReport } from "../src/health/index.js";
import { runReview } from "../src/commands/review.js";
import { runSimSurface } from "../src/commands/sim.js";

interface Envelope {
  schema_version: string;
  command: string;
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; next: string };
}

interface Driven {
  exitCode: number;
  envelope: Envelope;
  stderr: string;
}

async function drive(
  cwd: string,
  run: (io: Required<CommandIO>) => Promise<number>
): Promise<Driven> {
  let stdout = "";
  let stderr = "";
  const exitCode = await run({
    cwd,
    stdoutWrite: (chunk) => {
      stdout += chunk;
    },
    stderrWrite: (chunk) => {
      stderr += chunk;
    },
  });
  return { exitCode, envelope: JSON.parse(stdout) as Envelope, stderr };
}

function assertSuccess(result: Driven, command: string): Record<string, unknown> {
  assert.equal(result.envelope.schema_version, "riptide-command.v1");
  assert.equal(result.envelope.command, command);
  assert.equal(result.envelope.ok, true, JSON.stringify(result.envelope.error));
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  return result.envelope.data!;
}

function assertFailure(result: Driven, command: string, code: string, exitCode: number): Envelope {
  assert.equal(result.envelope.schema_version, "riptide-command.v1");
  assert.equal(result.envelope.command, command);
  assert.equal(result.envelope.ok, false);
  assert.equal(result.envelope.error?.code, code);
  assert.ok(result.envelope.error.message.length > 0);
  assert.doesNotMatch(result.envelope.error.message, /\n/);
  assert.ok(result.envelope.error.next.length > 0);
  assert.equal(result.exitCode, exitCode);
  assert.equal(result.stderr, "");
  return result.envelope;
}

async function tempRepo(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `riptide-top-json-${prefix}-`));
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

async function init(cwd: string, options: Partial<InitOptions> = {}): Promise<Driven> {
  return drive(cwd, (io) => runInit({ force: false, dir: cwd, json: true, ...options }, io));
}

const ANCHOR_TOML = `[programs.localnet]
token_vault = "Vau1t11111111111111111111111111111111111111"
`;

async function anchorRepo(): Promise<string> {
  const cwd = await tempRepo("anchor");
  await writeFile(path.join(cwd, "Anchor.toml"), ANCHOR_TOML, "utf8");
  return cwd;
}

test("init --json: a scaffold is a success envelope naming every file written", async () => {
  const cwd = await tempRepo("init");
  const data = assertSuccess(await init(cwd, { blank: true, name: "manual-program" }), "init");

  assert.deepEqual(data.programs, ["manual-program"]);
  assert.ok((data.created as string[]).includes(".riptide/.gitignore"));
  assert.ok((data.created as string[]).includes(".riptide/adapters/manual-program.toml"));
  assert.deepEqual(
    (data.adapters as { program: string; path: string }[]).map((a) => [a.program, a.path]),
    [["manual-program", ".riptide/adapters/manual-program.toml"]]
  );
});

test("init --json: every known failure path carries a stable code and a next action", async () => {
  const empty = await tempRepo("init-empty");
  assertFailure(await init(empty), "init", "init_no_program_detected", 2);

  const existing = await tempRepo("init-existing");
  assertSuccess(await init(existing, { blank: true }), "init");
  const exists = assertFailure(await init(existing, { blank: true }), "init", "init_workspace_exists", 2);
  assert.match(exists.error!.next, /reuse the existing Workspace/);

  const unknown = assertFailure(
    await init(await anchorRepo(), { program: "nope" }),
    "init",
    "init_program_not_found",
    2
  );
  assert.match(unknown.error!.next, /token-vault/);

  assertFailure(
    await init(await anchorRepo(), { protocol: "nft" as InitOptions["protocol"] }),
    "init",
    "init_invalid_option",
    2
  );
  assertFailure(
    await init(await anchorRepo(), { protocol: "amm", profile: "lending" }),
    "init",
    "init_invalid_option",
    2
  );

  const nameless = await tempRepo("init-nameless");
  await writeFile(path.join(nameless, "Anchor.toml"), "[provider]\ncluster = \"localnet\"\n", "utf8");
  assertFailure(await init(nameless), "init", "init_anchor_toml_unreadable", 2);

  const unpaired = await tempRepo("init-unpaired");
  await mkdir(path.join(unpaired, "target", "deploy"), { recursive: true });
  await mkdir(path.join(unpaired, "target", "idl"), { recursive: true });
  await writeFile(path.join(unpaired, "target", "deploy", "vault.so"), "so", "utf8");
  assertFailure(await init(unpaired), "init", "init_artifacts_unpaired", 2);

  assertFailure(
    await init(await tempRepo("init-bad-name"), { blank: true, name: "Bad Name" }),
    "init",
    "init_invalid_program_name",
    2
  );
});

test("init without --json keeps its human report on stderr", async () => {
  const cwd = await tempRepo("init-human");
  let stdout = "";
  let stderr = "";
  const exitCode = await runInit(
    { force: false, dir: cwd },
    {
      stdoutWrite: (chunk) => {
        stdout += chunk;
      },
      stderrWrite: (chunk) => {
        stderr += chunk;
      },
    }
  );
  assert.equal(exitCode, 2);
  assert.equal(stdout, "");
  assert.match(stderr, /riptide init: no Solana program detected in this directory\./);
});

// ---------------------------------------------------------------------------
// readiness
// ---------------------------------------------------------------------------

test("readiness --json: a repo report is a success envelope", async () => {
  const cwd = await anchorRepo();
  const data = assertSuccess(
    await drive(cwd, (io) =>
      runReadiness(".", { json: true }, { ...io, buildHealth: healthyReport })
    ),
    "readiness"
  );
  assert.equal(data.schemaVersion, "readiness.v1");
  assert.equal((data.health as { verdict: string }).verdict, "pass");
});

test("readiness --json: every known failure path carries a stable code and a next action", async () => {
  const cwd = await tempRepo("readiness");
  assertFailure(
    await drive(cwd, (io) => runReadiness(undefined, { json: true }, io)),
    "readiness",
    "readiness_missing_target",
    2
  );
  assertFailure(
    await drive(cwd, (io) => runReadiness(undefined, { json: true, caseStudies: "nowhere" }, io)),
    "readiness",
    "readiness_case_studies_not_found",
    2
  );

  await writeFile(path.join(cwd, "occupied"), "", "utf8");
  assertFailure(
    await drive(cwd, (io) => runReadiness(".", { json: true, out: "occupied" }, io)),
    "readiness",
    "readiness_failed",
    2
  );
});

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------

const SIM_MANIFEST = [
  "[sim.sweep]",
  'name = "rate_shock_bps"',
  "values = [0, 300]",
  "seeds_per_value = 2",
  "",
  "[sim.cartography]",
  'class = "lending.v1"',
  'risk_objective = "solvency"',
  "",
  "[sim.lifecycle]",
  'required_flows = ["deposit", "liquidate"]',
  "",
];

/** A Workspace holding one guided-sim sweep run; `withControl` declares the positive control. */
async function guidedSimWorkspace(withControl = true): Promise<string> {
  const cwd = await tempRepo("workspace");
  const simDir = path.join(cwd, ".riptide", "sim");
  const runDir = path.join(simDir, "artifacts", "smoke");
  await mkdir(runDir, { recursive: true });
  const manifest = withControl
    ? [...SIM_MANIFEST, "[sim.positive_control]", 'parameter = "rate_shock_bps"', "value = 0", ""]
    : SIM_MANIFEST;
  await writeFile(path.join(simDir, "Riptide.toml"), manifest.join("\n"), "utf8");
  const iterations = [0, 0, 300, 300].map((shock, index) => ({
    iteration: index,
    seed: index.toString(16).padStart(64, "0"),
    status: "passed",
    panic: false,
    parameters: { rate_shock_bps: shock },
    metrics: { bad_debt: shock * 10 + index },
    tx_outcomes: [
      { label: "deposit", ok: true },
      { label: "liquidate", ok: true },
    ],
    ...(index === 3 ? { invariant_fires: ["solvency"] } : {}),
  }));
  await writeFile(
    path.join(runDir, "guided-sim-run.json"),
    JSON.stringify({
      schema_version: 1,
      status: "passed",
      base_seed: "52".repeat(32),
      retained_failing_seed: null,
      iterations,
    }),
    "utf8"
  );
  return cwd;
}

async function review(cwd: string, target: string): Promise<Driven> {
  return drive(cwd, (io) => runReview(target, { json: true }, io));
}

test("review --json: a guided-sim artifact review is a success envelope", async () => {
  const cwd = await guidedSimWorkspace();
  const data = assertSuccess(await review(cwd, ".riptide/sim/artifacts/smoke"), "review");
  assert.equal(data.schema_version, "guided-sim-review.v1");
  assert.equal(data.status, "passed");
});

test("review --json: every known failure path carries a stable code and a next action", async () => {
  const cwd = await tempRepo("review");
  assertFailure(await review(cwd, "nowhere"), "review", "review_unrecognized_root", 2);

  const malformed = path.join(cwd, "malformed");
  await mkdir(malformed);
  await writeFile(path.join(malformed, "guided-sim-run.json"), "{", "utf8");
  assertFailure(await review(cwd, "malformed"), "review", "review_artifact_malformed", 2);

  const legacy = path.join(cwd, "legacy");
  await mkdir(legacy);
  await writeFile(path.join(legacy, "guided-sim-run.json"), JSON.stringify({ schema_version: 0 }), "utf8");
  assertFailure(await review(cwd, "legacy"), "review", "review_artifact_schema_invalid", 2);

  const badTrace = path.join(cwd, "bad-trace");
  await mkdir(badTrace);
  await writeFile(
    path.join(badTrace, "guided-sim-run.json"),
    JSON.stringify({ schema_version: 1, status: "passed", trace_schema_version: 2, iterations: [] }),
    "utf8"
  );
  assertFailure(await review(cwd, "bad-trace"), "review", "review_trace_malformed", 2);

  const badRerun = path.join(cwd, "bad-rerun");
  await mkdir(badRerun);
  await writeFile(
    path.join(badRerun, "guided-sim-run.json"),
    JSON.stringify({ schema_version: 1, status: "passed", iterations: [] }),
    "utf8"
  );
  await writeFile(path.join(badRerun, "rerun.sh"), "if then\n", "utf8");
  assertFailure(await review(cwd, "bad-rerun"), "review", "review_rerun_script_invalid", 2);

  const retained = path.join(cwd, "retained");
  await mkdir(retained);
  await writeFile(path.join(retained, "case.json"), JSON.stringify({ case_digest: "0".repeat(64) }), "utf8");
  await writeFile(path.join(retained, "rerun.sh"), "true\n", "utf8");
  assertFailure(await review(cwd, "retained"), "review", "review_case_digest_invalid", 2);

  const campaign = path.join(cwd, "campaign");
  await mkdir(campaign);
  await writeFile(path.join(campaign, "campaign-summary.json"), "{}", "utf8");
  await writeFile(path.join(campaign, "retention-manifest.json"), JSON.stringify({ entries: [] }), "utf8");
  assertFailure(await review(cwd, "campaign"), "review", "review_no_retained_cases", 2);
});

// ---------------------------------------------------------------------------
// assess
// ---------------------------------------------------------------------------

async function surfaced(withControl: boolean): Promise<string> {
  const cwd = await guidedSimWorkspace(withControl);
  let stderr = "";
  const exitCode = await runSimSurface(
    ".riptide/sim/artifacts/smoke",
    { sim: ".riptide/sim" },
    { cwd, stdoutWrite: () => {}, stderrWrite: (chunk) => (stderr += chunk) }
  );
  assert.equal(exitCode, 0, stderr);
  return cwd;
}

test("assess --json: an assessment is a success envelope", async () => {
  const cwd = await surfaced(true);
  const data = assertSuccess(
    await drive(cwd, (io) => runAssess(".riptide", { json: true }, io)),
    "assess"
  );
  assert.equal(data.schema_version, "assess-cli.v1");
  assert.match(data.assessment_digest as string, /^[0-9a-f]{64}$/);
});

test("assess --json: every known failure path carries a stable code and a next action", async () => {
  const empty = await tempRepo("assess-empty");
  assertFailure(
    await drive(empty, (io) => runAssess(".", { json: true }, io)),
    "assess",
    "assess_no_evidence",
    1
  );

  const cwd = await surfaced(true);
  assertFailure(
    await drive(cwd, (io) => runAssess(".riptide", { json: true, input: "missing.json" }, io)),
    "assess",
    "assess_input_not_found",
    1
  );
  assertFailure(
    await drive(cwd, (io) => runAssess(".riptide", { json: true, input: ".riptide" }, io)),
    "assess",
    "assess_input_unreadable",
    1
  );
  await writeFile(path.join(cwd, "bad.json"), "{", "utf8");
  assertFailure(
    await drive(cwd, (io) => runAssess(".riptide", { json: true, input: "bad.json" }, io)),
    "assess",
    "assess_input_invalid",
    1
  );
  assertFailure(
    await drive(cwd, (io) => runAssess(".riptide", { json: true, verdict: "safe" }, io)),
    "assess",
    "assess_input_invalid",
    1
  );

  const summaryPath = path.join(cwd, ".riptide", "campaign-summary.json");
  const summary = await readFile(summaryPath, "utf8");
  await writeFile(summaryPath, "{", "utf8");
  assertFailure(
    await drive(cwd, (io) => runAssess(".riptide", { json: true }, io)),
    "assess",
    "assess_artifact_malformed",
    1
  );
  await writeFile(summaryPath, summary, "utf8");

  const surfacePath = path.join(cwd, ".riptide", "risk-surface.json");
  const surface = JSON.parse(await readFile(surfacePath, "utf8")) as { schema_version: string };
  surface.schema_version = "risk-surface.v0";
  await writeFile(surfacePath, JSON.stringify(surface), "utf8");
  assertFailure(
    await drive(cwd, (io) => runAssess(".riptide", { json: true }, io)),
    "assess",
    "assess_artifact_schema_mismatch",
    1
  );
});

test("assess --json: blocked execution-honesty gates carry the gate report as data", async () => {
  const cwd = await surfaced(false);
  const blocked = assertFailure(
    await drive(cwd, (io) => runAssess(".riptide", { json: true }, io)),
    "assess",
    "assess_honesty_gates_blocked",
    1
  );
  const honesty = blocked.data!.execution_honesty as { status: string; gates: { id: string; status: string }[] };
  assert.equal(honesty.status, "blocked");
  assert.ok(honesty.gates.some((gate) => gate.id === "positive_control" && gate.status === "fail"));
});

test("assess --json: artifacts that drifted from the fresh render are reported, not overwritten", async () => {
  const cwd = await surfaced(true);
  assertSuccess(await drive(cwd, (io) => runAssess(".riptide", { json: true }, io)), "assess");
  const mdPath = path.join(cwd, ".riptide", "assessment.md");
  await writeFile(mdPath, `${await readFile(mdPath, "utf8")}tampered\n`, "utf8");
  assertFailure(
    await drive(cwd, (io) => runAssess(".riptide", { json: true }, io)),
    "assess",
    "assess_artifacts_drifted",
    1
  );
  assert.match(await readFile(mdPath, "utf8"), /tampered\n$/);
});

async function healthyReport(input: { cwd: string }): Promise<HealthReport> {
  return { cwd: input.cwd, environment: [], adapters: [], exitCode: 0 };
}
