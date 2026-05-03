import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { monorepoRootFromModule } from "../orchestrator/index.js";
import {
  runScenarios,
  type RunEvent,
  type RunOneContext,
  type RunOneResult,
  type RunSummary
} from "../run/loop.js";
import type { ScenarioRecord } from "../run/last-run.js";

import {
  writeCampaignArtifacts,
  type CampaignArtifactPaths,
  type CampaignRetentionManifest,
  type CampaignSummaryJson
} from "./aggregation.js";
import {
  buildCampaignExpansion,
  type CampaignExpansionOptions,
  type CampaignExpansionPlan,
  type CampaignRunPlan
} from "./expansion.js";
import type { CampaignSpec, JsonScalar } from "./schema.js";

export interface ExecuteCampaignOptions extends CampaignExpansionOptions {
  silent?: boolean;
  harnessPath?: string;
  runOne?: (ctx: RunOneContext) => Promise<RunOneResult>;
  onRunEvent?: (event: RunEvent) => void;
}

export interface CampaignRunMetadata {
  schema_version: "campaign-run-metadata.v1";
  campaign_id: string;
  campaign_digest: string;
  campaign_name: string;
  class: string;
  risk_objective: string;
  run_id: string;
  run_index: number;
  run_seed: string;
  engine_seed: number;
  run_config_digest: string;
  run_config_path: string;
  scenario_family: string;
  scenario_source: string;
  sampled_parameters: Record<string, JsonScalar>;
  personas: CampaignRunPlan["personas"];
  config_status: "created" | "reused";
  status: "pass" | "fail" | "error" | "skipped";
  invariant_fires: ScenarioRecord["invariant_fires"];
  setup_error?: string;
  artifacts_dir?: string;
  simulation_result_path?: string;
  report_path?: string;
}

export interface CampaignRunRecord extends CampaignRunMetadata {
  metadata_path: string;
}

export interface CampaignExecutionResult {
  plan: CampaignExpansionPlan;
  records: CampaignRunRecord[];
  runSummary: RunSummary;
  runsJsonlPath: string;
  artifactPaths: CampaignArtifactPaths;
  campaignSummary: CampaignSummaryJson;
  retentionManifest: CampaignRetentionManifest;
  createdConfigs: number;
  reusedConfigs: number;
}

export class CampaignResumeSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignResumeSafetyError";
  }
}

export async function executeCampaign(
  spec: CampaignSpec,
  options: ExecuteCampaignOptions = {}
): Promise<CampaignExecutionResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const harnessPath = options.harnessPath ? path.resolve(cwd, options.harnessPath) : undefined;
  const plan = await buildCampaignExpansion(spec, { ...options, cwd });
  const materialized = await materializeGeneratedConfigs(plan);
  const generatedPolicies = await materializeGeneratedPolicySidecars(spec, plan);

  const scenarios = plan.runs.map((run) => {
    const sourcePoliciesPath = path.join(
      spec.scenarios.definitions[run.scenarioFamily]!.source.resolved,
      "policies.json"
    );
    return {
      name: run.runId,
      runConfigPath: run.runConfigPath,
      ...(generatedPolicies.has(run.runId)
        ? { policiesPathOverride: generatedPolicies.get(run.runId)! }
        : existsSync(sourcePoliciesPath)
          ? { policiesPathOverride: sourcePoliciesPath }
          : {}),
      packRunIdOverride: `${plan.campaignId}-${run.runId}`,
      reproCommandOverride: buildCampaignRerunCommand({
        cwd,
        runConfigPath: run.runConfigPath,
        adapterPath: spec.adapter.resolved,
        harnessPath
      })
    };
  });

  const runSummary = await runScenarios({
    scenarios,
    cwd,
    monorepoRoot: monorepoRootFromModule() ?? null,
    silent: options.silent !== false,
    outputDir: path.join(plan.campaignRoot, "runs"),
    selectedSourcePath: spec.filePath,
    harnessPath,
    runOne: options.runOne,
    onEvent: options.onRunEvent
  });

  const records = await writePerRunMetadata({
    spec,
    plan,
    runSummary,
    configStatuses: materialized.configStatuses,
    cwd
  });
  const runsJsonlPath = await writeRunsJsonl(plan.campaignRoot, records);
  const campaignArtifacts = await writeCampaignArtifacts({
    spec,
    plan,
    records,
    runSummary,
    runsJsonlPath,
    cwd,
    harnessPath
  });

  return {
    plan,
    records,
    runSummary,
    runsJsonlPath,
    artifactPaths: campaignArtifacts.paths,
    campaignSummary: campaignArtifacts.summary,
    retentionManifest: campaignArtifacts.retentionManifest,
    createdConfigs: materialized.created,
    reusedConfigs: materialized.reused
  };
}

async function materializeGeneratedConfigs(plan: CampaignExpansionPlan): Promise<{
  created: number;
  reused: number;
  configStatuses: Map<string, "created" | "reused">;
}> {
  await mkdir(plan.campaignRoot, { recursive: true });
  await writeDeterministicFile({
    path: path.join(plan.campaignRoot, "campaign-canonical.json"),
    expected: `${plan.canonicalCampaignJson}\n`,
    label: "campaign canonical JSON"
  });

  let created = 0;
  let reused = 0;
  const configStatuses = new Map<string, "created" | "reused">();

  for (const run of plan.runs) {
    await mkdir(run.runDir, { recursive: true });
    const status = await writeDeterministicFile({
      path: run.runConfigPath,
      expected: run.runConfigJson,
      label: `generated run config for ${run.runId}`
    });
    configStatuses.set(run.runId, status);
    if (status === "created") created += 1;
    else reused += 1;
  }

  return { created, reused, configStatuses };
}

