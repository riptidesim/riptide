// `sim run --firing-check` against a real sim crate built on the runtime:
// one invariant that fires under its declared violation, and one wired to the
// wrong account that must come back `did-not-fire`. Declaring violations
// leaves a normal run's Engine Output untouched.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { CommandIO } from "../src/contract/index.js";
import { runSimRun } from "../src/commands/sim.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(process.cwd(), "..");
const FIXTURE_MAIN = path.join(REPO_ROOT, "fixtures", "firing-check", "src", "main.rs");
const cliEntrypoint = path.resolve(process.cwd(), "dist/src/index.js");

// Every fixture crate shares one build cache, so the runtime compiles once.
process.env.CARGO_TARGET_DIR ??= path.join(REPO_ROOT, "target", "sim-fixtures");

interface Envelope {
  schema_version: string;
  command: string;
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; next: string };
}

async function drive(
  cwd: string,
  run: (io: Required<CommandIO>) => Promise<number>
): Promise<{ exitCode: number; envelope: Envelope; stderr: string }> {
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

/** A Workspace whose `.riptide/sim` crate is the fixture, built on the runtime in this repo. */
async function fixtureWorkspace(prefix: string, main?: string): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), `riptide-firing-${prefix}-`));
  const crate = path.join(cwd, ".riptide", "sim");
  await mkdir(path.join(crate, "src"), { recursive: true });
  await writeFile(
    path.join(crate, "Cargo.toml"),
    [
      "[package]",
      'name = "firing-check-sim"',
      'version = "0.1.0"',
      'edition = "2021"',
      "publish = false",
      "",
      "[workspace]",
      "",
      "[dependencies]",
      `riptide-sim = { path = ${JSON.stringify(path.join(REPO_ROOT, "riptide-sim"))} }`,
      "",
    ].join("\n"),
    "utf8"
  );
  await copyFile(path.join(REPO_ROOT, "Cargo.lock"), path.join(crate, "Cargo.lock"));
  await writeFile(
    path.join(crate, "src", "main.rs"),
    main ?? (await readFile(FIXTURE_MAIN, "utf8")),
    "utf8"
  );
  return cwd;
}

/** The fixture with its `#[violations]` method removed. */
async function undeclaredMain(): Promise<string> {
  const main = await readFile(FIXTURE_MAIN, "utf8");
  const start = main.indexOf("    #[violations]");
  const end = main.indexOf("}\n\nfn main()");
  assert.ok(start > 0 && end > start, "the fixture declares its violations in one method");
  return (main.slice(0, start).trimEnd() + "\n" + main.slice(end))
    .replace(" FiringCheck,", "")
    .replace(" Violation,", "");
}

test("sim run --firing-check --json: one invariant fires, the one wired to the wrong account does not", async () => {
  const cwd = await fixtureWorkspace("both");

  const result = await drive(cwd, (io) =>
    runSimRun(".riptide/sim", { firingCheck: true, flows: "3", json: true }, io)
  );

  assert.equal(result.envelope.schema_version, "riptide-command.v1");
  assert.equal(result.envelope.command, "sim run");
  assert.equal(result.envelope.ok, true, JSON.stringify(result.envelope.error));
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  const data = result.envelope.data!;
  assert.equal(data.crate, path.join(cwd, ".riptide", "sim"));
  assert.match(data.seed as string, /^[0-9a-f]{64}$/);
  assert.equal(data.flows, 3);
  assert.equal(data.fired, 1);
  assert.equal(data.did_not_fire, 1);
  assert.deepEqual(data.invariants, [
    {
      invariant: "vault_backed",
      violation: `zero 8 byte(s) at offset 8 of ${"4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi"}`,
      result: "fired",
      detail: null,
    },
    {
      invariant: "decoy_backed",
      violation: `zero 8 byte(s) at offset 8 of ${"4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi"}`,
      result: "did-not-fire",
      detail: null,
    },
  ]);
  assert.deepEqual(await readdir(cwd), [".riptide"], "a Firing Check writes no run artifact");
});

test("sim run: declaring violations leaves a normal run's Engine Output byte-identical", async () => {
  const declared = await fixtureWorkspace("declared");
  const undeclared = await fixtureWorkspace("undeclared", await undeclaredMain());

  const outputs: string[] = [];
  for (const cwd of [declared, undeclared]) {
    const result = await drive(cwd, (io) =>
      runSimRun(".riptide/sim", { iterations: "2", flows: "3", out: "out", json: true }, io)
    );
    assert.equal(result.envelope.ok, true, JSON.stringify(result.envelope.error));
    assert.deepEqual((await readdir(path.join(cwd, "out"))).sort(), ["guided-sim-run.json", "rerun.sh"]);
    outputs.push(await readFile(path.join(cwd, "out", "guided-sim-run.json"), "utf8"));
  }
  assert.equal(outputs[0], outputs[1]);
  assert.doesNotMatch(outputs[0]!, /firing|violation/i);
});

test("sim run --firing-check --json: a sim that declares no violations names the file to author", async () => {
  const cwd = await fixtureWorkspace("none", await undeclaredMain());

  const result = await drive(cwd, (io) =>
    runSimRun(".riptide/sim", { firingCheck: true, json: true }, io)
  );

  assert.equal(result.envelope.ok, false);
  assert.equal(result.envelope.error?.code, "sim_firing_check_undeclared");
  assert.equal(result.exitCode, 2);
  assert.match(result.envelope.error!.next, /\.riptide\/sim\/src\/violations\.rs/);
  assert.match(result.envelope.error!.next, /riptide sim run \.riptide\/sim --firing-check --json/);
  assert.deepEqual(result.envelope.data!.invariants, []);
});

test("sim run --firing-check --json: a run that cannot reach the injection names the repair", async () => {
  const cwd = await fixtureWorkspace(
    "unreachable",
    (await readFile(FIXTURE_MAIN, "utf8")).replace(
      "let vault = self.vault;",
      'riptide_sim::anyhow::ensure!(self.vault == self.decoy, "deposit rejected");\n        let vault = self.vault;'
    )
  );

  const result = await drive(cwd, (io) =>
    runSimRun(".riptide/sim", { firingCheck: true, json: true }, io)
  );

  assert.equal(result.envelope.ok, false);
  assert.equal(result.envelope.error?.code, "sim_firing_check_failed");
  assert.equal(result.exitCode, 1);
  assert.match(
    result.envelope.error!.message,
    /flow deposit failed at step 0 before the Firing Check: deposit rejected/
  );
  assert.match(result.envelope.error!.next, /riptide sim run \.riptide\/sim --firing-check --json/);
  assert.ok(Array.isArray(result.envelope.data!.log_tail));
});

test("sim run --firing-check cannot be combined with --out", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [cliEntrypoint, "sim", "run", "--firing-check", "--out", "x", "--json"]),
    (err: { stderr: string }) => /--firing-check.*cannot be used with.*--out/.test(err.stderr)
  );
});
