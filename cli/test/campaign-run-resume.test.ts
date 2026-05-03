import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CampaignResumeSafetyError,
  executeCampaign,
  parseCampaignToml
} from "../src/campaign/index.js";
import type { SimulationResult } from "../src/compiler/schema.js";
import {
  resolveArtifactsDir,
  type RunOneContext,
  type RunOneResult
} from "../src/run/loop.js";

test("campaign run resume: executes generated configs through the run path and writes metadata", async () => {
  const root = await campaignFixtureRoot("execute");
  const spec = parseCampaignToml(await readFile(path.join(root, "campaign.toml"), "utf8"), path.join(root, "campaign.toml"));
  const seen: string[] = [];
  const harnessPath = path.join(root, ".riptide", "harness");
  const seenHarnessPaths: Array<string | undefined> = [];
  const seenRerunCommands: Array<string | undefined> = [];

  const result = await executeCampaign(spec, {
    cwd: root,
    harnessPath,
    maxRuns: 2,
    runOne: async (ctx) => {
      seen.push(ctx.scenario.name);
      seenHarnessPaths.push(ctx.harnessPath);
      seenRerunCommands.push(ctx.reproCommandOverride);
      return writeFakeArtifacts(ctx);
    }
  });

  assert.deepEqual(seen, result.plan.runs.map((run) => run.runId));
  assert.deepEqual(seenHarnessPaths, [harnessPath, harnessPath]);
  assert.ok(seenRerunCommands.every((command) => command?.includes("--harness .riptide/harness")));
  assert.ok(
    result.retentionManifest.entries
      .filter((entry) => entry.status === "selected")
      .every((entry) => entry.rerun_command.includes("--harness .riptide/harness"))
  );
  assert.equal(result.createdConfigs, 2);
  assert.equal(result.reusedConfigs, 0);
  assert.equal(result.runSummary.pass, 2);
  assert.equal(result.runSummary.error, 0);

  for (const run of result.plan.runs) {
    const configBytes = await readFile(run.runConfigPath, "utf8");
    assert.equal(configBytes, run.runConfigJson);
    const metadata = JSON.parse(
      await readFile(path.join(run.runDir, "metadata.json"), "utf8")
    ) as {
      run_id: string;
      status: string;
      config_status: string;
      simulation_result_path: string;
      invariant_fires: unknown[];
    };
    assert.equal(metadata.run_id, run.runId);
    assert.equal(metadata.status, "pass");
    assert.equal(metadata.config_status, "created");
    assert.deepEqual(metadata.invariant_fires, []);
    assert.equal(
      await readFile(path.join(run.runDir, "simulation-result.json"), "utf8"),
      JSON.stringify(baseSimulationResult(), null, 2) + "\n"
    );
    assert.match(metadata.simulation_result_path, /simulation-result\.json$/);
  }

  const lines = (await readFile(result.runsJsonlPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]!).status, "pass");
});

test("campaign run resume: records setup errors separately from invariant failures", async () => {
  const root = await campaignFixtureRoot("setup-error");
  const spec = parseCampaignToml(await readFile(path.join(root, "campaign.toml"), "utf8"), path.join(root, "campaign.toml"));

  const result = await executeCampaign(spec, {
    cwd: root,
    maxRuns: 2,
    runOne: async (ctx) => {
      if (resultRunIndex(ctx.scenario.runConfigPath) === 1) {
        return { kind: "error", wallClockS: 0, error: "adapter setup failed" };
      }
      return writeFakeArtifacts(ctx);
    }
  });

  assert.equal(result.runSummary.pass, 1);
  assert.equal(result.runSummary.fail, 0);
  assert.equal(result.runSummary.error, 1);
  const errored = result.records.find((record) => record.status === "error");
  assert.ok(errored);
  assert.equal(errored.setup_error, "adapter setup failed");
  assert.deepEqual(errored.invariant_fires, []);
});

