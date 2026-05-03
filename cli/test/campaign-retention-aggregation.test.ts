import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  executeCampaign,
  parseCampaignToml
} from "../src/campaign/index.js";
import type { SimulationResult } from "../src/compiler/schema.js";
import {
  resolveArtifactsDir,
  type RunOneContext,
  type RunOneResult
} from "../src/run/loop.js";

test("campaign retention aggregation: writes summaries and selects retained labels deterministically", async () => {
  const root = await campaignFixtureRoot("aggregation");
  const spec = parseCampaignToml(
    await readFile(path.join(root, "campaign.toml"), "utf8"),
    path.join(root, "campaign.toml")
  );

  const result = await executeCampaign(spec, {
    cwd: root,
    maxRuns: 5,
    runOne: async (ctx) => {
      const index = resultRunIndex(ctx.scenario.runConfigPath);
      if (index === 4) {
        return { kind: "error", wallClockS: 0, error: "adapter setup failed" };
      }
      if (index === 1) {
        const simulation = simulationResult(index, {
          totalBadDebt: 100,
          maxUtilization: 1.1,
          minTvl: 900
        });
        const artifactsDir = await writeArtifacts(ctx, simulation);
        return {
          kind: "fail",
          wallClockS: 0.01,
          artifactsDir,
          result: simulation,
          fires: [{ name: "bad_debt_bound", tick: 2 }]
        };
      }
      const metrics = index === 0
        ? { totalBadDebt: 1200, maxUtilization: 2, minTvl: 700 }
        : index === 2
          ? { totalBadDebt: 1200, maxUtilization: 5, minTvl: 300 }
          : { totalBadDebt: 0, maxUtilization: 3, minTvl: 600 };
      const simulation = simulationResult(index, metrics);
      const artifactsDir = await writeArtifacts(ctx, simulation);
      return { kind: "pass", wallClockS: 0.01, artifactsDir, result: simulation };
    }
  });

  const summary = JSON.parse(
    await readFile(result.artifactPaths.summaryJsonPath, "utf8")
  ) as {
    totals: {
      completed_runs: number;
      invariant_failed_runs: number;
      setup_errors: number;
    };
    campaign: { output_dir: string };
    artifacts: Record<string, string>;
    first_failure_ticks: { min: number | null };
    lending: { total_bad_debt: { max: number | null } } | null;
  };
  assert.equal(summary.totals.completed_runs, 4);
  assert.equal(summary.totals.invariant_failed_runs, 1);
  assert.equal(summary.totals.setup_errors, 1);
  assert.match(summary.campaign.output_dir, /^\.riptide\/campaigns\/campaign_[a-f0-9]{12}$/);
  assert.deepEqual(summary.artifacts, {
    runs_jsonl: "runs.jsonl",
    parameters_csv: "parameters.csv",
    retention_manifest: "retention-manifest.json",
    markdown_summary: "campaign-summary.md"
  });
  assert.equal(summary.first_failure_ticks.min, 2);
  assert.equal(summary.lending?.total_bad_debt.max, 1200);

  const manifest = JSON.parse(
    await readFile(result.artifactPaths.retentionManifestPath, "utf8")
  ) as {
    entries: Array<{
      label: string;
      status: "selected" | "warning";
      run_index?: number;
      reason?: string;
      tie_breaker?: string | null;
      case_digest?: string;
      risk_signals?: { total_bad_debt?: number | null; max_utilization?: number | null };
      paths?: { case_manifest?: string; rerun_sh?: string };
      warning?: string;
    }>;
  };
  const byLabel = new Map(manifest.entries.map((entry) => [entry.label, entry]));
  assert.equal(byLabel.get("first_failure")?.run_index, 1);
  assert.equal(byLabel.get("worst_bad_debt")?.run_index, 0, "bad-debt ties use lower run index");
  assert.equal(byLabel.get("worst_liquidity")?.run_index, 2);
  assert.equal(byLabel.get("median")?.status, "selected");
  assert.equal(byLabel.get("surprising_outlier")?.status, "selected");
  const badDebt = byLabel.get("worst_bad_debt")!;
  assert.match(badDebt.reason ?? "", /tie: 2 runs shared the same bad-debt score/);
  assert.equal(badDebt.tie_breaker, "2 runs shared the same bad-debt score; selected lowest run index 0");
  assert.equal(badDebt.risk_signals?.total_bad_debt, 1200);
  assert.match(badDebt.case_digest ?? "", /^[a-f0-9]{64}$/);
  const caseManifestPath = path.resolve(result.plan.campaignRoot, badDebt.paths?.case_manifest ?? "");
  const rerunPath = path.resolve(result.plan.campaignRoot, badDebt.paths?.rerun_sh ?? "");
  assert.match(await readFile(caseManifestPath, "utf8"), /campaign-retained-case\.v1/);
  assert.match(await readFile(rerunPath, "utf8"), /riptide run/);

  const csv = await readFile(result.artifactPaths.parametersCsvPath, "utf8");
  assert.match(csv.split("\n")[0]!, /total_bad_debt,max_utilization,min_tvl/);
  assert.match(csv.split("\n")[0]!, /shock_profile/);

  const markdown = await readFile(result.artifactPaths.summaryMarkdownPath, "utf8");
  assert.match(markdown, /observations within this campaign/i);
  assert.match(markdown, /Key Risk Signal/);
  assert.match(markdown, /Retained case `worst_bad_debt`/);
  assert.doesNotMatch(markdown, /protocol is safe/i);

  const combined = [
    await readFile(result.artifactPaths.summaryJsonPath, "utf8"),
    await readFile(result.artifactPaths.summaryMarkdownPath, "utf8"),
    await readFile(result.artifactPaths.parametersCsvPath, "utf8"),
    await readFile(result.artifactPaths.retentionManifestPath, "utf8"),
    await readFile(result.runsJsonlPath, "utf8")
  ].join("\n");
  assert.doesNotMatch(combined, /\[object Object\]/);
});

