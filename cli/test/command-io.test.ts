// Every Engine command runner can be driven with injected stdout, stderr
// and cwd: its output lands in the injected streams, relative paths resolve
// against the injected cwd, and nothing is written to the process streams.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CommandIO } from "../src/contract/index.js";
import { runAssess } from "../src/commands/assess.js";
import { runDoctor } from "../src/commands/doctor.js";
import { runInit } from "../src/commands/init.js";
import { runReadiness } from "../src/commands/readiness.js";
import { runReview } from "../src/commands/review.js";
import {
  runSimDebug,
  runSimFork,
  runSimGenerate,
  runSimLint,
  runSimRefresh,
  runSimRun,
  runSimSurface,
} from "../src/commands/sim.js";

const AMM_ADAPTER = path.resolve(process.cwd(), "..", "fixtures", "adapters", "amm.toml");
const GAPS_ADAPTER = path.resolve(
  process.cwd(),
  "..",
  "fixtures",
  "auto-genesis",
  "gaps",
  "adapter.toml"
);

interface Driven {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a command runner with injected streams, and fail if anything reaches
 * the real process streams while it runs.
 */
async function drive(
  cwd: string,
  run: (io: Required<CommandIO> & { color: false }) => Promise<number>
): Promise<Driven> {
  let stdout = "";
  let stderr = "";
  let leaked = "";
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  const spy = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    leaked += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    const callback = rest.find((arg): arg is () => void => typeof arg === "function");
    callback?.();
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = spy;
  process.stderr.write = spy;
  let exitCode: number;
  try {
    exitCode = await run({
      cwd,
      stdoutWrite: (chunk) => {
        stdout += chunk;
      },
      stderrWrite: (chunk) => {
        stderr += chunk;
      },
      color: false,
    });
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
  assert.equal(leaked, "", "the runner wrote to the process streams");
  return { exitCode, stdout, stderr };
}

async function tempRepo(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `riptide-command-io-${prefix}-`));
}

test("command io: init reports through the injected stderr", async () => {
  const cwd = await tempRepo("init");
  const result = await drive(cwd, (io) =>
    runInit({ force: false, dir: cwd, blank: true, name: "manual-program" }, io)
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /riptide init: scaffolded \.riptide\/ for 1 program/);
  assert.match(result.stderr, /created \.riptide\/\.gitignore/);
  assert.ok(existsSync(path.join(cwd, ".riptide", "adapters", "manual-program.toml")));
});

test("command io: init failures report through the injected stderr", async () => {
  const cwd = await tempRepo("init-fail");
  const result = await drive(cwd, (io) => runInit({ force: false, dir: cwd }, io));

  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /riptide init:/);
});

