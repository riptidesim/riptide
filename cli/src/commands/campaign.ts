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
import {
  pickColorizer,
  shouldUseColor,
  type Colorizer
} from "../display/index.js";
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
    .option(
      "--harness <path>",
      "Run every generated campaign scenario through this Rust harness crate or Cargo.toml"
    )
    .option(
      "--serve",
      "Reserved for a future campaign dashboard. Campaign runs currently write reviewable artifacts; use `riptide review <campaign-root>` after the run.",
      false
    )
    .option("--json", "Emit a stable machine-readable run summary", false)
    .action(async (campaignPath: string, options: Record<string, unknown>) => {
      const json = Boolean(options.json);
      if (Boolean(options.serve)) {
        const message =
          "riptide campaign run --serve is not supported yet. Run the campaign without --serve, then inspect the output with `riptide review <campaign-root>`. For the scenario dashboard, use `riptide run --serve`.";
        if (json) {
          writeJson({ ok: false, error: message });
        } else {
          process.stderr.write(`${message}\n`);
        }
        process.exitCode = 2;
        return;
      }
      try {
        const spec = await readCampaignTomlFile(campaignPath);
        const result = await executeCampaign(spec, {
          ...expansionOptions(options),
          ...campaignRunOptions(options),
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

function campaignRunOptions(options: Record<string, unknown>): {
  harnessPath?: string;
} {
  const harnessPath =
    typeof options.harness === "string" && options.harness.length > 0
      ? path.resolve(options.harness)
      : undefined;
  return {
    ...(harnessPath !== undefined ? { harnessPath } : {})
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

export interface RenderRunOptions {
  color?: boolean;
}

export function renderRun(result: CampaignExecutionResult, options: RenderRunOptions = {}): string {
  const c = pickColorizer(
    options.color ?? shouldUseColor(process.env, Boolean(process.stdout.isTTY))
  );
  const campaignRoot = campaignRootDisplayPath(result);
  const warningLabels = retentionWarningLabels(result);
  const lines = [
    `${campaignRunTitle(result, c)}: ${c.cyan(result.campaignSummary.campaign.name)}`,
    "",
    c.bold("Result"),
    `  Outcome: ${campaignOutcomeLine(result, c)}`,
    `  Runs: ${campaignRunsLine(result)}`,
    `  Risk signals: ${campaignRiskLine(result)}`,
    `  Coverage: ${campaignCoverageLine(result, c)}`,
    "",
    c.bold("Workload"),
    `  Size: ${campaignWorkloadLine(result)}`,
    `  Simulation time: ${formatDuration(simulationTimeSeconds(result))}`,
    `  Configs: ${campaignConfigsLine(result)}`,
    "",
    c.bold("Next"),
    `  ${c.cyan(`riptide review ${shellQuotePath(campaignRoot)}`)}`,
    "",
    c.bold("Evidence"),
    `  Summary: ${c.cyan(artifactDisplayPath(result, "markdown_summary"))}`,
    `  Artifacts: ${c.cyan(campaignRoot)}`,
    `  Retained cases: ${retainedSelectionLine(result, c)}`
  ];
  if (warningLabels) {
    lines.push(`  Retention warnings: ${c.yellow(warningLabels)}`);
  }
  lines.push(
    "",
    c.bold("Details"),
    c.dim(`  Objective: ${result.campaignSummary.campaign.risk_objective} (${result.campaignSummary.campaign.class})`),
    c.dim(`  Campaign ID: ${result.plan.campaignId}`),
    c.dim(`  Digest: ${compactDigest(result.plan.campaignDigest)}`),
    "",
    c.bold("Boundary"),
    c.dim("  No invariant violation observed means none was observed in this campaign, not proof of complete safety."),
    ""
  );
  return lines.join("\n");
}

function campaignRiskLine(result: CampaignExecutionResult): string {
  const lending = result.campaignSummary.lending;
  if (!lending) return `not available for ${result.campaignSummary.campaign.class}`;
  const signals: string[] = [];
  if (lending.total_bad_debt.max !== null) {
    signals.push(`bad debt max=${formatRiskValue(lending.total_bad_debt.max)}`);
  }
  if (lending.total_liquidations.max !== null) {
    signals.push(`liquidations max=${formatRiskValue(lending.total_liquidations.max)}`);
  }
  if (lending.liquidity_stress.max_utilization_observed !== null) {
    signals.push(
      `max utilization=${formatRiskValue(lending.liquidity_stress.max_utilization_observed)}`
    );
  }
  return signals.length > 0 ? signals.join(", ") : "no lending risk metrics reported";
}

function formatRiskValue(value: number | null): string {
  return value === null ? "n/a" : String(Math.round(value * 1_000_000) / 1_000_000);
}

function campaignRunTitle(result: CampaignExecutionResult, c: Colorizer): string {
  if (result.runSummary.error > 0) return c.yellow("Campaign finished");
  if (result.runSummary.fail > 0) return c.red("Campaign finished");
  return c.green("Campaign complete");
}

function campaignOutcomeLine(result: CampaignExecutionResult, c: Colorizer): string {
  const invariantText = result.runSummary.fail === 0
    ? c.green("no invariant failures observed")
    : c.red(`${formatCount(result.runSummary.fail, "invariant failure")} observed`);
  const setupText = result.runSummary.error === 0
    ? c.green("no setup errors")
    : c.yellow(formatCount(result.runSummary.error, "setup error"));
  return `${invariantText}, ${setupText}`;
}

function campaignRunsLine(result: CampaignExecutionResult): string {
  const completed = result.runSummary.pass + result.runSummary.fail;
  return [
    `${completed}/${result.plan.runs.length} completed`,
    formatCount(result.runSummary.error, "setup error"),
    formatCount(result.runSummary.skipped, "skipped run")
  ].join(", ");
}

function campaignCoverageLine(result: CampaignExecutionResult, c: Colorizer): string {
  const interpretations = result.runSummary.scenarios
    .map((scenario) => scenario.interpretation)
    .filter((interpretation) => interpretation !== undefined);
  if (interpretations.length === 0) return c.dim("not classified");
  const coverageCounts = countStrings(
    interpretations.map((interpretation) => interpretation.coverage)
  );
  const confidenceCounts = countStrings(
    interpretations.map((interpretation) => interpretation.confidence)
  );
  const coverage = formatCountMap(coverageCounts);
  const confidence = formatCountMap(confidenceCounts);
  const text = `${coverage}; confidence ${confidence}`;
  return coverageCounts.partial || coverageCounts.none || confidenceCounts.low
    ? c.yellow(text)
    : c.green(text);
}

function campaignWorkloadLine(result: CampaignExecutionResult): string {
  const workload = new Map<string, { count: number; family: string; agents: number | null; ticks: number | null }>();
  for (const run of result.plan.runs) {
    const config = jsonObject(run.runConfig);
    const agents = numberValue(config?.agents);
    const ticks = numberValue(config?.ticks);
    const key = `${run.scenarioFamily}\0${agents ?? "?"}\0${ticks ?? "?"}`;
    const existing = workload.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      workload.set(key, { count: 1, family: run.scenarioFamily, agents, ticks });
    }
  }
  if (workload.size === 0) return `${result.plan.runs.length} runs`;
  return [...workload.values()]
    .sort((left, right) => left.family.localeCompare(right.family))
    .map((entry) =>
      `${entry.count}x ${entry.family} (${formatUnitCount(entry.agents, "agent")} x ${formatUnitCount(entry.ticks, "tick")})`
    )
    .join(", ");
}

function campaignConfigsLine(result: CampaignExecutionResult): string {
  const base = `${result.createdConfigs} created, ${result.reusedConfigs} reused`;
  return result.reusedConfigs > 0
    ? `${base} (configs reused; simulations still executed)`
    : base;
}

function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function retainedSelectionLine(result: CampaignExecutionResult, c: Colorizer): string {
  const selected = result.retentionManifest.entries.filter((entry) => entry.status === "selected");
  if (selected.length === 0) return "(none selected)";
  return selected.map((entry) => `${entry.label} -> ${c.cyan(entry.run_id)}`).join(", ");
}

function retentionWarningLabels(result: CampaignExecutionResult): string {
  return result.retentionManifest.entries
    .filter((entry) => entry.status === "warning")
    .map((entry) => entry.label)
    .join(", ");
}

function campaignRootDisplayPath(result: CampaignExecutionResult): string {
  return result.campaignSummary.campaign.output_dir || displayPath(result.plan.campaignRoot);
}

function artifactDisplayPath(
  result: CampaignExecutionResult,
  artifact: keyof CampaignExecutionResult["campaignSummary"]["artifacts"]
): string {
  const artifactPath = result.campaignSummary.artifacts[artifact];
  if (path.isAbsolute(artifactPath)) return artifactPath;
  const root = campaignRootDisplayPath(result);
  return root === "." ? artifactPath : path.join(root, artifactPath);
}

function displayPath(filePath: string): string {
  const relative = path.relative(process.cwd(), filePath);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
  return filePath;
}

function shellQuotePath(filePath: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(filePath)) return filePath;
  return `'${filePath.replace(/'/g, "'\\''")}'`;
}

function compactDigest(digest: string): string {
  return digest.length <= 24 ? digest : `${digest.slice(0, 12)}...${digest.slice(-6)}`;
}

function simulationTimeSeconds(result: CampaignExecutionResult): number {
  return result.runSummary.scenarios.reduce(
    (total, scenario) => total + (typeof scenario.wall_clock_s === "number" ? scenario.wall_clock_s : 0),
    0
  );
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "unknown";
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 10) return `${Math.round(seconds * 100) / 100}s`;
  return `${Math.round(seconds)}s`;
}

function countStrings(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function formatCountMap(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, count]) => `${count} ${label}`)
    .join(", ");
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatUnitCount(value: number | null, singular: string): string {
  if (value === null) return `unknown ${singular}s`;
  return formatCount(value, singular);
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