test("campaign run resume: reuses byte-identical configs and fails mismatches", async () => {
  const root = await campaignFixtureRoot("resume");
  const spec = parseCampaignToml(await readFile(path.join(root, "campaign.toml"), "utf8"), path.join(root, "campaign.toml"));

  const first = await executeCampaign(spec, {
    cwd: root,
    maxRuns: 1,
    runOne: writeFakeArtifacts
  });
  assert.equal(first.records[0]?.config_status, "created");

  const second = await executeCampaign(spec, {
    cwd: root,
    maxRuns: 1,
    runOne: writeFakeArtifacts
  });
  assert.equal(second.createdConfigs, 0);
  assert.equal(second.reusedConfigs, 1);
  assert.equal(second.records[0]?.config_status, "reused");

  await writeFile(first.plan.runs[0]!.runConfigPath, "{}\n", "utf8");
  await assert.rejects(
    executeCampaign(spec, {
      cwd: root,
      maxRuns: 1,
      runOne: writeFakeArtifacts
    }),
    (err: unknown) =>
      err instanceof CampaignResumeSafetyError &&
      /existing generated run config/.test(err.message)
  );
});

async function writeFakeArtifacts(ctx: RunOneContext): Promise<RunOneResult> {
  const artifactsDir = resolveArtifactsDir(ctx);
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(
    path.join(artifactsDir, "simulation-result.json"),
    JSON.stringify(baseSimulationResult(), null, 2) + "\n",
    "utf8"
  );
  await writeFile(path.join(artifactsDir, "report.md"), "# Report\n", "utf8");
  return {
    kind: "pass",
    wallClockS: 0.01,
    artifactsDir,
    result: baseSimulationResult()
  };
}

function baseSimulationResult(): SimulationResult {
  return {
    run_config: {
      agents: 1,
      ticks: 4,
      scenario: "unit",
      seed: 1,
      personas: ["whale"],
      validator_url: "unused",
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
        persona_id: "whale",
        persona_label: "Whale",
        action: "deposit",
        params: { amount: 1 },
        outcome: "success"
      }
    ],
    agents: [
      {
        agent_id: "agent-001",
        persona_id: "whale",
        persona_label: "Whale",
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
}

async function campaignFixtureRoot(label: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `riptide-campaign-${label}-`));
  await mkdir(path.join(root, "fixtures", "adapters"), { recursive: true });
  await mkdir(path.join(root, "fixtures", "personas"), { recursive: true });
  await mkdir(path.join(root, "fixtures", "scenarios", "lending", "oracle-lag-baseline"), {
    recursive: true
  });
  await writeFile(path.join(root, "fixtures", "adapters", "lending.toml"), "", "utf8");
  await writeFile(path.join(root, "fixtures", "personas", "whale.toml"), "", "utf8");
  await writeFile(
    path.join(root, "fixtures", "scenarios", "lending", "oracle-lag-baseline", "run-config.json"),
    JSON.stringify(
      {
        agents: 1,
        ticks: 4,
        scenario: "price-shock",
        personas: ["whale"],
        validator_url: "unused",
        output_path: "template-output"
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(path.join(root, "campaign.toml"), campaignToml(), "utf8");
  return root;
}

function campaignToml(): string {
  return `
[campaign]
name = "unit-campaign"
adapter = "fixtures/adapters/lending.toml"
class = "lending.v1"
risk_objective = "liquidation-safety"
run_budget = 3
seed_policy = "fixed:20260426"
replay_retention = ["first_failure", "median"]

[campaign.scenarios]
selection = "weighted"
families = ["oracle_shock"]

[campaign.scenarios.oracle_shock]
source = "fixtures/scenarios/lending/oracle-lag-baseline"
weight = 1
parameters = ["shock_profile"]

[campaign.personas]
base = "fixtures/personas"
families = ["retail_borrowers"]

[campaign.personas.retail_borrowers]
source = "whale.toml"
count = "borrower_count"

[campaign.parameters.shock_profile]
distribution = "fixed"
value = "price-shock"

[campaign.parameters.borrower_count]
distribution = "fixed"
value = 1
`;
}

function resultRunIndex(runConfigPath: string): number {
  const runDir = path.basename(path.dirname(runConfigPath));
  const match = /^run_(\d{6})_/.exec(runDir);
  return match ? Number(match[1]) : -1;
}
