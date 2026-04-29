// `riptide run` run-loop tests.
//
// Covers the seven done-when cases in T03's Obsidian note:
//   1. default discovers + runs every scenario (sequential order)
//   2. glob pattern filters discovered list
//   3. .json file path runs the single file (backward-compat)
//   4. file-path-wins disambiguation (arg that is both a valid glob AND an existing file)
//   5. .riptide/last-run.json is written at the end of every invocation
//   6. --only-failing filters by last-run.json statuses
//   7. sequential execution — engine invoked once per scenario in order
//
// The full engine is NOT invoked here. Tests inject a fake `runOne`
// so we can pin the orchestration shape without the 60-90s engine
// startup cost. The real engine invocation path is covered by the
// byte-stable regression-hash gates in scripts/perps-scratch.sh,
// scripts/amm-scratch.sh, and the hero-grid artifact under
// fixtures/scenarios/lending/hero-grid/w25-s40/.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildScenarioRun,
  defaultOutputPathForScenario,
  resolveScenarios,
  runScenarios,
  extractInvariantFires,
  type ResolvedScenario,
  type RunEvent,
  type RunOneContext,
  type RunOneResult
} from "../src/run/loop.js";
import type { SimulationResult } from "../src/compiler/schema.js";
import { resolveAdapterForScenario } from "../src/run/adapter.js";
import {
  LAST_RUN_SCHEMA_VERSION,
  failingNames,
  lastRunPath,
  readLastRun,
  writeLastRun
} from "../src/run/last-run.js";
import { filterScenariosByPattern, matchScenarioName } from "../src/run/glob.js";

const GOOD_RUN_CONFIG = JSON.stringify({
  agents: 1,
  ticks: 1,
  scenario: "x",
  seed: 1,
  personas: []
});

async function mkScenario(root: string, name: string): Promise<string> {
  const dir = path.join(root, ".riptide", "scenarios", ...name.split("/"));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "run-config.json");
  await writeFile(file, GOOD_RUN_CONFIG, "utf8");
  return file;
}

async function tmpRoot(label: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `riptide-run-${label}-`));
}

function passResult(wallClockS = 0.1): RunOneResult {
  return {
    kind: "pass",
    wallClockS,
    artifactsDir: "/tmp/unused",
    result: baseSimulationResult()
  };
}

function failResult(fires: Array<{ name: string; tick: number }>, wallClockS = 0.1): RunOneResult {
  return {
    kind: "fail",
    wallClockS,
    artifactsDir: "/tmp/unused",
    fires,
    result: baseSimulationResult({
      events: [
        ...baseSimulationResult().events,
        ...fires.map((fire) => ({
          tick: fire.tick,
          agent_id: "__engine__",
          persona_id: "invariant",
          persona_label: "invariant",
          action: `invariant_violation:${fire.name}`,
          params: {},
          outcome: "failed" as const
        }))
      ],
      summary: {
        invariants_fired: fires.map((fire) => ({
          name: fire.name,
          field: "bad_debt",
          op: "==",
          value: 0,
          firings: 1
        }))
      }
    })
  };
}

function errorResult(error: string): RunOneResult {
  return { kind: "error", wallClockS: 0, error };
}

function baseSimulationResult(overrides: Partial<SimulationResult> = {}): SimulationResult {
  const result: SimulationResult = {
    run_config: {
      agents: 1,
      ticks: 4,
      scenario: "unit",
      seed: 1,
      personas: ["cautious-yield-farmer"],
      validator_url: "http://127.0.0.1:8899",
      output_path: ".riptide/runs/unit"
    },
    seed: 1,
    total_ticks: 4,
    timeseries: [
      { tick: 0, active_agents: 1, tvl: 100 },
      { tick: 4, active_agents: 1, tvl: 101 }
    ],
    events: [
      {
        tick: 1,
        agent_id: "agent-001",
        persona_id: "cautious-yield-farmer",
        persona_label: "Cautious Yield Farmer",
        action: "deposit",
        params: { amount: 1 },
        outcome: "success"
      }
    ],
    agents: [
      {
        agent_id: "agent-001",
        persona_id: "cautious-yield-farmer",
        persona_label: "Cautious Yield Farmer",
        status: "active",
        final_balance: 101,
        pnl: 1,
        total_actions: 1,
        triggers_activated: 0
      }
    ],
    summary: {
      agents_active: 1,
      agents_liquidated: 0,
      agents_depleted: 0,
      invariants_fired: [
        { name: "no_bad_debt", field: "bad_debt", op: "==", value: 0, firings: 0 }
      ]
    },
    simulation_boundaries: ["unit test"]
  };

  return {
    ...result,
    ...overrides,
    run_config: { ...result.run_config, ...overrides.run_config },
    summary: { ...result.summary, ...overrides.summary }
  };
}

// --- resolveScenarios ---

