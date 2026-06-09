import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import TOML from "toml";

import { canonicalJson, sha256Hex } from "../state-pack/json.js";
import {
  buildRiskSurfaceDocument,
  serializeRiskSurface,
  type RiskSurfaceRunInput
} from "../campaign/surface.js";
import type {
  CampaignSummaryJson,
  CampaignRetentionManifest,
  CampaignParameterSummary
} from "../campaign/aggregation.js";
import type { JsonScalar, ParameterDistribution, RetentionLabel } from "../campaign/schema.js";

/**
 * Bridge: turn a guided-sim parameter sweep into the three cartography
 * artifacts (`campaign-summary.json`, `risk-surface.json`,
 * `retention-manifest.json`) that `riptide assess` renders as a risk-surface
 * heatmap. This is a pure producer over an existing `guided-sim-run.json`; it
 * reuses the canonical {@link buildRiskSurfaceDocument} builder and never
 * touches the campaign engine or the assess model, so the cartography byte
 * pins are unreachable from this path.
 *
 * The sweep coordinate per iteration comes from the runner-recorded
 * `iterations[].parameters` (see riptide-sim runner). A non-flat surface needs
 * the guided sim to record error-severity invariant fires (mapped to a cell
 * `fail`) and/or outcome metrics (mapped to cell percentiles).
 */

const CAMPAIGN_SUMMARY_FILE = "campaign-summary.json";
const RISK_SURFACE_FILE = "risk-surface.json";
const RETENTION_MANIFEST_FILE = "retention-manifest.json";
const RUNS_JSONL_FILE = "runs.jsonl";
const PARAMETERS_CSV_FILE = "parameters.csv";
const MARKDOWN_SUMMARY_FILE = "campaign-summary.md";

const CARTOGRAPHY_CLAIM_BOUNDARY =
  "Simulation evidence over the declared, fixed-seed guided-sim sweep region only — " +
  "not audit signoff, formal verification, complete protocol safety, or a mainnet prediction.";

export interface SweepConfig {
  name: string;
  values: number[];
  seedsPerValue: number;
}

export interface CartographyConfig {
  class: string;
  riskObjective: string;
}

/** Read `[sim.sweep]` from a sim manifest. Returns null when absent. */
export async function readSweepConfig(manifestPath: string): Promise<SweepConfig | null> {
  const block = await readSimBlock(manifestPath, "sweep");
  if (!block) return null;
  const name = typeof block.name === "string" ? block.name : null;
  const values = Array.isArray(block.values)
    ? block.values.filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    : [];
  if (!name || values.length === 0) return null;
  const seedsPerValue =
    typeof block.seeds_per_value === "number" && Number.isInteger(block.seeds_per_value)
      ? Math.max(1, block.seeds_per_value)
      : 1;
  return { name, values, seedsPerValue };
}

/** Read `[sim.cartography]` from a sim manifest. Returns null when absent. */
export async function readCartographyConfig(
  manifestPath: string
): Promise<CartographyConfig | null> {
  const block = await readSimBlock(manifestPath, "cartography");
  if (!block) return null;
  const cls = typeof block.class === "string" ? block.class : null;
  const riskObjective =
    typeof block.risk_objective === "string" ? block.risk_objective : null;
  if (!cls || !riskObjective) return null;
  return { class: cls, riskObjective };
}

/** Format a {@link SweepConfig} as the runner `--sweep name=v1,v2,...` flag value. */
export function formatSweepFlag(sweep: SweepConfig): string {
  return `${sweep.name}=${sweep.values.join(",")}`;
}

async function readSimBlock(
  manifestPath: string,
  key: "sweep" | "cartography"
): Promise<Record<string, unknown> | null> {
  if (!existsSync(manifestPath)) return null;
  let parsed: unknown;
  try {
    parsed = TOML.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return null;
  }
  const sim = isRecord(parsed) ? parsed["sim"] : undefined;
  const block = isRecord(sim) ? sim[key] : undefined;
  return isRecord(block) ? block : null;
}

// ---------------------------------------------------------------------------
// guided-sim-run.json shape (only the fields the producer reads)
// ---------------------------------------------------------------------------

interface GuidedSimIteration {
  iteration: number;
  seed: string;
  status: string;
  panic?: boolean;
  parameters?: Record<string, number>;
  metrics?: Record<string, number>;
  invariant_fires?: string[];
}

interface GuidedSimRunDocument {
  status: string;
  base_seed: string;
  retained_failing_seed: string | null;
  iterations: GuidedSimIteration[];
}

/**
 * Map a guided-sim iteration to its risk-surface run status:
 * - `panic` (engine fault) → `error` (excluded from the solvency failure rate)
 * - engine `failed` or any recorded invariant fire → `fail`
 * - otherwise → `pass`
 */
