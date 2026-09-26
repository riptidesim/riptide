// The `sim` subcommands under `--json`: one command envelope on stdout,
// and the error shape (code, message, next) on every failure the Skill has
// to repair — a build failure, a lint failure, a missing setup piece.
// Driven through the runners against fixture Workspaces and tiny stand-in
// sim crates.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { CommandIO } from "../src/contract/index.js";
import {
  runSimDebug,
  runSimFork,
  runSimGenerate,
  runSimLint,
  runSimRefresh,
  runSimRun,
  runSimSurface,
} from "../src/commands/sim.js";

const execFileAsync = promisify(execFile);
const cliEntrypoint = path.resolve(process.cwd(), "dist/src/index.js");
const FIXTURES = path.resolve(process.cwd(), "..", "fixtures");
const DERIVABLE_ADAPTER = path.join(FIXTURES, "auto-genesis", "derivable", "adapter.toml");
const GAPS_ADAPTER = path.join(FIXTURES, "auto-genesis", "gaps", "adapter.toml");
const SURFACE_FILES = ["campaign-summary.json", "risk-surface.json", "retention-manifest.json"];

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

function assertSuccess(result: Driven, command: string, exitCode = 0): Record<string, unknown> {
  assert.equal(result.envelope.schema_version, "riptide-command.v1");
  assert.equal(result.envelope.command, command);
  assert.equal(result.envelope.ok, true, JSON.stringify(result.envelope.error));
  assert.equal(result.exitCode, exitCode);
  assert.equal(result.stderr, "");
  return result.envelope.data!;
}

function assertFailure(result: Driven, command: string, code: string, exitCode: number): Envelope {
  assert.equal(result.envelope.schema_version, "riptide-command.v1");
  assert.equal(result.envelope.command, command);
  assert.equal(result.envelope.ok, false);
  assert.equal(result.envelope.error?.code, code, JSON.stringify(result.envelope.error));
  assert.ok(result.envelope.error.message.length > 0);
  assert.doesNotMatch(result.envelope.error.message, /\n/);
  assert.ok(result.envelope.error.next.length > 0);
  assert.equal(result.exitCode, exitCode);
  assert.equal(result.stderr, "");
  return result.envelope;
}

async function tempRepo(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `riptide-sim-json-${prefix}-`));
}

test("sim --json: every subcommand accepts --json", async () => {
  for (const sub of ["generate", "refresh", "run", "surface", "fork", "lint", "debug"]) {
    const { stdout } = await execFileAsync(process.execPath, [cliEntrypoint, "sim", sub, "--help"]);
    assert.match(stdout, /--json\b/, `sim ${sub} --help lists no --json`);
  }
});

test("sim --json: the CLI writes only the envelope to stdout", async () => {
  const cwd = await tempRepo("cli");
  const result = await execFileAsync(
    process.execPath,
    [cliEntrypoint, "sim", "generate", "--adapter", DERIVABLE_ADAPTER, "--json"],
    { cwd }
  );
  const envelope = JSON.parse(result.stdout) as Envelope;
  assert.equal(envelope.command, "sim generate");
  assert.equal(envelope.ok, true);
  assert.equal(result.stderr, "");
});

// ---------------------------------------------------------------------------
// generate / refresh
// ---------------------------------------------------------------------------

test("sim generate --json: a derived genesis is a success envelope carrying the setup-gaps report", async () => {
  const cwd = await tempRepo("generate");
  const data = assertSuccess(
    await drive(cwd, (io) => runSimGenerate({ adapter: DERIVABLE_ADAPTER, json: true }, io)),
    "sim generate"
  );

  assert.equal(data.dir, path.join(cwd, ".riptide", "sim"));
  assert.equal(data.sim_manifest, path.join(cwd, ".riptide", "sim", "Riptide.toml"));
  assert.equal((data.setup_gaps as { genesis: string }).genesis, "derived");
  assert.ok(existsSync(path.join(cwd, ".riptide", "sim", "src", "flows.rs")));
});