test("resolveScenarios: zero-arg → all discovered scenarios", async () => {
  const root = await tmpRoot("resolve-default");
  await mkScenario(root, "alpha");
  await mkScenario(root, "bravo");

  const res = await resolveScenarios({ cwd: root });
  assert.equal(res.kind, "ok");
  if (res.kind !== "ok") return;
  assert.deepEqual(res.scenarios.map((s) => s.name), ["alpha", "bravo"]);
});

test("resolveScenarios: glob pattern filters the discovered list", async () => {
  const root = await tmpRoot("resolve-glob");
  await mkScenario(root, "hero-grid/w25-s40");
  await mkScenario(root, "hero-grid/w5-s20");
  await mkScenario(root, "perps/shock");

  const r1 = await resolveScenarios({ cwd: root, positional: "hero-grid" });
  assert.equal(r1.kind, "ok");
  if (r1.kind !== "ok") return;
  assert.deepEqual(r1.scenarios.map((s) => s.name), [
    "hero-grid/w25-s40",
    "hero-grid/w5-s20"
  ]);

  const r2 = await resolveScenarios({ cwd: root, positional: "*shock*" });
  assert.equal(r2.kind, "ok");
  if (r2.kind !== "ok") return;
  assert.deepEqual(r2.scenarios.map((s) => s.name), ["perps/shock"]);

  const r3 = await resolveScenarios({ cwd: root, positional: "hero-grid/w25-*" });
  assert.equal(r3.kind, "ok");
  if (r3.kind !== "ok") return;
  assert.deepEqual(r3.scenarios.map((s) => s.name), ["hero-grid/w25-s40"]);
});

test("resolveScenarios: existing .json path → single scenario (backward-compat)", async () => {
  const root = await tmpRoot("resolve-path");
  const file = await mkScenario(root, "hero-grid/w25-s40");

  const res = await resolveScenarios({ cwd: root, positional: file });
  assert.equal(res.kind, "ok");
  if (res.kind !== "ok") return;
  assert.equal(res.scenarios.length, 1);
  assert.equal(res.scenarios[0]!.runConfigPath, file);
  // Name should still be derived from .riptide/scenarios/ when the
  // file sits under it, not from the raw basename.
  assert.equal(res.scenarios[0]!.name, "hero-grid/w25-s40");
  assert.equal(res.sourcePath, file);
});

test("resolveScenarios: file-path wins over glob ambiguity (disambiguation)", async () => {
  const root = await tmpRoot("resolve-disambig");
  // Build a scenario whose name would match the glob `amb`, then also
  // stash a `amb.json` file in cwd that exists. The path wins.
  await mkScenario(root, "amb/alpha");
  await mkScenario(root, "amb/bravo");
  const diskPath = path.join(root, "amb.json");
  await writeFile(diskPath, GOOD_RUN_CONFIG, "utf8");

  const res = await resolveScenarios({ cwd: root, positional: diskPath });
  assert.equal(res.kind, "ok");
  if (res.kind !== "ok") return;
  assert.equal(res.scenarios.length, 1);
  assert.equal(res.scenarios[0]!.runConfigPath, diskPath);
});

test("resolveScenarios: missing .riptide/ + non-file arg → setup_error", async () => {
  const root = await tmpRoot("resolve-missing");
  const res = await resolveScenarios({ cwd: root, positional: "hero-grid" });
  assert.equal(res.kind, "setup_error");
  if (res.kind !== "setup_error") return;
  assert.match(res.message, /\.riptide/);
});

test("resolveScenarios: glob with no matches → setup_error", async () => {
  const root = await tmpRoot("resolve-nomatch");
  await mkScenario(root, "alpha");
  const res = await resolveScenarios({ cwd: root, positional: "zeta" });
  assert.equal(res.kind, "setup_error");
  if (res.kind !== "setup_error") return;
  assert.match(res.message, /did not match/);
});

test("resolveScenarios: --only-failing filters by last-run.json statuses", async () => {
  const root = await tmpRoot("resolve-onlyfailing");
  const alphaFile = await mkScenario(root, "alpha");
  const bravoFile = await mkScenario(root, "bravo");
  await mkScenario(root, "charlie");

  await writeLastRun(root, {
    schema_version: LAST_RUN_SCHEMA_VERSION,
    started_at: "2026-04-19T00:00:00.000Z",
    finished_at: "2026-04-19T00:00:10.000Z",
    signal_aborted: false,
    partial_abort: false,
    scenarios: [
      {
        name: "alpha",
        run_config_path: alphaFile,
        status: "fail",
        wall_clock_s: 0.1,
        invariant_fires: [{ name: "inv", tick: 1 }]
      },
      {
        name: "bravo",
        run_config_path: bravoFile,
        status: "error",
        wall_clock_s: 0,
        invariant_fires: []
      },
      {
        name: "charlie",
        run_config_path: path.join(root, ".riptide", "scenarios", "charlie", "run-config.json"),
        status: "pass",
        wall_clock_s: 0.1,
        invariant_fires: []
      }
    ]
  });

  const res = await resolveScenarios({ cwd: root, onlyFailing: true });
  assert.equal(res.kind, "ok");
  if (res.kind !== "ok") return;
  assert.deepEqual(res.scenarios.map((s) => s.name), ["alpha", "bravo"]);
});

