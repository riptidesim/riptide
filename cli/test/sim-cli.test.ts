import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cliEntrypoint = path.resolve(process.cwd(), "dist/src/index.js");

test("sim command is registered in advanced support help", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliEntrypoint, "--help"], {
    cwd: process.cwd()
  });

  assert.match(stdout, /^\s+sim\b/m);
  assert.match(stdout, /Generate, refresh, and run guided Rust\s+simulations/);
});

test("sim generate CLI writes expected files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-sim-cli-"));
  const adapter = path.resolve(process.cwd(), "..", "fixtures", "adapters", "amm.toml");
  const outDir = path.join(root, ".riptide", "sim");

  const generated = await execFileAsync(
    process.execPath,
    [cliEntrypoint, "sim", "generate", "--adapter", adapter, "--dir", outDir],
    { cwd: root }
  );

  assert.match(generated.stderr, /generated guided Rust simulation/);
  assert.match(generated.stderr, /bootstrap .*Riptide\.toml/);
  assert.match(await readFile(path.join(outDir, "src", "types.rs"), "utf8"), /SwapBuilder/);
  assert.match(await readFile(path.join(outDir, "src", "services", "oracle.rs"), "utf8"), /impl Service for OracleService/);
  assert.match(await readFile(path.join(outDir, "Riptide.toml"), "utf8"), /\[\[sim\.accounts\]\]/);

  const linted = await execFileAsync(process.execPath, [cliEntrypoint, "sim", "lint", outDir], {
    cwd: root
  });
  assert.match(linted.stdout, /Verdict: PASS \(exit 0\)/);
});

test("sim generate CLI routes an unresolvable genesis to the agent skill on stderr", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-sim-cli-gaps-"));
  const adapter = path.resolve(
    process.cwd(),
    "..",
    "fixtures",
    "auto-genesis",
    "gaps",
    "adapter.toml"
  );
  const outDir = path.join(root, ".riptide", "sim");

  const generated = await execFileAsync(
    process.execPath,
    [cliEntrypoint, "sim", "generate", "--adapter", adapter, "--dir", outDir],
    { cwd: root }
  );

  // Routing copy is human chrome: stderr only, so a --json consumer keeps a
  // clean stdout.
  assert.equal(generated.stdout, "");
  assert.match(generated.stderr, /riptide sim: tick-0 genesis has 5 unresolved seams/);
  assert.match(generated.stderr, /accounts\.vault \(program_constrained_address\)/);
  assert.match(generated.stderr, /next: \/riptide-assess/);
  assert.match(generated.stderr, /report .*setup-gaps\.json/);

  const report = JSON.parse(await readFile(path.join(outDir, "setup-gaps.json"), "utf8")) as {
    schema_version: string;
    genesis: string;
  };
  assert.equal(report.schema_version, "setup-gaps.v1");
  assert.equal(report.genesis, "gaps");
});

test("sim generate CLI states the derived genesis is a baseline, never a safety claim", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-sim-cli-derived-"));
  const adapter = path.resolve(
    process.cwd(),
    "..",
    "fixtures",
    "auto-genesis",
    "derivable",
    "adapter.toml"
  );
  const outDir = path.join(root, ".riptide", "sim");

  const generated = await execFileAsync(
    process.execPath,
    [cliEntrypoint, "sim", "generate", "--adapter", adapter, "--dir", outDir],
    { cwd: root }
  );

  assert.match(generated.stderr, /riptide sim: tick-0 genesis derived from declared adapter facts/);
  assert.match(generated.stderr, /baseline starting state — not a model of/);
  assert.doesNotMatch(generated.stderr, /\baudit\b|\bverified safe\b|\bno vulnerabilities\b|\bsafe\b/i);
});

test("sim lint CLI accepts a valid manifest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-sim-lint-pass-"));
  const simDir = path.join(root, ".riptide", "sim");
  await mkdir(path.join(simDir, "fixtures", "accounts"), { recursive: true });
  await mkdir(path.join(simDir, "target", "deploy"), { recursive: true });
  await writeFile(path.join(simDir, "target", "deploy", "dependency.so"), "fake so", "utf8");
  await writeFile(
    path.join(simDir, "fixtures", "accounts", "dependency-account.json"),
    JSON.stringify({
      pubkey: "11111111111111111111111111111111",
      account: {
        lamports: 42,
        data: ["AQID", "base64"],
        owner: "11111111111111111111111111111111",
        executable: false,
        rentEpoch: 0
      }
    }),
    "utf8"
  );
  await writeFile(
    path.join(simDir, "Riptide.toml"),
    `
[[sim.programs]]
address = "So11111111111111111111111111111111111111112"
program = "target/deploy/dependency.so"
loader = "direct"

[[sim.accounts]]
address = "11111111111111111111111111111111"
filename = "fixtures/accounts/dependency-account.json"

[sim.metrics]
enabled = true
filename = "artifacts/guided-sim-metrics.json"

[sim.regression]
enabled = true
accounts = ["11111111111111111111111111111111"]
state_hashes = ["pool"]

[sim.coverage]
enabled = false
`,
    "utf8"
  );

  const result = await execFileAsync(process.execPath, [cliEntrypoint, "sim", "lint", simDir], {
    cwd: root
  });

  assert.match(result.stdout, /Sim manifest lint - .*Riptide\.toml/);
  assert.match(result.stdout, /PASS \[manifest-schema\] sim/);
  assert.match(result.stdout, /Verdict: PASS \(exit 0\)/);
});