export function iterationStatus(iteration: GuidedSimIteration): RiskSurfaceRunInput["status"] {
  if (iteration.panic === true || iteration.status === "panic") return "error";
  const invariantFired = (iteration.invariant_fires ?? []).length > 0;
  if (iteration.status === "failed" || invariantFired) return "fail";
  return "pass";
}

/** Map sweep iterations to {@link RiskSurfaceRunInput}[] for the surface builder. */
export function mapIterationsToRuns(
  doc: GuidedSimRunDocument,
  sweepName: string
): RiskSurfaceRunInput[] {
  return doc.iterations.map((iteration, index) => {
    const metrics = iteration.metrics ?? {};
    const coordinate = iteration.parameters?.[sweepName];
    const badDebt = numberOrNull(metrics["bad_debt"]);
    return {
      runIndex: index,
      status: iterationStatus(iteration),
      sampledParameters:
        coordinate === undefined ? {} : ({ [sweepName]: coordinate } as Record<string, JsonScalar>),
      badDebt,
      utilization: numberOrNull(metrics["utilization"]),
      tvl: numberOrNull(metrics["tvl"]),
      availableLiquidity: numberOrNull(metrics["available_liquidity"]),
      // Generic-class surface metric; prefer an explicit risk_score, else fall
      // back to bad_debt so a non-lending sweep still shows a metric gradient.
      riskScore: numberOrNull(metrics["risk_score"]) ?? badDebt ?? 0
    };
  });
}

/** A discrete axis distribution over the swept values, with uniform weights. */
export function buildSweepAxisDistribution(
  sweep: SweepConfig
): Record<string, ParameterDistribution> {
  return {
    [sweep.name]: {
      distribution: "discrete",
      values: sweep.values as JsonScalar[],
      weights: sweep.values.map(() => 1)
    }
  };
}

export interface EmitCartographyInput {
  runDoc: GuidedSimRunDocument;
  sweep: SweepConfig;
  cartography: CartographyConfig;
}

export interface CartographyArtifacts {
  campaignSummary: CampaignSummaryJson;
  riskSurfaceJson: string;
  retentionManifest: CampaignRetentionManifest;
  campaignId: string;
  campaignDigest: string;
}

/**
 * Build the three cartography artifacts in memory. Deterministic: identity ids
 * are hashed from declared inputs (not wall-clock/paths), all artifact paths
 * are relative, and the surface is serialized with the canonical builder.
 */
export function buildCartographyArtifacts(input: EmitCartographyInput): CartographyArtifacts {
  const { runDoc, sweep, cartography } = input;
  const runs = mapIterationsToRuns(runDoc, sweep.name);
  const parameters = buildSweepAxisDistribution(sweep);

  // Identity hashed from the declared, path-independent inputs.
  const identityPayload = {
    base_seed: runDoc.base_seed,
    class: cartography.class,
    risk_objective: cartography.riskObjective,
    sweep: { name: sweep.name, values: sweep.values, seeds_per_value: sweep.seedsPerValue }
  };
  const campaignDigest = sha256Hex(canonicalJson(identityPayload));
  const campaignId = `guided-sim-${campaignDigest.slice(0, 16)}`;
  const name = `${sweep.name} sweep`;
  const seedPolicyDisplay = `fixed:${runDoc.base_seed}`;
  const requestedRuns = runs.length;

  const surface = buildRiskSurfaceDocument({
    campaign: {
      campaignId,
      campaignDigest,
      name,
      semanticClass: cartography.class,
      riskObjective: cartography.riskObjective,
      seedPolicyDisplay,
      runBudget: requestedRuns,
      requestedRuns
    },
    parameters,
    runs
  });
  const riskSurfaceJson = serializeRiskSurface(surface);

  const campaignSummary = synthesizeCampaignSummary({
    campaignId,
    campaignDigest,
    name,
    cartography,
    seedPolicyDisplay,
    sweep,
    runs
  });

  const retentionManifest: CampaignRetentionManifest = {
    schema_version: "campaign-retention-manifest.v1",
    campaign_id: campaignId,
    campaign_digest: campaignDigest,
    campaign_name: name,
    class: cartography.class,
    risk_objective: cartography.riskObjective,
    requested_labels: [] as RetentionLabel[],
    artifacts: { risk_surface: RISK_SURFACE_FILE },
    entries: [],
    warnings: [
      "Guided-sim sweep evidence: retained cases are the failing iterations' seeds in guided-sim-run.json."
    ]
  };

  return { campaignSummary, riskSurfaceJson, retentionManifest, campaignId, campaignDigest };
}

interface SynthesizeSummaryInput {
  campaignId: string;
  campaignDigest: string;
  name: string;
  cartography: CartographyConfig;
  seedPolicyDisplay: string;
  sweep: SweepConfig;
  runs: RiskSurfaceRunInput[];
}

