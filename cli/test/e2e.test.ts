// End-to-end integration test for `riptide simulate` against a live
// solana-test-validator. This is the full-system smoke test that proves
// the CLI -> persona compiler -> engine -> lending program pipeline works.
//
// Gated on RIPTIDE_RUN_E2E=1 so regular `npm test` never touches the
// network or requires a validator to be running. Mirrors the gating
// pattern used by engine/tests/engine_cli_e2e.rs.
//
// Preconditions to run:
//   1. solana-test-validator running on loopback (default 127.0.0.1:8899)
//   2. CLI built:             npm run build            (in cli/)
//   3. Engine built:           cargo build --release -p riptide-engine
//   4. Lending program built:  cargo build-sbf --manifest-path programs/lending_pool/Cargo.toml
//   5. Funded payer keypair:   export RIPTIDE_PAYER=/tmp/riptide-payer.json
//
// Invoke:
//   RIPTIDE_RUN_E2E=1 RIPTIDE_PAYER=/tmp/riptide-payer.json npm test

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SimulationResultSchema, type SimulationResult } from "../src/compiler/schema.js";

const E2E_ENABLED = process.env.RIPTIDE_RUN_E2E === "1";
const E2E_TIMEOUT_MS = 180_000;

const cliEntrypoint = path.resolve(process.cwd(), "dist/src/index.js");

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface RunSimulateOptions {
  outputDir: string;
  personas: string;
  shockDrop?: string;
  extraArgs?: string[];
}

async function runSimulate(opts: RunSimulateOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        cliEntrypoint,
        "simulate",
        "--agents",
        "5",
        "--ticks",
        "10",
        "--seed",
        "42",
        "--scenario",
        "price-shock",
        "--personas",
        opts.personas,
        "--output",
        opts.outputDir,
        ...(opts.extraArgs ?? [])
      ],
      {
        cwd: process.cwd(),
        // Allowlisted env: we are asserting on realized liquidations,
        // so any ambient RIPTIDE_* knob could silently falsify the
        // result. Only pass what the subprocess genuinely needs —
        // PATH/HOME for node + solana RPC resolution, RIPTIDE_PAYER
        // for the funded keypair, and the one shock knob the test
        // owns. Notably, RIPTIDE_ENGINE_BIN is NOT forwarded: this
        // test must exercise the release binary on its canonical
        // path, not an orchestrator-unit-test override.
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          RIPTIDE_PAYER: process.env.RIPTIDE_PAYER ?? "",
          RIPTIDE_PRICE_SHOCK_DROP: opts.shockDrop ?? "0.5"
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      // Mirror engine stderr live so a human watching npm test sees progress.
      process.stderr.write(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

// Fields that are chain-identity or wall-clock dependent and MUST be
// stripped before comparing two runs with the same seed. The simulation
// logic (tick snapshots, events, agent PnL, trigger counts) is expected
// to be byte-identical; chain accounts and RPC-assigned balances are not.
//
// We use field-name matching rather than schema-path matching because the
// set of leaky fields lives across several nested types and a name-based
// sweep is easier to audit.
// Fields to strip before comparing two runs. Keep this list minimal: the
// whole point is to catch real divergences in simulation logic. Today the
// only field that legitimately changes between same-seed runs is
// run_config.output_path, which the CLI forwards as the tmp dir we pass
// in. Chain identity (pubkeys, signatures, program IDs) is *not* in the
// artifact output — the engine intentionally omits them from
// SimulationResult, so we don't need to strip them here.
const EPHEMERAL_KEYS = new Set(["output_path"]);

function stripEphemeral(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripEphemeral);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (EPHEMERAL_KEYS.has(k)) continue;
      out[k] = stripEphemeral(v);
    }
    return out;
  }
  return value;
}

async function loadArtifact(outputDir: string): Promise<SimulationResult> {
  const raw = await readFile(path.join(outputDir, "simulation-result.json"), "utf8");
  return SimulationResultSchema.parse(JSON.parse(raw));
}