test("sim lint CLI accepts a multi-axis sweep manifest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-sim-lint-multi-axis-"));
  const simDir = path.join(root, ".riptide", "sim");
  await mkdir(simDir, { recursive: true });
  await writeFile(
    path.join(simDir, "Riptide.toml"),
    `
[sim.sweep]
seeds_per_value = 3

[[sim.sweep.axes]]
name = "rate_shock_bps"
values = [0, 100, 300, 500]

[[sim.sweep.axes]]
name = "collateral_ratio"
values = [1.2, 1.5, 2.0]
`,
    "utf8"
  );

  const result = await execFileAsync(process.execPath, [cliEntrypoint, "sim", "lint", simDir], {
    cwd: root
  });

  assert.match(result.stdout, /PASS \[manifest-schema\] sim/);
  assert.match(result.stdout, /Verdict: PASS \(exit 0\)/);
});

test("sim fork CLI reuses an existing cache without network", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-sim-fork-reuse-"));
  const outPath = path.join(root, "fork-cache.json");
  await writeFile(
    outPath,
    JSON.stringify({
      pubkey: "11111111111111111111111111111111",
      account: {
        lamports: 1,
        data: ["", "base64"],
        owner: "11111111111111111111111111111111",
        executable: false,
        rentEpoch: 0
      }
    }),
    "utf8"
  );

  const result = await execFileAsync(
    process.execPath,
    [
      cliEntrypoint,
      "sim",
      "fork",
      "--address",
      "11111111111111111111111111111111",
      "--cluster",
      "http://127.0.0.1:9",
      "--out",
      outPath
    ],
    { cwd: root }
  );

  assert.match(result.stdout, /reused cached snapshot/);
});

test("sim fork CLI rejects a cached snapshot for the wrong address", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-sim-fork-mismatch-"));
  const outPath = path.join(root, "fork-cache.json");
  await writeFile(
    outPath,
    JSON.stringify({
      pubkey: "11111111111111111111111111111111",
      account: {
        lamports: 1,
        data: ["", "base64"],
        owner: "11111111111111111111111111111111",
        executable: false,
        rentEpoch: 0
      }
    }),
    "utf8"
  );

  await assert.rejects(
    () =>
      execFileAsync(
        process.execPath,
        [
          cliEntrypoint,
          "sim",
          "fork",
          "--address",
          "So11111111111111111111111111111111111111112",
          "--cluster",
          "http://127.0.0.1:9",
          "--out",
          outPath
        ],
        { cwd: root }
      ),
    (err: unknown) => {
      const error = err as { code?: number; stderr?: string };
      assert.equal(error.code, 2);
      assert.match(error.stderr ?? "", /does not match requested address/);
      return true;
    }
  );
});

test("sim lint CLI reports fixable manifest diagnostics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-sim-lint-fail-"));
  const simDir = path.join(root, ".riptide", "sim");
  await mkdir(path.join(simDir, "fixtures", "accounts"), { recursive: true });
  await writeFile(
    path.join(simDir, "fixtures", "accounts", "bad-account.json"),
    JSON.stringify({
      pubkey: "So11111111111111111111111111111111111111112",
      account: {
        lamports: 42,
        data: ["@@@", "base64"],
        owner: "11111111111111111111111111111111",
        executable: false,
        rentEpoch: 0
      }
    }),
    "utf8"
  );
  await writeFile(
    path.join(simDir, "fork-cache.json"),
    JSON.stringify({
      pubkey: "So11111111111111111111111111111111111111112",
      account: {
        lamports: 7,
        data: ["AQID", "base64"],
        owner: "11111111111111111111111111111111",
        executable: false,
        rentEpoch: 0
      }
    }),
    "utf8"
  );
  await writeFile(
    path.join(simDir, "Riptide.toml"),
    `
[[sim.programs]]
address = "not-a-pubkey"
program = "missing.so"
loader = "upgradeable"

[[sim.accounts]]
address = "11111111111111111111111111111111"
filename = "fixtures/accounts/bad-account.json"

[[sim.accounts]]
address = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
filename = "fixtures/accounts/missing-account.json"

[[sim.fork]]
address = "11111111111111111111111111111111"
cluster = "mainnet"
filename = "fork-cache.json"
overwrite = false

[sim.coverage]
enabled = true
`,
    "utf8"
  );

  await assert.rejects(
    () =>
      execFileAsync(process.execPath, [cliEntrypoint, "sim", "lint", simDir], {
        cwd: root
      }),
    (err: unknown) => {
      const error = err as { code?: number; stdout?: string; stderr?: string };
      assert.equal(error.code, 2, `stderr:\n${error.stderr ?? ""}\nstdout:\n${error.stdout ?? ""}`);
      const stdout = error.stdout ?? "";
      assert.match(stdout, /FAIL \[invalid-pubkey\] sim\.programs\[0\]\.address/);
      assert.match(stdout, /FAIL \[program-file-missing\] sim\.programs\[0\]\.program/);
      assert.match(stdout, /FAIL \[unsupported-loader\] sim\.programs\[0\]\.loader/);
      assert.match(stdout, /FAIL \[account-data-base64\] sim\.accounts\[0\]\.filename\.data/);
      assert.match(stdout, /FAIL \[account-file-missing\] sim\.accounts\[1\]\.filename/);
      assert.match(stdout, /FAIL \[duplicate-address\] sim\.fork\[0\]\.address/);
      assert.match(stdout, /FAIL \[cache-pubkey-mismatch\] sim\.fork\[0\]\.filename/);
      assert.match(stdout, /FAIL \[coverage-unavailable\] sim\.coverage\.enabled/);
      assert.match(stdout, /Verdict: FAIL \(exit 2\)/);
      return true;
    }
  );
});
