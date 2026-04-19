import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SimulationResultSchema } from "../src/compiler/schema.js";

const T04_TIMEOUT_MS = 180_000;

const CLI_ROOT = process.cwd();
const REPO_ROOT = path.resolve(CLI_ROOT, "..");
const CLI_ENTRY = path.resolve(CLI_ROOT, "dist/src/index.js");
const ENGINE_MANIFEST = path.resolve(REPO_ROOT, "engine/Cargo.toml");
const ENGINE_PATH = path.resolve(REPO_ROOT, "target/release/riptide-engine");
const RESOURCE_GRINDER_SO = path.resolve(
  REPO_ROOT,
  "programs/resource_grinder/target/deploy/resource_grinder.so"
);
const RESOURCE_GRINDER_ADAPTER = path.resolve(
  REPO_ROOT,
  "fixtures/adapters/resource-grinder.toml"
);

let gateChecked = false;
function ensureEngineAndProgramReady(): void {
  if (gateChecked) return;
  gateChecked = true;

  process.stderr.write(
    "gate: building release riptide-engine (cargo build --release -p riptide-engine)...\n"
  );
  const result = spawnSync(
    "cargo",
    ["build", "--release", "--manifest-path", ENGINE_MANIFEST],
    { stdio: ["ignore", "inherit", "inherit"] }
  );
  if (result.status !== 0) {
    throw new Error(
      "gate: engine build failed.\n  cargo build --release -p riptide-engine"
    );
  }

  if (!existsSync(RESOURCE_GRINDER_SO)) {
    throw new Error(
      `gate: resource_grinder.so missing at ${RESOURCE_GRINDER_SO}.\n` +
        "Build once with:\n" +
        "  cargo build-sbf --manifest-path programs/resource_grinder/Cargo.toml"
    );
  }
}