test("resolveScenarios: --only-failing with no last-run.json → setup_error", async () => {
  const root = await tmpRoot("resolve-onlyfail-none");
  await mkScenario(root, "alpha");
  const res = await resolveScenarios({ cwd: root, onlyFailing: true });
  assert.equal(res.kind, "setup_error");
  if (res.kind !== "setup_error") return;
  assert.match(res.message, /no .*last-run\.json/i);
});

// --- runScenarios ---

test("runScenarios: sequential invocation in discovery-sorted order", async () => {
  const root = await tmpRoot("run-order");
  const a = { name: "alpha", runConfigPath: path.join(root, "a.json") };
  const b = { name: "bravo", runConfigPath: path.join(root, "b.json") };
  const c = { name: "charlie", runConfigPath: path.join(root, "c.json") };
  const scenarios: ResolvedScenario[] = [a, b, c];

  const callOrder: string[] = [];
  const overlapCounter = { active: 0, maxActive: 0 };
  const runOne = async (ctx: RunOneContext): Promise<RunOneResult> => {
    callOrder.push(ctx.scenario.name);
    overlapCounter.active += 1;
    overlapCounter.maxActive = Math.max(overlapCounter.maxActive, overlapCounter.active);
    // simulate work
    await new Promise<void>((r) => setTimeout(r, 5));
    overlapCounter.active -= 1;
    return passResult();
  };

  await mkdir(path.join(root, ".riptide"), { recursive: true });
  const summary = await runScenarios({
    scenarios,
    cwd: root,
    runOne,
    handleSignals: false
  });

  assert.deepEqual(callOrder, ["alpha", "bravo", "charlie"]);
  assert.equal(
    overlapCounter.maxActive,
    1,
    "runScenarios must be strictly sequential — no overlap"
  );
  assert.equal(summary.pass, 3);
  assert.equal(summary.fail, 0);
  assert.equal(summary.error, 0);
});

