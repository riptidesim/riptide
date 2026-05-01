import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runSweep } from "../src/run/sweep.js";
import type { RunOneContext, RunOneResult } from "../src/run/loop.js";
import type { SimulationResult } from "../src/compiler/schema.js";

async function tmpRoot(label: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `riptide-sweep-${label}-`));
}

async function writeSeedlessConfig(root: string): Promise<string> {
  const dir = path.join(root, ".riptide", "scenarios", "baseline");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "run-config.json");
  await writeFile(
    file,
    JSON.stringify({ agents: 1, ticks: 1, scenario: "baseline", personas: [] }),
    "utf8"
  );
  return file;
}

async function seedFor(ctx: RunOneContext): Promise<number> {
  const parsed = JSON.parse(await readFile(ctx.scenario.runConfigPath, "utf8")) as {
    seed: number;
  };
  return parsed.seed;
}

function resultForSeed(seed: number): SimulationResult {
  return {
    run_config: {
      agents: 1,
      ticks: 1,
      scenario: "baseline",
      seed,
      personas: [],
      validator_url: "http://127.0.0.1:8899",
      output_path: `.riptide/runs/baseline/runs/${seed}`
    },
    seed,
    total_ticks: 1,
    timeseries: [{ tick: 0, active_agents: 1 }],
    events: [
      {
        tick: 0,
        agent_id: "agent-001",
        persona_id: "baseline",
        persona_label: "Baseline",
        action: "noop",
        params: {},
        outcome: "success"
      }
    ],
    agents: [
      {
        agent_id: "agent-001",
        persona_id: "baseline",
        persona_label: "Baseline",
        status: "active",
        final_balance: 1,
        pnl: 0,
        total_actions: 1,
        triggers_activated: 0
      }
    ],
    summary: {
      agents_active: 1,
      agents_liquidated: 0,
      agents_depleted: 0
    },
    simulation_boundaries: []
  };
}

function pass(seed: number, ctx: RunOneContext): RunOneResult {
  return {
    kind: "pass",
    wallClockS: 0.01,
    artifactsDir: ctx.artifactDirOverride!,
    result: resultForSeed(seed)
  };
}

function fired(seed: number, ctx: RunOneContext): RunOneResult {
  return {
    kind: "fail",
    wallClockS: 0.01,
    artifactsDir: ctx.artifactDirOverride!,
    result: resultForSeed(seed),
    fires: [{ name: "bad_debt_emerged", tick: 1 }]
  };
}

test("runSweep derives deterministic seeds and respects the parallelism cap", async () => {
  const root = await tmpRoot("parallel");
  const runConfigPath = await writeSeedlessConfig(root);
  const active = { now: 0, max: 0 };
  const seeds: number[] = [];

  const summary = await runSweep({
    scenario: { name: "baseline", runConfigPath },
    cwd: root,
    scenarioOutputDir: path.join(root, ".riptide", "runs", "baseline"),
    sweepSize: 5,
    seedRoot: 10,
    full: false,
    parallelism: 2,
    runOne: async (ctx) => {
      const seed = await seedFor(ctx);
      seeds.push(seed);
      active.now += 1;
      active.max = Math.max(active.max, active.now);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active.now -= 1;
      return pass(seed, ctx);
    }
  });

  assert.equal(summary.kind, "pass");
  assert.equal(active.max, 2);
  assert.deepEqual(
    seeds.sort((a, b) => a - b),
    [10, 11, 12, 13, 14]
  );
  const rawSummary = JSON.parse(
    await readFile(path.join(root, ".riptide", "runs", "baseline", "sweep-summary.json"), "utf8")
  );
  assert.equal(rawSummary.seed_root, 10);
  assert.equal(rawSummary.sweep_size, 5);
  assert.equal(rawSummary.status, "all_pass");
});

test("runSweep fail-fast cancels in-flight cells and stops scheduling new seeds", async () => {
  const root = await tmpRoot("failfast");
  const runConfigPath = await writeSeedlessConfig(root);
  const started: number[] = [];

  const summary = await runSweep({
    scenario: { name: "baseline", runConfigPath },
    cwd: root,
    scenarioOutputDir: path.join(root, ".riptide", "runs", "baseline"),
    sweepSize: 6,
    seedRoot: 20,
    full: false,
    parallelism: 3,
    runOne: async (ctx) => {
      const seed = await seedFor(ctx);
      started.push(seed);
      if (seed === 20) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return fired(seed, ctx);
      }
      await new Promise<void>((resolve) => {
        ctx.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { kind: "error", wallClockS: 0.01, error: "aborted" };
    }
  });

  assert.equal(summary.kind, "fail");
  assert.deepEqual(
    started.sort((a, b) => a - b),
    [20, 21, 22]
  );
  const rawSummary = JSON.parse(
    await readFile(path.join(root, ".riptide", "runs", "baseline", "sweep-summary.json"), "utf8")
  );
  assert.equal(rawSummary.status, "fired");
  assert.equal(rawSummary.fired, 1);
  assert.equal(rawSummary.completed, 1);
  assert.equal(rawSummary.cells.filter((cell: { status: string }) => cell.status === "killed").length, 2);
  assert.match(rawSummary.first_fire_cell, /runs\/20$/);
});

test("runSweep --full runs every cell and records fire frequency", async () => {
  const root = await tmpRoot("full");
  const runConfigPath = await writeSeedlessConfig(root);
  const started: number[] = [];

  const summary = await runSweep({
    scenario: { name: "baseline", runConfigPath },
    cwd: root,
    scenarioOutputDir: path.join(root, ".riptide", "runs", "baseline"),
    sweepSize: 4,
    seedRoot: 30,
    full: true,
    parallelism: 2,
    runOne: async (ctx) => {
      const seed = await seedFor(ctx);
      started.push(seed);
      return seed === 31 ? fired(seed, ctx) : pass(seed, ctx);
    }
  });

  assert.equal(summary.kind, "fail");
  assert.deepEqual(
    started.sort((a, b) => a - b),
    [30, 31, 32, 33]
  );
  const rawSummary = JSON.parse(
    await readFile(path.join(root, ".riptide", "runs", "baseline", "sweep-summary.json"), "utf8")
  );
  assert.equal(rawSummary.status, "fired");
  assert.equal(rawSummary.completed, 4);
  assert.equal(rawSummary.invariant_fire_frequency.bad_debt_emerged.count, 1);
  assert.equal(rawSummary.invariant_fire_frequency.bad_debt_emerged.rate, 0.25);
});

test("runSweep records engine_error summaries even when no cell produced a result", async () => {
  const root = await tmpRoot("engine-error");
  const runConfigPath = await writeSeedlessConfig(root);

  const summary = await runSweep({
    scenario: { name: "baseline", runConfigPath },
    cwd: root,
    scenarioOutputDir: path.join(root, ".riptide", "runs", "baseline"),
    sweepSize: 3,
    seedRoot: 40,
    full: false,
    parallelism: 1,
    runOne: async () => ({
      kind: "error",
      wallClockS: 0.01,
      error: "engine exploded"
    })
  });

  assert.equal(summary.kind, "error");
  assert.match(summary.error, /engine exploded/);
  const rawSummary = JSON.parse(
    await readFile(path.join(root, ".riptide", "runs", "baseline", "sweep-summary.json"), "utf8")
  );
  assert.equal(rawSummary.status, "engine_error");
  assert.equal(rawSummary.completed, 1);
  assert.equal(rawSummary.engine_errors, 1);
});
