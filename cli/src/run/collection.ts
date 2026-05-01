import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { SimulationResultSchema } from "../compiler/schema.js";

import type { Coverage, Verdict, CoverageCheck, RunInterpretation } from "./interpretation.js";
import type {
  InvariantFire,
  ScenarioRecord,
  ScenarioStatus,
  ScenarioSweepRecord
} from "./last-run.js";

export const RUN_COLLECTION_FILE_REL = path.join(".riptide", "run-collection.json");
export const RUN_COLLECTION_SCHEMA_VERSION = 1 as const;

export type MetricPreviewValue = number | boolean | string | null;
export type MetricPreview = Record<string, MetricPreviewValue>;

export type TotalsByStatus = Record<ScenarioStatus, number>;
export type TotalsByVerdict = Record<Verdict, number>;
export type TotalsByCoverage = Record<Coverage, number>;

export interface RunCollectionScenario {
  name: string;
  run_config_path: string;
  status: ScenarioStatus;
  wall_clock_s: number;
  artifacts_dir?: string;
  sweep?: ScenarioSweepRecord;
  invariant_fires: InvariantFire[];
  invariant_fire_count: number;
  interpretation?: RunInterpretation;
  coverage_checks: CoverageCheck[];
  metric_preview: MetricPreview;
  simulation_result_path?: string;
  report_path?: string;
  error?: string;
}

export interface RunCollection {
  schema_version: typeof RUN_COLLECTION_SCHEMA_VERSION;
  started_at: string;
  finished_at: string;
  selected_pattern?: string;
  selected_source_path?: string;
  allow_invariant_violations: boolean;
  total_scenarios: number;
  totals_by_status: TotalsByStatus;
  totals_by_verdict: TotalsByVerdict;
  totals_by_coverage: TotalsByCoverage;
  scenarios: RunCollectionScenario[];
}

export interface BuildRunCollectionInput {
  cwd: string;
  startedAt: string;
  finishedAt: string;
  scenarios: ScenarioRecord[];
  selectedPattern?: string;
  selectedSourcePath?: string;
  allowInvariantViolations?: boolean;
}

export function runCollectionPath(cwd: string): string {
  return path.join(cwd, RUN_COLLECTION_FILE_REL);
}

export async function writeRunCollection(input: BuildRunCollectionInput): Promise<string> {
  const target = runCollectionPath(input.cwd);
  await mkdir(path.dirname(target), { recursive: true });
  const collection = await buildRunCollection(input);
  await writeFile(target, JSON.stringify(collection, null, 2) + "\n", "utf8");
  return target;
}

export async function buildRunCollection(input: BuildRunCollectionInput): Promise<RunCollection> {
  const scenarios = await Promise.all(
    input.scenarios.map((record) => buildScenarioEntry(input.cwd, record))
  );

  return {
    schema_version: RUN_COLLECTION_SCHEMA_VERSION,
    started_at: input.startedAt,
    finished_at: input.finishedAt,
    ...(input.selectedPattern ? { selected_pattern: input.selectedPattern } : {}),
    ...(input.selectedSourcePath
      ? { selected_source_path: relativizeIfInside(input.cwd, input.selectedSourcePath) }
      : {}),
    allow_invariant_violations: input.allowInvariantViolations === true,
    total_scenarios: input.scenarios.length,
    totals_by_status: countStatuses(input.scenarios),
    totals_by_verdict: countVerdicts(input.scenarios),
    totals_by_coverage: countCoverages(input.scenarios),
    scenarios
  };
}

