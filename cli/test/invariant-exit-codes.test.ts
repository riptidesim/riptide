// engine invariant CI exit codes.
//
// Verifies the three-way exit code contract wired in
// `engine/src/main.rs`:
// - Exit 0: all declared invariants held through the run.
// - Exit 1: ≥1 invariant fired during the run.
// - Exit 2: setup error (adapter references unknown field, parse
// error, missing program.so, etc.).
//
// Also verifies `--allow-invariant-violations` restores exit 0 on an
// otherwise-firing run.
//
// Hard-gated in the default `cd cli && npm test` path — no env var
// dance required. The test auto-builds the engine binary on first
// run if it's missing (pure Rust, always buildable) and fails with
// a clear diagnostic if the lending_pool `.so` hasn't been produced
// (that requires `cargo build-sbf` which not every CI can run from
// scratch). Matches the Round 3 Pyth-helper hard-gate pattern.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const T03_TIMEOUT_MS = 180_000;

const REPO_ROOT = path.resolve(process.cwd(), "..");
const ENGINE_MANIFEST = path.resolve(REPO_ROOT, "engine/Cargo.toml");
const ENGINE_PATH = path.resolve(REPO_ROOT, "target/release/riptide-engine");
const LENDING_SO = path.resolve(
  REPO_ROOT,
  "programs/lending_pool/target/deploy/lending_pool.so"
);

/**
 * Enforced gate — build the engine binary in-process if absent, fail
 * loudly if the lending_pool SBF artifact can't be found. Lazy-runs
 * once per `npm test` invocation; subsequent calls reuse the cached
 * binary. Matches the Round 3 pyth helper pattern (auto-build +
 * fail-hard, no soft skip).
 */