interface CliRunResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function runReplayCommand(args: string[]): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [CLI_ENTRY, ...args], {
      cwd: CLI_ROOT,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        RIPTIDE_ENGINE_BIN: ENGINE_PATH
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

test(
  "`riptide replay` runs end-to-end and emits schema-compatible JSON",
  { timeout: T04_TIMEOUT_MS },
  async () => {
    ensureEngineAndProgramReady();
    const workDir = await mkdtemp(path.join(os.tmpdir(), "t04-replay-cli-"));
    const replayDir = path.join(workDir, "resource-grinder-replay");
    const replayConfigPath = path.join(workDir, "replay-config.json");
    const outputPath = path.join(workDir, "artifacts");

    try {
      await mkdir(replayDir, { recursive: true });
      await writeFile(
        path.join(replayDir, "initial-state.json"),
        JSON.stringify(
          {
            instructions: [{ name: "mine", agent: "alice", args: { amount: 2 } }]
          },
          null,
          2
        ) + "\n"
      );
      await writeFile(
        path.join(replayDir, "trajectory.json"),
        JSON.stringify(
          {
            metadata: {
              name: "resource-grinder-cli",
              description: "CLI replay smoke test",
              source: "cli/test/replay-command.test.ts"
            },
            ticks: [
              {
                tick: 0,
                instructions: [{ name: "craft", agent: "alice", args: { amount: 1 } }]
              },
              {
                tick: 1,
                instructions: [{ name: "mine", agent: "alice", args: { amount: 3 } }]
              },
              {
                tick: 2,
                instructions: [
                  { name: "list_for_sale", agent: "alice", args: { amount: 2 } }
                ]
              }
            ]
          },
          null,
          2
        ) + "\n"
      );
      await writeFile(
        path.join(replayDir, "oracle-trajectory.json"),
        JSON.stringify({ ticks: [{ tick: 0, price: 100.0 }] }, null, 2) + "\n"
      );
      await writeFile(
        replayConfigPath,
        JSON.stringify(
          {
            adapter: RESOURCE_GRINDER_ADAPTER,
            trajectory_dir: replayDir,
            output_path: outputPath
          },
          null,
          2
        ) + "\n"
      );

      const result = await runReplayCommand(["replay", replayConfigPath, "--format", "json"]);
      assert.equal(
        result.code,
        0,
        `expected exit 0, got ${result.code}; stderr: ${result.stderr.slice(-500)}`
      );

      const parsed = SimulationResultSchema.parse(JSON.parse(result.stdout));
      assert.equal(parsed.run_config.scenario, "replay:resource-grinder-cli");
      assert.equal(parsed.total_ticks, 2);
      assert.equal(parsed.events.length, 3);
      assert.equal(parsed.events[0]?.tick, 0);
      assert.equal(parsed.events[0]?.action, "craft");
      assert.equal(parsed.run_config.output_path, outputPath);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
);

test(
  "invariant firing on replay still surfaces the full SimulationResult (exit 1)",
  { timeout: T04_TIMEOUT_MS },
  async () => {
    // re-review #1: previously the CLI's catch block threw
    // away the orchestrator-parsed SimulationResult on exit 1 and
    // printed `{"error":...}`, which broke the user-facing replay
    // contract on the canonical invariant-firing path. This test
    // locks the fix: exit 1 still, but stdout carries the full
    // SimulationResult JSON with `invariants_fired[].firings > 0`.
    ensureEngineAndProgramReady();
    const workDir = await mkdtemp(path.join(os.tmpdir(), "t05-cli-inv-"));
    const replayDir = path.join(workDir, "resource-grinder-replay");
    const adapterPath = path.join(workDir, "adapter-with-invariant.toml");
    const replayConfigPath = path.join(workDir, "replay-config.json");
    const outputPath = path.join(workDir, "artifacts");

    try {
      await mkdir(replayDir, { recursive: true });
      // Trajectory: bootstrap mines 2, tick 1 mines 8 so player.gold
      // climbs to ~10. The invariant `player.gold <= 5` stays green
      // at tick 0 (gold=2) and violates at tick 1 (gold=10) — a clean
      // "passes then fires" shape without needing a new.so.
      await writeFile(
        path.join(replayDir, "initial-state.json"),
        JSON.stringify(
          {
            instructions: [{ name: "mine", agent: "alice", args: { amount: 2 } }]
          },
          null,
          2
        ) + "\n"
      );
      await writeFile(
        path.join(replayDir, "trajectory.json"),
        JSON.stringify(
          {
            metadata: {
              name: "resource-grinder-invariant-cli",
              description: "CLI invariant-firing replay test",
              source: "cli/test/replay-command.test.ts"
            },
            ticks: [
              {
                tick: 0,
                instructions: [{ name: "mine", agent: "alice", args: { amount: 0 } }]
              },
              {
                tick: 1,
                instructions: [{ name: "mine", agent: "alice", args: { amount: 8 } }]
              }
            ]
          },
          null,
          2
        ) + "\n"
      );
      // Adapter variant that adds a single invariant on top of the
      // shipped resource-grinder shape. Absolute paths so the test's
      // tmpdir-hosted TOML can resolve the shipped.so + IDL.
      await writeFile(
        adapterPath,
        [
          `protocol = "generic"`,
          `program_so = "${RESOURCE_GRINDER_SO}"`,
          `idl_path = "${path.resolve(REPO_ROOT, "fixtures/idls/resource-grinder.json")}"`,
          ``,
          `[accounts.player]`,
          `kind = "agent"`,
          `space = 48`,
          ``,
          `[accounts.marketplace]`,
          `kind = "shared"`,
          `space = 512`,
          ``,
          `[instructions]`,
          `mine = { action = "mine", amount = "amount" }`,
          `craft = { action = "craft", amount = "amount" }`,
          `list_for_sale = { action = "list_for_sale", amount = "amount" }`,
          ``,
          `[state_mapping]`,
          `"player.gold" = "player.gold"`,
          `"player.wood" = "player.wood"`,
          `"marketplace.listings" = "marketplace.listings"`,
          ``,
          `[actions.mine]`,
          `takes = ["amount"]`,
          `[actions.craft]`,
          `takes = ["amount"]`,
          `[actions.list_for_sale]`,
          `takes = ["amount"]`,
          ``,
          `[observations]`,
          `"player.gold" = "uint"`,
          `"player.wood" = "uint"`,
          `"marketplace.listings" = "map"`,
          ``,
          `[personas.replay]`,
          `action_rate_multiplier = 0.0`,
          `action_weights = { mine = 0.0, craft = 0.0, list_for_sale = 0.0 }`,
          `triggers = []`,
          ``,
          `[[invariants]]`,
          `name = "wood_below_cap"`,
          `field = "player.wood"`,
          `op = "<="`,
          `value = 5`,
          ``
        ].join("\n")
      );
      await writeFile(
        replayConfigPath,
        JSON.stringify(
          {
            adapter: adapterPath,
            trajectory_dir: replayDir,
            output_path: outputPath
          },
          null,
          2
        ) + "\n"
      );

      // Default path: exit 1, but stdout must carry a full parseable
      // SimulationResult with invariants_fired[0].firings > 0.
      const defaultRun = await runReplayCommand([
        "replay",
        replayConfigPath,
        "--format",
        "json"
      ]);
      assert.equal(
        defaultRun.code,
        1,
        `expected exit 1 on invariant firing, got ${defaultRun.code}; stderr: ${defaultRun.stderr.slice(-500)}`
      );
      const defaultParsed = SimulationResultSchema.parse(
        JSON.parse(defaultRun.stdout)
      );
      const invariants = defaultParsed.summary.invariants_fired;
      assert.ok(
        Array.isArray(invariants),
        "summary.invariants_fired should be an array on invariant-firing replay"
      );
      const firstRow = invariants[0];
      assert.ok(firstRow, "at least one invariant row expected");
      assert.equal(firstRow.name, "wood_below_cap");
      assert.ok(
        typeof firstRow.firings === "number" && firstRow.firings > 0,
        `expected >0 firings, got ${firstRow.firings}`
      );

      // --allow-invariant-violations path: same shape, exit 0.
      const allowRun = await runReplayCommand([
        "replay",
        replayConfigPath,
        "--format",
        "json",
        "--allow-invariant-violations"
      ]);
      assert.equal(
        allowRun.code,
        0,
        `--allow-invariant-violations should exit 0, got ${allowRun.code}; stderr: ${allowRun.stderr.slice(-500)}`
      );
      const allowParsed = SimulationResultSchema.parse(JSON.parse(allowRun.stdout));
      const allowInv = allowParsed.summary.invariants_fired;
      assert.ok(Array.isArray(allowInv));
      assert.equal(allowInv[0]?.name, "wood_below_cap");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
);