test("sim generate --json: unresolved genesis seams are a setup-gap failure naming the file to author", async () => {
  const cwd = await tempRepo("generate-gaps");
  const failure = assertFailure(
    await drive(cwd, (io) => runSimGenerate({ adapter: GAPS_ADAPTER, json: true }, io)),
    "sim generate",
    "sim_setup_gaps",
    2
  );

  assert.match(failure.error!.message, /5 unresolved seams: .*accounts\.vault/);
  assert.match(failure.error!.next, /author the unresolved seams .* in \.riptide\/sim\/src\/flows\.rs/);
  assert.match(failure.error!.next, /riptide sim run \.riptide\/sim --json/);
  const gaps = failure.data!.setup_gaps as { genesis: string; gaps: unknown[] };
  assert.equal(gaps.genesis, "gaps");
  assert.equal(gaps.gaps.length, 5);
  assert.ok(existsSync(path.join(cwd, ".riptide", "sim", "setup-gaps.json")));
});

test("sim generate --json: seams already authored in a preserved flows.rs are not a failure", async () => {
  const cwd = await tempRepo("generate-preserved");
  await drive(cwd, (io) => runSimGenerate({ adapter: GAPS_ADAPTER, json: true }, io));

  const data = assertSuccess(
    await drive(cwd, (io) => runSimGenerate({ adapter: GAPS_ADAPTER, json: true }, io)),
    "sim generate"
  );
  assert.equal((data.setup_gaps as { flows_rs: string }).flows_rs, "preserved");
});

test("sim generate and refresh --json: adapter and IDL problems carry a stable code", async () => {
  const cwd = await tempRepo("generate-fail");
  const missing = assertFailure(
    await drive(cwd, (io) => runSimGenerate({ adapter: "missing.toml", json: true }, io)),
    "sim generate",
    "sim_adapter_not_found",
    2
  );
  assert.match(missing.error!.next, /riptide init --json/);

  await mkdir(path.join(cwd, "adapters"), { recursive: true });
  await writeFile(
    path.join(cwd, "adapters", "broken-idl.toml"),
    (await readFile(DERIVABLE_ADAPTER, "utf8")).replace(/^idl_path\s*=.*$/m, 'idl_path = "missing-idl.json"'),
    "utf8"
  );
  assertFailure(
    await drive(cwd, (io) =>
      runSimRefresh({ adapter: path.join(cwd, "adapters", "broken-idl.toml"), json: true }, io)
    ),
    "sim refresh",
    "sim_idl_invalid",
    2
  );
});

test("sim refresh --json: a refresh is a success envelope", async () => {
  const cwd = await tempRepo("refresh");
  const data = assertSuccess(
    await drive(cwd, (io) => runSimRefresh({ adapter: DERIVABLE_ADAPTER, json: true }, io)),
    "sim refresh"
  );
  assert.equal(data.dir, path.join(cwd, ".riptide", "sim"));
  assert.equal(data.adapter, DERIVABLE_ADAPTER);
});

// ---------------------------------------------------------------------------
// lint
// ---------------------------------------------------------------------------

test("sim lint --json: a valid manifest is a success envelope with the findings", async () => {
  const cwd = await tempRepo("lint");
  await mkdir(path.join(cwd, ".riptide", "sim"), { recursive: true });
  await writeFile(
    path.join(cwd, ".riptide", "sim", "Riptide.toml"),
    '[sim.sweep]\nname = "shock"\nvalues = [0, 1]\n',
    "utf8"
  );

  const data = assertSuccess(
    await drive(cwd, (io) => runSimLint(".riptide/sim", { json: true }, io)),
    "sim lint"
  );
  assert.equal(data.verdict, "pass");
  assert.deepEqual(
    (data.findings as { code: string }[]).map((finding) => finding.code),
    ["manifest-schema"]
  );
});