let gateChecked = false;
function ensureEngineAndProgramReady(): void {
  if (gateChecked) return;
  gateChecked = true;

  if (!existsSync(ENGINE_PATH)) {
    process.stderr.write(
      `gate: riptide-engine binary missing, building (cargo build --release -p riptide-engine)...\n`
    );
    const result = spawnSync(
      "cargo",
      ["build", "--release", "--manifest-path", ENGINE_MANIFEST],
      { stdio: ["ignore", "inherit", "inherit"] }
    );
    if (result.status !== 0) {
      throw new Error(
        `gate: engine build FAILED (cargo exit ${result.status}). Fix the build before ` +
          `continuing:\n  cargo build --release -p riptide-engine`
      );
    }
    if (!existsSync(ENGINE_PATH)) {
      throw new Error(
        `gate: cargo build succeeded but no binary at ${ENGINE_PATH}`
      );
    }
  }

  if (!existsSync(LENDING_SO)) {
    throw new Error(
      `gate: lending_pool.so missing at ${LENDING_SO}.\n` +
        `  This is a Solana SBF artifact — not auto-buildable without the cargo-build-sbf ` +
        `toolchain. Build once with:\n  ` +
        `cargo build-sbf --manifest-path programs/lending_pool/Cargo.toml\n` +
        `  The same artifact is required by litesvm_parity and e2e_determinism, so it ` +
        `should exist in any dev environment that can build the engine's release tests.`
    );
  }
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function runEngine(args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(ENGINE_PATH, args, {
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? ""
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

async function writeFixtures(
  workDir: string,
  opts: {
    adapterTOML: string;
    invariantClause?: string;
    runConfig?: Record<string, unknown>;
  }
): Promise<{
  configPath: string;
  policiesPath: string;
  outputPath: string;
  adapterPath: string;
}> {
  const adapterPath = path.join(workDir, "adapter.toml");
  const configPath = path.join(workDir, "run-config.json");
  const policiesPath = path.join(workDir, "policies.json");
  const outputPath = path.join(workDir, "simulation-result.json");

  await writeFile(adapterPath, opts.adapterTOML + (opts.invariantClause ?? ""));
  const runConfig = opts.runConfig ?? {
    agents: 2,
    ticks: 3,
    scenario: "baseline",
    seed: 7,
    personas: ["cautious-yield-farmer"],
    validator_url: "unused",
    output_path: "out"
  };
  await writeFile(configPath, JSON.stringify(runConfig, null, 2) + "\n");
  // Use shipped policy fixture so the lending path has a real policy.
  // Copying via module path keeps this hermetic.
  const policy = {
    persona_id: "cautious-yield-farmer",
    persona_label: "cautious-yield-farmer",
    action_rate_multiplier: 1.0,
    risk_tolerance: 0.3,
    action_weights: {
      deposit: 0.9,
      borrow: 0.1,
      withdraw: 0.0,
      repay: 0.0,
      liquidate: 0.0
    },
    triggers: [],
    position_sizing: { strategy: "fixed", params: { amount: 100.0 } },
    max_exposure: 0.5
  };
  await writeFile(policiesPath, JSON.stringify([policy], null, 2) + "\n");

  return { adapterPath, configPath, policiesPath, outputPath };
}

/**
 * Minimal lending adapter that round-trips — same shape as the shipped
 * lending.toml but inline so we can parametrize the [[invariants]]
 * block per test case.
 */
const CLEAN_ADAPTER = `protocol = "lending"

[instructions]
deposit   = { action = "deposit",   amount = "amount" }
borrow    = { action = "borrow",    amount = "amount" }
repay     = { action = "repay",     amount = "amount" }
withdraw  = { action = "withdraw",  amount = "amount" }
liquidate = { action = "liquidate", amount = "repay_amount" }

[state_mapping]
"pool.total_deposits" = "tvl"
"pool.total_borrows"  = "debt"
"pool.bad_debt"       = "bad_debt"
"position.collateral" = "collateral"
"position.debt"       = "debt"
"position.liquidated" = "liquidated"

[actions]
[observations]
[personas]
`;

const BASE_ENGINE_ARGS = (fix: {
  configPath: string;
  policiesPath: string;
  outputPath: string;
  adapterPath: string;
}) => [
  "--config",
  fix.configPath,
  "--policies",
  fix.policiesPath,
  "--output",
  fix.outputPath,
  "--program-so",
  LENDING_SO,
  "--adapter",
  fix.adapterPath
];

test(
  "clean run (no invariants declared) exits 0",
  { timeout: T03_TIMEOUT_MS },
  async () => {
    ensureEngineAndProgramReady();
    const workDir = await mkdtemp(path.join(os.tmpdir(), "t03-clean-"));
    try {
      const fix = await writeFixtures(workDir, { adapterTOML: CLEAN_ADAPTER });
      const result = await runEngine(BASE_ENGINE_ARGS(fix));
      assert.equal(
        result.code,
        0,
        `expected exit 0, got ${result.code}; stderr: ${result.stderr.slice(-500)}`
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
);

test(
  "clean run with always-true invariant exits 0",
  { timeout: T03_TIMEOUT_MS },
  async () => {
    ensureEngineAndProgramReady();
    const workDir = await mkdtemp(path.join(os.tmpdir(), "t03-holds-"));
    try {
      const invariant = `
[[invariants]]
name = "tvl_never_negative"
field = "tvl"
op = ">="
value = 0
`;
      const fix = await writeFixtures(workDir, {
        adapterTOML: CLEAN_ADAPTER,
        invariantClause: invariant
      });
      const result = await runEngine(BASE_ENGINE_ARGS(fix));
      assert.equal(
        result.code,
        0,
        `expected exit 0, got ${result.code}; stderr: ${result.stderr.slice(-500)}`
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
);

test(
  "firing invariant exits 1",
  { timeout: T03_TIMEOUT_MS },
  async () => {
    ensureEngineAndProgramReady();
    const workDir = await mkdtemp(path.join(os.tmpdir(), "t03-fires-"));
    try {
      // tvl starts >= 0; assert tvl < 0 so it fires every tick.
      const invariant = `
[[invariants]]
name = "impossible_tvl"
field = "tvl"
op = "<"
value = 0
`;
      const fix = await writeFixtures(workDir, {
        adapterTOML: CLEAN_ADAPTER,
        invariantClause: invariant
      });
      const result = await runEngine(BASE_ENGINE_ARGS(fix));
      assert.equal(
        result.code,
        1,
        `expected exit 1, got ${result.code}; stderr: ${result.stderr.slice(-500)}`
      );
      assert.ok(
        result.stderr.includes("invariant violation"),
        `stderr should mention invariant violations: ${result.stderr.slice(-500)}`
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
);

test(
  "--allow-invariant-violations restores exit 0",
  { timeout: T03_TIMEOUT_MS },
  async () => {
    ensureEngineAndProgramReady();
    const workDir = await mkdtemp(path.join(os.tmpdir(), "t03-allow-"));
    try {
      const invariant = `
[[invariants]]
name = "impossible_tvl"
field = "tvl"
op = "<"
value = 0
`;
      const fix = await writeFixtures(workDir, {
        adapterTOML: CLEAN_ADAPTER,
        invariantClause: invariant
      });
      const result = await runEngine([
        ...BASE_ENGINE_ARGS(fix),
        "--allow-invariant-violations"
      ]);
      assert.equal(
        result.code,
        0,
        `expected exit 0 with --allow-invariant-violations, got ${result.code}; stderr: ${result.stderr.slice(-500)}`
      );
      assert.ok(
        result.stderr.includes("invariant violation"),
        `stderr should still mention violations even with allow flag: ${result.stderr.slice(-500)}`
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
);

test(
  "broken adapter (unknown invariant field) exits 2",
  { timeout: T03_TIMEOUT_MS },
  async () => {
    ensureEngineAndProgramReady();
    const workDir = await mkdtemp(path.join(os.tmpdir(), "t03-broken-"));
    try {
      // Reference a field that's not declared as a lending snapshot
      // metric or observation — loader rejects at parse time.
      const invariant = `
[[invariants]]
name = "dangling"
field = "nonexistent_field_xyz"
op = "=="
value = 0
`;
      const fix = await writeFixtures(workDir, {
        adapterTOML: CLEAN_ADAPTER,
        invariantClause: invariant
      });
      const result = await runEngine(BASE_ENGINE_ARGS(fix));
      assert.equal(
        result.code,
        2,
        `expected exit 2 (setup error), got ${result.code}; stderr: ${result.stderr.slice(-500)}`
      );
      assert.ok(
        result.stderr.includes("nonexistent_field_xyz") ||
          result.stderr.includes("unknown invariant field"),
        `stderr should name the offending field: ${result.stderr.slice(-500)}`
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
);

test(
  "malformed adapter (bad TOML) exits 2",
  { timeout: T03_TIMEOUT_MS },
  async () => {
    ensureEngineAndProgramReady();
    const workDir = await mkdtemp(path.join(os.tmpdir(), "t03-malformed-"));
    try {
      // Stray unclosed bracket — TOML parse fails.
      const fix = await writeFixtures(workDir, {
        adapterTOML: 'protocol = "lending"\n[instructions\n'
      });
      const result = await runEngine(BASE_ENGINE_ARGS(fix));
      assert.equal(
        result.code,
        2,
        `expected exit 2 (parse error), got ${result.code}; stderr: ${result.stderr.slice(-500)}`
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
);
