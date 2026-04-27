import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { SimulationResult } from "../src/compiler/schema.js";
import { RUN_COLLECTION_SCHEMA_VERSION, type RunCollection } from "../src/run/collection.js";
import { startDashboardServer, type DashboardHandle } from "../src/serve/index.js";
import { SEMANTIC_LABELS } from "../src/serve/labels.js";

async function tmpRoot(label: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `riptide-serve-${label}-`));
}

function resultFor(scenario: string, outputPath: string): SimulationResult {
  return {
    run_config: {
      agents: 1,
      ticks: 4,
      scenario,
      seed: 7,
      personas: ["cautious-yield-farmer"],
      validator_url: "http://127.0.0.1:8899",
      output_path: outputPath
    },
    seed: 7,
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
      final_utilization: 0.25,
      total_bad_debt: 0,
      agents_active: 1,
      agents_liquidated: 0,
      agents_depleted: 0,
      invariants_fired: [
        { name: "no_bad_debt", field: "bad_debt", op: "==", value: 0, firings: 0 }
      ]
    },
    simulation_boundaries: ["serve test"]
  };
}

async function writeScenarioArtifacts(root: string, name: string): Promise<string> {
  const relDir = path.join(".riptide", "runs", ...name.split("/"));
  const absDir = path.join(root, relDir);
  await mkdir(absDir, { recursive: true });
  const result = resultFor(name, path.join(root, relDir));
  await writeFile(
    path.join(absDir, "simulation-result.json"),
    JSON.stringify(result, null, 2) + "\n",
    "utf8"
  );
  await writeFile(path.join(absDir, "report.md"), `# ${name}\n`, "utf8");
  return relDir;
}

async function withServer<T>(sourcePath: string, fn: (handle: DashboardHandle) => Promise<T>) {
  const handle = await startDashboardServer(sourcePath, { port: 0, maxAttempts: 1 });
  try {
    return await fn(handle);
  } finally {
    await handle.close();
  }
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  assert.equal(response.status, 200);
  return (await response.json()) as Record<string, unknown>;
}

async function getText(url: string): Promise<string> {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return response.text();
}