test("sim lint --json: a failing manifest names the first repair as next", async () => {
  const cwd = await tempRepo("lint-fail");
  await mkdir(path.join(cwd, ".riptide", "sim"), { recursive: true });
  await writeFile(
    path.join(cwd, ".riptide", "sim", "Riptide.toml"),
    '[[sim.programs]]\naddress = "11111111111111111111111111111111"\nprogram = "missing.so"\nloader = "direct"\n',
    "utf8"
  );

  const failure = assertFailure(
    await drive(cwd, (io) => runSimLint(".riptide/sim", { json: true }, io)),
    "sim lint",
    "sim_lint_failed",
    2
  );
  assert.match(failure.error!.message, /program-file-missing at sim\.programs\[0\]\.program/);
  assert.match(failure.error!.next, /^sim\.programs\[0\]\.program: Build the dependency program/);
  assert.equal(failure.data!.verdict, "fail");
});

test("sim lint --json: a missing manifest points at sim generate", async () => {
  const cwd = await tempRepo("lint-missing");
  const failure = assertFailure(
    await drive(cwd, (io) => runSimLint(".riptide/sim", { json: true }, io)),
    "sim lint",
    "sim_lint_manifest_missing",
    2
  );
  assert.match(failure.error!.next, /riptide sim generate --adapter <adapter> --dir \.riptide\/sim --json/);
});

// ---------------------------------------------------------------------------
// run / debug
// ---------------------------------------------------------------------------

test("sim run --json: a passing run is a success envelope and the crate's output stays off stdout", async () => {
  const cwd = await tempRepo("run");
  await writeCrate(path.join(cwd, ".riptide", "sim"), PASSING_MAIN);

  const data = assertSuccess(
    await drive(cwd, (io) =>
      runSimRun(".riptide/sim", { flows: "3", out: "out", json: true }, io)
    ),
    "sim run"
  );
  assert.equal(data.crate, path.join(cwd, ".riptide", "sim"));
  assert.equal(data.out, path.join(cwd, "out"));
  assert.equal(data.sweep, null);
  assert.deepEqual(data.run, null);
  assert.deepEqual(data.execution_honesty_warnings, []);
  assert.match(await readFile(path.join(cwd, "out", "rerun.sh"), "utf8"), /riptide sim run .* --flows 3 --out /);
  assert.doesNotMatch(await readFile(path.join(cwd, "out", "rerun.sh"), "utf8"), /--json/);
});

test("sim run --json: a compile error is a build failure carrying the compiler diagnostics", async () => {
  const cwd = await tempRepo("run-build");
  await writeCrate(path.join(cwd, ".riptide", "sim"), "fn main() { let x: u8 = \"nope\"; }\n");

  const result = await drive(cwd, (io) => runSimRun(".riptide/sim", { json: true }, io));
  const failure = assertFailure(result, "sim run", "sim_build_failed", result.exitCode);
  assert.notEqual(result.exitCode, 0);
  assert.match(failure.error!.next, /fix the compiler errors in data\.diagnostics/);
  assert.match(failure.error!.next, /riptide sim run \.riptide\/sim --json/);
  assert.ok(
    (failure.data!.diagnostics as string[]).some((line) => /error\[E0308\]/.test(line)),
    JSON.stringify(failure.data)
  );
});

test("sim run --json: a failing iteration names the seed to replay with sim debug", async () => {
  const cwd = await tempRepo("run-fail");
  await writeCrate(path.join(cwd, ".riptide", "sim"), FAILING_MAIN);

  const failure = assertFailure(
    await drive(cwd, (io) => runSimRun(".riptide/sim", { json: true }, io)),
    "sim run",
    "sim_run_failed",
    1
  );
  assert.equal(failure.data!.failing_seed, "ab12");
  assert.match(failure.error!.message, /seed ab12: invariant solvency failed/);
  assert.match(failure.error!.next, /riptide sim debug \.riptide\/sim --seed ab12 --json/);
  assert.ok((failure.data!.log_tail as string[]).includes("riptide sim: invariant solvency failed"));
});