test("runScenarios: writes .riptide/last-run.json with v1 schema", async () => {
  const root = await tmpRoot("run-lastrun");
  await mkdir(path.join(root, ".riptide"), { recursive: true });
  const scenarios: ResolvedScenario[] = [
    { name: "alpha", runConfigPath: path.join(root, "a.json") },
    { name: "bravo", runConfigPath: path.join(root, "b.json") }
  ];
  const runOne = async (ctx: RunOneContext): Promise<RunOneResult> => {
    if (ctx.scenario.name === "bravo") {
      return failResult([{ name: "tvl_ok", tick: 3 }], 0.2);
    }
    return passResult(0.1);
  };

  const summary = await runScenarios({
    scenarios,
    cwd: root,
    runOne,
    handleSignals: false
  });

  assert.ok(summary.lastRunPath.endsWith(path.join(".riptide", "last-run.json")));
  const raw = await readFile(lastRunPath(root), "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.schema_version, 1);
  assert.equal(parsed.scenarios.length, 2);
  assert.equal(parsed.scenarios[0].name, "alpha");
  assert.equal(parsed.scenarios[0].status, "pass");
  assert.deepEqual(parsed.scenarios[0].invariant_fires, []);
  assert.equal(parsed.scenarios[0].interpretation.verdict, "no-failure-observed");
  assert.equal(parsed.scenarios[1].name, "bravo");
  assert.equal(parsed.scenarios[1].status, "fail");
  assert.deepEqual(parsed.scenarios[1].invariant_fires, [{ name: "tvl_ok", tick: 3 }]);
  assert.equal(parsed.scenarios[1].interpretation.verdict, "failure-observed");
  assert.equal(typeof parsed.started_at, "string");
  assert.equal(typeof parsed.finished_at, "string");
  assert.equal(parsed.signal_aborted, false);
  assert.equal(parsed.partial_abort, false);
});

test("runScenarios: adapter semantic invariants count as declared inventory", async () => {
  const root = await tmpRoot("run-semantic-inventory");
  await mkdir(path.join(root, ".riptide"), { recursive: true });
  const adapterFile = path.join(root, "adapter.toml");
  await writeFile(
    adapterFile,
    `protocol = "generic"
program_so = "./program.so"
idl_path = "./idl.json"

[accounts.position]
kind = "shared"
space = 8

[instructions.deposit]
action = "deposit"
amount = "amount"

[state_mapping]
"position.health_factor" = "position.health_factor"

[actions.deposit]
label = "Deposit"
takes = ["amount"]

[observations]
"position.health_factor" = "uint"

[personas.baseline]
label = "Baseline"
action_rate_multiplier = 1.0
action_weights = { deposit = 1.0 }
triggers = []

[semantics]
class = "lending.v1"

[semantics.roles.position]
source = "account.position"
fields.health_factor = "u64"

[semantics.roles.reserve]
source = "account.position"
fields.available_liquidity = "u64"

[semantics.roles.oracle]
source = "account.position"
fields.price = "i64"

[semantics.roles.liquidation_config]
source = "account.position"
fields.close_factor_bps = "u64"

[[semantics.invariants]]
name = "health_factor_above_one"
expr = "health_factor >= 1"
severity = "warn"
`,
    "utf8"
  );
  const scenarios: ResolvedScenario[] = [
    { name: "baseline", runConfigPath: path.join(root, "baseline.json") }
  ];
  const semanticResult = baseSimulationResult({
    summary: {
      agents_active: 1,
      agents_liquidated: 0,
      agents_depleted: 0,
      invariants_fired: null,
      expression_invariants: [
        {
          name: "health_factor_above_one",
          expr: "health_factor >= 1",
          severity: "warn",
          first_tick: null,
          firing_count: 0,
          observed: []
        }
      ]
    }
  });
  const semanticRunOne = async (): Promise<RunOneResult> => ({
    kind: "pass",
    wallClockS: 0.1,
    artifactsDir: "/tmp/unused",
    result: semanticResult
  });

  await runScenarios({
    scenarios,
    cwd: root,
    adapterOverride: adapterFile,
    runOne: semanticRunOne,
    handleSignals: false
  });

  const raw = await readFile(lastRunPath(root), "utf8");
  const parsed = JSON.parse(raw);
  const check = parsed.scenarios[0].interpretation.coverage_checks.find(
    (entry: { name: string }) => entry.name === "invariant_inventory"
  );
  assert.equal(check.status, "pass");
  assert.equal(check.detail, "1 declared invariant row present");
  assert.doesNotMatch(check.detail, /no invariants/);
  assert.equal(parsed.scenarios[0].interpretation.verdict, "no-failure-observed");
});

test("runScenarios: errored scenario records 'error' status + partialAbort flag", async () => {
  const root = await tmpRoot("run-error");
  await mkdir(path.join(root, ".riptide"), { recursive: true });
  const scenarios: ResolvedScenario[] = [
    { name: "alpha", runConfigPath: path.join(root, "a.json") }
  ];
  const runOne = async (): Promise<RunOneResult> => errorResult("engine crashed");

  const summary = await runScenarios({
    scenarios,
    cwd: root,
    runOne,
    handleSignals: false
  });

  assert.equal(summary.error, 1);
  assert.equal(summary.partialAbort, true);
  assert.equal(summary.signalAborted, false);
  assert.equal(summary.scenarios[0]!.status, "error");
  assert.equal(summary.scenarios[0]!.error, "engine crashed");
  assert.equal(summary.scenarios[0]!.interpretation?.verdict, "setup-error");
  assert.equal(summary.scenarios[0]!.interpretation?.coverage, "unknown");
});

test("runScenarios: skipped scenarios receive setup-error interpretation on SIGINT", async () => {
  const root = await tmpRoot("run-skip-interpretation");
  await mkdir(path.join(root, ".riptide"), { recursive: true });
  const scenarios: ResolvedScenario[] = [
    { name: "alpha", runConfigPath: path.join(root, "a.json") },
    { name: "bravo", runConfigPath: path.join(root, "b.json") }
  ];
  const runOne = async (): Promise<RunOneResult> => {
    process.emit("SIGINT");
    return passResult(0.1);
  };

  const summary = await runScenarios({
    scenarios,
    cwd: root,
    runOne
  });

  assert.equal(summary.signalAborted, true);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.scenarios[1]!.status, "skipped");
  assert.equal(summary.scenarios[1]!.interpretation?.verdict, "setup-error");
  assert.equal(summary.scenarios[1]!.interpretation?.coverage, "unknown");
});

test("runScenarios: distinguishes error (exit 2) from fail (invariant fire) in records", async () => {
  // Mixed-bundle regression guard (T09 done-when #6): verify the
  // run loop records errored scenarios with status "error" and
  // invariant-firing scenarios with status "fail" in the same sweep.
  const root = await tmpRoot("run-mixed-classification");
  await mkdir(path.join(root, ".riptide"), { recursive: true });
  const scenarios: ResolvedScenario[] = [
    { name: "grinder/broken", runConfigPath: path.join(root, "g.json") },
    { name: "solend/baseline", runConfigPath: path.join(root, "s.json") },
    { name: "solend/failing", runConfigPath: path.join(root, "f.json") }
  ];
  const runOne = async (ctx: RunOneContext): Promise<RunOneResult> => {
    if (ctx.scenario.name === "grinder/broken") {
      return errorResult("riptide-engine exited with code 2.");
    }
    if (ctx.scenario.name === "solend/failing") {
      return failResult([{ name: "tvl_ok", tick: 5 }], 0.2);
    }
    return passResult(0.1);
  };

  const summary = await runScenarios({
    scenarios,
    cwd: root,
    runOne,
    handleSignals: false
  });

  assert.equal(summary.pass, 1);
  assert.equal(summary.fail, 1);
  assert.equal(summary.error, 1);
  assert.equal(summary.skipped, 0);
  assert.equal(summary.scenarios[0]!.status, "error");
  assert.equal(summary.scenarios[1]!.status, "pass");
  assert.equal(summary.scenarios[2]!.status, "fail");
});

