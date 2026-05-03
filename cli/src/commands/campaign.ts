import path from "node:path";

import { Command } from "commander";

import {
  CampaignValidationError,
  buildCampaignExpansion,
  campaignIdentity,
  executeCampaign,
  readCampaignTomlFile,
  renderCampaignDiagnostics,
  type CampaignDiagnostic,
  type CampaignExecutionResult,
  type CampaignExpansionPlan,
  type CampaignSpec
} from "../campaign/index.js";
import { exitCodeFromSummary } from "../run/exit-codes.js";

export function createCampaignCommand(): Command {
  const command = new Command("campaign")
    .description(
      "Validate, plan, and run bounded local evidence campaigns. Campaigns report observations within declared inputs, not complete protocol safety."
    );

  command
    .command("validate")
    .description("Validate a Campaign TOML v1 file without executing simulations.")
    .argument("<campaign.toml>", "Campaign TOML file")
    .option("--json", "Emit a stable machine-readable validation result", false)
    .action(async (campaignPath: string, options: Record<string, unknown>) => {
      const json = Boolean(options.json);
      try {
        const spec = await readCampaignTomlFile(campaignPath);
        const identity = campaignIdentity(spec);
        if (json) {
          writeJson({
            ok: true,
            command: "campaign validate",
            campaign: campaignJson(spec, identity)
          });
          return;
        }
        process.stdout.write(renderValidationSuccess(spec, identity));
      } catch (err) {
        handleCampaignError(err, { json, setupExitCode: 2 });
      }
    });

  command
    .command("plan")
    .description(
      "Expand a campaign plan, showing deterministic run IDs and output paths without executing simulations."
    )
    .argument("<campaign.toml>", "Campaign TOML file")
    .option("--max-runs <n>", "Plan at most n generated runs without changing the campaign digest")
    .option("--out <dir>", "Artifact root directory (default: <cwd>/.riptide/campaigns)")
    .option("--json", "Emit a stable machine-readable plan summary", false)
    .action(async (campaignPath: string, options: Record<string, unknown>) => {
      const json = Boolean(options.json);
      try {
        const spec = await readCampaignTomlFile(campaignPath);
        const plan = await buildCampaignExpansion(spec, expansionOptions(options));
        if (json) {
          writeJson({
            ok: true,
            command: "campaign plan",
            campaign: campaignJson(spec, plan),
            plan: planJson(spec, plan)
          });
          return;
        }
        process.stdout.write(renderPlan(spec, plan));
      } catch (err) {
        handleCampaignError(err, { json, setupExitCode: 2 });
      }
    });

  command
    .command("run")
    .description(
      "Execute generated campaign runs sequentially through the existing riptide run path."
    )
    .argument("<campaign.toml>", "Campaign TOML file")
    .option("--max-runs <n>", "Execute at most n generated runs without changing the campaign digest")
    .option("--out <dir>", "Artifact root directory (default: <cwd>/.riptide/campaigns)")
    .option("--json", "Emit a stable machine-readable run summary", false)
    .action(async (campaignPath: string, options: Record<string, unknown>) => {
      const json = Boolean(options.json);
      try {
        const spec = await readCampaignTomlFile(campaignPath);
        const result = await executeCampaign(spec, {
          ...expansionOptions(options),
          silent: true
        });
        if (json) {
          writeJson({
            ok: true,
            command: "campaign run",
            campaign: campaignJson(spec, result.plan),
            run: runJson(result)
          });
          process.exitCode = exitCodeFromSummary(result.runSummary);
          return;
        }
        process.stdout.write(renderRun(result));
        process.exitCode = exitCodeFromSummary(result.runSummary);
      } catch (err) {
        handleCampaignError(err, { json, setupExitCode: 1 });
      }
    });

  return command;
}

function expansionOptions(options: Record<string, unknown>): {
  maxRuns?: number;
  outputRoot?: string;
} {
  const maxRuns = typeof options.maxRuns === "string"
    ? parsePositiveIntegerOption(options.maxRuns, "--max-runs")
    : undefined;
  const outputRoot =
    typeof options.out === "string" && options.out.length > 0
      ? path.resolve(options.out)
      : undefined;
  return {
    ...(maxRuns !== undefined ? { maxRuns } : {}),
    ...(outputRoot !== undefined ? { outputRoot } : {})
  };
}