test("dashboard server serves a run collection and selected scenario artifacts", async () => {
  const root = await tmpRoot("collection");
  const alphaDir = await writeScenarioArtifacts(root, "alpha");
  const betaDir = await writeScenarioArtifacts(root, "beta");
  const collectionPath = path.join(root, ".riptide", "run-collection.json");
  const collection: RunCollection = {
    schema_version: RUN_COLLECTION_SCHEMA_VERSION,
    started_at: "2026-04-25T00:00:00.000Z",
    finished_at: "2026-04-25T00:00:01.000Z",
    selected_pattern: "*",
    allow_invariant_violations: false,
    total_scenarios: 2,
    totals_by_status: { pass: 2, fail: 0, error: 0, skipped: 0 },
    totals_by_verdict: {
      "failure-observed": 0,
      "no-failure-observed": 2,
      inconclusive: 0,
      "setup-error": 0
    },
    totals_by_coverage: { exercised: 2, partial: 0, unexercised: 0, unknown: 0 },
    scenarios: [
      {
        name: "alpha",
        run_config_path: path.join(".riptide", "scenarios", "alpha", "run-config.json"),
        status: "pass",
        wall_clock_s: 0.1,
        artifacts_dir: alphaDir,
        invariant_fires: [],
        invariant_fire_count: 0,
        coverage_checks: [],
        metric_preview: { final_tvl: 125 },
        simulation_result_path: path.join(alphaDir, "simulation-result.json"),
        report_path: path.join(alphaDir, "report.md")
      },
      {
        name: "beta",
        run_config_path: path.join(".riptide", "scenarios", "beta", "run-config.json"),
        status: "pass",
        wall_clock_s: 0.2,
        artifacts_dir: betaDir,
        invariant_fires: [],
        invariant_fire_count: 0,
        coverage_checks: [],
        metric_preview: { final_tvl: 125 },
        simulation_result_path: path.join(betaDir, "simulation-result.json"),
        report_path: path.join(betaDir, "report.md")
      }
    ]
  };
  await writeFile(collectionPath, JSON.stringify(collection, null, 2) + "\n", "utf8");

  await withServer(collectionPath, async (handle) => {
    assert.notEqual(handle.port, 0);

    const servedCollection = await getJson(`${handle.url}/api/collection`);
    assert.equal(servedCollection.total_scenarios, 2);

    const defaultResult = await getJson(`${handle.url}/api/result`);
    assert.equal((defaultResult.run_config as { scenario: string }).scenario, "alpha");
    assert.equal(
      (defaultResult.run_config as { output_path: string }).output_path,
      path.join(".riptide", "runs", "alpha")
    );

    const betaResult = await getJson(
      `${handle.url}/api/result?scenario=${encodeURIComponent("beta")}`
    );
    assert.equal((betaResult.run_config as { scenario: string }).scenario, "beta");

    const betaReport = await getText(
      `${handle.url}/api/report?scenario=${encodeURIComponent("beta")}`
    );
    assert.match(betaReport, /^# beta/);

    const missing = await fetch(
      `${handle.url}/api/result?scenario=${encodeURIComponent("missing")}`
    );
    assert.equal(missing.status, 404);
    const payload = (await missing.json()) as { error: string };
    assert.equal(payload.error, "scenario_not_found");
  });
});

test("dashboard server returns a synthetic collection for a single artifact directory", async () => {
  const root = await tmpRoot("single");
  const artifactsDir = path.join(root, "riptide-output", "single");
  await mkdir(artifactsDir, { recursive: true });
  const result = resultFor("single", artifactsDir);
  await writeFile(
    path.join(artifactsDir, "simulation-result.json"),
    JSON.stringify(result, null, 2) + "\n",
    "utf8"
  );
  await writeFile(path.join(artifactsDir, "report.md"), "# single\n", "utf8");

  await withServer(artifactsDir, async (handle) => {
    const collection = await getJson(`${handle.url}/api/collection`);
    assert.equal(collection.schema_version, RUN_COLLECTION_SCHEMA_VERSION);
    assert.equal(collection.total_scenarios, 1);
    assert.deepEqual(collection.totals_by_status, { pass: 1, fail: 0, error: 0, skipped: 0 });
    const scenarios = collection.scenarios as Array<{
      name: string;
      interpretation: { verdict: string };
      metric_preview: { final_tvl: number };
    }>;
    assert.equal(scenarios[0]!.name, "single");
    assert.equal(scenarios[0]!.interpretation.verdict, "no-failure-observed");
    assert.equal(scenarios[0]!.metric_preview.final_tvl, 125);

    const servedResult = await getJson(`${handle.url}/api/result`);
    assert.equal((servedResult.run_config as { scenario: string }).scenario, "single");

    const report = await getText(`${handle.url}/api/report`);
    assert.match(report, /^# single/);
  });
});

test("dashboard server passes through semantics fields and serves the label map", async () => {
  const root = await tmpRoot("semantics");
  const artifactsDir = path.join(root, "riptide-output", "semantic");
  await mkdir(artifactsDir, { recursive: true });
  const result = resultFor("semantic", artifactsDir);
  result.semantics = {
    class: "lending.v1",
    roles_bound: [
      { role_name: "position", source: "instruction.deposit_obligation_collateral" },
      { role_name: "reserve", source: "account.reserve" },
      { role_name: "oracle", source: "account.oracle" },
      { role_name: "liquidation_config", source: "account.reserve" }
    ],
    derived_observation_definitions: [
      { name: "collateral_value", expr: "position.collateral_amount * oracle.price" },
      { name: "debt_value", expr: "position.debt_amount" },
      { name: "health_factor", expr: "collateral_value / max(debt_value, 1)" },
      { name: "custom_probe", expr: "health_factor + 1" }
    ]
  };
  result.timeseries[0] = {
    ...result.timeseries[0]!,
    derived_observations: {
      collateral_value: 125,
      debt_value: 100,
      health_factor: 1.25,
      custom_probe: 2.25
    }
  };
  result.summary.expression_invariants = [
    {
      name: "ltv_below_max",
      expr: "debt_value <= max_borrow_value",
      severity: "warn",
      first_tick: 1,
      firing_count: 1,
      observed: [{ tick: 1, values: { debt_value: 100, max_borrow_value: 80 } }]
    }
  ];
  await writeFile(
    path.join(artifactsDir, "simulation-result.json"),
    JSON.stringify(result, null, 2) + "\n",
    "utf8"
  );
  await writeFile(path.join(artifactsDir, "report.md"), "# semantic\n", "utf8");

  await withServer(artifactsDir, async (handle) => {
    const labels = await getJson(`${handle.url}/api/labels`);
    assert.deepEqual(labels, SEMANTIC_LABELS);
    assert.equal(
      (labels["lending.v1.health_factor"] as { label?: string }).label,
      "Health factor"
    );
    assert.equal(
      (labels["lending.v1.liquidation_threshold_value"] as { tooltip?: string }).tooltip,
      "Collateral value at the reserve liquidation threshold."
    );

    const servedResult = await getJson(`${handle.url}/api/result`);
    const semantics = servedResult.semantics as {
      class: string;
      roles_bound: Array<{ role_name: string; source: string }>;
      derived_observation_definitions: Array<{ name: string; expr: string }>;
    };
    assert.equal(semantics.class, "lending.v1");
    assert.equal(semantics.roles_bound.length, 4);
    assert.equal(semantics.derived_observation_definitions[0]!.name, "collateral_value");
    const timeseries = servedResult.timeseries as Array<{
      derived_observations?: Record<string, unknown>;
    }>;
    assert.deepEqual(timeseries[0]!.derived_observations, {
      collateral_value: 125,
      debt_value: 100,
      health_factor: 1.25,
      custom_probe: 2.25
    });
    const summary = servedResult.summary as Record<string, unknown>;
    const expressionRows = summary.expression_invariants as Array<Record<string, unknown>>;
    assert.equal(expressionRows[0]!.name, "ltv_below_max");
  });
});