test("e2e: risky persona mix produces realized liquidations under shock", { skip: !E2E_ENABLED, timeout: E2E_TIMEOUT_MS }, async () => {
  if (!process.env.RIPTIDE_PAYER) {
    throw new Error("RIPTIDE_PAYER must be set to a funded local validator keypair path");
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), "riptide-e2e-risky-"));
  try {
    const outputDir = path.join(tmp, "run");
    const run = await runSimulate({
      outputDir,
      personas: "panic-whale,degen-borrower,aggressive-arb-bot"
    });

    assert.equal(run.code, 0, `simulate exited non-zero (code=${run.code})\nstderr tail:\n${run.stderr.slice(-2000)}`);
    assert.match(run.stderr, /riptide simulate:/);
    assert.match(run.stdout, /Riptide Simulation Summary/);
    assert.match(run.stdout, /Final TVL:/);

    const parsed = await loadArtifact(outputDir);

    assert.equal(parsed.total_ticks, 10, "total_ticks should match --ticks");
    // 1 initial snapshot at t=0 + one per tick = 11.
    assert.equal(parsed.timeseries.length, 11, "timeseries = 1 initial + one per tick");
    assert.equal(parsed.agents.length, 5, "agent count should match --agents");
    assert.ok(parsed.events.length > 0, "expected some SimEvents to be recorded");

    // The real acceptance criterion: the shock actually liquidates
    // leveraged borrowers. Anything less means we're measuring plumbing,
    // not the behavior the demo is supposed to showcase.
    assert.ok(
      parsed.summary.total_liquidations >= 1,
      `risky mix produced no realized liquidations (summary.total_liquidations=${parsed.summary.total_liquidations})`
    );
    assert.ok(
      parsed.summary.agents_liquidated >= 1,
      `risky mix did not mark any agents as liquidated (agents_liquidated=${parsed.summary.agents_liquidated})`
    );

    // Risky personas must actually open borrows — otherwise there's
    // nothing for the shock to land on.
    const borrowSuccesses = parsed.events.filter(
      (e) => e.action === "borrow" && e.outcome === "success"
    );
    assert.ok(
      borrowSuccesses.length > 0,
      `risky mix never successfully borrowed, so the test is measuring nothing`
    );

    assert.ok(parsed.simulation_boundaries.length > 0, "simulation_boundaries should be non-empty");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("e2e: cautious persona mix survives the same shock without liquidations", { skip: !E2E_ENABLED, timeout: E2E_TIMEOUT_MS }, async () => {
  // The second half of the "different personas behave differently" claim.
  // Same shock, same seed, same protocol — but with cautious-yield-farmer +
  // steady-lp the pool should have zero borrows, zero liquidation attempts,
  // and every agent still active. A regression where all personas converge
  // to similar behavior will fail this test.
  if (!process.env.RIPTIDE_PAYER) {
    throw new Error("RIPTIDE_PAYER must be set");
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), "riptide-e2e-safe-"));
  try {
    const outputDir = path.join(tmp, "run");
    const run = await runSimulate({
      outputDir,
      personas: "cautious-yield-farmer,steady-lp"
    });

    assert.equal(run.code, 0, `safe simulate exited non-zero: ${run.stderr.slice(-1000)}`);
    const parsed = await loadArtifact(outputDir);

    assert.equal(parsed.summary.total_liquidations, 0, "safe mix should not liquidate anyone");
    assert.equal(parsed.summary.agents_liquidated, 0, "safe mix should have zero liquidated agents");
    assert.equal(parsed.summary.agents_active, 5, "all safe agents should still be active");

    const borrowAttempts = parsed.events.filter((e) => e.action === "borrow");
    const liquidateAttempts = parsed.events.filter((e) => e.action === "liquidate");
    assert.equal(
      borrowAttempts.length,
      0,
      `cautious personas should not open borrows (saw ${borrowAttempts.length})`
    );
    assert.equal(
      liquidateAttempts.length,
      0,
      `cautious personas should not attempt liquidations (saw ${liquidateAttempts.length})`
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("e2e: determinism — two runs with same seed produce byte-identical simulation logic", { skip: !E2E_ENABLED, timeout: E2E_TIMEOUT_MS * 2 }, async () => {
  if (!process.env.RIPTIDE_PAYER) {
    throw new Error("RIPTIDE_PAYER must be set");
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), "riptide-e2e-det-"));
  try {
    const outA = path.join(tmp, "runA");
    const outB = path.join(tmp, "runB");

    const runOpts = { personas: "panic-whale,degen-borrower,aggressive-arb-bot" };
    const runA = await runSimulate({ ...runOpts, outputDir: outA });
    assert.equal(runA.code, 0, `first run exited non-zero: ${runA.stderr.slice(-1000)}`);

    const runB = await runSimulate({ ...runOpts, outputDir: outB });
    assert.equal(runB.code, 0, `second run exited non-zero: ${runB.stderr.slice(-1000)}`);

    const rawA = await readFile(path.join(outA, "simulation-result.json"), "utf8");
    const rawB = await readFile(path.join(outB, "simulation-result.json"), "utf8");
    const a = JSON.parse(rawA);
    const b = JSON.parse(rawB);

    const stripA = stripEphemeral(a);
    const stripB = stripEphemeral(b);

    // Serialize with sorted keys so object key ordering can't flake the diff.
    const canonA = JSON.stringify(stripA, Object.keys(stripA as object).sort());
    const canonB = JSON.stringify(stripB, Object.keys(stripB as object).sort());
    assert.deepStrictEqual(
      stripA,
      stripB,
      `deterministic runs diverged after stripping ephemeral fields.\n` +
        `canonA length=${canonA.length} canonB length=${canonB.length}`
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