function campaignJson(
  spec: CampaignSpec,
  identity: {
    campaignId: string;
    campaignDigest: string;
    campaignRoot?: string;
  }
): Record<string, unknown> {
  return {
    name: spec.name,
    class: spec.semanticClass,
    risk_objective: spec.riskObjective,
    run_budget: spec.runBudget,
    replay_retention: spec.replayRetention,
    campaign_id: identity.campaignId,
    campaign_digest: identity.campaignDigest,
    ...(identity.campaignRoot ? { output_dir: identity.campaignRoot } : {})
  };
}

function planJson(spec: CampaignSpec, plan: CampaignExpansionPlan): Record<string, unknown> {
  return {
    planned_runs: plan.runs.length,
    run_budget: spec.runBudget,
    output_dir: plan.campaignRoot,
    scenario_mix: scenarioMix(plan),
    retained_labels: spec.replayRetention,
    runs: plan.runs.map((run) => ({
      run_index: run.runIndex,
      run_id: run.runId,
      run_seed: run.runSeed,
      scenario_family: run.scenarioFamily,
      sampled_parameters: run.sampledParameters,
      run_config_digest: run.runConfigDigest,
      run_config_path: run.runConfigPath
    }))
  };
}

function runJson(result: CampaignExecutionResult): Record<string, unknown> {
  return {
    output_dir: result.plan.campaignRoot,
    requested_runs: result.plan.runs.length,
    completed_runs: result.runSummary.pass + result.runSummary.fail,
    invariant_failures: result.runSummary.fail,
    setup_errors: result.runSummary.error,
    skipped: result.runSummary.skipped,
    created_configs: result.createdConfigs,
    reused_configs: result.reusedConfigs,
    runs_jsonl_path: result.runsJsonlPath,
    campaign_summary_path: result.artifactPaths.summaryJsonPath,
    campaign_summary_markdown_path: result.artifactPaths.summaryMarkdownPath,
    parameters_csv_path: result.artifactPaths.parametersCsvPath,
    retention_manifest_path: result.artifactPaths.retentionManifestPath,
    runs: result.records.map((record) => ({
      run_index: record.run_index,
      run_id: record.run_id,
      run_seed: record.run_seed,
      scenario_family: record.scenario_family,
      sampled_parameters: record.sampled_parameters,
      status: record.status,
      run_config_digest: record.run_config_digest,
      run_config_path: record.run_config_path
    })),
    retained_labels: result.retentionManifest.entries,
    last_run_path: result.runSummary.lastRunPath,
    run_collection_path: result.runSummary.runCollectionPath,
    records: result.records
  };
}

function renderValidationSuccess(
  spec: CampaignSpec,
  identity: { campaignId: string; campaignDigest: string }
): string {
  return [
    `campaign valid: ${spec.name}`,
    `  class: ${spec.semanticClass}`,
    `  objective: ${spec.riskObjective}`,
    `  run budget: ${spec.runBudget}`,
    `  campaign id: ${identity.campaignId}`,
    `  campaign digest: ${identity.campaignDigest}`,
    ""
  ].join("\n");
}

function renderPlan(spec: CampaignSpec, plan: CampaignExpansionPlan): string {
  const mix = scenarioMix(plan);
  const lines = [
    `campaign plan: ${spec.name}`,
    `  class: ${spec.semanticClass}`,
    `  objective: ${spec.riskObjective}`,
    `  campaign id: ${plan.campaignId}`,
    `  campaign digest: ${plan.campaignDigest}`,
    `  run budget: ${spec.runBudget}`,
    `  planned runs: ${plan.runs.length}`,
    `  output dir: ${plan.campaignRoot}`,
    `  retained labels: ${spec.replayRetention.join(", ")}`,
    "  scenario mix:"
  ];
  for (const [family, count] of Object.entries(mix)) {
    lines.push(`    ${family}: ${count}`);
  }
  lines.push("  planned run coordinates:");
  for (const run of plan.runs) {
    lines.push(
      `    ${run.runId}: seed=${run.runSeed} family=${run.scenarioFamily} ` +
        `params=${formatSampledParameters(run.sampledParameters)}`
    );
  }
  lines.push("  simulations executed: 0");
  lines.push("  claim boundary: planned observations are scoped to this campaign's declared inputs.");
  lines.push("");
  return lines.join("\n");
}

