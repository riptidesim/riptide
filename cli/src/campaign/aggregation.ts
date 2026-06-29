import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SimulationResult } from "../compiler/schema.js";
import type { ExecutionHonestyReport } from "../sim/honesty-gates.js";
import { renderRiskSurfaceNarrative } from "../report/surface-narrative.js";
import type { RunSummary } from "../run/loop.js";
import type { ScenarioRecord } from "../run/last-run.js";
import { canonicalJson, sha256Hex, type JsonValue } from "../state-pack/json.js";

import {
  buildRiskSurfaceDocument,
  serializeRiskSurface,
  type RiskSurfaceDocument,
  type RiskSurfaceRunInput
} from "./surface.js";
import {
  RETENTION_LABELS,
  type CampaignSpec,
  type JsonScalar,
  type ParameterDistribution,
  type RetentionLabel,
  type SeedPolicy
} from "./schema.js";

// Campaign run/plan shapes consumed by the aggregation artifacts. These describe
// the deterministic expansion plan and the per-run metadata records the campaign
// aggregation reads when it writes summaries and retained-case evidence.
export interface PersonaRunSelection {
  family: string;
  source: string;
  countParameter: string;
  count: number;
  scaleDepositsBy: string;
  scaleDeposits: JsonScalar;
  scaleBorrowsBy: string;
  scaleBorrows: JsonScalar;
}

export interface CampaignRunPlan {
  runIndex: number;
  runId: string;
  runSeed: string;
  engineSeed: number;
  runConfigDigest: string;
  scenarioFamily: string;
  scenarioSource: string;
  sampledParameters: Record<string, JsonScalar>;
  personas: PersonaRunSelection[];
  runDir: string;
  runConfigPath: string;
  runConfig: JsonValue;
  runConfigJson: string;
}

export interface CampaignIdentity {
  canonicalCampaign: JsonValue;
  canonicalCampaignJson: string;
  campaignDigest: string;
  campaignId: string;
}

