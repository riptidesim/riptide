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
// fixtures/scenarios/solend-fork/hero-grid/w25-s40/.

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
import { resolveDefaultAdapter } from "../src/commands/run.js";
import {
  LAST_RUN_SCHEMA_VERSION,
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
    // `result` is not consumed in tests — cast through unknown.
    result: {} as unknown as RunOneResult extends { result: infer R } ? R : never
  };
}

function failResult(fires: Array<{ name: string; tick: number }>, wallClockS = 0.1): RunOneResult {
  return {
    kind: "fail",
    wallClockS,
    artifactsDir: "/tmp/unused",
    fires,
    result: {} as unknown as RunOneResult extends { result: infer R } ? R : never
  };
}

function abortResult(error: string): RunOneResult {
  return { kind: "aborted", wallClockS: 0, error };
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
        status: "aborted",
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
  assert.equal(summary.aborted, 0);
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
  assert.equal(parsed.scenarios[1].name, "bravo");
  assert.equal(parsed.scenarios[1].status, "fail");
  assert.deepEqual(parsed.scenarios[1].invariant_fires, [{ name: "tvl_ok", tick: 3 }]);
  assert.equal(typeof parsed.started_at, "string");
  assert.equal(typeof parsed.finished_at, "string");
  assert.equal(parsed.signal_aborted, false);
  assert.equal(parsed.partial_abort, false);
});

test("runScenarios: aborted scenario records 'aborted' + partialAbort flag", async () => {
  const root = await tmpRoot("run-abort");
  await mkdir(path.join(root, ".riptide"), { recursive: true });
  const scenarios: ResolvedScenario[] = [
    { name: "alpha", runConfigPath: path.join(root, "a.json") }
  ];
  const runOne = async (): Promise<RunOneResult> => abortResult("engine crashed");

  const summary = await runScenarios({
    scenarios,
    cwd: root,
    runOne,
    handleSignals: false
  });

  assert.equal(summary.aborted, 1);
  assert.equal(summary.partialAbort, true);
  assert.equal(summary.signalAborted, false);
  assert.equal(summary.scenarios[0]!.status, "aborted");
  assert.equal(summary.scenarios[0]!.error, "engine crashed");
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

// --- default adapter resolution (Finding 1) ---

test("resolveDefaultAdapter: single .toml under .riptide/adapters/ → ok", async () => {
  const root = await tmpRoot("adapter-single");
  const adaptersDir = path.join(root, ".riptide", "adapters");
  await mkdir(adaptersDir, { recursive: true });
  const adapterFile = path.join(adaptersDir, "my-program.toml");
  await writeFile(adapterFile, "protocol = \"lending\"\n");

  const res = resolveDefaultAdapter(root);
  assert.equal(res.kind, "ok");
  if (res.kind !== "ok") return;
  assert.equal(res.path, adapterFile);
});

test("resolveDefaultAdapter: scaffolded adapter wins over monorepo fallback", async () => {
  const root = await tmpRoot("adapter-precedence");
  const scaffoldedDir = path.join(root, ".riptide", "adapters");
  await mkdir(scaffoldedDir, { recursive: true });
  const scaffolded = path.join(scaffoldedDir, "my-program.toml");
  await writeFile(scaffolded, "x\n");

  // Also lay down a monorepo-shaped fallback to prove it's NOT chosen.
  const monorepoFixture = path.join(root, "fixtures", "adapters");
  await mkdir(monorepoFixture, { recursive: true });
  await writeFile(path.join(monorepoFixture, "solend-fork.toml"), "y\n");

  const res = resolveDefaultAdapter(root);
  assert.equal(res.kind, "ok");
  if (res.kind !== "ok") return;
  assert.equal(res.path, scaffolded);
});

test("resolveDefaultAdapter: multiple .tomls under .riptide/adapters/ → ambiguous", async () => {
  const root = await tmpRoot("adapter-multi");
  const adaptersDir = path.join(root, ".riptide", "adapters");
  await mkdir(adaptersDir, { recursive: true });
  await writeFile(path.join(adaptersDir, "a.toml"), "x\n");
  await writeFile(path.join(adaptersDir, "b.toml"), "y\n");

  const res = resolveDefaultAdapter(root);
  assert.equal(res.kind, "ambiguous");
  if (res.kind !== "ambiguous") return;
  assert.equal(res.candidates.length, 2);
});

test("resolveDefaultAdapter: falls back to monorepo fixture (module-root derived) regardless of cwd", async () => {
  // Injected moduleRoot emulates the CLI being invoked from a deep
  // subdirectory — cwd has no fixtures/ layout, but module-root does.
  // This is the Phase 2 review Finding 1 fix: resolution MUST NOT
  // depend on cwd pointing at repo root.
  const cwd = await tmpRoot("adapter-module-root-cwd");
  const fakeMonorepo = await tmpRoot("adapter-module-root-fake");
  const fixtureDir = path.join(fakeMonorepo, "fixtures", "adapters");
  await mkdir(fixtureDir, { recursive: true });
  const fixture = path.join(fixtureDir, "solend-fork.toml");
  await writeFile(fixture, "y\n");

  const res = resolveDefaultAdapter(cwd, fakeMonorepo);
  assert.equal(res.kind, "ok");
  if (res.kind !== "ok") return;
  assert.equal(res.path, fixture);
});

test("resolveDefaultAdapter: cwd-local fixtures/adapters/ is the last-resort fallback", async () => {
  const cwd = await tmpRoot("adapter-cwd-fallback");
  const cwdFixture = path.join(cwd, "fixtures", "adapters", "solend-fork.toml");
  await mkdir(path.dirname(cwdFixture), { recursive: true });
  await writeFile(cwdFixture, "y\n");

  // Pass moduleRoot: null so the module-root branch is skipped and
  // we actually exercise the cwd-local fallback.
  const res = resolveDefaultAdapter(cwd, null);
  assert.equal(res.kind, "ok");
  if (res.kind !== "ok") return;
  assert.equal(res.path, cwdFixture);
});

test("resolveDefaultAdapter: nothing anywhere → none", async () => {
  const root = await tmpRoot("adapter-none");
  const res = resolveDefaultAdapter(root, null);
  assert.equal(res.kind, "none");
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