test("runScenarios: events emitted in the correct order", async () => {
  const root = await tmpRoot("run-events");
  await mkdir(path.join(root, ".riptide"), { recursive: true });
  const scenarios: ResolvedScenario[] = [
    { name: "alpha", runConfigPath: path.join(root, "a.json") },
    { name: "bravo", runConfigPath: path.join(root, "b.json") }
  ];
  const events: RunEvent[] = [];
  await runScenarios({
    scenarios,
    cwd: root,
    runOne: async () => passResult(),
    onEvent: (e) => events.push(e),
    handleSignals: false
  });

  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    "run_start",
    "scenario_start",
    "scenario_end",
    "scenario_start",
    "scenario_end",
    "run_end"
  ]);
});

// --- glob matcher ---

test("matchScenarioName: bare token matches exact + prefix-with-slash", () => {
  assert.equal(matchScenarioName("hero-grid", "hero-grid"), true);
  assert.equal(matchScenarioName("hero-grid/w25", "hero-grid"), true);
  assert.equal(matchScenarioName("hero-grid-extra", "hero-grid"), false);
  assert.equal(matchScenarioName("other/hero-grid", "hero-grid"), false);
});

test("matchScenarioName: * matches anywhere (jest-style, crosses /)", () => {
  assert.equal(matchScenarioName("hero-grid/w25-s40", "hero-grid/w25-*"), true);
  assert.equal(matchScenarioName("hero-grid/w25-s40/extra", "hero-grid/**"), true);
  // Jest ergonomics per spec R3.2 example: `*` crosses `/` boundaries so
  // the user can write `*shock*` and match any nested scenario.
  assert.equal(matchScenarioName("perps/shock", "*shock*"), true);
});

test("matchScenarioName: *shock* matches 'shock' anywhere in name", () => {
  assert.equal(matchScenarioName("perps/oracle-shock", "*shock*"), true);
  assert.equal(matchScenarioName("shock-test", "*shock*"), true);
  assert.equal(matchScenarioName("hero-grid/w25", "*shock*"), false);
});

test("filterScenariosByPattern preserves input order", () => {
  const input = [
    { name: "alpha" },
    { name: "beta" },
    { name: "gamma" }
  ];
  const out = filterScenariosByPattern(input, "*a*");
  assert.deepEqual(out.map((s) => s.name), ["alpha", "beta", "gamma"]);
});

// --- extractInvariantFires ---