test("sim run --json: a missing sim crate points at sim generate", async () => {
  const cwd = await tempRepo("run-missing");
  const failure = assertFailure(
    await drive(cwd, (io) => runSimRun(".riptide/sim", { json: true }, io)),
    "sim run",
    "sim_crate_not_found",
    2
  );
  assert.match(failure.error!.next, /riptide sim generate --adapter <adapter> --dir \.riptide\/sim --json/);
});

test("sim debug --json: the replay log is the data, whether the seed passes or fails", async () => {
  const passing = await tempRepo("debug");
  await writeCrate(path.join(passing, ".riptide", "sim"), PASSING_MAIN);
  const passed = assertSuccess(
    await drive(passing, (io) => runSimDebug(".riptide/sim", { seed: "ab", json: true }, io)),
    "sim debug"
  );
  assert.equal(passed.status, "passed");
  assert.equal(passed.seed, "ab");
  assert.ok((passed.log as string[]).includes("tx label=deposit ok=true"));

  const failing = await tempRepo("debug-fail");
  await writeCrate(path.join(failing, ".riptide", "sim"), FAILING_MAIN);
  const failed = assertSuccess(
    await drive(failing, (io) => runSimDebug(".riptide/sim", { seed: "ab12", json: true }, io)),
    "sim debug"
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.failure, "invariant solvency failed");
});

// ---------------------------------------------------------------------------
// surface
// ---------------------------------------------------------------------------

test("sim surface --json: writes the same Engine Output bytes as the human path", async () => {
  const human = await tempRepo("surface-human");
  const agent = await tempRepo("surface-json");
  await writeGuidedSimWorkspace(human);
  await writeGuidedSimWorkspace(agent);

  let humanStderr = "";
  const humanExit = await runSimSurface(
    ".riptide/sim/artifacts/smoke",
    { sim: ".riptide/sim" },
    { cwd: human, stdoutWrite: () => {}, stderrWrite: (chunk) => (humanStderr += chunk) }
  );
  assert.equal(humanExit, 0, humanStderr);

  const data = assertSuccess(
    await drive(agent, (io) =>
      runSimSurface(".riptide/sim/artifacts/smoke", { sim: ".riptide/sim", json: true }, io)
    ),
    "sim surface"
  );
  assert.equal(data.out_dir, path.join(agent, ".riptide"));
  assert.deepEqual(data.files, SURFACE_FILES);
  assert.equal((data.execution_honesty as { status: string }).status, "pass");

  for (const file of SURFACE_FILES) {
    assert.equal(
      await readFile(path.join(agent, ".riptide", file), "utf8"),
      await readFile(path.join(human, ".riptide", file), "utf8"),
      `${file} bytes differ between --json and the human path`
    );
  }
});

test("sim surface --json: a missing run or a missing sweep is a setup failure with the next step", async () => {
  const noRun = await tempRepo("surface-no-run");
  const missingRun = assertFailure(
    await drive(noRun, (io) =>
      runSimSurface(".riptide/sim/artifacts/smoke", { sim: ".riptide/sim", json: true }, io)
    ),
    "sim surface",
    "sim_surface_run_not_found",
    2
  );
  assert.match(missingRun.error!.next, /riptide sim run \.riptide\/sim --out \.riptide\/sim\/artifacts\/smoke --json/);

  const noSweep = await tempRepo("surface-no-sweep");
  await writeGuidedSimWorkspace(noSweep);
  await writeFile(path.join(noSweep, ".riptide", "sim", "Riptide.toml"), "", "utf8");
  const missingSweep = assertFailure(
    await drive(noSweep, (io) =>
      runSimSurface(".riptide/sim/artifacts/smoke", { sim: ".riptide/sim", json: true }, io)
    ),
    "sim surface",
    "sim_surface_sweep_missing",
    2
  );
  assert.match(missingSweep.error!.next, /declare a \[sim\.sweep\] block/);

  await writeFile(path.join(noSweep, ".riptide", "sim", "artifacts", "smoke", "guided-sim-run.json"), "{", "utf8");
  assertFailure(
    await drive(noSweep, (io) =>
      runSimSurface(".riptide/sim/artifacts/smoke", { sim: ".riptide/sim", json: true }, io)
    ),
    "sim surface",
    "sim_surface_run_malformed",
    2
  );
});