test("campaign retention aggregation: unsupported or absent labels warn without failing", async () => {
  const root = await campaignFixtureRoot("unsupported", {
    semanticClass: "amm.v1",
    replayRetention: ["worst_bad_debt", "worst_liquidity", "surprising_outlier"]
  });
  const spec = parseCampaignToml(
    await readFile(path.join(root, "campaign.toml"), "utf8"),
    path.join(root, "campaign.toml")
  );

  const result = await executeCampaign(spec, {
    cwd: root,
    maxRuns: 2,
    runOne: async (ctx) => {
      const simulation = simulationResult(resultRunIndex(ctx.scenario.runConfigPath), {
        totalBadDebt: 0,
        maxUtilization: 1,
        minTvl: 1000
      });
      const artifactsDir = await writeArtifacts(ctx, simulation);
      return { kind: "pass", wallClockS: 0.01, artifactsDir, result: simulation };
    }
  });

  assert.equal(result.runSummary.pass, 2);
  assert.equal(result.retentionManifest.warnings.length, 3);
  assert.match(result.retentionManifest.warnings.join("\n"), /unsupported for class amm\.v1/);
  assert.match(result.retentionManifest.warnings.join("\n"), /at least three completed runs/);
});

test("campaign retention aggregation: case digests are stable across output roots", async () => {
  const root = await campaignFixtureRoot("portable-digest");
  const spec = parseCampaignToml(
    await readFile(path.join(root, "campaign.toml"), "utf8"),
    path.join(root, "campaign.toml")
  );
  const runOne = async (ctx: RunOneContext): Promise<RunOneResult> => {
    const index = resultRunIndex(ctx.scenario.runConfigPath);
    const simulation = simulationResult(index, {
      totalBadDebt: index === 0 ? 1200 : 0,
      maxUtilization: index + 1,
      minTvl: 1000 - index
    });
    const artifactsDir = await writeArtifacts(ctx, simulation);
    return { kind: "pass", wallClockS: 0.01, artifactsDir, result: simulation };
  };

  const first = await executeCampaign(spec, {
    cwd: root,
    outputRoot: path.join(root, "out-a"),
    maxRuns: 5,
    runOne
  });
  const second = await executeCampaign(spec, {
    cwd: root,
    outputRoot: path.join(root, "out-b"),
    maxRuns: 5,
    runOne
  });

  const firstByLabel = selectedEntriesByLabel(first.retentionManifest);
  const secondByLabel = selectedEntriesByLabel(second.retentionManifest);
  assert.notEqual(
    firstByLabel.get("worst_bad_debt")?.rerun_command,
    secondByLabel.get("worst_bad_debt")?.rerun_command,
    "rerun commands remain output-root specific reviewer instructions"
  );
  for (const [label, firstEntry] of firstByLabel) {
    assert.equal(
      firstEntry.case_digest,
      secondByLabel.get(label)?.case_digest,
      `${label} digest should ignore output-root-specific commands`
    );
  }
});