async function buildScenarioEntry(
  cwd: string,
  record: ScenarioRecord
): Promise<RunCollectionScenario> {
  const artifactsDir = record.artifacts_dir
    ? relativizeIfInside(cwd, record.artifacts_dir)
    : undefined;
  const simulationResultPath = artifactsDir
    ? path.join(artifactsDir, "simulation-result.json")
    : undefined;
  const reportPath = artifactsDir ? path.join(artifactsDir, "report.md") : undefined;

  return {
    name: record.name,
    run_config_path: relativizeIfInside(cwd, record.run_config_path),
    status: record.status,
    wall_clock_s: record.wall_clock_s,
    ...(artifactsDir ? { artifacts_dir: artifactsDir } : {}),
    ...(record.sweep ? { sweep: relativizeSweep(cwd, record.sweep) } : {}),
    invariant_fires: record.invariant_fires,
    invariant_fire_count: record.invariant_fires.length,
    ...(record.interpretation ? { interpretation: record.interpretation } : {}),
    coverage_checks: record.interpretation?.coverage_checks ?? [],
    metric_preview: simulationResultPath
      ? await readMetricPreview(cwd, simulationResultPath)
      : {},
    ...(simulationResultPath ? { simulation_result_path: simulationResultPath } : {}),
    ...(reportPath ? { report_path: reportPath } : {}),
    ...(record.error ? { error: record.error } : {})
  };
}

function relativizeSweep(cwd: string, sweep: ScenarioSweepRecord): ScenarioSweepRecord {
  return {
    ...sweep,
    summary_path: relativizeIfInside(cwd, sweep.summary_path),
    report_path: relativizeIfInside(cwd, sweep.report_path),
    ...(sweep.first_fire_cell
      ? { first_fire_cell: relativizeIfInside(cwd, sweep.first_fire_cell) }
      : {})
  };
}

async function readMetricPreview(cwd: string, resultPath: string): Promise<MetricPreview> {
  try {
    const raw = await readFile(resolveFromCwd(cwd, resultPath), "utf8");
    const parsed = SimulationResultSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return {};
    return metricPreviewFromSummary(parsed.data.summary);
  } catch {
    return {};
  }
}

export function metricPreviewFromSummary(summary: Record<string, unknown>): MetricPreview {
  const preview: MetricPreview = {};
  const preferred = [
    "final_tvl",
    "final_utilization",
    "total_bad_debt",
    "largest_single_tick_drawdown",
    "total_liquidations",
    "agents_active",
    "agents_liquidated",
    "agents_depleted"
  ];

  for (const key of preferred) {
    const value = summary[key];
    if (isMetricPreviewValue(value)) {
      preview[key] = value;
    }
  }

  for (const key of Object.keys(summary).sort()) {
    if (Object.keys(preview).length >= 8) break;
    if (key in preview || key === "invariants_fired") continue;
    const value = summary[key];
    if (isMetricPreviewValue(value)) {
      preview[key] = value;
    }
  }

  return preview;
}

function countStatuses(records: ScenarioRecord[]): TotalsByStatus {
  const totals: TotalsByStatus = { pass: 0, fail: 0, error: 0, skipped: 0 };
  for (const record of records) {
    totals[record.status] += 1;
  }
  return totals;
}

function countVerdicts(records: ScenarioRecord[]): TotalsByVerdict {
  const totals: TotalsByVerdict = {
    "failure-observed": 0,
    "no-failure-observed": 0,
    inconclusive: 0,
    "setup-error": 0,
    interrupted: 0
  };
  for (const record of records) {
    const verdict = record.interpretation?.verdict;
    if (verdict) totals[verdict] += 1;
  }
  return totals;
}

function countCoverages(records: ScenarioRecord[]): TotalsByCoverage {
  const totals: TotalsByCoverage = {
    exercised: 0,
    partial: 0,
    unexercised: 0,
    unknown: 0
  };
  for (const record of records) {
    const coverage = record.interpretation?.coverage;
    if (coverage) totals[coverage] += 1;
  }
  return totals;
}

function relativizeIfInside(cwd: string, value: string): string {
  if (!path.isAbsolute(value)) return value;
  const relative = path.relative(cwd, value);
  if (relative === "") return ".";
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative;
  }
  return value;
}

function resolveFromCwd(cwd: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

function isMetricPreviewValue(value: unknown): value is MetricPreviewValue {
  return (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "string"
  );
}