test("extractInvariantFires: pulls (name, tick) pairs from events[] in emission order", () => {
  const result = {
    run_config: {},
    seed: 0,
    total_ticks: 0,
    timeseries: [],
    events: [
      { tick: 1, persona_id: "trader", action: "swap", params: {}, outcome: "success", agent_id: "a", persona_label: "l" },
      { tick: 3, persona_id: "invariant", action: "invariant_violation:tvl_ok", params: {}, outcome: "failed", agent_id: "__engine__", persona_label: "invariant" },
      { tick: 7, persona_id: "invariant", action: "invariant_violation:solvency", params: {}, outcome: "failed", agent_id: "__engine__", persona_label: "invariant" }
    ],
    agents: [],
    summary: { agents_active: 0, agents_liquidated: 0, agents_depleted: 0 },
    simulation_boundaries: []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const fires = extractInvariantFires(result);
  assert.deepEqual(fires, [
    { name: "tvl_ok", tick: 3 },
    { name: "solvency", tick: 7 }
  ]);
});

test("extractInvariantFires: includes severity-error expression invariant fires", () => {
  const result = {
    run_config: {},
    seed: 0,
    total_ticks: 0,
    timeseries: [],
    events: [
      {
        tick: 2,
        persona_id: "expression_invariant",
        action: "expression_invariant_fire:warn_only",
        params: { severity: "warn" },
        outcome: "success",
        agent_id: "__engine__",
        persona_label: "expression_invariant"
      },
      {
        tick: 3,
        persona_id: "expression_invariant",
        action: "expression_invariant_fire:semantic_failure",
        params: { severity: "error" },
        outcome: "failed",
        agent_id: "__engine__",
        persona_label: "expression_invariant"
      }
    ],
    agents: [],
    summary: { agents_active: 0, agents_liquidated: 0, agents_depleted: 0 },
    simulation_boundaries: []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  assert.deepEqual(extractInvariantFires(result), [
    { name: "semantic_failure", tick: 3 }
  ]);
});

test("extractInvariantFires: falls back to expression invariant summary rows", () => {
  const result = {
    run_config: {},
    seed: 0,
    total_ticks: 0,
    timeseries: [],
    events: [],
    agents: [],
    summary: {
      agents_active: 0,
      agents_liquidated: 0,
      agents_depleted: 0,
      expression_invariants: [
        {
          name: "warn_only",
          expr: "x < y",
          severity: "warn",
          first_tick: 0,
          firing_count: 1,
          observed: [{ tick: 0, values: {} }]
        },
        {
          name: "semantic_failure",
          expr: "x < y",
          severity: "error",
          first_tick: 4,
          firing_count: 2,
          observed: [{ tick: 4, values: {} }]
        }
      ]
    },
    simulation_boundaries: []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  assert.deepEqual(extractInvariantFires(result), [
    { name: "semantic_failure", tick: 4 }
  ]);
});

// --- per-scenario adapter resolution (R9.1) ---

test("resolveAdapterForScenario: --adapter override wins every other branch", async () => {
  const root = await tmpRoot("adapter-override");
  const overrideToml = path.join(root, "pinned.toml");
  await writeFile(overrideToml, "x\n");

  // Even with a scaffolded + monorepo + run-config-declared adapter, the
  // global override must win. We give the resolver the override to prove
  // the short-circuit without actually populating the other candidates.
  const res = resolveAdapterForScenario(
    { name: "whatever/x", runConfigPath: "/nonexistent.json" },
    { cwd: root, monorepoRoot: null, globalOverride: overrideToml }
  );
  assert.equal(res.kind, "ok");
  if (res.kind !== "ok") return;
  assert.equal(res.path, path.resolve(overrideToml));
  assert.equal(res.source, "override");
});

test("resolveAdapterForScenario: scenario's run-config 'adapter' field wins over monorepo bundle", async () => {
  const root = await tmpRoot("adapter-runconfig");
  const scenarioDir = path.join(root, ".riptide", "scenarios", "custom", "one");
  await mkdir(scenarioDir, { recursive: true });
  const adapterFile = path.join(scenarioDir, "declared.toml");
  await writeFile(adapterFile, "x\n");
  const runConfigPath = path.join(scenarioDir, "run-config.json");
  await writeFile(
    runConfigPath,
    JSON.stringify({
      agents: 1, ticks: 1, scenario: "x", seed: 1, personas: [],
      adapter: "declared.toml"
    })
  );

  const res = resolveAdapterForScenario(
    { name: "custom/one", runConfigPath },
    { cwd: root, monorepoRoot: null }
  );
  assert.equal(res.kind, "ok");
  if (res.kind !== "ok") return;
  assert.equal(res.path, adapterFile);
  assert.equal(res.source, "run-config");
});

test("resolveAdapterForScenario: monorepo bundle fallback derives from first path segment", async () => {
  // Mixed-bundle scenarios in the monorepo must pick the bundle adapter
  // that matches their name prefix. resource-grinder scenarios must NOT
  // end up using lending's adapter — that's the T09 bug.
  const monorepo = await tmpRoot("adapter-bundle");
  const adaptersDir = path.join(monorepo, "fixtures", "adapters");
  await mkdir(adaptersDir, { recursive: true });
  const grinderAdapter = path.join(adaptersDir, "resource-grinder.toml");
  const solendAdapter = path.join(adaptersDir, "lending.toml");
  await writeFile(grinderAdapter, "g\n");
  await writeFile(solendAdapter, "s\n");

  const cwd = await tmpRoot("adapter-bundle-cwd");
  const resGrinder = resolveAdapterForScenario(
    {
      name: "resource-grinder/botter-share-sweep",
      runConfigPath: "/nonexistent.json"
    },
    { cwd, monorepoRoot: monorepo }
  );
  const resSolend = resolveAdapterForScenario(
    {
      name: "lending/hero-grid/w25-s40",
      runConfigPath: "/nonexistent.json"
    },
    { cwd, monorepoRoot: monorepo }
  );

  assert.equal(resGrinder.kind, "ok");
  assert.equal(resSolend.kind, "ok");
  if (resGrinder.kind !== "ok" || resSolend.kind !== "ok") return;
  assert.equal(resGrinder.path, grinderAdapter);
  assert.equal(resSolend.path, solendAdapter);
  assert.equal(resGrinder.source, "bundle");
  assert.equal(resSolend.source, "bundle");
});

test("resolveAdapterForScenario: scaffolded .riptide/adapters/<one>.toml is the user-repo fallback", async () => {
  const cwd = await tmpRoot("adapter-scaffold");
  const scaffoldDir = path.join(cwd, ".riptide", "adapters");
  await mkdir(scaffoldDir, { recursive: true });
  const scaffolded = path.join(scaffoldDir, "my-program.toml");
  await writeFile(scaffolded, "x\n");

  const res = resolveAdapterForScenario(
    { name: "scenario/alpha", runConfigPath: "/nonexistent.json" },
    { cwd, monorepoRoot: null }
  );
  assert.equal(res.kind, "ok");
  if (res.kind !== "ok") return;
  assert.equal(res.path, scaffolded);
  assert.equal(res.source, "scaffold");
});

test("resolveAdapterForScenario: multiple scaffolded adapters → error (ambiguous)", async () => {
  const cwd = await tmpRoot("adapter-scaffold-multi");
  const scaffoldDir = path.join(cwd, ".riptide", "adapters");
  await mkdir(scaffoldDir, { recursive: true });
  await writeFile(path.join(scaffoldDir, "a.toml"), "x\n");
  await writeFile(path.join(scaffoldDir, "b.toml"), "y\n");

  const res = resolveAdapterForScenario(
    { name: "scenario/alpha", runConfigPath: "/nonexistent.json" },
    { cwd, monorepoRoot: null }
  );
  assert.equal(res.kind, "error");
  if (res.kind !== "error") return;
  assert.match(res.message, /multiple TOMLs/);
});

test("resolveAdapterForScenario: nothing anywhere → error with resolution trace", async () => {
  const cwd = await tmpRoot("adapter-none");
  const res = resolveAdapterForScenario(
    { name: "scenario/x", runConfigPath: "/nonexistent.json" },
    { cwd, monorepoRoot: null }
  );
  assert.equal(res.kind, "error");
  if (res.kind !== "error") return;
  assert.match(res.message, /could not resolve an adapter/);
});

test("resolveAdapterForScenario: monorepo fallback fires only when first-segment adapter exists", async () => {
  // Scenario name 'unknown-bundle/x' with no matching fixtures/adapters/
  // entry falls through to the next step (user-repo scaffold); if that's
  // missing too, errors out.
  const monorepo = await tmpRoot("adapter-bundle-missing");
  await mkdir(path.join(monorepo, "fixtures", "adapters"), { recursive: true });
  // only lending present
  await writeFile(
    path.join(monorepo, "fixtures", "adapters", "lending.toml"),
    "y\n"
  );

  const cwd = await tmpRoot("adapter-bundle-missing-cwd");
  const res = resolveAdapterForScenario(
    { name: "unknown-bundle/x", runConfigPath: "/nonexistent.json" },
    { cwd, monorepoRoot: monorepo }
  );
  assert.equal(res.kind, "error");
});

// --- buildScenarioRun: validator_url passthrough + default output path ---

test("buildScenarioRun: forwards validator_url from the scenario file", async () => {
  const root = await tmpRoot("validator-url");
  const file = path.join(root, "rc.json");
  await writeFile(
    file,
    JSON.stringify({
      agents: 1,
      ticks: 1,
      scenario: "x",
      seed: 1,
      personas: [],
      validator_url: "https://api.mainnet-beta.solana.com"
    }),
    "utf8"
  );

  const build = buildScenarioRun({
    scenarioName: "n",
    runConfigPath: file,
    cwd: root
  });
  assert.equal(build.runConfig.validator_url, "https://api.mainnet-beta.solana.com");
  assert.equal(build.simulateOptions.validator_url, "https://api.mainnet-beta.solana.com");
});

test("buildScenarioRun: missing validator_url falls back to env/default (existing behavior)", async () => {
  const root = await tmpRoot("validator-url-fallback");
  const file = path.join(root, "rc.json");
  await writeFile(
    file,
    JSON.stringify({
      agents: 1,
      ticks: 1,
      scenario: "x",
      seed: 1,
      personas: []
    }),
    "utf8"
  );
  const priorEnv = process.env.RIPTIDE_RPC_URL;
  delete process.env.RIPTIDE_RPC_URL;
  try {
    const build = buildScenarioRun({
      scenarioName: "n",
      runConfigPath: file,
      cwd: root
    });
    assert.equal(build.runConfig.validator_url, "http://127.0.0.1:8899");
  } finally {
    if (priorEnv !== undefined) process.env.RIPTIDE_RPC_URL = priorEnv;
  }
});

test("defaultOutputPathForScenario: preserves full scenario name across leaf collisions", () => {
  const a = defaultOutputPathForScenario("amm/baseline");
  const b = defaultOutputPathForScenario("perps/baseline");
  assert.notEqual(a, b);
  assert.equal(a, path.join(".riptide", "runs", "amm", "baseline"));
  assert.equal(b, path.join(".riptide", "runs", "perps", "baseline"));
});

test("defaultOutputPathForScenario: single-segment name is a single subdir", () => {
  assert.equal(
    defaultOutputPathForScenario("baseline"),
    path.join(".riptide", "runs", "baseline")
  );
});

test("buildScenarioRun: uses default output path derived from full scenario name when file omits output_path", async () => {
  const root = await tmpRoot("output-path");
  const file = path.join(root, "rc.json");
  await writeFile(
    file,
    JSON.stringify({ agents: 1, ticks: 1, scenario: "x", seed: 1, personas: [] }),
    "utf8"
  );
  const build = buildScenarioRun({
    scenarioName: "perps/baseline",
    runConfigPath: file,
    cwd: root
  });
  assert.equal(build.runConfig.output_path, path.join(".riptide", "runs", "perps", "baseline"));
  assert.equal(build.outputPath, path.join(".riptide", "runs", "perps", "baseline"));
});

test("buildScenarioRun: explicit output_path in file wins over the default", async () => {
  const root = await tmpRoot("output-path-explicit");
  const file = path.join(root, "rc.json");
  await writeFile(
    file,
    JSON.stringify({
      agents: 1,
      ticks: 1,
      scenario: "x",
      seed: 1,
      personas: [],
      output_path: "my/custom/out"
    }),
    "utf8"
  );
  const build = buildScenarioRun({
    scenarioName: "perps/baseline",
    runConfigPath: file,
    cwd: root
  });
  assert.equal(build.runConfig.output_path, "my/custom/out");
});

test("buildScenarioRun: outputPathOverride wins over the run-config's output_path (T11)", async () => {
  // T11 makes riptide-run always write to .riptide/runs/ regardless of
  // what the scenario file declared. This is the override hook the loop
  // uses — verify it wins even when the file has an explicit path.
  const root = await tmpRoot("output-path-override");
  const file = path.join(root, "rc.json");
  await writeFile(
    file,
    JSON.stringify({
      agents: 1,
      ticks: 1,
      scenario: "x",
      seed: 1,
      personas: [],
      output_path: "fixtures/scenarios/foo/bar"
    }),
    "utf8"
  );
  const build = buildScenarioRun({
    scenarioName: "foo/bar",
    runConfigPath: file,
    cwd: root,
    outputPathOverride: path.join(root, ".riptide", "runs", "foo", "bar")
  });
  assert.equal(
    build.runConfig.output_path,
    path.join(root, ".riptide", "runs", "foo", "bar")
  );
});

test("resolveArtifactsDir: default produces a relative .riptide/runs/<scenario-name> path (not absolute)", async () => {
  // Relative-by-default so the serialized SimulationResult's
  // run_config.output_path — which the dashboard renders — reads
  // as `.riptide/runs/…` instead of leaking the full dev-machine
  // home dir into every result file.
  const { resolveArtifactsDir } = await import("../src/run/loop.js");
  const p = resolveArtifactsDir({
    scenario: { name: "lending/hero-grid/w25-s40", runConfigPath: "/x.json" },
    cwd: "/x/repo"
  });
  assert.equal(p, path.join(".riptide", "runs", "lending", "hero-grid", "w25-s40"));
  assert.equal(path.isAbsolute(p), false);
});

test("resolveArtifactsDir: --output-dir override replaces the .riptide/runs root", async () => {
  const { resolveArtifactsDir } = await import("../src/run/loop.js");
  const cwd = "/x/repo";
  const p = resolveArtifactsDir({
    scenario: { name: "grinder/b", runConfigPath: "/x.json" },
    cwd,
    outputDir: "/mounted/volume"
  });
  assert.equal(p, path.join("/mounted/volume", "grinder", "b"));
});

// --- last-run round-trip ---

test("readLastRun / writeLastRun round-trip", async () => {
  const root = await tmpRoot("lastrun-roundtrip");
  await mkdir(path.join(root, ".riptide"), { recursive: true });
  await writeLastRun(root, {
    schema_version: 1,
    started_at: "2026-04-19T00:00:00.000Z",
    finished_at: "2026-04-19T00:00:01.000Z",
    signal_aborted: false,
    partial_abort: false,
    scenarios: [
      {
        name: "x",
        run_config_path: "/x.json",
        status: "pass",
        wall_clock_s: 0.1,
        invariant_fires: []
      }
    ]
  });
  const back = await readLastRun(root);
  assert.ok(back);
  assert.equal(back!.scenarios.length, 1);
  assert.equal(back!.scenarios[0]!.name, "x");
});

test("readLastRun: old aborted statuses normalize to error for --only-failing", async () => {
  const root = await tmpRoot("lastrun-old-aborted");
  await mkdir(path.join(root, ".riptide"), { recursive: true });
  await writeFile(
    lastRunPath(root),
    JSON.stringify({
      schema_version: 1,
      started_at: "2026-04-19T00:00:00.000Z",
      finished_at: "2026-04-19T00:00:01.000Z",
      signal_aborted: false,
      partial_abort: true,
      scenarios: [
        {
          name: "old-abort",
          run_config_path: "/x.json",
          status: "aborted",
          wall_clock_s: 0,
          invariant_fires: []
        }
      ]
    }) + "\n",
    "utf8"
  );

  const back = await readLastRun(root);
  assert.ok(back);
  assert.equal(back!.scenarios[0]!.status, "error");
  assert.deepEqual([...failingNames(back!)], ["old-abort"]);
});
