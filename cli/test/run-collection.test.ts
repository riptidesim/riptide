import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { SimulationResult } from "../src/compiler/schema.js";
import { runSummaryJson } from "../src/commands/run.js";
import {
  metricPreviewFromSummary,
  runCollectionPath
} from "../src/run/collection.js";
import {
  runScenarios,
  type ResolvedScenario,
  type RunOneContext,
  type RunOneResult,
  type RunSummary
} from "../src/run/loop.js";

async function tmpRoot(label: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `riptide-collection-${label}-`));
}

function baseResult(
  outputPath: string,
  overrides: Partial<SimulationResult> = {}
): SimulationResult {
  const result: SimulationResult = {
    run_config: {
      agents: 1,
      ticks: 4,
      scenario: "collection-test",
      seed: 1,
      personas: ["cautious-yield-farmer"],
      validator_url: "http://127.0.0.1:8899",
      output_path: outputPath
    },
    seed: 1,
    total_ticks: 4,
    timeseries: [
      { tick: 0, active_agents: 1, tvl: 100 },
      { tick: 4, active_agents: 1, tvl: 125 }
    ],
    events: [
      {
        tick: 1,
        agent_id: "agent-001",
        persona_id: "cautious-yield-farmer",
        persona_label: "Cautious Yield Farmer",
        action: "deposit",
        params: { amount: 25 },
        outcome: "success"
      }
    ],
    agents: [
      {
        agent_id: "agent-001",
        persona_id: "cautious-yield-farmer",
        persona_label: "Cautious Yield Farmer",
        status: "active",
        final_balance: 125,
        pnl: 25,
        total_actions: 1,
        triggers_activated: 0
      }
    ],
    summary: {
      final_tvl: 125,
      final_utilization: 0.2,
      total_bad_debt: 0,
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

async function writeScenarioArtifacts(
  cwd: string,
  scenarioName: string,
  result: SimulationResult
): Promise<string> {
  const artifactsDir = path.join(".riptide", "runs", ...scenarioName.split("/"));
  const absDir = path.join(cwd, artifactsDir);
  await mkdir(absDir, { recursive: true });
  await writeFile(
    path.join(absDir, "simulation-result.json"),
    JSON.stringify(result, null, 2) + "\n",
    "utf8"
  );
  await writeFile(path.join(absDir, "report.md"), "# Report\n", "utf8");
  return artifactsDir;
}

test("runScenarios writes .riptide/run-collection.json with schema v1", async () => {
  const root = await tmpRoot("write");
  await mkdir(path.join(root, ".riptide"), { recursive: true });
  const scenarios: ResolvedScenario[] = [
    {
      name: "lending/baseline",
      runConfigPath: path.join(root, ".riptide", "scenarios", "lending", "baseline", "run-config.json")
    },
    {
      name: "lending/failing",
      runConfigPath: path.join(root, ".riptide", "scenarios", "lending", "failing", "run-config.json")
    }
  ];

  const runOne = async (ctx: RunOneContext): Promise<RunOneResult> => {
    const artifactsDir = path.join(".riptide", "runs", ...ctx.scenario.name.split("/"));
    if (ctx.scenario.name.endsWith("failing")) {
      const result = baseResult(artifactsDir, {
        events: [
          ...baseResult(artifactsDir).events,
          {
            tick: 4,
            agent_id: "__engine__",
            persona_id: "invariant",
            persona_label: "invariant",
            action: "invariant_violation:no_bad_debt",
            params: {},
            outcome: "failed"
          }
        ],
        summary: {
          final_tvl: 80,
          total_bad_debt: 10,
          invariants_fired: [
            { name: "no_bad_debt", field: "bad_debt", op: "==", value: 0, firings: 1 }
          ]
        }
      });
      const writtenDir = await writeScenarioArtifacts(root, ctx.scenario.name, result);
      return {
        kind: "fail",
        wallClockS: 0.2,
        artifactsDir: writtenDir,
        result,
        fires: [{ name: "no_bad_debt", tick: 4 }]
      };
    }

    const result = baseResult(artifactsDir);
    const writtenDir = await writeScenarioArtifacts(root, ctx.scenario.name, result);
    return { kind: "pass", wallClockS: 0.1, artifactsDir: writtenDir, result };
  };

  const summary = await runScenarios({
    scenarios,
    cwd: root,
    runOne,
    handleSignals: false,
    selectedPattern: "lending/*",
    selectedSourcePath: scenarios[0]!.runConfigPath,
    allowInvariantViolations: true
  });

  assert.equal(summary.runCollectionPath, runCollectionPath(root));
  const parsed = JSON.parse(await readFile(summary.runCollectionPath, "utf8"));
  assert.equal(parsed.schema_version, 1);
  assert.equal(parsed.selected_pattern, "lending/*");
  assert.equal(
    parsed.selected_source_path,
    path.join(".riptide", "scenarios", "lending", "baseline", "run-config.json")
  );
  assert.equal(parsed.allow_invariant_violations, true);
  assert.equal(parsed.total_scenarios, 2);
  assert.deepEqual(parsed.totals_by_status, { pass: 1, fail: 1, error: 0, skipped: 0 });
  assert.equal(parsed.totals_by_verdict["no-failure-observed"], 1);
  assert.equal(parsed.totals_by_verdict["failure-observed"], 1);
  assert.equal(parsed.totals_by_coverage.exercised, 2);
  assert.equal(parsed.scenarios.length, 2);

  const baseline = parsed.scenarios[0];
  assert.equal(baseline.name, "lending/baseline");
  assert.equal(baseline.interpretation.verdict, "no-failure-observed");
  assert.equal(baseline.coverage_checks.length > 0, true);
  assert.equal(baseline.metric_preview.final_tvl, 125);
  assert.equal(
    baseline.artifacts_dir,
    path.join(".riptide", "runs", "lending", "baseline")
  );
  assert.equal(
    baseline.simulation_result_path,
    path.join(".riptide", "runs", "lending", "baseline", "simulation-result.json")
  );
  assert.equal(
    baseline.report_path,
    path.join(".riptide", "runs", "lending", "baseline", "report.md")
  );
  assert.equal(path.isAbsolute(baseline.artifacts_dir), false);
  assert.equal(path.isAbsolute(baseline.simulation_result_path), false);
  assert.equal(path.isAbsolute(baseline.report_path), false);

  const failing = parsed.scenarios[1];
  assert.equal(failing.invariant_fire_count, 1);
  assert.deepEqual(failing.invariant_fires, [{ name: "no_bad_debt", tick: 4 }]);
  assert.equal(failing.interpretation.verdict, "failure-observed");
  assert.equal(failing.metric_preview.total_bad_debt, 10);
});

test("runSummaryJson retains existing multi-scenario fields and adds run_collection_path", () => {
  const summary: RunSummary = {
    pass: 1,
    fail: 1,
    error: 0,
    skipped: 0,
    total: 2,
    signalAborted: false,
    partialAbort: false,
    lastRunPath: "/repo/.riptide/last-run.json",
    runCollectionPath: "/repo/.riptide/run-collection.json",
    scenarios: []
  };

  const json = runSummaryJson(summary);
  assert.equal(json.pass, 1);
  assert.equal(json.fail, 1);
  assert.equal(json.error, 0);
  assert.equal(json.skipped, 0);
  assert.equal(json.total, 2);
  assert.equal(json.last_run_path, "/repo/.riptide/last-run.json");
  assert.equal(json.run_collection_path, "/repo/.riptide/run-collection.json");
  assert.deepEqual(json.scenarios, []);
});

test("metricPreviewFromSummary keeps primitive metrics and skips structured rows", () => {
  const preview = metricPreviewFromSummary({
    final_tvl: 100,
    final_utilization: 0.5,
    total_bad_debt: 1,
    agents_active: 2,
    agents_liquidated: 0,
    agents_depleted: 0,
    custom_metric: "present",
    invariants_fired: [
      { name: "no_bad_debt", field: "bad_debt", op: "==", value: 0, firings: 0 }
    ]
  });

  assert.equal(preview.final_tvl, 100);
  assert.equal(preview.custom_metric, "present");
  assert.equal("invariants_fired" in preview, false);
});