async function writeArtifacts(
  ctx: RunOneContext,
  result: SimulationResult
): Promise<string> {
  const artifactsDir = resolveArtifactsDir(ctx);
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(
    path.join(artifactsDir, "simulation-result.json"),
    JSON.stringify(result, null, 2) + "\n",
    "utf8"
  );
  await writeFile(path.join(artifactsDir, "report.md"), "# Report\n", "utf8");
  return artifactsDir;
}

function simulationResult(
  index: number,
  metrics: { totalBadDebt: number; maxUtilization: number; minTvl: number }
): SimulationResult {
  return {
    run_config: {
      agents: 1,
      ticks: 4,
      scenario: "unit",
      seed: index + 1,
      personas: ["whale"],
      validator_url: "unused",
      output_path: ".riptide/runs/unit"
    },
    seed: index + 1,
    total_ticks: 4,
    timeseries: [
      {
        tick: 0,
        active_agents: 1,
        tvl: 1000,
        utilization: 0,
        cumulative_bad_debt: 0,
        cumulative_liquidations: 0
      },
      {
        tick: 4,
        active_agents: 1,
        tvl: metrics.minTvl,
        utilization: metrics.maxUtilization,
        cumulative_bad_debt: metrics.totalBadDebt,
        cumulative_liquidations: metrics.totalBadDebt > 0 ? 1 : 0
      }
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
        final_balance: 100,
        pnl: 0,
        total_actions: 1,
        triggers_activated: 0
      }
    ],
    summary: {
      agents_active: 1,
      agents_liquidated: 0,
      agents_depleted: 0,
      final_tvl: metrics.minTvl,
      final_utilization: metrics.maxUtilization,
      total_bad_debt: metrics.totalBadDebt,
      total_liquidations: metrics.totalBadDebt > 0 ? 1 : 0,
      invariants_fired: [
        { name: "bad_debt_bound", field: "bad_debt", op: "<=", value: 0, firings: 0 }
      ]
    },
    simulation_boundaries: ["unit test"]
  };
}

async function campaignFixtureRoot(
  label: string,
  options: { semanticClass?: string; replayRetention?: string[] } = {}
): Promise<string> {
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
  await writeFile(
    path.join(root, "campaign.toml"),
    campaignToml(options),
    "utf8"
  );
  return root;
}

function campaignToml(options: {
  semanticClass?: string;
  replayRetention?: string[];
} = {}): string {
  const semanticClass = options.semanticClass ?? "lending.v1";
  const replayRetention = options.replayRetention ?? [
    "first_failure",
    "worst_bad_debt",
    "worst_liquidity",
    "median",
    "surprising_outlier"
  ];
  return `
[campaign]
name = "unit-campaign"
adapter = "fixtures/adapters/lending.toml"
class = "${semanticClass}"
risk_objective = "liquidation-safety"
run_budget = 5
seed_policy = "fixed:20260426"
replay_retention = [${replayRetention.map((label) => `"${label}"`).join(", ")}]

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

function selectedEntriesByLabel(manifest: {
  entries: Array<{
    label: string;
    status: "selected" | "warning";
    case_digest?: string;
    rerun_command?: string;
  }>;
}): Map<string, { case_digest?: string; rerun_command?: string }> {
  return new Map(
    manifest.entries
      .filter((entry) => entry.status === "selected")
      .map((entry) => [entry.label, entry])
  );
}
