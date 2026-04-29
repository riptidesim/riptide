// Adapter smoke runner.
//
// Contract: take a (validated) adapter TOML, invoke the engine binary
// with the canonical `--config / --policies / --output / --adapter`
// shape, then assert that at least one observation in the output delta
// changed from the initial state. Used by `riptide adapt` as its only
// job: verify an adapter that the Claude Code skill's in-session agent
// just generated round-trips cleanly against the local engine.
//
// We pick the matching sample run-config for the inferred runtime
// (lending vs generic), shrink it to a tiny run (5 agents · 2 ticks ·
// baseline), and run the engine. If the engine exits 0 and the output
// JSON contains at least one observation value that differs from an
// initial baseline, the smoke test passes. Anything else is a fail.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { resolveAdapterRuntime, type Adapter } from "../schemas/adapter.js";

export interface SmokeTestOptions {
  adapterPath: string;
  adapter: Adapter;
  engineBinary: string;
  fixturesRoot: string;
}

export interface SmokeTestResult {
  passed: boolean;
  engineExitCode: number | null;
  engineStderr: string;
  reason: string;
  outputPath: string;
}

export async function runSmokeTest(options: SmokeTestOptions): Promise<SmokeTestResult> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "riptide-adapt-"));
  const outputPath = path.join(tempDir, "smoke-output.json");
  const configPath = path.join(tempDir, "run.json");
  const policiesPath = path.join(tempDir, "policies.json");

  const { runConfig, policies } = pickFixtures(options);
  await writeFile(configPath, JSON.stringify(runConfig, null, 2), "utf8");
  await writeFile(policiesPath, JSON.stringify(policies, null, 2), "utf8");

  if (!existsSync(options.engineBinary)) {
    return {
      passed: false,
      engineExitCode: null,
      engineStderr: "",
      reason: `engine binary not found at ${options.engineBinary} — build it with \`cargo build --release -p riptide-engine\``,
      outputPath
    };
  }

  const child = spawn(
    options.engineBinary,
    [
      "--config",
      configPath,
      "--policies",
      policiesPath,
      "--output",
      outputPath,
      "--adapter",
      options.adapterPath
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  // Drain stdout so the child never blocks on a full pipe.
  child.stdout.on("data", () => {});

  const exitCode: number | null = await new Promise((resolve) => {
    child.on("exit", (code) => resolve(code));
  });

  if (exitCode !== 0) {
    return {
      passed: false,
      engineExitCode: exitCode,
      engineStderr: stderr,
      reason: `engine exited with code ${exitCode}`,
      outputPath
    };
  }

  let parsed: unknown;
  try {
    const raw = await readFile(outputPath, "utf8");
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      passed: false,
      engineExitCode: exitCode,
      engineStderr: stderr,
      reason: `could not read or parse engine output at ${outputPath}: ${err instanceof Error ? err.message : String(err)}`,
      outputPath
    };
  }

  const delta = findObservationDelta(parsed);
  if (!delta) {
    return {
      passed: false,
      engineExitCode: exitCode,
      engineStderr: stderr,
      reason: "engine output contains no observation delta from the initial state (no action mutated observable state)",
      outputPath
    };
  }

  return {
    passed: true,
    engineExitCode: exitCode,
    engineStderr: stderr,
    reason: `observed state delta: ${delta}`,
    outputPath
  };
}

function pickFixtures(options: SmokeTestOptions): {
  runConfig: Record<string, unknown>;
  policies: unknown;
} {
  const protocol = resolveAdapterRuntime(options.adapter);

  if (protocol === "lending") {
    return {
      runConfig: {
        agents: 5,
        ticks: 2,
        scenario: "baseline",
        seed: 1337,
        personas: ["cautious-yield-farmer", "panic-whale"],
        validator_url: "http://localhost:8899",
        output_path: "riptide-adapt-smoke"
      },
      policies: loadSampleLendingPolicies(options.fixturesRoot)
    };
  }

  // generic — reuse the shipped generic-demo run + empty policies.
  const genericRun = JSON.parse(
    readFileSync(path.join(options.fixturesRoot, "generic-demo.run.json"), "utf8")
  ) as Record<string, unknown>;
  // Shrink for smoke-speed.
  genericRun.agents = 3;
  genericRun.ticks = 2;
  // Generic adapters declare their own persona roster inline. Leave
  // the run-config persona list empty so the engine round-robins those
  // adapter personas instead of forcing the bundled generic-demo ids.
  genericRun.personas = [];

  return {
    runConfig: genericRun,
    policies: []
  };
}