test("command io: doctor text report goes to the injected stdout", async () => {
  const cwd = await tempRepo("doctor");
  const result = await drive(cwd, (io) => runDoctor({}, io));

  assert.match(result.stdout, /Doctor — Riptide health check/);
  assert.match(result.stdout, new RegExp(`cwd: ${cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("command io: sim generate, refresh and lint resolve paths against the injected cwd", async () => {
  const cwd = await tempRepo("sim-generate");

  const generated = await drive(cwd, (io) => runSimGenerate({ adapter: AMM_ADAPTER }, io));
  assert.equal(generated.exitCode, 0, generated.stderr);
  assert.equal(generated.stdout, "");
  assert.match(generated.stderr, /generated guided Rust simulation/);
  assert.ok(existsSync(path.join(cwd, ".riptide", "sim", "Riptide.toml")));

  const refreshed = await drive(cwd, (io) => runSimRefresh({ adapter: AMM_ADAPTER }, io));
  assert.equal(refreshed.exitCode, 0, refreshed.stderr);
  assert.match(refreshed.stderr, /refreshed generated Rust files/);

  const linted = await drive(cwd, (io) => runSimLint(".riptide/sim", io));
  assert.equal(linted.exitCode, 0, linted.stdout);
  assert.match(linted.stdout, /Verdict: PASS \(exit 0\)/);
});

test("command io: sim generate routes the genesis summary through the injected stderr", async () => {
  const cwd = await tempRepo("sim-gaps");
  const result = await drive(cwd, (io) => runSimGenerate({ adapter: GAPS_ADAPTER }, io));

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /tick-0 genesis has 5 unresolved seams/);
});

test("command io: sim generate failures report through the injected stderr", async () => {
  const cwd = await tempRepo("sim-generate-fail");
  const result = await drive(cwd, (io) => runSimGenerate({ adapter: "missing.toml" }, io));

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /riptide sim:/);
});

test("command io: sim surface, sim review, assess and readiness drive a fixture Workspace", async () => {
  const cwd = await tempRepo("workspace");
  await writeGuidedSimWorkspace(cwd);

  const surfaced = await drive(cwd, (io) =>
    runSimSurface(".riptide/sim/artifacts/smoke", { sim: ".riptide/sim" }, io)
  );
  assert.equal(surfaced.exitCode, 0, surfaced.stderr);
  assert.equal(surfaced.stdout, "");
  assert.match(surfaced.stderr, /wrote cartography artifacts/);
  assert.match(surfaced.stderr, /next: riptide assess \.riptide\n/);
  assert.ok(existsSync(path.join(cwd, ".riptide", "campaign-summary.json")));

  const reviewed = await drive(cwd, (io) =>
    runReview(".riptide/sim/artifacts/smoke", { json: true }, io)
  );
  assert.equal(reviewed.exitCode, 0, reviewed.stderr);
  assert.ok(JSON.parse(reviewed.stdout));

  const assessed = await drive(cwd, (io) => runAssess(".riptide", { json: true }, io));
  assert.equal(assessed.exitCode, 0, assessed.stderr);
  assert.equal(
    (JSON.parse(assessed.stdout) as { schema_version: string }).schema_version,
    "assess-cli.v1"
  );

  const readiness = await drive(cwd, (io) => runReadiness(".", { json: true }, io));
  assert.equal(readiness.exitCode, 0, readiness.stderr);
  assert.ok(JSON.parse(readiness.stdout));
});

test("command io: sim surface and review failures report through the injected stderr", async () => {
  const cwd = await tempRepo("workspace-fail");

  const surfaced = await drive(cwd, (io) => runSimSurface("nowhere", { sim: ".riptide/sim" }, io));
  assert.equal(surfaced.exitCode, 2);
  assert.match(surfaced.stderr, /guided-sim run artifact not found/);

  const reviewed = await drive(cwd, (io) => runReview("nowhere", {}, io));
  assert.equal(reviewed.exitCode, 2);
  assert.match(reviewed.stderr, /not a recognized Riptide review root/);
});

test("command io: sim fork reuses a cached snapshot resolved against the injected cwd", async () => {
  const cwd = await tempRepo("sim-fork");
  const address = "11111111111111111111111111111111";
  await writeFile(
    path.join(cwd, "snapshot.json"),
    JSON.stringify({
      pubkey: address,
      account: { lamports: 1, data: ["", "base64"], owner: address, executable: false, rentEpoch: 0 },
    }),
    "utf8"
  );

  const reused = await drive(cwd, (io) =>
    runSimFork({ address, cluster: "mainnet", out: "snapshot.json" }, io)
  );
  assert.equal(reused.exitCode, 0, reused.stderr);
  assert.match(reused.stdout, /reused cached snapshot .*snapshot\.json/);

  const mismatched = await drive(cwd, (io) =>
    runSimFork({ address: "Stake11111111111111111111111111111111111111", cluster: "mainnet", out: "snapshot.json" }, io)
  );
  assert.equal(mismatched.exitCode, 2);
  assert.match(mismatched.stderr, /does not match requested address/);
});

test("command io: sim run and sim debug pipe the sim crate's output into the injected streams", async () => {
  const cwd = await tempRepo("sim-run");
  await writeEchoCrate(path.join(cwd, ".riptide", "sim"));

  const ran = await drive(cwd, (io) => runSimRun(".riptide/sim", { flows: "3" }, io));
  assert.equal(ran.exitCode, 0, ran.stderr);
  assert.match(ran.stdout, /sim stdout: --flows 3\n/);
  assert.match(ran.stderr, /sim stderr\n/);

  const debugged = await drive(cwd, (io) => runSimDebug(".riptide/sim", { seed: "ab" }, io));
  assert.equal(debugged.exitCode, 0, debugged.stderr);
  assert.match(debugged.stdout, /sim stdout: --iterations 1 --seed ab --debug\n/);
});

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

/** A dependency-free crate standing in for a sim crate: it echoes its args. */
async function writeEchoCrate(dir: string): Promise<void> {
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(
    path.join(dir, "Cargo.toml"),
    '[package]\nname = "echo-sim"\nversion = "0.0.0"\nedition = "2021"\n\n[workspace]\n',
    "utf8"
  );
  await writeFile(
    path.join(dir, "src", "main.rs"),
    [
      "fn main() {",
      '    let args: Vec<String> = std::env::args().skip(1).collect();',
      '    println!("sim stdout: {}", args.join(" "));',
      '    eprintln!("sim stderr");',
      "}",
      "",
    ].join("\n"),
    "utf8"
  );
}