function synthesizeCampaignSummary(input: SynthesizeSummaryInput): CampaignSummaryJson {
  const { runs } = input;
  const completed = runs.filter((r) => r.status === "pass" || r.status === "fail").length;
  const passed = runs.filter((r) => r.status === "pass").length;
  const failed = runs.filter((r) => r.status === "fail").length;
  const setupErrors = runs.filter((r) => r.status === "error").length;
  const skipped = runs.filter((r) => r.status === "skipped").length;
  const failureRate = completed === 0 ? 0 : round6(failed / completed);

  const coordinateValues = input.sweep.values;
  const sampled = runs
    .map((r) => r.sampledParameters[input.sweep.name])
    .filter((v): v is number => typeof v === "number");
  const parameterSummary: CampaignParameterSummary = {
    distribution: "discrete",
    sampled_count: sampled.length,
    min: sampled.length ? Math.min(...sampled) : null,
    median: median(sampled),
    max: sampled.length ? Math.max(...sampled) : null,
    values: coordinateValues as JsonScalar[]
  };

  const isLending = input.cartography.class === "lending.v1";
  const badDebts = runs.map((r) => r.badDebt).filter((v): v is number => v !== null);
  const lending = isLending
    ? {
        observations_used: ["bad_debt", "utilization", "tvl", "available_liquidity"],
        completed_runs_with_metrics: badDebts.length,
        total_bad_debt: { min: minOrNull(badDebts), median: median(badDebts), max: maxOrNull(badDebts) },
        total_liquidations: { min: null, median: null, max: null },
        liquidity_stress: {
          min_tvl_observed: minOrNull(runs.map((r) => r.tvl).filter(isNum)),
          max_utilization_observed: maxOrNull(runs.map((r) => r.utilization).filter(isNum)),
          min_available_liquidity_observed: minOrNull(
            runs.map((r) => r.availableLiquidity).filter(isNum)
          )
        },
        liquidation_safety_failures: { failed_runs: failed, invariant_names: ["solvency"] }
      }
    : null;

  return {
    schema_version: "campaign-summary.v1",
    campaign: {
      campaign_id: input.campaignId,
      campaign_digest: input.campaignDigest,
      name: input.name,
      class: input.cartography.class,
      risk_objective: input.cartography.riskObjective,
      run_budget: runs.length,
      requested_runs: runs.length,
      seed_policy: input.seedPolicyDisplay,
      replay_retention: [] as RetentionLabel[],
      adapter: "guided-sim",
      output_dir: "."
    },
    artifacts: {
      runs_jsonl: RUNS_JSONL_FILE,
      parameters_csv: PARAMETERS_CSV_FILE,
      retention_manifest: RETENTION_MANIFEST_FILE,
      markdown_summary: MARKDOWN_SUMMARY_FILE,
      risk_surface: RISK_SURFACE_FILE
    },
    totals: {
      requested_runs: runs.length,
      completed_runs: completed,
      passed_runs: passed,
      invariant_failed_runs: failed,
      setup_errors: setupErrors,
      skipped_runs: skipped,
      invariant_failure_rate: failureRate
    },
    first_failure_ticks: { count: 0, min: null, median: null, max: null, distribution: {} },
    scenario_families: {
      guided_sim_sweep: {
        planned_runs: runs.length,
        completed_runs: completed,
        passed_runs: passed,
        invariant_failed_runs: failed,
        setup_errors: setupErrors,
        skipped_runs: skipped,
        first_failure_tick_min: null,
        total_bad_debt_max: maxOrNull(badDebts),
        max_utilization_observed: maxOrNull(runs.map((r) => r.utilization).filter(isNum)),
        min_tvl_observed: minOrNull(runs.map((r) => r.tvl).filter(isNum))
      }
    },
    parameters: { [input.sweep.name]: parameterSummary },
    lending,
    retention: { selected: [], warnings: [] },
    warnings: [],
    claim_boundary: CARTOGRAPHY_CLAIM_BOUNDARY
  };
}

/** Write the three cartography artifacts to `outDir`. Returns the directory. */
export async function emitCartographyRoot(
  artifacts: CartographyArtifacts,
  outDir: string
): Promise<string> {
  await mkdir(outDir, { recursive: true });
  await writeFile(
    path.join(outDir, CAMPAIGN_SUMMARY_FILE),
    canonicalJson(artifacts.campaignSummary as unknown as Parameters<typeof canonicalJson>[0]),
    "utf8"
  );
  await writeFile(path.join(outDir, RISK_SURFACE_FILE), artifacts.riskSurfaceJson, "utf8");
  await writeFile(
    path.join(outDir, RETENTION_MANIFEST_FILE),
    canonicalJson(artifacts.retentionManifest as unknown as Parameters<typeof canonicalJson>[0]),
    "utf8"
  );
  return outDir;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isNum(value: number | null): value is number {
  return value !== null;
}

function minOrNull(values: number[]): number | null {
  return values.length ? Math.min(...values) : null;
}

function maxOrNull(values: number[]): number | null {
  return values.length ? Math.max(...values) : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? round6((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type { GuidedSimRunDocument };