function loadSampleLendingPolicies(fixturesRoot: string): unknown {
  const raw = readFileSync(path.join(fixturesRoot, "policies.sample.json"), "utf8");
  return JSON.parse(raw);
}

// Walk the engine output JSON and prove that at least one observation
// actually changed because of a successful write-action.
//
// Contract: "locate an appropriate write-action, invoke the engine,
// assert at least one observation in the output delta changed from the
// initial state". Two real signals satisfy that:
//
// A. The engine's events array contains at least one entry with
// `outcome == "success"` that is NOT a passive signal (trigger
// activation, noop, skipped). A successful deposit/borrow/repay/
// withdraw/liquidate/mine/swap/etc. is direct evidence a write
// action mutated observable state.
//
// B. The timeseries has >= 2 entries AND at least one numeric
// observation field differs between the first and last entry.
// This catches cases where the engine aggregates per-tick state
// without individually logging each successful event.
//
// Either signal on its own is sufficient. A populated `summary` or
// `metrics` object by itself is NOT — a static baseline also has a
// populated summary, and accepting that as proof of a delta is a bug
// that review caught before this shipped.
export function findObservationDelta(output: unknown): string | null {
  if (!output || typeof output !== "object") {
    return null;
  }
  const root = output as Record<string, unknown>;

  const events = root["events"];
  if (Array.isArray(events)) {
    for (const entry of events) {
      if (entry && typeof entry === "object") {
        const e = entry as Record<string, unknown>;
        const outcome = e["outcome"];
        const action = e["action"];
        if (
          outcome === "success" &&
          typeof action === "string" &&
          isWriteAction(action)
        ) {
          return `successful write-action event: ${action}`;
        }
      }
    }
  }

  const ts = root["timeseries"];
  if (Array.isArray(ts) && ts.length >= 2) {
    const first = ts[0];
    const last = ts[ts.length - 1];
    if (
      first &&
      last &&
      typeof first === "object" &&
      typeof last === "object"
    ) {
      const firstObj = first as Record<string, unknown>;
      const lastObj = last as Record<string, unknown>;
      const delta = findNumericDelta(firstObj, lastObj);
      if (delta !== null) {
        return delta;
      }
    }
  }

  return null;
}

// Write-action labels the smoke test accepts as proof of a state
// mutation. Purely additive: anything outside this list is treated as
// a passive signal (trigger fired, tick noop, persona reaction, etc.)
// and does NOT satisfy the delta contract.
const WRITE_ACTIONS = new Set<string>([
  // lending primitive
  "deposit",
  "borrow",
  "repay",
  "withdraw",
  "liquidate",
  // generic primitive — resource grinder + common generic verbs
  "mine",
  "craft",
  "list_for_sale",
  // AMM (for future-proofing AMM wiring)
  "swap",
  "add_liquidity",
  "remove_liquidity"
]);

function isWriteAction(action: string): boolean {
  if (WRITE_ACTIONS.has(action)) {
    return true;
  }
  // Passive signals the engine emits alongside real actions — explicit
  // blocklist so adapter-defined custom action names (generic
  // primitive) still qualify as write actions by default.
  if (
    action === "trigger_activated" ||
    action === "noop" ||
    action === "no_op" ||
    action === "skipped" ||
    action === "tick" ||
    action.startsWith("expression_invariant_fire:") ||
    action.startsWith("invariant_violation:")
  ) {
    return false;
  }
  return true;
}

function findNumericDelta(
  first: Record<string, unknown>,
  last: Record<string, unknown>,
  prefix = ""
): string | null {
  for (const key of Object.keys(first)) {
    if (key === "tick") {
      continue;
    }
    const pathKey = prefix.length > 0 ? `${prefix}.${key}` : key;
    const a = first[key];
    const b = last[key];
    if (isNumericLike(a) && isNumericLike(b) && a !== b) {
      return `timeseries field \`${pathKey}\` changed: ${a} → ${b}`;
    }
    if (isPlainObject(a) && isPlainObject(b)) {
      const nested = findNumericDelta(a, b, pathKey);
      if (nested !== null) {
        return nested;
      }
    }
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNumericLike(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