export interface CampaignExpansionPlan extends CampaignIdentity {
  campaignRoot: string;
  runs: CampaignRunPlan[];
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

export interface CampaignArtifactPaths {
  runsJsonlPath: string;
  summaryJsonPath: string;
  summaryMarkdownPath: string;
  parametersCsvPath: string;
  retentionManifestPath: string;
  /**
   * Additive (T02): the standalone, canonical-hashed `risk-surface.json`. It is
   * a NEW file. Summary/manifest JSON gain additive path references to it while
   * existing artifact fields keep their names and ordering.
   */
  riskSurfaceJsonPath: string;
}

export interface CampaignArtifactsResult {
  paths: CampaignArtifactPaths;
  summary: CampaignSummaryJson;
  retentionManifest: CampaignRetentionManifest;
  /** The emitted risk-surface document (additive, T02). */
  riskSurface: RiskSurfaceDocument;
}

export interface CampaignSummaryJson {
  schema_version: "campaign-summary.v1";
  campaign: {
    campaign_id: string;
    campaign_digest: string;
    name: string;
    class: string;
    risk_objective: string;
    run_budget: number;
    requested_runs: number;
    seed_policy: string;
    replay_retention: RetentionLabel[];
    adapter: string;
    output_dir: string;
  };
  artifacts: {
    runs_jsonl: string;
    parameters_csv: string;
    retention_manifest: string;
    markdown_summary: string;
    risk_surface: string;
  };
  totals: {
    requested_runs: number;
    completed_runs: number;
    passed_runs: number;
    invariant_failed_runs: number;
    setup_errors: number;
    skipped_runs: number;
    invariant_failure_rate: number;
  };
  first_failure_ticks: {
    count: number;
    min: number | null;
    median: number | null;
    max: number | null;
    distribution: Record<string, number>;
  };
  scenario_families: Record<string, CampaignScenarioFamilySummary>;
  parameters: Record<string, CampaignParameterSummary>;
  lending: CampaignLendingSummary | null;
  retention: {
    selected: CampaignRetentionSelection[];
    warnings: string[];
  };
  warnings: string[];
  claim_boundary: string;
  /**
   * Additive, optional: the distinct protocol flows a guided-sim sweep
   * exercised (e.g. `open_swap`, `liquidate_position`). Set only by the
   * guided-sim → cartography producer; absent for real `riptide campaign run`
   * summaries, so it never affects existing campaign artifacts. Surfaced in the
   * assessment scope so the report names the real flows under test.
   */
  guided_sim_flows?: string[];
  /**
   * Additive, optional: the execution-honesty gate report for a guided-sim
   * sweep (positive control / lifecycle-executed / determinism). Set only by the
   * guided-sim → cartography producer; absent for real `riptide campaign run`
   * summaries, so it never affects existing campaign artifacts. `riptide assess`
   * re-verifies it and blocks emit on a failed gate (guided-sim only).
   */
  execution_honesty?: ExecutionHonestyReport;
}

export interface CampaignScenarioFamilySummary {
  planned_runs: number;
  completed_runs: number;
  passed_runs: number;
  invariant_failed_runs: number;
  setup_errors: number;
  skipped_runs: number;
  first_failure_tick_min: number | null;
  total_bad_debt_max: number | null;
  max_utilization_observed: number | null;
  min_tvl_observed: number | null;
}

export interface CampaignParameterSummary {
  distribution: string;
  unit?: string;
  sampled_count: number;
  min: number | null;
  median: number | null;
  max: number | null;
  values: JsonScalar[];
}

export interface CampaignLendingSummary {
  observations_used: string[];
  completed_runs_with_metrics: number;
  total_bad_debt: {
    min: number | null;
    median: number | null;
    max: number | null;
  };
  total_liquidations: {
    min: number | null;
    median: number | null;
    max: number | null;
  };
  liquidity_stress: {
    min_tvl_observed: number | null;
    max_utilization_observed: number | null;
    min_available_liquidity_observed: number | null;
  };
  liquidation_safety_failures: {
    failed_runs: number;
    invariant_names: string[];
  };
}

export interface CampaignRetentionManifest {
  schema_version: "campaign-retention-manifest.v1";
  campaign_id: string;
  campaign_digest: string;
  campaign_name: string;
  class: string;
  risk_objective: string;
  requested_labels: RetentionLabel[];
  artifacts: {
    risk_surface: string;
  };
  entries: CampaignRetentionEntry[];
  warnings: string[];
}

export type CampaignRetentionEntry =
  | CampaignRetentionSelection
  | CampaignRetentionWarning;

export interface CampaignRetentionSelection {
  label: RetentionLabel;
  status: "selected";
  run_id: string;
  run_index: number;
  scenario_family: string;
  sampled_parameters: Record<string, JsonScalar>;
  reason: string;
  score: number | null;
  tie_breaker: string | null;
  risk_signals: CampaignRetentionRiskSignals;
  rerun_command: string;
  case_digest?: string;
  paths: {
    run_dir: string;
    run_config: string;
    metadata: string;
    case_dir: string;
    case_manifest: string;
    rerun_sh: string;
    simulation_result?: string;
    report?: string;
  };
}

export interface CampaignRetentionRiskSignals {
  status: CampaignRunRecord["status"];
  first_failure_tick: number | null;
  invariant_names: string[];
  semantic_signal_names: string[];
  total_bad_debt: number | null;
  total_liquidations: number | null;
  max_utilization: number | null;
  min_tvl: number | null;
  min_available_liquidity: number | null;
  risk_score: number;
}

export function canonicalRetainedCaseDigestPayload(
  caseRecord: Record<string, JsonValue>
): Record<string, JsonValue> {
  const {
    case_digest: _caseDigest,
    rerun_command: _rerunCommand,
    review_command: _reviewCommand,
    ...canonical
  } = caseRecord;
  return canonical;
}

export interface CampaignRetentionWarning {
  label: RetentionLabel;
  status: "warning";
  warning: string;
}

interface WriteCampaignArtifactsInput {
  spec: CampaignSpec;
  plan: CampaignExpansionPlan;
  records: CampaignRunRecord[];
  runSummary: RunSummary;
  runsJsonlPath: string;
  cwd: string;
  harnessPath?: string;
}

interface EnrichedRun {
  plan: CampaignRunPlan;
  record: CampaignRunRecord;
  metrics: CampaignRunMetrics;
  warnings: string[];
}

interface CampaignRunMetrics {
  completed: boolean;
  firstFailureTick: number | null;
  invariantFireCount: number;
  invariantNames: string[];
  semanticSignalNames: string[];
  totalBadDebt: number | null;
  totalLiquidations: number | null;
  finalTvl: number | null;
  minTvl: number | null;
  maxUtilization: number | null;
  minAvailableLiquidity: number | null;
  riskScore: number;
}

type JsonRecord = Record<string, unknown>;

export async function writeCampaignArtifacts(
  input: WriteCampaignArtifactsInput
): Promise<CampaignArtifactsResult> {
  await mkdir(input.plan.campaignRoot, { recursive: true });
  const enriched = await enrichRuns(input);
  const paths: CampaignArtifactPaths = {
    runsJsonlPath: input.runsJsonlPath,
    summaryJsonPath: path.join(input.plan.campaignRoot, "campaign-summary.json"),
    summaryMarkdownPath: path.join(input.plan.campaignRoot, "campaign-summary.md"),
    parametersCsvPath: path.join(input.plan.campaignRoot, "parameters.csv"),
    retentionManifestPath: path.join(input.plan.campaignRoot, "retention-manifest.json"),
    riskSurfaceJsonPath: path.join(input.plan.campaignRoot, "risk-surface.json")
  };
  const retentionManifest = buildRetentionManifest({
    spec: input.spec,
    plan: input.plan,
    enriched,
    paths,
    cwd: input.cwd,
    harnessPath: input.harnessPath
  });
  await writeRetainedCaseArtifacts({
    spec: input.spec,
    plan: input.plan,
    retentionManifest,
    cwd: input.cwd
  });
  const summary = buildCampaignSummary({
    spec: input.spec,
    plan: input.plan,
    runSummary: input.runSummary,
    enriched,
    retentionManifest,
    paths,
    cwd: input.cwd
  });

  const riskSurface = buildRiskSurfaceDocument({
    campaign: {
      campaignId: input.plan.campaignId,
      campaignDigest: input.plan.campaignDigest,
      name: input.spec.name,
      semanticClass: input.spec.semanticClass,
      riskObjective: input.spec.riskObjective,
      seedPolicyDisplay: seedPolicyDisplay(input.spec.seedPolicy),
      runBudget: input.spec.runBudget,
      requestedRuns: input.plan.runs.length
    },
    parameters: input.spec.parameters,
    runs: enriched.map(surfaceRunInput)
  });

  await writeFile(paths.parametersCsvPath, renderParametersCsv(input.spec, enriched), "utf8");
  await writeFile(
    paths.retentionManifestPath,
    JSON.stringify(retentionManifest, null, 2) + "\n",
    "utf8"
  );
  await writeFile(
    paths.summaryJsonPath,
    JSON.stringify(summary, null, 2) + "\n",
    "utf8"
  );
  await writeFile(
    paths.summaryMarkdownPath,
    renderCampaignSummaryMarkdown(summary, retentionManifest, riskSurface),
    "utf8"
  );
  await writeFile(paths.riskSurfaceJsonPath, serializeRiskSurface(riskSurface), "utf8");

  return { paths, summary, retentionManifest, riskSurface };
}

function surfaceRunInput(run: EnrichedRun): RiskSurfaceRunInput {
  return {
    runIndex: run.plan.runIndex,
    status: run.record.status,
    sampledParameters: run.plan.sampledParameters,
    badDebt: run.metrics.totalBadDebt,
    utilization: run.metrics.maxUtilization,
    tvl: run.metrics.minTvl,
    availableLiquidity: run.metrics.minAvailableLiquidity,
    riskScore: run.metrics.riskScore
  };
}

async function enrichRuns(input: WriteCampaignArtifactsInput): Promise<EnrichedRun[]> {
  const recordsByRunId = new Map(input.records.map((record) => [record.run_id, record]));
  const enriched: EnrichedRun[] = [];
  for (const run of input.plan.runs) {
    const record = recordsByRunId.get(run.runId);
    if (!record) {
      const synthetic = missingRecord(input, run);
      enriched.push({
        plan: run,
        record: synthetic,
        metrics: metricsForRecord(synthetic, null),
        warnings: [`missing per-run metadata for ${run.runId}`]
      });
      continue;
    }
    const read = await readSimulationResult(record, input.cwd);
    enriched.push({
      plan: run,
      record,
      metrics: metricsForRecord(record, read.result),
      warnings: read.warning ? [read.warning] : []
    });
  }
  return enriched;
}

function missingRecord(
  input: WriteCampaignArtifactsInput,
  run: CampaignRunPlan
): CampaignRunRecord {
  return {
    schema_version: "campaign-run-metadata.v1",
    campaign_id: input.plan.campaignId,
    campaign_digest: input.plan.campaignDigest,
    campaign_name: input.spec.name,
    class: input.spec.semanticClass,
    risk_objective: input.spec.riskObjective,
    run_id: run.runId,
    run_index: run.runIndex,
    run_seed: run.runSeed,
    engine_seed: run.engineSeed,
    run_config_digest: run.runConfigDigest,
    run_config_path: relativizeIfInside(input.cwd, run.runConfigPath),
    scenario_family: run.scenarioFamily,
    scenario_source: run.scenarioSource,
    sampled_parameters: run.sampledParameters,
    personas: run.personas,
    config_status: "created",
    status: "error",
    invariant_fires: [],
    setup_error: "campaign metadata was not written",
    metadata_path: path.join(run.runDir, "metadata.json")
  };
}

async function readSimulationResult(
  record: CampaignRunRecord,
  cwd: string
): Promise<{ result: SimulationResult | null; warning?: string }> {
  const candidate =
    record.simulation_result_path ??
    (record.artifacts_dir ? path.join(record.artifacts_dir, "simulation-result.json") : undefined);
  if (!candidate) return { result: null };
  const resolved = path.resolve(cwd, candidate);
  try {
    const raw = await readFile(resolved, "utf8");
    return { result: JSON.parse(raw) as SimulationResult };
  } catch (err) {
    return {
      result: null,
      warning: `could not read simulation result for ${record.run_id} at ${relativizeIfInside(cwd, resolved)}: ${errMessage(err)}`
    };
  }
}

function metricsForRecord(
  record: CampaignRunRecord,
  result: SimulationResult | null
): CampaignRunMetrics {
  const firstFailureTick = firstFailureTickFor(record, result);
  const invariantNames = invariantNamesFor(record, result);
  const semanticSignalNames = semanticSignalNamesFor(result);
  const invariantFireCount = invariantNames.length > 0
    ? Math.max(record.invariant_fires.length, invariantNames.length)
    : record.invariant_fires.length;
  const summary = asRecord(result?.summary);
  const timeseries = Array.isArray(result?.timeseries)
    ? result.timeseries
        .map((entry) => asRecord(entry))
        .filter((entry): entry is JsonRecord => entry !== null)
    : [];
  const totalBadDebt =
    numberField(summary, "total_bad_debt") ??
    maxNumericField(timeseries, "cumulative_bad_debt") ??
    maxNumericField(timeseries, "bad_debt");
  const totalLiquidations =
    numberField(summary, "total_liquidations") ??
    maxNumericField(timeseries, "cumulative_liquidations") ??
    maxNumericField(timeseries, "liquidations");
  const finalTvl =
    numberField(summary, "final_tvl") ??
    lastNumericField(timeseries, "tvl");
  const minTvl =
    minNumericField(timeseries, "tvl") ??
    finalTvl;
  const maxUtilization =
    maxNumericField(timeseries, "utilization") ??
    numberField(summary, "final_utilization");
  const minAvailableLiquidity =
    minNumericField(timeseries, "available_liquidity") ??
    minNumericField(timeseries, "liquidity");
  const completed = record.status === "pass" || record.status === "fail";
  return {
    completed,
    firstFailureTick,
    invariantFireCount,
    invariantNames,
    semanticSignalNames,
    totalBadDebt,
    totalLiquidations,
    finalTvl,
    minTvl,
    maxUtilization,
    minAvailableLiquidity,
    riskScore: riskScore({
      status: record.status,
      firstFailureTick,
      invariantFireCount,
      semanticSignalCount: semanticSignalNames.length,
      totalBadDebt,
      maxUtilization,
      minTvl,
      minAvailableLiquidity
    })
  };
}

function firstFailureTickFor(
  record: CampaignRunRecord,
  result: SimulationResult | null
): number | null {
  const ticks = record.invariant_fires
    .map((fire) => fire.tick)
    .filter((tick) => Number.isSafeInteger(tick) && tick >= 0);
  const summary = asRecord(result?.summary);
  for (const row of expressionInvariantRows(summary)) {
    const count = expressionInvariantFiringCount(row);
    const tick = expressionInvariantFirstTick(row);
    if (row.severity === "error" && count > 0 && tick !== null) {
      ticks.push(tick);
    }
  }
  if (ticks.length === 0) return null;
  return Math.min(...ticks);
}

function invariantNamesFor(
  record: CampaignRunRecord,
  result: SimulationResult | null
): string[] {
  const names = new Set<string>();
  for (const fire of record.invariant_fires) {
    if (fire.name.length > 0) names.add(fire.name);
  }
  const summary = asRecord(result?.summary);
  const rows = Array.isArray(summary?.invariants_fired) ? summary.invariants_fired : [];
  for (const row of rows) {
    const record = asRecord(row);
    if (!record) continue;
    const name = stringField(record, "name");
    const firings = numberField(record, "firings") ?? 0;
    if (name && firings > 0) names.add(name);
  }
  for (const row of expressionInvariantRows(summary)) {
    if (row.severity === "error" && expressionInvariantFiringCount(row) > 0) names.add(row.name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function semanticSignalNamesFor(result: SimulationResult | null): string[] {
  const names = new Set<string>();
  const summary = asRecord(result?.summary);
  for (const row of expressionInvariantRows(summary)) {
    if (row.severity === "warn" && expressionInvariantFiringCount(row) > 0) names.add(row.name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function riskScore(input: {
  status: CampaignRunRecord["status"];
  firstFailureTick: number | null;
  invariantFireCount: number;
  semanticSignalCount: number;
  totalBadDebt: number | null;
  maxUtilization: number | null;
  minTvl: number | null;
  minAvailableLiquidity: number | null;
}): number {
  const failurePenalty = input.status === "fail" ? 1_000_000 : 0;
  const badDebtScore = input.totalBadDebt ?? 0;
  const utilizationScore = (input.maxUtilization ?? 0) * 1_000;
  const invariantScore = input.invariantFireCount * 10_000;
  const semanticSignalScore = input.semanticSignalCount * 10_000;
  const earlyFailureScore =
    input.firstFailureTick === null ? 0 : 5_000 / Math.max(1, input.firstFailureTick + 1);
  const liquidityFloor = input.minAvailableLiquidity ?? input.minTvl;
  const liquidityScore = liquidityFloor === null ? 0 : 1_000 / Math.max(1, liquidityFloor);
  return roundNumber(
    failurePenalty +
      badDebtScore +
      utilizationScore +
      invariantScore +
      semanticSignalScore +
      earlyFailureScore +
      liquidityScore
  );
}

function buildRetentionManifest(input: {
  spec: CampaignSpec;
  plan: CampaignExpansionPlan;
  enriched: EnrichedRun[];
  paths: CampaignArtifactPaths;
  cwd: string;
  harnessPath?: string;
}): CampaignRetentionManifest {
  const requested = input.spec.replayRetention.length > 0
    ? input.spec.replayRetention
    : [...RETENTION_LABELS];
  const entries = requested.map((label) => selectRetentionLabel(label, input));
  const warnings = entries
    .filter((entry): entry is CampaignRetentionWarning => entry.status === "warning")
    .map((entry) => `${entry.label}: ${entry.warning}`);
  return {
    schema_version: "campaign-retention-manifest.v1",
    campaign_id: input.plan.campaignId,
    campaign_digest: input.plan.campaignDigest,
    campaign_name: input.spec.name,
    class: input.spec.semanticClass,
    risk_objective: input.spec.riskObjective,
    requested_labels: requested,
    artifacts: {
      risk_surface: relativizeIfInside(input.plan.campaignRoot, input.paths.riskSurfaceJsonPath)
    },
    entries,
    warnings
  };
}

function selectRetentionLabel(
  label: RetentionLabel,
  input: {
    spec: CampaignSpec;
    plan: CampaignExpansionPlan;
    enriched: EnrichedRun[];
    cwd: string;
    harnessPath?: string;
  }
): CampaignRetentionEntry {
  const completed = input.enriched.filter((run) => run.metrics.completed);
  if (label === "first_failure") {
    const candidates = completed
      .filter((run) => run.metrics.firstFailureTick !== null)
      .sort((a, b) =>
        compareNumbers(a.metrics.firstFailureTick!, b.metrics.firstFailureTick!) ||
        compareNumbers(a.plan.runIndex, b.plan.runIndex)
      );
    const selected = candidates[0];
    if (!selected) return warning(label, "no invariant failure tick was observed within this campaign");
    const tieBreaker = tieBreakerFor(
      candidates,
      selected,
      (run) => run.metrics.firstFailureTick,
      "the earliest failure tick"
    );
    return selection(
      label,
      selected,
      input.plan,
      input.cwd,
      input.harnessPath,
      withTie("earliest invariant failure tick observed within this campaign", tieBreaker),
      selected.metrics.firstFailureTick,
      tieBreaker
    );
  }

  if (label === "worst_bad_debt") {
    if (input.spec.semanticClass !== "lending.v1") {
      return warning(label, `unsupported for class ${input.spec.semanticClass}; bad-debt metrics are lending.v1-specific in v1`);
    }
    const candidates = completed
      .filter((run) => run.metrics.totalBadDebt !== null)
      .sort((a, b) =>
        compareNumbersDesc(a.metrics.totalBadDebt!, b.metrics.totalBadDebt!) ||
        compareNumbers(a.plan.runIndex, b.plan.runIndex)
      );
    const selected = candidates[0];
    if (!selected) return warning(label, "no completed run exposed a lending bad-debt metric");
    const tieBreaker = tieBreakerFor(
      candidates,
      selected,
      (run) => run.metrics.totalBadDebt,
      "the same bad-debt score"
    );
    return selection(
      label,
      selected,
      input.plan,
      input.cwd,
      input.harnessPath,
      withTie("highest lending bad debt observed within this campaign", tieBreaker),
      selected.metrics.totalBadDebt,
      tieBreaker
    );
  }

  if (label === "worst_liquidity") {
    if (input.spec.semanticClass !== "lending.v1") {
      return warning(label, `unsupported for class ${input.spec.semanticClass}; liquidity-stress metrics are lending.v1-specific in v1`);
    }
    const candidates = completed
      .filter((run) => run.metrics.maxUtilization !== null || run.metrics.minTvl !== null)
      .sort((a, b) =>
        compareNumbersDesc(a.metrics.maxUtilization ?? -Infinity, b.metrics.maxUtilization ?? -Infinity) ||
        compareNumbers(a.metrics.minTvl ?? Infinity, b.metrics.minTvl ?? Infinity) ||
        compareNumbers(a.plan.runIndex, b.plan.runIndex)
      );
    const selected = candidates[0];
    if (!selected) return warning(label, "no completed run exposed lending liquidity metrics");
    const tieBreaker = tieBreakerFor(
      candidates,
      selected,
      (run) => `${run.metrics.maxUtilization ?? ""}:${run.metrics.minTvl ?? ""}`,
      "the same utilization and TVL score"
    );
    return selection(
      label,
      selected,
      input.plan,
      input.cwd,
      input.harnessPath,
      withTie("highest utilization, then lowest TVL, observed within this campaign", tieBreaker),
      selected.metrics.maxUtilization ?? selected.metrics.minTvl,
      tieBreaker
    );
  }

  if (label === "median") {
    if (completed.length === 0) return warning(label, "no completed runs were available for median retention");
    const sorted = [...completed].sort((a, b) =>
      compareNumbers(a.metrics.riskScore, b.metrics.riskScore) ||
      compareNumbers(a.plan.runIndex, b.plan.runIndex)
    );
    const selected = sorted[Math.floor((sorted.length - 1) / 2)]!;
    const tieBreaker = tieBreakerFor(
      sorted,
      selected,
      (run) => run.metrics.riskScore,
      "the same deterministic risk score"
    );
    return selection(
      label,
      selected,
      input.plan,
      input.cwd,
      input.harnessPath,
      withTie("middle completed run by deterministic campaign risk score", tieBreaker),
      selected.metrics.riskScore,
      tieBreaker
    );
  }

  if (completed.length < 3) {
    return warning(label, "at least three completed runs are needed for the simple outlier heuristic");
  }
  const scores = completed.map((run) => run.metrics.riskScore).sort((a, b) => a - b);
  const median = medianNumber(scores) ?? 0;
  const distance = (run: EnrichedRun) => roundNumber(Math.abs(run.metrics.riskScore - median));
  const outlierCandidates = [...completed].sort((a, b) =>
    compareNumbersDesc(distance(a), distance(b)) ||
    compareNumbers(a.plan.runIndex, b.plan.runIndex)
  );
  const selected = outlierCandidates[0]!;
  const tieBreaker = tieBreakerFor(
    outlierCandidates,
    selected,
    distance,
    "the same distance from median risk score"
  );
  return selection(
    label,
    selected,
    input.plan,
    input.cwd,
    input.harnessPath,
    withTie("largest absolute distance from the median campaign risk score", tieBreaker),
    selected.metrics.riskScore,
    tieBreaker
  );
}

function selection(
  label: RetentionLabel,
  run: EnrichedRun,
  plan: CampaignExpansionPlan,
  cwd: string,
  harnessPath: string | undefined,
  reason: string,
  score: number | null,
  tieBreaker: string | null
): CampaignRetentionSelection {
  const caseDir = retainedCaseDir(plan.campaignRoot, label, run.record.run_id);
  return {
    label,
    status: "selected",
    run_id: run.record.run_id,
    run_index: run.record.run_index,
    scenario_family: run.record.scenario_family,
    sampled_parameters: run.plan.sampledParameters,
    reason,
    score: score === null ? null : roundNumber(score),
    tie_breaker: tieBreaker,
    risk_signals: riskSignalsFor(run),
    rerun_command: buildRetainedRerunCommand(cwd, run.record.run_config_path, harnessPath),
    paths: {
      run_dir: relativizeIfInside(plan.campaignRoot, run.plan.runDir),
      run_config: relativizeInsideCampaignRoot(plan, cwd, run.record.run_config_path),
      metadata: relativizeInsideCampaignRoot(plan, cwd, run.record.metadata_path),
      case_dir: relativizeIfInside(plan.campaignRoot, caseDir),
      case_manifest: relativizeIfInside(plan.campaignRoot, path.join(caseDir, "case.json")),
      rerun_sh: relativizeIfInside(plan.campaignRoot, path.join(caseDir, "rerun.sh")),
      ...(run.record.simulation_result_path
        ? { simulation_result: relativizeInsideCampaignRoot(plan, cwd, run.record.simulation_result_path) }
        : {}),
      ...(run.record.report_path
        ? { report: relativizeInsideCampaignRoot(plan, cwd, run.record.report_path) }
        : {})
    }
  };
}

function riskSignalsFor(run: EnrichedRun): CampaignRetentionRiskSignals {
  return {
    status: run.record.status,
    first_failure_tick: run.metrics.firstFailureTick,
    invariant_names: run.metrics.invariantNames,
    semantic_signal_names: run.metrics.semanticSignalNames,
    total_bad_debt: run.metrics.totalBadDebt,
    total_liquidations: run.metrics.totalLiquidations,
    max_utilization: run.metrics.maxUtilization,
    min_tvl: run.metrics.minTvl,
    min_available_liquidity: run.metrics.minAvailableLiquidity,
    risk_score: run.metrics.riskScore
  };
}

function tieBreakerFor<T>(
  candidates: EnrichedRun[],
  selected: EnrichedRun,
  valueFor: (run: EnrichedRun) => T,
  scoreLabel: string
): string | null {
  const selectedValue = valueFor(selected);
  const tied = candidates.filter((run) => valueFor(run) === selectedValue);
  if (tied.length <= 1) return null;
  return `${tied.length} runs shared ${scoreLabel}; selected lowest run index ${selected.plan.runIndex}`;
}

function withTie(reason: string, tieBreaker: string | null): string {
  return tieBreaker ? `${reason}; tie: ${tieBreaker}` : reason;
}

function retainedCaseDir(
  campaignRoot: string,
  label: RetentionLabel,
  runId: string
): string {
  return path.join(campaignRoot, "retained", `${label}-${runId}`);
}

function relativizeInsideCampaignRoot(
  plan: CampaignExpansionPlan,
  cwd: string,
  value: string
): string {
  return relativizeIfInside(plan.campaignRoot, path.resolve(cwd, value));
}

function buildRetainedRerunCommand(
  cwd: string,
  runConfigPath: string,
  harnessPath: string | undefined
): string {
  const command = ["exec", "riptide", "run", posixQuote(relativizeIfInside(cwd, runConfigPath))];
  if (harnessPath) {
    command.push("--harness", posixQuote(relativizeIfInside(cwd, harnessPath)));
  }
  return command.join(" ");
}

async function writeRetainedCaseArtifacts(input: {
  spec: CampaignSpec;
  plan: CampaignExpansionPlan;
  retentionManifest: CampaignRetentionManifest;
  cwd: string;
}): Promise<void> {
  for (const entry of input.retentionManifest.entries) {
    if (entry.status !== "selected") continue;
    const caseDir = retainedCaseDir(input.plan.campaignRoot, entry.label, entry.run_id);
    await mkdir(caseDir, { recursive: true });
    const caseRecordBase: Record<string, JsonValue> = {
      schema_version: "campaign-retained-case.v1",
      campaign_id: input.plan.campaignId,
      campaign_digest: input.plan.campaignDigest,
      campaign_name: input.spec.name,
      class: input.spec.semanticClass,
      risk_objective: input.spec.riskObjective,
      label: entry.label,
      run_id: entry.run_id,
      run_index: entry.run_index,
      scenario_family: entry.scenario_family,
      sampled_parameters: entry.sampled_parameters,
      reason: entry.reason,
      tie_breaker: entry.tie_breaker,
      score: entry.score,
      risk_signals: riskSignalsJson(entry.risk_signals),
      paths: pathsJson(entry.paths),
      rerun_command: entry.rerun_command,
      review_command: `riptide review ${posixQuote(relativizeIfInside(input.cwd, input.plan.campaignRoot))}`
    };
    const caseDigest = sha256Hex(
      `riptide-campaign-retained-case-v1\n${canonicalJson(
        canonicalRetainedCaseDigestPayload(caseRecordBase)
      )}`
    );
    entry.case_digest = caseDigest;
    const caseRecord: JsonValue = {
      ...caseRecordBase,
      case_digest: caseDigest
    };
    await writeFile(path.join(caseDir, "case.json"), canonicalJson(caseRecord), "utf8");
    await writeFile(
      path.join(caseDir, "rerun.sh"),
      renderRerunScript(input.cwd, entry.rerun_command),
      "utf8"
    );
    await chmod(path.join(caseDir, "rerun.sh"), 0o755);
  }
}

function renderRerunScript(cwd: string, command: string): string {
  return [
    "#!/usr/bin/env sh",
    "set -eu",
    `cd ${posixQuote(cwd)}`,
    command,
    ""
  ].join("\n");
}

function riskSignalsJson(signals: CampaignRetentionRiskSignals): JsonValue {
  return {
    status: signals.status,
    first_failure_tick: signals.first_failure_tick,
    invariant_names: signals.invariant_names,
    semantic_signal_names: signals.semantic_signal_names,
    total_bad_debt: signals.total_bad_debt,
    total_liquidations: signals.total_liquidations,
    max_utilization: signals.max_utilization,
    min_tvl: signals.min_tvl,
    min_available_liquidity: signals.min_available_liquidity,
    risk_score: signals.risk_score
  };
}

function pathsJson(paths: CampaignRetentionSelection["paths"]): JsonValue {
  const out: Record<string, JsonValue> = {
    run_dir: paths.run_dir,
    run_config: paths.run_config,
    metadata: paths.metadata,
    case_dir: paths.case_dir,
    case_manifest: paths.case_manifest,
    rerun_sh: paths.rerun_sh
  };
  if (paths.simulation_result !== undefined) out.simulation_result = paths.simulation_result;
  if (paths.report !== undefined) out.report = paths.report;
  return out;
}

function posixQuote(value: string): string {
  if (/^[-_./A-Za-z0-9]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function warning(label: RetentionLabel, message: string): CampaignRetentionWarning {
  return { label, status: "warning", warning: message };
}

function buildCampaignSummary(input: {
  spec: CampaignSpec;
  plan: CampaignExpansionPlan;
  runSummary: RunSummary;
  enriched: EnrichedRun[];
  retentionManifest: CampaignRetentionManifest;
  paths: CampaignArtifactPaths;
  cwd: string;
}): CampaignSummaryJson {
  const completedRuns = input.runSummary.pass + input.runSummary.fail;
  const retentionSelected = input.retentionManifest.entries.filter(
    (entry): entry is CampaignRetentionSelection => entry.status === "selected"
  );
  const artifactWarnings = input.enriched.flatMap((run) => run.warnings);
  const warnings = [...artifactWarnings, ...input.retentionManifest.warnings];
  return {
    schema_version: "campaign-summary.v1",
    campaign: {
      campaign_id: input.plan.campaignId,
      campaign_digest: input.plan.campaignDigest,
      name: input.spec.name,
      class: input.spec.semanticClass,
      risk_objective: input.spec.riskObjective,
      run_budget: input.spec.runBudget,
      requested_runs: input.plan.runs.length,
      seed_policy: seedPolicyDisplay(input.spec.seedPolicy),
      replay_retention: input.spec.replayRetention,
      adapter: input.spec.adapter.digestPath,
      output_dir: relativizeIfInside(input.cwd, input.plan.campaignRoot)
    },
    artifacts: {
      runs_jsonl: relativizeIfInside(input.plan.campaignRoot, input.paths.runsJsonlPath),
      parameters_csv: relativizeIfInside(input.plan.campaignRoot, input.paths.parametersCsvPath),
      retention_manifest: relativizeIfInside(input.plan.campaignRoot, input.paths.retentionManifestPath),
      markdown_summary: relativizeIfInside(input.plan.campaignRoot, input.paths.summaryMarkdownPath),
      risk_surface: relativizeIfInside(input.plan.campaignRoot, input.paths.riskSurfaceJsonPath)
    },
    totals: {
      requested_runs: input.plan.runs.length,
      completed_runs: completedRuns,
      passed_runs: input.runSummary.pass,
      invariant_failed_runs: input.runSummary.fail,
      setup_errors: input.runSummary.error,
      skipped_runs: input.runSummary.skipped,
      invariant_failure_rate: completedRuns === 0 ? 0 : roundNumber(input.runSummary.fail / completedRuns)
    },
    first_failure_ticks: firstFailureTickSummary(input.enriched),
    scenario_families: scenarioFamilySummary(input.plan, input.enriched),
    parameters: parameterSummary(input.spec, input.enriched),
    lending: input.spec.semanticClass === "lending.v1" ? lendingSummary(input.enriched) : null,
    retention: {
      selected: retentionSelected,
      warnings: input.retentionManifest.warnings
    },
    warnings,
    claim_boundary:
      "All conclusions are observations within this campaign's declared inputs, scenario families, parameters, seed policy, and run budget. They are not proof of complete protocol safety."
  };
}

function firstFailureTickSummary(enriched: EnrichedRun[]): CampaignSummaryJson["first_failure_ticks"] {
  const ticks = enriched
    .map((run) => run.metrics.firstFailureTick)
    .filter((tick): tick is number => tick !== null)
    .sort((a, b) => a - b);
  const distribution: Record<string, number> = {};
  for (const tick of ticks) {
    distribution[String(tick)] = (distribution[String(tick)] ?? 0) + 1;
  }
  return {
    count: ticks.length,
    min: ticks[0] ?? null,
    median: medianNumber(ticks),
    max: ticks[ticks.length - 1] ?? null,
    distribution
  };
}

function scenarioFamilySummary(
  plan: CampaignExpansionPlan,
  enriched: EnrichedRun[]
): Record<string, CampaignScenarioFamilySummary> {
  const families = new Map<string, CampaignScenarioFamilySummary>();
  for (const run of plan.runs) {
    const family = familyEntry(families, run.scenarioFamily);
    family.planned_runs += 1;
  }
  for (const run of enriched) {
    const family = familyEntry(families, run.record.scenario_family);
    if (run.record.status === "pass") family.passed_runs += 1;
    if (run.record.status === "fail") family.invariant_failed_runs += 1;
    if (run.record.status === "error") family.setup_errors += 1;
    if (run.record.status === "skipped") family.skipped_runs += 1;
    if (run.metrics.completed) family.completed_runs += 1;
    family.first_failure_tick_min = minNullable(
      family.first_failure_tick_min,
      run.metrics.firstFailureTick
    );
    family.total_bad_debt_max = maxNullable(family.total_bad_debt_max, run.metrics.totalBadDebt);
    family.max_utilization_observed = maxNullable(
      family.max_utilization_observed,
      run.metrics.maxUtilization
    );
    family.min_tvl_observed = minNullable(family.min_tvl_observed, run.metrics.minTvl);
  }
  return Object.fromEntries([...families.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function familyEntry(
  families: Map<string, CampaignScenarioFamilySummary>,
  name: string
): CampaignScenarioFamilySummary {
  const existing = families.get(name);
  if (existing) return existing;
  const created: CampaignScenarioFamilySummary = {
    planned_runs: 0,
    completed_runs: 0,
    passed_runs: 0,
    invariant_failed_runs: 0,
    setup_errors: 0,
    skipped_runs: 0,
    first_failure_tick_min: null,
    total_bad_debt_max: null,
    max_utilization_observed: null,
    min_tvl_observed: null
  };
  families.set(name, created);
  return created;
}

function parameterSummary(
  spec: CampaignSpec,
  enriched: EnrichedRun[]
): Record<string, CampaignParameterSummary> {
  const out: Record<string, CampaignParameterSummary> = {};
  for (const name of Object.keys(spec.parameters).sort()) {
    const values = enriched
      .map((run) => run.plan.sampledParameters[name])
      .filter((value): value is JsonScalar => value !== undefined);
    const numericValues = values
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
      .sort((a, b) => a - b);
    const distribution = spec.parameters[name]!;
    const summary: CampaignParameterSummary = {
      distribution: distributionLabel(distribution),
      sampled_count: values.length,
      min: numericValues[0] ?? null,
      median: medianNumber(numericValues),
      max: numericValues[numericValues.length - 1] ?? null,
      values: uniqueScalars(values)
    };
    if (distribution.unit !== undefined) summary.unit = distribution.unit;
    out[name] = summary;
  }
  return out;
}

function lendingSummary(enriched: EnrichedRun[]): CampaignLendingSummary {
  const completed = enriched.filter((run) => run.metrics.completed);
  const badDebtValues = completed
    .map((run) => run.metrics.totalBadDebt)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  const liquidations = completed
    .map((run) => run.metrics.totalLiquidations)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  const invariantNames = new Set<string>();
  for (const run of completed) {
    for (const name of run.metrics.invariantNames) invariantNames.add(name);
  }
  return {
    observations_used: [
      "summary.total_bad_debt",
      "timeseries.cumulative_bad_debt",
      "timeseries.tvl",
      "timeseries.utilization",
      "summary.total_liquidations",
      "run invariant fires"
    ],
    completed_runs_with_metrics: completed.filter(
      (run) => run.metrics.totalBadDebt !== null || run.metrics.maxUtilization !== null
    ).length,
    total_bad_debt: {
      min: badDebtValues[0] ?? null,
      median: medianNumber(badDebtValues),
      max: badDebtValues[badDebtValues.length - 1] ?? null
    },
    total_liquidations: {
      min: liquidations[0] ?? null,
      median: medianNumber(liquidations),
      max: liquidations[liquidations.length - 1] ?? null
    },
    liquidity_stress: {
      min_tvl_observed: minOf(completed.map((run) => run.metrics.minTvl)),
      max_utilization_observed: maxOf(completed.map((run) => run.metrics.maxUtilization)),
      min_available_liquidity_observed: minOf(completed.map((run) => run.metrics.minAvailableLiquidity))
    },
    liquidation_safety_failures: {
      failed_runs: completed.filter((run) => run.record.status === "fail").length,
      invariant_names: [...invariantNames].sort((a, b) => a.localeCompare(b))
    }
  };
}

function renderParametersCsv(spec: CampaignSpec, enriched: EnrichedRun[]): string {
  const parameterNames = Object.keys(spec.parameters).sort();
  const headers = [
    "run_index",
    "run_id",
    "status",
    "scenario_family",
    "run_seed",
    "first_failure_tick",
    "total_bad_debt",
    "max_utilization",
    "min_tvl",
    "total_liquidations",
    ...parameterNames
  ];
  const rows = enriched.map((run) => [
    run.record.run_index,
    run.record.run_id,
    run.record.status,
    run.record.scenario_family,
    run.record.run_seed,
    run.metrics.firstFailureTick,
    run.metrics.totalBadDebt,
    run.metrics.maxUtilization,
    run.metrics.minTvl,
    run.metrics.totalLiquidations,
    ...parameterNames.map((name) => run.plan.sampledParameters[name] ?? "")
  ]);
  return [headers, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\n") + "\n";
}

function renderCampaignSummaryMarkdown(
  summary: CampaignSummaryJson,
  retentionManifest: CampaignRetentionManifest,
  riskSurface: RiskSurfaceDocument
): string {
  const lines: string[] = [
    `# Campaign Summary: ${summary.campaign.name}`,
    "",
    "## Scope",
    "",
    `This report describes observations within this campaign only. It does not certify complete protocol safety.`,
    "",
    `- **Class:** ${summary.campaign.class}`,
    `- **Objective:** ${summary.campaign.risk_objective}`,
    `- **Campaign ID:** ${summary.campaign.campaign_id}`,
    `- **Campaign digest:** \`${summary.campaign.campaign_digest}\``,
    `- **Run budget:** ${summary.campaign.run_budget}`,
    `- **Runs requested here:** ${summary.totals.requested_runs}`,
    `- **Adapter:** \`${summary.campaign.adapter}\``,
    "",
    "## Outcome",
    "",
    `- **Completed runs:** ${summary.totals.completed_runs}`,
    `- **Setup errors:** ${summary.totals.setup_errors}`,
    `- **Invariant-failed runs:** ${summary.totals.invariant_failed_runs}`,
    `- **Invariant failure rate:** ${formatPercent(summary.totals.invariant_failure_rate)}`,
    `- **First failure ticks:** ${firstFailureTickDisplay(summary.first_failure_ticks)}`,
    ""
  ];

  if (summary.totals.invariant_failed_runs === 0) {
    if (hasMeaningfulLendingRisk(summary)) {
      lines.push(
        "No error-severity invariant violation was observed, but lending risk metrics did move. Treat the retained risk case as campaign-scoped evidence, not as a safety proof.",
        ""
      );
    } else {
      lines.push(
        "No invariant violation was observed within this campaign. That means only that the declared campaign inputs did not produce an invariant violation in this run budget.",
        ""
      );
    }
  } else {
    lines.push(
      "One or more invariant failures were observed within this campaign. Inspect the retained runs before changing the scenario, adapter, or protocol assumptions.",
      ""
    );
  }

  lines.push("## Key Risk Signal", "", keyRiskSignal(summary), "");

  lines.push("## Scenario Families", "");
  if (summary.lending) {
    lines.push(
      "| Family | Planned | Completed | Failed | Setup errors | First failure tick | Bad debt max | Max utilization | Min TVL |",
      "|---|---:|---:|---:|---:|---:|---:|---:|---:|"
    );
    for (const [family, row] of Object.entries(summary.scenario_families)) {
      lines.push(
        `| ${family} | ${row.planned_runs} | ${row.completed_runs} | ${row.invariant_failed_runs} | ${row.setup_errors} | ${displayValue(row.first_failure_tick_min)} | ${displayValue(row.total_bad_debt_max)} | ${displayValue(row.max_utilization_observed)} | ${displayValue(row.min_tvl_observed)} |`
      );
    }
  } else {
    lines.push(
      "| Family | Planned | Completed | Failed | Setup errors | First failure tick |",
      "|---|---:|---:|---:|---:|---:|"
    );
    for (const [family, row] of Object.entries(summary.scenario_families)) {
      lines.push(
        `| ${family} | ${row.planned_runs} | ${row.completed_runs} | ${row.invariant_failed_runs} | ${row.setup_errors} | ${displayValue(row.first_failure_tick_min)} |`
      );
    }
  }
  lines.push("");

  lines.push("## Parameters", "", "| Parameter | Distribution | Unit | Samples | Observed range |", "|---|---|---|---:|---|");
  for (const [name, parameter] of Object.entries(summary.parameters)) {
    if (parameter.sampled_count === 0) continue;
    lines.push(
      `| ${name} | ${parameter.distribution} | ${parameter.unit ?? ""} | ${parameter.sampled_count} | ${rangeDisplay(parameter.min, parameter.max)} |`
    );
  }
  lines.push("");

  if (summary.lending) {
    lines.push(
      "## Lending Observations",
      "",
      `Observed semantic/lending surfaces: ${summary.lending.observations_used.map((name) => `\`${name}\``).join(", ")}.`,
      "",
      `- **Bad debt max:** ${displayValue(summary.lending.total_bad_debt.max)}`,
      `- **Total liquidations max:** ${displayValue(summary.lending.total_liquidations.max)}`,
      `- **Max utilization observed:** ${displayValue(summary.lending.liquidity_stress.max_utilization_observed)}`,
      `- **Minimum TVL observed:** ${displayValue(summary.lending.liquidity_stress.min_tvl_observed)}`,
      `- **Liquidation-safety failed runs:** ${summary.lending.liquidation_safety_failures.failed_runs}`,
      ""
    );
  }

  lines.push(
    "## Retained Evidence",
    "",
    "| Label | Status | Run | Score | Risk signals | Reason |",
    "|---|---|---|---:|---|---|"
  );
  for (const entry of retentionManifest.entries) {
    if (entry.status === "selected") {
      lines.push(
        `| ${entry.label} | selected | \`${entry.run_id}\` | ${displayValue(entry.score)} | ${riskSignalDisplay(entry)} | ${entry.reason} |`
      );
    } else {
      lines.push(`| ${entry.label} | warning |  |  |  | ${entry.warning} |`);
    }
  }
  lines.push("");

  if (summary.warnings.length > 0) {
    lines.push("## Warnings", "");
    for (const warning of summary.warnings) lines.push(`- ${warning}`);
    lines.push("");
  }

  lines.push(renderRiskSurfaceNarrative(riskSurface), "");

  lines.push(
    "## Artifact Index",
    "",
    `- \`campaign-summary.json\``,
    `- \`campaign-summary.md\``,
    `- \`parameters.csv\``,
    `- \`runs.jsonl\``,
    `- \`retention-manifest.json\``,
    `- \`risk-surface.json\``,
    `- \`retained/<label>-<run-id>/case.json\``,
    `- \`retained/<label>-<run-id>/rerun.sh\``,
    "",
    "## Recommendation",
    "",
    recommendation(summary),
    "",
    `Claim boundary: ${summary.claim_boundary}`,
    ""
  );
  return lines.join("\n");
}

function recommendation(summary: CampaignSummaryJson): string {
  if (summary.totals.setup_errors > 0) {
    return "Resolve setup errors before treating the campaign as review evidence.";
  }
  if (summary.totals.invariant_failed_runs > 0) {
    return "Review retained failure evidence, then decide whether to tighten invariants, broaden scenarios, or change protocol assumptions.";
  }
  if ((summary.lending?.total_bad_debt.max ?? 0) > 0) {
    return "Review retained bad-debt evidence and rerun the selected case before changing scenario or protocol assumptions.";
  }
  if ((summary.lending?.total_liquidations.max ?? 0) > 0) {
    return "Review retained liquidation-pressure evidence and decide whether the stress frontier needs a larger budget.";
  }
  return "Use this as campaign-scoped evidence only; broaden scenario families, budgets, and retained reads before making release decisions.";
}

function keyRiskSignal(summary: CampaignSummaryJson): string {
  const selected = summary.retention.selected;
  const badDebt = selected
    .filter((entry) => (entry.risk_signals.total_bad_debt ?? 0) > 0)
    .sort(
      (left, right) =>
        (right.risk_signals.total_bad_debt ?? 0) - (left.risk_signals.total_bad_debt ?? 0)
    )[0];
  if (badDebt) {
    return (
      `Retained case \`${badDebt.label}\` -> \`${badDebt.run_id}\` produced ` +
      `bad debt ${displayValue(badDebt.risk_signals.total_bad_debt)} with ` +
      `${displayValue(badDebt.risk_signals.total_liquidations)} liquidation(s). ` +
      `Parameters: ${sampledParametersDisplay(badDebt.sampled_parameters)}.`
    );
  }
  const invariant = selected.find((entry) => entry.risk_signals.invariant_names.length > 0);
  if (invariant) {
    return (
      `Retained case \`${invariant.label}\` -> \`${invariant.run_id}\` recorded invariant signal ` +
      `${invariant.risk_signals.invariant_names.join(", ")}. ` +
      `Parameters: ${sampledParametersDisplay(invariant.sampled_parameters)}.`
    );
  }
  const semanticSignal = selected.find((entry) => entry.risk_signals.semantic_signal_names.length > 0);
  if (semanticSignal) {
    return (
      `Retained case \`${semanticSignal.label}\` -> \`${semanticSignal.run_id}\` recorded warn signal ` +
      `${semanticSignal.risk_signals.semantic_signal_names.join(", ")}. ` +
      `Parameters: ${sampledParametersDisplay(semanticSignal.sampled_parameters)}.`
    );
  }
  const liquidation = selected.find((entry) => (entry.risk_signals.total_liquidations ?? 0) > 0);
  if (liquidation) {
    return (
      `Retained case \`${liquidation.label}\` -> \`${liquidation.run_id}\` recorded ` +
      `${displayValue(liquidation.risk_signals.total_liquidations)} liquidation(s) without realized bad debt. ` +
      `Parameters: ${sampledParametersDisplay(liquidation.sampled_parameters)}.`
    );
  }
  const liquidity = selected.find((entry) => (entry.risk_signals.max_utilization ?? 0) > 1);
  if (liquidity) {
    return (
      `Retained case \`${liquidity.label}\` -> \`${liquidity.run_id}\` reached utilization ` +
      `${displayValue(liquidity.risk_signals.max_utilization)}. ` +
      `Parameters: ${sampledParametersDisplay(liquidity.sampled_parameters)}.`
    );
  }
  if (summary.totals.setup_errors > 0) {
    return `${summary.totals.setup_errors} setup error(s) prevented complete campaign evidence.`;
  }
  if (summary.campaign.class === "lending.v1") {
    return "No non-zero lending risk metric or invariant failure was retained in this campaign run.";
  }
  return `No ${summary.campaign.class} semantic warning signal or invariant failure was retained in this campaign run.`;
}

function hasMeaningfulLendingRisk(summary: CampaignSummaryJson): boolean {
  return (
    (summary.lending?.total_bad_debt.max ?? 0) > 0 ||
    (summary.lending?.total_liquidations.max ?? 0) > 0 ||
    (summary.lending?.liquidity_stress.max_utilization_observed ?? 0) > 1
  );
}

function riskSignalDisplay(entry: CampaignRetentionSelection): string {
  const signals = entry.risk_signals;
  const parts: string[] = [];
  if (signals.invariant_names.length > 0) {
    parts.push(`invariants=${signals.invariant_names.join("+")}`);
  }
  if (signals.semantic_signal_names.length > 0) {
    parts.push(`warn_signals=${signals.semantic_signal_names.join("+")}`);
  }
  if (signals.total_bad_debt !== null) parts.push(`bad_debt=${displayValue(signals.total_bad_debt)}`);
  if (signals.total_liquidations !== null) {
    parts.push(`liquidations=${displayValue(signals.total_liquidations)}`);
  }
  if (signals.max_utilization !== null) {
    parts.push(`max_utilization=${displayValue(signals.max_utilization)}`);
  }
  if (signals.min_tvl !== null) parts.push(`min_tvl=${displayValue(signals.min_tvl)}`);
  return parts.length > 0 ? parts.join(", ") : "no numeric risk metric";
}

function sampledParametersDisplay(parameters: Record<string, JsonScalar>): string {
  const entries = Object.entries(parameters).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "(none)";
  return entries.map(([key, value]) => `${key}=${scalarDisplay(value)}`).join(", ");
}

function expressionInvariantRows(summary: JsonRecord | null): Array<{
  name: string;
  severity: "error" | "warn";
  first_tick?: number | null;
  first_fired_tick?: number | null;
  firing_count?: number;
  firings?: number;
  observed?: Array<{ tick?: number }>;
}> {
  const value = summary?.expression_invariants;
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is {
    name: string;
    severity: "error" | "warn";
    first_tick?: number | null;
    first_fired_tick?: number | null;
    firing_count?: number;
    firings?: number;
    observed?: Array<{ tick?: number }>;
  } => {
    const record = asRecord(row);
    return (
      record !== null &&
      typeof record.name === "string" &&
      (record.severity === "error" || record.severity === "warn")
    );
  });
}

function expressionInvariantFiringCount(row: {
  firing_count?: number;
  firings?: number;
}): number {
  const count = row.firing_count ?? row.firings ?? 0;
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

function expressionInvariantFirstTick(row: {
  first_tick?: number | null;
  first_fired_tick?: number | null;
  observed?: Array<{ tick?: number }>;
}): number | null {
  const tick = row.first_tick ?? row.first_fired_tick ?? row.observed?.[0]?.tick;
  return typeof tick === "number" && Number.isSafeInteger(tick) && tick >= 0 ? tick : null;
}

function distributionLabel(distribution: ParameterDistribution): string {
  if (distribution.distribution === "fixed") {
    return `fixed(${scalarDisplay(distribution.value)})`;
  }
  if (distribution.distribution === "discrete") {
    return `discrete(${distribution.values.map(scalarDisplay).join("|")})`;
  }
  return `${distribution.distribution}(${distribution.min}..${distribution.max}${distribution.integer ? ", integer" : ""})`;
}

function seedPolicyDisplay(policy: SeedPolicy): string {
  if (policy.kind === "fixed") return `fixed:${policy.seed}`;
  if (policy.kind === "range") return `range:${policy.start}..${policy.end}`;
  return "expanding";
}

function firstFailureTickDisplay(value: CampaignSummaryJson["first_failure_ticks"]): string {
  if (value.count === 0) return "none observed";
  return `count ${value.count}, min ${value.min}, median ${value.median}, max ${value.max}`;
}

function formatPercent(value: number): string {
  return `${roundNumber(value * 100)}%`;
}

function rangeDisplay(min: number | null, max: number | null): string {
  if (min === null && max === null) return "non-numeric or not sampled";
  if (min === max) return displayValue(min);
  return `${displayValue(min)} -> ${displayValue(max)}`;
}

function displayValue(value: number | null): string {
  if (value === null) return "";
  return String(roundNumber(value));
}

function scalarDisplay(value: JsonScalar): string {
  return value === null ? "null" : String(value);
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function numberField(record: JsonRecord | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringField(record: JsonRecord, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function maxNumericField(records: JsonRecord[], key: string): number | null {
  return maxOf(records.map((record) => numberField(record, key)));
}

function minNumericField(records: JsonRecord[], key: string): number | null {
  return minOf(records.map((record) => numberField(record, key)));
}

function lastNumericField(records: JsonRecord[], key: string): number | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const value = numberField(records[index]!, key);
    if (value !== null) return value;
  }
  return null;
}

function maxOf(values: Array<number | null>): number | null {
  const numeric = values.filter((value): value is number => value !== null);
  if (numeric.length === 0) return null;
  return Math.max(...numeric);
}

function minOf(values: Array<number | null>): number | null {
  const numeric = values.filter((value): value is number => value !== null);
  if (numeric.length === 0) return null;
  return Math.min(...numeric);
}

function minNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function maxNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function medianNumber(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return roundNumber(sorted[mid]!);
  return roundNumber((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function uniqueScalars(values: JsonScalar[]): JsonScalar[] {
  const seen = new Set<string>();
  const out: JsonScalar[] = [];
  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out.sort(compareScalars);
}

function compareScalars(a: JsonScalar, b: JsonScalar): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return scalarDisplay(a).localeCompare(scalarDisplay(b));
}

function compareNumbers(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareNumbersDesc(a: number, b: number): number {
  return compareNumbers(b, a);
}

function roundNumber(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1_000_000) / 1_000_000;
}

function relativizeIfInside(cwd: string, value: string): string {
  const abs = path.resolve(cwd, value);
  const rel = path.relative(cwd, abs);
  if (rel === "") return ".";
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel.split(path.sep).join("/");
  return value.split(path.sep).join("/");
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