function renderRun(result: CampaignExecutionResult): string {
  const completed = result.runSummary.pass + result.runSummary.fail;
  const retainedLabels = result.retentionManifest.entries
    .map((entry) =>
      entry.status === "selected"
        ? `${entry.label}=${entry.run_id}`
        : `${entry.label}=warning`
    )
    .join(", ");
  return [
    `campaign run: ${result.campaignSummary.campaign.name}`,
    `  class: ${result.campaignSummary.campaign.class}`,
    `  objective: ${result.campaignSummary.campaign.risk_objective}`,
    `  campaign id: ${result.plan.campaignId}`,
    `  campaign digest: ${result.plan.campaignDigest}`,
    `  requested runs: ${result.plan.runs.length}`,
    `  completed runs: ${completed}`,
    `  invariant failures: ${result.runSummary.fail}`,
    `  setup errors: ${result.runSummary.error}`,
    `  skipped: ${result.runSummary.skipped}`,
    `  risk signals: ${campaignRiskLine(result)}`,
    `  generated configs: ${result.createdConfigs} created, ${result.reusedConfigs} reused`,
    `  retained labels: ${retainedLabels || "(none)"}`,
    `  output dir: ${result.plan.campaignRoot}`,
    `  runs log: ${result.runsJsonlPath}`,
    `  summary: ${result.artifactPaths.summaryMarkdownPath}`,
    `  retention manifest: ${result.artifactPaths.retentionManifestPath}`,
    "  claim boundary: no invariant violation observed means no violation observed in this campaign, not proof of complete safety.",
    ""
  ].join("\n");
}

function campaignRiskLine(result: CampaignExecutionResult): string {
  const lending = result.campaignSummary.lending;
  if (!lending) return "not available for this campaign class";
  return [
    `bad debt max=${formatRiskValue(lending.total_bad_debt.max)}`,
    `liquidations max=${formatRiskValue(lending.total_liquidations.max)}`,
    `max utilization=${formatRiskValue(lending.liquidity_stress.max_utilization_observed)}`
  ].join(", ");
}

function formatRiskValue(value: number | null): string {
  return value === null ? "n/a" : String(Math.round(value * 1_000_000) / 1_000_000);
}

function scenarioMix(plan: CampaignExpansionPlan): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const run of plan.runs) {
    counts[run.scenarioFamily] = (counts[run.scenarioFamily] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function formatSampledParameters(parameters: Record<string, unknown>): string {
  const entries = Object.entries(parameters);
  if (entries.length === 0) return "(none)";
  return entries
    .map(([key, value]) => `${key}=${formatParameterValue(value)}`)
    .join(", ");
}

function formatParameterValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function handleCampaignError(
  err: unknown,
  options: { json: boolean; setupExitCode: number }
): void {
  if (options.json) {
    writeJson(errorJson(err));
  } else if (err instanceof CampaignValidationError) {
    process.stderr.write(renderCampaignDiagnostics(err.filePath, err.diagnostics) + "\n");
  } else {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
  }
  process.exitCode = err instanceof CampaignValidationError ? 2 : options.setupExitCode;
}

function errorJson(err: unknown): Record<string, unknown> {
  if (err instanceof CampaignValidationError) {
    return {
      ok: false,
      error: "campaign validation failed",
      path: err.filePath,
      diagnostics: diagnosticsJson(err.diagnostics)
    };
  }
  return {
    ok: false,
    error: err instanceof Error ? err.message : String(err)
  };
}

function diagnosticsJson(diagnostics: CampaignDiagnostic[]): Record<string, string>[] {
  return diagnostics.map((diagnostic) => ({
    path: diagnostic.path,
    message: diagnostic.message
  }));
}

function writeJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function parsePositiveIntegerOption(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}