// ---------------------------------------------------------------------------
// fork / review
// ---------------------------------------------------------------------------

test("sim fork --json: a reused cache is a success envelope; a mismatched cache says to overwrite", async () => {
  const cwd = await tempRepo("fork");
  const address = "11111111111111111111111111111111";
  await writeFile(
    path.join(cwd, "snapshot.json"),
    JSON.stringify({
      pubkey: address,
      account: { lamports: 1, data: ["", "base64"], owner: address, executable: false, rentEpoch: 0 },
    }),
    "utf8"
  );

  const data = assertSuccess(
    await drive(cwd, (io) =>
      runSimFork({ address, cluster: "mainnet", out: "snapshot.json", json: true }, io)
    ),
    "sim fork"
  );
  assert.deepEqual(data, { address, cluster: "mainnet", out: path.join(cwd, "snapshot.json"), reused: true });

  const mismatch = assertFailure(
    await drive(cwd, (io) =>
      runSimFork(
        { address: "Stake11111111111111111111111111111111111111", cluster: "mainnet", out: "snapshot.json", json: true },
        io
      )
    ),
    "sim fork",
    "sim_fork_cache_invalid",
    2
  );
  assert.match(mismatch.error!.next, /--overwrite --json/);

  assertFailure(
    await drive(cwd, (io) =>
      runSimFork({ address, cluster: "http://127.0.0.1:9", out: "fresh.json", json: true }, io)
    ),
    "sim fork",
    "sim_fork_fetch_failed",
    2
  );
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const PASSING_MAIN = [
  "fn main() {",
  '    eprintln!("riptide sim iteration=0 seed=ab");',
  '    eprintln!("tx label=deposit ok=true");',
  "}",
  "",
].join("\n");

/** Mirrors the guided-sim runner's failure lines and exit code. */
const FAILING_MAIN = [
  "fn main() {",
  '    eprintln!("riptide sim iteration=0 seed=ab12");',
  '    eprintln!("riptide sim failure iteration=0 seed=ab12");',
  '    eprintln!("riptide sim: invariant solvency failed");',
  "    std::process::exit(1);",
  "}",
  "",
].join("\n");

/** A dependency-free crate standing in for a sim crate. */
async function writeCrate(dir: string, main: string): Promise<void> {
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(
    path.join(dir, "Cargo.toml"),
    '[package]\nname = "stand-in-sim"\nversion = "0.0.0"\nedition = "2021"\n\n[workspace]\n',
    "utf8"
  );
  await writeFile(path.join(dir, "src", "main.rs"), main, "utf8");
}

/** A minimal Workspace holding one guided-sim sweep run and its manifest. */
async function writeGuidedSimWorkspace(cwd: string): Promise<void> {
  const simDir = path.join(cwd, ".riptide", "sim");
  const runDir = path.join(simDir, "artifacts", "smoke");
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(simDir, "Riptide.toml"),
    [
      "[sim.sweep]",
      'name = "rate_shock_bps"',
      "values = [0, 300]",
      "seeds_per_value = 2",
      "",
      "[sim.cartography]",
      'class = "lending.v1"',
      'risk_objective = "solvency"',
      "",
      "[sim.positive_control]",
      'parameter = "rate_shock_bps"',
      "value = 0",
      "",
      "[sim.lifecycle]",
      'required_flows = ["deposit", "liquidate"]',
      "",
    ].join("\n"),
    "utf8"
  );
  const iterations = [];
  for (const [index, shock] of [0, 0, 300, 300].entries()) {
    iterations.push({
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
      ...(shock === 300 && index === 3 ? { invariant_fires: ["solvency"] } : {}),
    });
  }
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
}