async function materializeGeneratedPolicySidecars(
  spec: CampaignSpec,
  plan: CampaignExpansionPlan
): Promise<Map<string, string>> {
  const policiesByRunId = new Map<string, string>();
  for (const run of plan.runs) {
    const sourcePoliciesPath = path.join(
      spec.scenarios.definitions[run.scenarioFamily]!.source.resolved,
      "policies.json"
    );
    if (!existsSync(sourcePoliciesPath)) continue;
    const target = path.join(run.runDir, "policies.json");
    await writeDeterministicFile({
      path: target,
      expected: await readFile(sourcePoliciesPath, "utf8"),
      label: `generated policy sidecar for ${run.runId}`
    });
    policiesByRunId.set(run.runId, target);
  }
  return policiesByRunId;
}

async function writeDeterministicFile(input: {
  path: string;
  expected: string;
  label: string;
}): Promise<"created" | "reused"> {
  try {
    const existing = await readFile(input.path, "utf8");
    if (existing === input.expected) return "reused";
    throw new CampaignResumeSafetyError(
      `campaign resume safety failed: existing ${input.label} differs from deterministic expansion\n` +
        `  path: ${input.path}\n` +
        "  next: move or remove the existing campaign artifact only if you intend to regenerate it"
    );
  } catch (err) {
    if (err instanceof CampaignResumeSafetyError) throw err;
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      await writeFile(input.path, input.expected, "utf8");
      return "created";
    }
    throw err;
  }
}

async function writePerRunMetadata(input: {
  spec: CampaignSpec;
  plan: CampaignExpansionPlan;
  runSummary: RunSummary;
  configStatuses: Map<string, "created" | "reused">;
  cwd: string;
}): Promise<CampaignRunRecord[]> {
  const recordsByRunId = new Map(input.runSummary.scenarios.map((record) => [record.name, record]));
  const out: CampaignRunRecord[] = [];

  for (const run of input.plan.runs) {
    const scenarioRecord = recordsByRunId.get(run.runId);
    const metadata = buildRunMetadata({
      spec: input.spec,
      plan: input.plan,
      run,
      scenarioRecord,
      configStatus: input.configStatuses.get(run.runId) ?? "created",
      cwd: input.cwd
    });
    const metadataPath = path.join(run.runDir, "metadata.json");
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + "\n", "utf8");
    out.push({ ...metadata, metadata_path: metadataPath });
  }

  return out;
}

function buildRunMetadata(input: {
  spec: CampaignSpec;
  plan: CampaignExpansionPlan;
  run: CampaignRunPlan;
  scenarioRecord: ScenarioRecord | undefined;
  configStatus: "created" | "reused";
  cwd: string;
}): CampaignRunMetadata {
  const record = input.scenarioRecord;
  const artifactsDir = record?.artifacts_dir;
  return {
    schema_version: "campaign-run-metadata.v1",
    campaign_id: input.plan.campaignId,
    campaign_digest: input.plan.campaignDigest,
    campaign_name: input.spec.name,
    class: input.spec.semanticClass,
    risk_objective: input.spec.riskObjective,
    run_id: input.run.runId,
    run_index: input.run.runIndex,
    run_seed: input.run.runSeed,
    engine_seed: input.run.engineSeed,
    run_config_digest: input.run.runConfigDigest,
    run_config_path: relativizeIfInside(input.cwd, input.run.runConfigPath),
    scenario_family: input.run.scenarioFamily,
    scenario_source: input.run.scenarioSource,
    sampled_parameters: input.run.sampledParameters,
    personas: input.run.personas,
    config_status: input.configStatus,
    status: record?.status ?? "error",
    invariant_fires: record?.invariant_fires ?? [],
    ...(record?.status === "error" && record.error ? { setup_error: record.error } : {}),
    ...(artifactsDir ? { artifacts_dir: relativizeIfInside(input.cwd, artifactsDir) } : {}),
    ...(artifactsDir
      ? {
          simulation_result_path: path.join(
            relativizeIfInside(input.cwd, artifactsDir),
            "simulation-result.json"
          ),
          report_path: path.join(relativizeIfInside(input.cwd, artifactsDir), "report.md")
        }
      : {})
  };
}

async function writeRunsJsonl(
  campaignRoot: string,
  records: CampaignRunRecord[]
): Promise<string> {
  const runsJsonlPath = path.join(campaignRoot, "runs.jsonl");
  const lines = records.map((record) => JSON.stringify(record));
  await writeFile(runsJsonlPath, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
  return runsJsonlPath;
}

function relativizeIfInside(cwd: string, value: string): string {
  const abs = path.resolve(cwd, value);
  const rel = path.relative(cwd, abs);
  if (rel === "") return ".";
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
  return value;
}

function buildCampaignRerunCommand(input: {
  cwd: string;
  runConfigPath: string;
  adapterPath: string;
  harnessPath?: string;
}): string {
  const runConfig = relativizeIfInside(input.cwd, input.runConfigPath);
  const adapter = relativizeIfInside(input.cwd, input.adapterPath);
  const command = [
    "exec",
    "riptide",
    "run",
    posixQuote(runConfig),
    "--adapter",
    posixQuote(adapter)
  ];
  if (input.harnessPath) {
    command.push("--harness", posixQuote(relativizeIfInside(input.cwd, input.harnessPath)));
  }
  return command.join(" ");
}

function posixQuote(value: string): string {
  if (/^[-_./A-Za-z0-9]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
