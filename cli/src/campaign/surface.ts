import { canonicalJson, sha256Hex, type JsonValue } from "../state-pack/json.js";

import type { JsonScalar, ParameterDistribution } from "./schema.js";

/**
 * risk-surface.v1 — quantitative risk-surface contract (Phase 1: types only).
 *
 * ## What this is
 *
 * A campaign run already sweeps parameters, binds each run's sampled
 * coordinates to its outcome (see `EnrichedRun` in `aggregation.ts`:
 * `plan.sampledParameters` ↔ `metrics`), and emits `campaign-summary.v1` with
 * *marginal* per-parameter distributions. The risk surface is the missing
 * *joint* view: it cross-tabulates the swept parameters against outcomes into a
 * grid of cells, reports each cell's invariant-failure rate and metric
 * percentiles, ranks which axis moves risk most, and extracts a recommended
 * safe region.
 *
 * `risk-surface.json` is a NEW, purely-additive artifact. It does NOT alter
 * `campaign-summary.v1`, `simulation-result.json`, the retention manifest, or
 * any retained-case bytes. The summary/manifest gain only additive *path
 * references* to it (added in T02), never a reordering of existing fields.
 *
 * ## Emission path (R1.5 — no new CLI command)
 *
 * Produced inside the existing campaign aggregation step
 * (`writeCampaignArtifacts` in `cli/src/campaign/aggregation.ts`), alongside
 * `campaign-summary.json`, from the same `EnrichedRun[]`. There is NO
 * `riptide surface` / `riptide assess` command; `riptide campaign run` emits it
 * always-on, contingent only on not breaking existing artifact tests.
 *
 * ## No engine/Rust change (R1.1)
 *
 * Every input the surface needs already exists on the TS side per run:
 * `EnrichedRun.plan.sampledParameters` (the axis coordinates) and
 * `EnrichedRun.metrics` (`completed`, `invariantFireCount`, `firstFailureTick`,
 * `totalBadDebt`, `maxUtilization`, `minTvl`, `minAvailableLiquidity`,
 * `riskScore`). The producer reads these in memory — no new engine output,
 * no Rust change.
 *
 * ## Determinism contract (load-bearing)
 *
 * The surface must be byte-stable for a fixed campaign digest + seed policy, so
 * a reviewer can rerun `riptide campaign run` and `sha256sum risk-surface.json`
 * to an identical value. Every ordering and numeric choice below is fixed and
 * derived only from the spec + sampled values — never from wall-clock, run
 * order, filesystem order, or `Map`/`Object` insertion order:
 *
 * 1. **Axis order** — swept axes are sorted ascending by `name`
 *    (`localeCompare`), matching `campaign-summary.v1`'s `parameters` ordering.
 * 2. **Bin order** — `bins[].index` is 0-based in the canonical bin order
 *    described per {@link RiskSurfaceBinningPolicy} below.
 * 3. **Cell order** — `cells[]` is sorted by the tuple of `coords[].bin_index`
 *    in axis order (lexicographic, ascending). Empty cells (run_count 0) are
 *    still emitted so the grid is complete and position-stable.
 * 4. **Percentile interpolation** — fixed linear interpolation on the
 *    ascending-sorted non-null samples (the "type-7" / NumPy-default method),
 *    documented on {@link RiskSurfaceMetricPercentiles}. No nearest-rank, no
 *    rounding of the rank position.
 * 5. **Numeric rounding** — every emitted rate/percentile is rounded to 6
 *    decimals (the same `roundNumber` convention `aggregation.ts` uses) so
 *    floating-point tails cannot perturb the bytes.
 * 6. **Tie-breaks** — sensitivity ties break by axis `name` ascending; safe-
 *    region bound ordering follows axis order. Documented inline at each block.
 * 7. **Canonical JSON** — the file is written via `canonicalJson` from
 *    `cli/src/state-pack/json.ts` (lexicographically sorted keys, `\n`
 *    terminator), the same serializer the campaign summary digest path uses.
 *
 * ## Binning policy (R1.3 — spec + sampled values only)
 *
 * - **Discrete axes** (`discrete` / `fixed` distributions): one bin per
 *   distinct *declared* value, in the distribution's declared value order. The
 *   bin coordinate is the value itself ({@link RiskSurfaceBin.value}). No
 *   wall-clock, no observed-frequency reordering.
 * - **Continuous axes** (`uniform` / `log-uniform`): binned by fixed,
 *   spec-declared *edges*. The edge set is derived deterministically from the
 *   declared `[min, max]` range (fixed-width partition into
 *   {@link DEFAULT_CONTINUOUS_BIN_COUNT} bins by default), so the edges depend
 *   only on the spec — not on which values happened to be sampled. Each bin is
 *   a half-open interval `[lower, upper)`; the final bin is closed `[lower,
 *   upper]` so the declared `max` lands in-range. Integer continuous axes
 *   (e.g. `oracle_lag_ticks`, `whale_share_bps`) reuse the same fixed-width
 *   edges; a follow-up may switch to quantile edges if cells come out lopsided
 *   (spec "Gray areas"), which is why the policy is recorded *in the artifact*
 *   ({@link RiskSurfaceBinningPolicy}) rather than left implicit.
 *
 * ## Canonicalization & digest (R1.4)
 *
 * `risk-surface.json` is canonical-JSON + sha256, exactly like other artifacts.
 * The document additionally embeds a self-digest field
 * ({@link RiskSurfaceDocument.surface_digest}) computed as
 * `sha256Hex(`${RISK_SURFACE_HASH_PREFIX}\n${canonicalJson(docWithoutDigest)}`)`
 * — the same domain-prefixed self-hash pattern the retained-case manifest uses
 * (`riptide-campaign-retained-case-v1`). Because the file is written with
 * `canonicalJson`, `sha256sum risk-surface.json` is itself the byte-stable
 * determinism hash recorded by the R6.4 gate.
 */
export const RISK_SURFACE_SCHEMA_VERSION = "risk-surface.v1" as const;

/** Domain-separation prefix for the embedded {@link RiskSurfaceDocument.surface_digest}. */
export const RISK_SURFACE_HASH_PREFIX = "riptide-risk-surface-v1" as const;

/**
 * Default number of fixed-width bins for a continuous axis when the spec does
 * not declare its own edges. Chosen small so per-cell run counts stay
 * non-trivial at realistic campaign budgets; recorded in the artifact so it is
 * reproducible and overridable.
 */
export const DEFAULT_CONTINUOUS_BIN_COUNT = 4 as const;

/**
 * Default safe-region failure-rate ceiling (R4.1). A cell counts as "safe" when
 * its `invariant_failure_rate` is at or below this. Surfaced as a config field
 * ({@link RiskSurfaceConfig.safe_region_failure_rate_threshold}) rather than
 * hard-coded, per the spec "Gray areas" note.
 */
export const DEFAULT_SAFE_REGION_THRESHOLD = 0.05 as const;

/**
 * Default minimum run count for a cell to be treated as statistically usable.
 * Cells below this are flagged sparse ({@link RiskSurfaceCell.sparse}) and
 * noted in {@link RiskSurfaceDocument.warnings} — never silently dropped (R2.4).
 */
export const DEFAULT_MIN_CELL_RUN_COUNT = 2 as const;

/**
 * Per-metric percentile keys computed for `lending.v1` campaigns. Generic
 * classes fall back to {@link GENERIC_SURFACE_METRICS}. The producer (T02) maps
 * each key to the matching `EnrichedRun.metrics` field.
 */
export const LENDING_SURFACE_METRICS = [
  "bad_debt",
  "utilization",
  "tvl",
  "available_liquidity"
] as const;

/** Per-metric percentile keys computed for non-lending classes. */
export const GENERIC_SURFACE_METRICS = ["risk_score"] as const;

export type LendingSurfaceMetric = (typeof LENDING_SURFACE_METRICS)[number];
export type GenericSurfaceMetric = (typeof GENERIC_SURFACE_METRICS)[number];
export type RiskSurfaceMetricKey = LendingSurfaceMetric | GenericSurfaceMetric;

// ---------------------------------------------------------------------------
// Document root
// ---------------------------------------------------------------------------

/** Top-level `risk-surface.json` document. */
export interface RiskSurfaceDocument {
  schema_version: typeof RISK_SURFACE_SCHEMA_VERSION;
  campaign: RiskSurfaceCampaignIdentity;
  /** Thresholds/policies used to build this surface, recorded for reproducibility. */
  config: RiskSurfaceConfig;
  /** Metric keys for which per-cell percentiles are reported, in declared order. */
  metrics: RiskSurfaceMetricKey[];
  /** Swept axes + their binning policy, sorted ascending by `name`. */
  axes: RiskSurfaceAxis[];
  /** Complete grid of cells, sorted by the `coords` bin-index tuple in axis order. */
  cells: RiskSurfaceCell[];
  sensitivity: RiskSurfaceSensitivity;
  safe_region: RiskSurfaceSafeRegion;
  warnings: string[];
  /**
   * Bounded-claim string (R4.4). Asserts simulation evidence over a declared,
   * fixed-seed parameter region — never protocol safety or mainnet prediction.
   */
  claim_boundary: string;
  /**
   * Self-digest: `sha256Hex(`${RISK_SURFACE_HASH_PREFIX}\n${canonicalJson(doc
   * without this field)}`)`. Lets the artifact carry its own integrity hash
   * the way the retained-case manifest does.
   */
  surface_digest: string;
}

/** Campaign identity, mirroring the `campaign-summary.v1` identity fields. */
export interface RiskSurfaceCampaignIdentity {
  campaign_id: string;
  campaign_digest: string;
  name: string;
  class: string;
  risk_objective: string;
  seed_policy: string;
  run_budget: number;
  requested_runs: number;
}

/** Policy values used to build the surface; emitted so the surface is reproducible. */
export interface RiskSurfaceConfig {
  /** Failure-rate ceiling for safe-region membership (R4.1). */
  safe_region_failure_rate_threshold: number;
  /** Cells with fewer runs than this are flagged `sparse` (R2.4). */
  min_cell_run_count: number;
  /** Default fixed-width bin count applied to continuous axes without declared edges. */
  default_continuous_bin_count: number;
  /** Percentile interpolation method, fixed for byte-stability. */
  percentile_interpolation: "linear";
}

// ---------------------------------------------------------------------------
// Axes & binning
// ---------------------------------------------------------------------------

export type RiskSurfaceAxisKind = "discrete" | "continuous";

/** A swept parameter rendered as a surface axis with its bins. */
export interface RiskSurfaceAxis {
  /** Parameter name, e.g. `whale_share_bps`. */
  name: string;
  /** Human-readable distribution label (matches `campaign-summary.v1` `parameters[].distribution`). */
  distribution: string;
  /** Optional unit carried from the parameter distribution. */
  unit?: string;
  kind: RiskSurfaceAxisKind;
  binning: RiskSurfaceBinningPolicy;
  /** Bins in canonical order; `bins[i].index === i`. */
  bins: RiskSurfaceBin[];
}

/**
 * How an axis is partitioned. Recorded in the artifact so the binning is
 * explainable and reproducible (and so a future quantile policy is a visible,
 * additive change rather than a silent re-tune).
 */
export type RiskSurfaceBinningPolicy =
  | {
      /** Discrete axis: one bin per declared value, in declared value order. */
      method: "value";
    }
  | {
      /** Continuous axis: fixed, spec-declared edges; bins are `[edge[i], edge[i+1])`. */
      method: "fixed-width";
      /** Ascending edge list of length `bins.length + 1`, derived from declared `[min, max]`. */
      edges: number[];
    };

/** A single bin on an axis. Discrete bins carry `value`; continuous bins carry `[lower, upper)`. */
export interface RiskSurfaceBin {
  /** 0-based canonical position; equals the bin's index in {@link RiskSurfaceAxis.bins}. */
  index: number;
  /** Stable human-readable label, e.g. `"calm"` or `"[2500, 5000)"`. */
  label: string;
  /** Discrete only: the declared parameter value this bin matches. */
  value?: JsonScalar;
  /** Continuous only: inclusive lower edge; `null` denotes an open lower bound. */
  lower?: number | null;
  /** Continuous only: exclusive upper edge (inclusive on the final bin); `null` denotes open above. */
  upper?: number | null;
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

/** A grid cell: one bin coordinate per axis plus its aggregated outcome. */
export interface RiskSurfaceCell {
  /** One coordinate per swept axis, in axis order. */
  coords: RiskSurfaceCellCoord[];
  /** Number of runs that landed in this cell (0 for empty grid positions). */
  run_count: number;
  /**
   * Invariant failure rate = (runs with an error-severity invariant fire) /
   * run_count, rounded to 6 decimals. 0 when `run_count` is 0.
   */
  invariant_failure_rate: number;
  /** Per-metric p10/p50/p90 over this cell's runs, keyed by {@link RiskSurfaceMetricKey}. */
  metrics: Record<string, RiskSurfaceMetricPercentiles>;
  /** True when `run_count < config.min_cell_run_count` (flagged, never dropped). */
  sparse: boolean;
}

/** A cell's coordinate on one axis. */
export interface RiskSurfaceCellCoord {
  axis: string;
  bin_index: number;
}

/**
 * p10/p50/p90 over the non-null samples in a cell, using fixed **linear**
 * interpolation: for percentile `q` over `n` ascending-sorted samples, the rank
 * is `h = (n - 1) * q` and the value is
 * `s[floor(h)] + (h - floor(h)) * (s[ceil(h)] - s[floor(h)])`. With `n === 0`
 * all three are `null`; with `n === 1` all three equal the single sample.
 */
export interface RiskSurfaceMetricPercentiles {
  /** Count of non-null samples backing these percentiles. */
  count: number;
  p10: number | null;
  p50: number | null;
  p90: number | null;
}

// ---------------------------------------------------------------------------
// Sensitivity (R3)
// ---------------------------------------------------------------------------

/** Parameter-sensitivity ranking: which axis moves the failure rate most. */
export interface RiskSurfaceSensitivity {
  /** Inline description of the method so the score is explainable, not opaque. */
  method: string;
  /** Axes ranked most-sensitive first; ties broken by axis `name` ascending. */
  ranking: RiskSurfaceAxisSensitivity[];
}

/** One axis's sensitivity entry. */
export interface RiskSurfaceAxisSensitivity {
  /** 1-based rank after sorting by `failure_rate_spread` desc, then `axis` asc. */
  rank: number;
  axis: string;
  /**
   * Marginal failure-rate spread = max − min of the per-bin marginal failure
   * rate across this axis's bins (bins with no runs are skipped). The primary
   * sensitivity signal.
   */
  failure_rate_spread: number;
  min_bin_failure_rate: number;
  max_bin_failure_rate: number;
  /**
   * Monotonicity note over the axis's bins by increasing bin index (R3.1).
   * `null` when undefined (fewer than two populated bins).
   */
  monotonic: RiskSurfaceMonotonicity | null;
  /**
   * Elasticity note (R3.1): the signed average failure-rate change per bin
   * step, measured from the first populated bin to the last populated bin —
   * `(rate_last − rate_first) / (index_last − index_first)`, rounded to 6
   * decimals. Complements the unsigned {@link failure_rate_spread} (how much
   * the axis moves risk) and the categorical {@link monotonic} note (the shape)
   * with a direction + per-step magnitude. Positive means failure rate tends to
   * rise with the axis; negative means it falls. `null` when fewer than two
   * populated bins make it undefined.
   */
  elasticity: number | null;
}

export type RiskSurfaceMonotonicity =
  | "increasing"
  | "decreasing"
  | "non-monotonic"
  | "flat";

// ---------------------------------------------------------------------------
// Safe region (R4)
// ---------------------------------------------------------------------------

export type RiskSurfaceSafeRegionStatus = "found" | "none" | "entire-region";

/** Recommended safe parameter bounds within the declared region. */
export interface RiskSurfaceSafeRegion {
  /** Failure-rate ceiling applied (mirrors {@link RiskSurfaceConfig.safe_region_failure_rate_threshold}). */
  threshold: number;
  /**
   * `found` — a strict sub-region is safe; `entire-region` — every populated
   * cell is at/under threshold; `none` — no cell qualifies. Never a silent
   * empty (R4.3).
   */
  status: RiskSurfaceSafeRegionStatus;
  /** Explicit, deterministic, region-bounded message (R4.3/R4.4). */
  message: string;
  /** Per-axis recommended bounds; empty when `status === "none"`. */
  bounds: RiskSurfaceAxisBound[];
  /** Worst per-cell failure rate observed inside the region; `null` when `status === "none"`. */
  worst_case_failure_rate: number | null;
}

/** A safe-region bound on one axis (discrete: allowed values; continuous: bin range). */
export interface RiskSurfaceAxisBound {
  axis: string;
  kind: RiskSurfaceAxisKind;
  /** Discrete only: the declared values that stay under threshold. */
  allowed_values?: JsonScalar[];
  /** Continuous only: the contiguous bin range that stays under threshold. */
  bin_range?: RiskSurfaceBinRange;
}

/** A contiguous run of continuous bins, expressed by edge bounds and bin indices. */
export interface RiskSurfaceBinRange {
  /** Inclusive lower edge of the first safe bin; `null` if open below. */
  lower: number | null;
  /** Upper edge of the last safe bin; `null` if open above. */
  upper: number | null;
  /** The bin indices spanned, ascending. */
  bin_indices: number[];
}

// ---------------------------------------------------------------------------
// Producer (T02) — turn enriched campaign runs into a risk-surface document.
// ---------------------------------------------------------------------------

/**
 * The bounded-claim string emitted on every surface (R4.4). Mirrors the
 * campaign-summary boundary: simulation evidence over a declared, fixed-seed
 * parameter region, never protocol safety or a mainnet prediction.
 */
export const RISK_SURFACE_CLAIM_BOUNDARY =
  "This surface reports invariant-failure rates and metric percentiles observed " +
  "within this campaign's declared, fixed-seed parameter region and run budget. " +
  "It is evidence over that region only, not a proof of protocol safety or a " +
  "prediction of mainnet behavior.";

/**
 * One enriched run reduced to exactly what the surface needs: its axis
 * coordinates ({@link sampledParameters}) and outcome. The producer is
 * decoupled from `aggregation.ts`'s `EnrichedRun` so `surface.ts` has no import
 * cycle; the call site maps `EnrichedRun` → this shape.
 */
export interface RiskSurfaceRunInput {
  /** Deterministic run index; only used for stable ordering of diagnostics. */
  runIndex: number;
  /** Run status; a cell's failures are the runs whose status is `"fail"`. */
  status: "pass" | "fail" | "error" | "skipped";
  /** The sampled axis coordinates for this run. */
  sampledParameters: Record<string, JsonScalar>;
  /** Lending bad-debt metric (`EnrichedRun.metrics.totalBadDebt`). */
  badDebt: number | null;
  /** Lending utilization metric (`EnrichedRun.metrics.maxUtilization`). */
  utilization: number | null;
  /** Lending TVL floor metric (`EnrichedRun.metrics.minTvl`). */
  tvl: number | null;
  /** Lending available-liquidity floor (`EnrichedRun.metrics.minAvailableLiquidity`). */
  availableLiquidity: number | null;
  /** Deterministic risk score (`EnrichedRun.metrics.riskScore`); generic-class metric. */
  riskScore: number;
}

/** Optional overrides for the surface-config thresholds; each defaults to its constant. */
export interface RiskSurfaceConfigOverrides {
  safeRegionFailureRateThreshold?: number;
  minCellRunCount?: number;
  defaultContinuousBinCount?: number;
}

/** Everything the producer needs to build a {@link RiskSurfaceDocument}. */
export interface BuildRiskSurfaceInput {
  campaign: {
    campaignId: string;
    campaignDigest: string;
    name: string;
    semanticClass: string;
    riskObjective: string;
    seedPolicyDisplay: string;
    runBudget: number;
    requestedRuns: number;
  };
  /** The campaign's declared parameter distributions (axes are derived from these). */
  parameters: Record<string, ParameterDistribution>;
  runs: RiskSurfaceRunInput[];
  config?: RiskSurfaceConfigOverrides;
}

/**
 * Build the canonical risk-surface document from enriched runs. Pure and
 * deterministic: every ordering and numeric choice is fixed (see the
 * determinism contract at the top of this file). Serialize with
 * {@link serializeRiskSurface}.
 */
export function buildRiskSurfaceDocument(input: BuildRiskSurfaceInput): RiskSurfaceDocument {
  const config = resolveConfig(input.config);
  const isLending = input.campaign.semanticClass === "lending.v1";
  const metrics: RiskSurfaceMetricKey[] = isLending
    ? [...LENDING_SURFACE_METRICS]
    : [...GENERIC_SURFACE_METRICS];

  const axes = buildAxes(input.parameters, config.default_continuous_bin_count);
  const warnings: string[] = [];

  // Place each run onto the grid. Runs missing a swept-axis coordinate cannot
  // be positioned and are excluded (never silently — a warning is emitted).
  const placements = new Map<string, RiskSurfaceRunInput[]>();
  let unplaceable = 0;
  for (const run of input.runs) {
    const coord = placeRun(run, axes);
    if (!coord) {
      unplaceable += 1;
      continue;
    }
    const key = coord.join(",");
    const bucket = placements.get(key);
    if (bucket) bucket.push(run);
    else placements.set(key, [run]);
  }
  if (unplaceable > 0) {
    warnings.push(
      `${unplaceable} run(s) omitted from the surface grid: missing a sampled value for one or more swept axes`
    );
  }

  // Emit a complete grid: every coordinate combination becomes a cell, even
  // when empty, so positions are stable across runs (R2.4: never drop cells).
  const cells: RiskSurfaceCell[] = [];
  let sparsePopulated = 0;
  let emptyCells = 0;
  for (const coord of cartesianBinIndices(axes)) {
    const key = coord.join(",");
    const runs = placements.get(key) ?? [];
    const runCount = runs.length;
    const failed = runs.filter((run) => run.status === "fail").length;
    const sparse = runCount < config.min_cell_run_count;
    if (runCount === 0) emptyCells += 1;
    else if (sparse) sparsePopulated += 1;
    cells.push({
      coords: axes.map((axis, position) => ({ axis: axis.name, bin_index: coord[position]! })),
      run_count: runCount,
      invariant_failure_rate: runCount === 0 ? 0 : roundNumber(failed / runCount),
      metrics: cellMetricPercentiles(metrics, runs),
      sparse
    });
  }
  if (sparsePopulated > 0) {
    warnings.push(
      `${sparsePopulated} populated cell(s) have fewer than ${config.min_cell_run_count} run(s); ` +
        "treat their failure rates and percentiles as low-confidence."
    );
  }
  if (emptyCells > 0) {
    warnings.push(`${emptyCells} grid cell(s) received no runs in this campaign's budget.`);
  }
  if (axes.length === 0) {
    warnings.push(
      "Campaign declared no varying parameters; the surface is a single aggregate cell over all runs."
    );
  }

  const sensitivity = buildSensitivity(axes, input.runs);
  const safeRegion = buildSafeRegion(axes, cells, config.safe_region_failure_rate_threshold);

  const document: Omit<RiskSurfaceDocument, "surface_digest"> = {
    schema_version: RISK_SURFACE_SCHEMA_VERSION,
    campaign: {
      campaign_id: input.campaign.campaignId,
      campaign_digest: input.campaign.campaignDigest,
      name: input.campaign.name,
      class: input.campaign.semanticClass,
      risk_objective: input.campaign.riskObjective,
      seed_policy: input.campaign.seedPolicyDisplay,
      run_budget: input.campaign.runBudget,
      requested_runs: input.campaign.requestedRuns
    },
    config,
    metrics,
    axes,
    cells,
    sensitivity,
    safe_region: safeRegion,
    warnings,
    claim_boundary: RISK_SURFACE_CLAIM_BOUNDARY
  };

  const surfaceDigest = sha256Hex(
    `${RISK_SURFACE_HASH_PREFIX}\n${canonicalJson(document as unknown as JsonValue)}`
  );
  return { ...document, surface_digest: surfaceDigest };
}

/** Serialize a surface document to its canonical, byte-stable on-disk form. */
export function serializeRiskSurface(document: RiskSurfaceDocument): string {
  return canonicalJson(document as unknown as JsonValue);
}

function resolveConfig(overrides: RiskSurfaceConfigOverrides | undefined): RiskSurfaceConfig {
  return {
    safe_region_failure_rate_threshold:
      overrides?.safeRegionFailureRateThreshold ?? DEFAULT_SAFE_REGION_THRESHOLD,
    min_cell_run_count: overrides?.minCellRunCount ?? DEFAULT_MIN_CELL_RUN_COUNT,
    default_continuous_bin_count:
      overrides?.defaultContinuousBinCount ?? DEFAULT_CONTINUOUS_BIN_COUNT,
    percentile_interpolation: "linear"
  };
}

// --- Axes & binning --------------------------------------------------------

/**
 * Derive the swept axes from the declared parameters. A parameter becomes an
 * axis only when it yields ≥ 2 bins (i.e. it actually varies); `fixed` values
 * and single-value `discrete` distributions collapse to one bin and carry no
 * surface information, so they are not axes. Sorted ascending by name to match
 * `campaign-summary.v1`'s parameter ordering.
 */
function buildAxes(
  parameters: Record<string, ParameterDistribution>,
  defaultContinuousBinCount: number
): RiskSurfaceAxis[] {
  const axes: RiskSurfaceAxis[] = [];
  for (const name of Object.keys(parameters).sort((a, b) => a.localeCompare(b))) {
    const distribution = parameters[name]!;
    const axis = buildAxis(name, distribution, defaultContinuousBinCount);
    if (axis && axis.bins.length >= 2) axes.push(axis);
  }
  return axes;
}

function buildAxis(
  name: string,
  distribution: ParameterDistribution,
  defaultContinuousBinCount: number
): RiskSurfaceAxis | null {
  const base = {
    name,
    distribution: distributionLabel(distribution),
    ...(distribution.unit !== undefined ? { unit: distribution.unit } : {})
  };
  if (distribution.distribution === "fixed" || distribution.distribution === "discrete") {
    const values = distribution.distribution === "fixed"
      ? [distribution.value]
      : uniqueScalars(distribution.values);
    const bins: RiskSurfaceBin[] = values.map((value, index) => ({
      index,
      label: scalarDisplay(value),
      value
    }));
    return { ...base, kind: "discrete", binning: { method: "value" }, bins };
  }

  // Continuous (uniform / log-uniform): fixed-width edges over [min, max].
  if (!(distribution.max > distribution.min)) {
    // Degenerate range collapses to a single point → one bin, not a swept axis.
    const lower = roundNumber(distribution.min);
    return {
      ...base,
      kind: "continuous",
      binning: { method: "fixed-width", edges: [lower, lower] },
      bins: [{ index: 0, label: `[${lower}, ${lower}]`, lower, upper: lower }]
    };
  }
  const edges = continuousEdges(distribution.min, distribution.max, defaultContinuousBinCount);
  const bins: RiskSurfaceBin[] = [];
  for (let index = 0; index < edges.length - 1; index += 1) {
    const lower = edges[index]!;
    const upper = edges[index + 1]!;
    const isLast = index === edges.length - 2;
    bins.push({
      index,
      label: `[${lower}, ${upper}${isLast ? "]" : ")"}`,
      lower,
      upper
    });
  }
  return { ...base, kind: "continuous", binning: { method: "fixed-width", edges }, bins };
}

function continuousEdges(min: number, max: number, binCount: number): number[] {
  const edges: number[] = [];
  for (let index = 0; index <= binCount; index += 1) {
    edges.push(roundNumber(min + ((max - min) * index) / binCount));
  }
  // Pin the endpoints exactly so rounding cannot drift the declared range.
  edges[0] = roundNumber(min);
  edges[binCount] = roundNumber(max);
  return edges;
}

/** Cartesian product of every axis's bin indices, in lexicographic order (first axis most significant). */
function cartesianBinIndices(axes: RiskSurfaceAxis[]): number[][] {
  let combos: number[][] = [[]];
  for (const axis of axes) {
    const next: number[][] = [];
    for (const combo of combos) {
      for (const bin of axis.bins) next.push([...combo, bin.index]);
    }
    combos = next;
  }
  return combos;
}

/** Coordinate (one bin index per axis) for a run, or `null` if it cannot be placed. */
function placeRun(run: RiskSurfaceRunInput, axes: RiskSurfaceAxis[]): number[] | null {
  const coord: number[] = [];
  for (const axis of axes) {
    const value = run.sampledParameters[axis.name];
    if (value === undefined) return null;
    const index = axis.kind === "discrete"
      ? placeDiscrete(axis, value)
      : placeContinuous(axis, value);
    if (index < 0) return null;
    coord.push(index);
  }
  return coord;
}

function placeDiscrete(axis: RiskSurfaceAxis, value: JsonScalar): number {
  const key = JSON.stringify(value);
  for (const bin of axis.bins) {
    if (JSON.stringify(bin.value ?? null) === key) return bin.index;
  }
  return -1;
}

function placeContinuous(axis: RiskSurfaceAxis, value: JsonScalar): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return -1;
  const binning = axis.binning;
  if (binning.method !== "fixed-width") return -1;
  const edges = binning.edges;
  const lastBin = edges.length - 2;
  if (lastBin < 0) return -1;
  if (value <= edges[0]!) return 0;
  if (value >= edges[edges.length - 1]!) return lastBin;
  for (let index = 0; index < edges.length - 1; index += 1) {
    if (value >= edges[index]! && value < edges[index + 1]!) return index;
  }
  return lastBin;
}

// --- Per-cell metric percentiles -------------------------------------------

function cellMetricPercentiles(
  metrics: RiskSurfaceMetricKey[],
  runs: RiskSurfaceRunInput[]
): Record<string, RiskSurfaceMetricPercentiles> {
  const out: Record<string, RiskSurfaceMetricPercentiles> = {};
  for (const metric of metrics) {
    const samples = runs
      .map((run) => metricValue(run, metric))
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b);
    out[metric] = {
      count: samples.length,
      p10: percentile(samples, 0.1),
      p50: percentile(samples, 0.5),
      p90: percentile(samples, 0.9)
    };
  }
  return out;
}

function metricValue(run: RiskSurfaceRunInput, metric: RiskSurfaceMetricKey): number | null {
  switch (metric) {
    case "bad_debt":
      return run.badDebt;
    case "utilization":
      return run.utilization;
    case "tvl":
      return run.tvl;
    case "available_liquidity":
      return run.availableLiquidity;
    case "risk_score":
      return run.riskScore;
    default:
      return null;
  }
}

/**
 * Fixed linear ("type-7" / NumPy-default) percentile over ascending samples.
 * `n === 0` → null; `n === 1` → the single sample. Result rounded to 6 decimals.
 */
function percentile(sortedAscending: number[], q: number): number | null {
  const n = sortedAscending.length;
  if (n === 0) return null;
  if (n === 1) return roundNumber(sortedAscending[0]!);
  const h = (n - 1) * q;
  const lower = Math.floor(h);
  const upper = Math.ceil(h);
  const value = sortedAscending[lower]! + (h - lower) * (sortedAscending[upper]! - sortedAscending[lower]!);
  return roundNumber(value);
}

// --- Sensitivity (baseline; refined in the ranking step) -------------------

const SENSITIVITY_METHOD =
  "Per-axis marginal invariant-failure-rate spread: for each axis, the failure " +
  "rate is computed per bin by marginalizing over the other axes (failed runs / " +
  "runs in that bin), and the spread is max − min across that axis's populated " +
  "bins. Axes are ranked by spread descending, ties broken by axis name ascending. " +
  "The monotonic note compares consecutive populated bins by increasing bin index. " +
  "The elasticity note is the signed average failure-rate change per bin step from " +
  "the first to the last populated bin: (rate_last − rate_first) / (index_last − " +
  "index_first); positive means risk rises with the axis.";

function buildSensitivity(
  axes: RiskSurfaceAxis[],
  runs: RiskSurfaceRunInput[]
): RiskSurfaceSensitivity {
  const entries = axes.map((axis) => axisSensitivity(axis, runs));
  entries.sort(
    (a, b) =>
      compareNumbersDesc(a.failure_rate_spread, b.failure_rate_spread) ||
      a.axis.localeCompare(b.axis)
  );
  const ranking = entries.map((entry, index) => ({ ...entry, rank: index + 1 }));
  return { method: SENSITIVITY_METHOD, ranking };
}

function axisSensitivity(
  axis: RiskSurfaceAxis,
  runs: RiskSurfaceRunInput[]
): Omit<RiskSurfaceAxisSensitivity, "rank"> {
  const perBinRate: Array<number | null> = axis.bins.map(() => null);
  const perBinTotal: number[] = axis.bins.map(() => 0);
  const perBinFailed: number[] = axis.bins.map(() => 0);
  for (const run of runs) {
    const value = run.sampledParameters[axis.name];
    if (value === undefined) continue;
    const index = axis.kind === "discrete" ? placeDiscrete(axis, value) : placeContinuous(axis, value);
    if (index < 0) continue;
    perBinTotal[index]! += 1;
    if (run.status === "fail") perBinFailed[index]! += 1;
  }
  const populated: number[] = [];
  for (let index = 0; index < axis.bins.length; index += 1) {
    if (perBinTotal[index]! > 0) {
      const rate = roundNumber(perBinFailed[index]! / perBinTotal[index]!);
      perBinRate[index] = rate;
      populated.push(rate);
    }
  }
  const min = populated.length > 0 ? Math.min(...populated) : 0;
  const max = populated.length > 0 ? Math.max(...populated) : 0;
  return {
    axis: axis.name,
    failure_rate_spread: roundNumber(max - min),
    min_bin_failure_rate: roundNumber(min),
    max_bin_failure_rate: roundNumber(max),
    monotonic: monotonicityOf(perBinRate),
    elasticity: elasticityOf(perBinRate)
  };
}

/**
 * Signed average failure-rate change per bin step from the first populated bin
 * to the last populated bin. `null` when fewer than two bins are populated (the
 * slope is undefined). Deterministic: bin indices are fixed and rounding is the
 * shared 6-decimal convention.
 */
function elasticityOf(perBinRate: Array<number | null>): number | null {
  let firstIndex = -1;
  let lastIndex = -1;
  for (let index = 0; index < perBinRate.length; index += 1) {
    if (perBinRate[index] === null) continue;
    if (firstIndex < 0) firstIndex = index;
    lastIndex = index;
  }
  if (firstIndex < 0 || firstIndex === lastIndex) return null;
  const rise = perBinRate[lastIndex]! - perBinRate[firstIndex]!;
  return roundNumber(rise / (lastIndex - firstIndex));
}

function monotonicityOf(perBinRate: Array<number | null>): RiskSurfaceMonotonicity | null {
  const sequence = perBinRate.filter((rate): rate is number => rate !== null);
  if (sequence.length < 2) return null;
  let increasing = false;
  let decreasing = false;
  for (let index = 1; index < sequence.length; index += 1) {
    const delta = sequence[index]! - sequence[index - 1]!;
    if (delta > 0) increasing = true;
    else if (delta < 0) decreasing = true;
  }
  if (increasing && decreasing) return "non-monotonic";
  if (increasing) return "increasing";
  if (decreasing) return "decreasing";
  return "flat";
}

// --- Safe region ------------------------------------------------------------

function buildSafeRegion(
  axes: RiskSurfaceAxis[],
  cells: RiskSurfaceCell[],
  threshold: number
): RiskSurfaceSafeRegion {
  const populated = cells.filter((cell) => cell.run_count > 0);
  if (populated.length === 0) {
    return {
      threshold,
      status: "none",
      message:
        "No populated cells were available, so no safe region within this declared parameter region could be identified.",
      bounds: [],
      worst_case_failure_rate: null
    };
  }
  const safe = populated.filter((cell) => cell.invariant_failure_rate <= threshold);
  if (safe.length === 0) {
    return {
      threshold,
      status: "none",
      message:
        `No cell stayed at or under the ${formatRate(threshold)} failure-rate threshold within ` +
        "this declared, fixed-seed parameter region.",
      bounds: [],
      worst_case_failure_rate: null
    };
  }
  if (safe.length === populated.length) {
    const worst = roundNumber(Math.max(...safe.map((cell) => cell.invariant_failure_rate)));
    const bounds = axes.map((axis, position) => axisBoundFromCells(axis, position, safe));
    return {
      threshold,
      status: "entire-region",
      message:
        `Every populated cell stayed at or under the ${formatRate(threshold)} failure-rate threshold ` +
        "within this declared, fixed-seed parameter region.",
      bounds,
      worst_case_failure_rate: worst
    };
  }
  const region = selectSafeRegion(axes, populated, threshold);
  if (!region) {
    return {
      threshold,
      status: "none",
      message:
        `No representable region stayed at or under the ${formatRate(threshold)} failure-rate threshold ` +
        "within this declared, fixed-seed parameter region.",
      bounds: [],
      worst_case_failure_rate: null
    };
  }
  return {
    threshold,
    status: "found",
    message:
      `Recommended bounds are a single representable region whose populated cells stayed at or under the ` +
      `${formatRate(threshold)} failure-rate threshold within this declared, fixed-seed parameter region.`,
    bounds: axes.map((axis, position) => axisBoundForIndices(axis, region.intervals[position]?.indices ?? [])),
    worst_case_failure_rate: region.worst
  };
}

interface SafeRegionInterval {
  lower: number;
  upper: number;
  indices: number[];
}

interface SafeRegionCandidate {
  intervals: SafeRegionInterval[];
  cells: RiskSurfaceCell[];
  coveredRuns: number;
  volume: number;
  worst: number;
  key: string;
}

function selectSafeRegion(
  axes: RiskSurfaceAxis[],
  populatedCells: RiskSurfaceCell[],
  threshold: number
): SafeRegionCandidate | null {
  const safeCells = populatedCells.filter((cell) => cell.invariant_failure_rate <= threshold);
  const intervalsByAxis = axes.map((_axis, position) => candidateIntervalsForAxis(safeCells, position));
  let best: SafeRegionCandidate | null = null;
  for (const intervals of cartesianIntervals(intervalsByAxis)) {
    const regionCells = populatedCells.filter((cell) => cellInRegion(cell, intervals));
    if (regionCells.length === 0) continue;
    if (regionCells.some((cell) => cell.invariant_failure_rate > threshold)) continue;
    const candidate = regionCandidate(intervals, regionCells);
    if (isBetterRegion(candidate, best)) best = candidate;
  }
  return best;
}

function candidateIntervalsForAxis(
  safeCells: RiskSurfaceCell[],
  position: number
): SafeRegionInterval[] {
  const safeIndices = [...new Set(safeCells.map((cell) => cell.coords[position]?.bin_index))]
    .filter((index): index is number => index !== undefined)
    .sort((a, b) => a - b);
  const intervals: SafeRegionInterval[] = [];
  for (let start = 0; start < safeIndices.length; start += 1) {
    for (let end = start; end < safeIndices.length; end += 1) {
      const lower = safeIndices[start]!;
      const upper = safeIndices[end]!;
      intervals.push({ lower, upper, indices: binIndexRange(lower, upper) });
    }
  }
  return intervals;
}

function cartesianIntervals(intervalsByAxis: SafeRegionInterval[][]): SafeRegionInterval[][] {
  let combos: SafeRegionInterval[][] = [[]];
  for (const intervals of intervalsByAxis) {
    const next: SafeRegionInterval[][] = [];
    for (const combo of combos) {
      for (const interval of intervals) next.push([...combo, interval]);
    }
    combos = next;
  }
  return combos;
}

function cellInRegion(cell: RiskSurfaceCell, intervals: SafeRegionInterval[]): boolean {
  return intervals.every((interval, position) => {
    const index = cell.coords[position]?.bin_index;
    return index !== undefined && index >= interval.lower && index <= interval.upper;
  });
}

function regionCandidate(
  intervals: SafeRegionInterval[],
  cells: RiskSurfaceCell[]
): SafeRegionCandidate {
  const coveredRuns = cells.reduce((sum, cell) => sum + cell.run_count, 0);
  const volume = intervals.reduce((product, interval) => product * interval.indices.length, 1);
  const worst = roundNumber(Math.max(...cells.map((cell) => cell.invariant_failure_rate)));
  const key = intervals.map((interval) => `${interval.lower}-${interval.upper}`).join("|");
  return { intervals, cells, coveredRuns, volume, worst, key };
}

function isBetterRegion(candidate: SafeRegionCandidate, best: SafeRegionCandidate | null): boolean {
  if (!best) return true;
  if (candidate.coveredRuns !== best.coveredRuns) return candidate.coveredRuns > best.coveredRuns;
  if (candidate.cells.length !== best.cells.length) return candidate.cells.length > best.cells.length;
  if (candidate.worst !== best.worst) return candidate.worst < best.worst;
  if (candidate.volume !== best.volume) return candidate.volume < best.volume;
  return candidate.key < best.key;
}

function axisBoundFromCells(
  axis: RiskSurfaceAxis,
  position: number,
  safeCells: RiskSurfaceCell[]
): RiskSurfaceAxisBound {
  const safeBinIndices = new Set<number>();
  for (const cell of safeCells) {
    const index = cell.coords[position]?.bin_index;
    if (index !== undefined) safeBinIndices.add(index);
  }
  return axisBoundForIndices(axis, [...safeBinIndices]);
}

function axisBoundForIndices(
  axis: RiskSurfaceAxis,
  binIndices: number[]
): RiskSurfaceAxisBound {
  const indices = [...new Set(binIndices)].sort((a, b) => a - b);
  if (axis.kind === "discrete") {
    const allowed = axis.bins
      .filter((bin) => indices.includes(bin.index))
      .map((bin) => bin.value ?? null);
    return { axis: axis.name, kind: "discrete", allowed_values: allowed };
  }
  const minIndex = indices[0]!;
  const maxIndex = indices[indices.length - 1]!;
  const lowerBin = axis.bins[minIndex];
  const upperBin = axis.bins[maxIndex];
  return {
    axis: axis.name,
    kind: "continuous",
    bin_range: {
      lower: lowerBin?.lower ?? null,
      upper: upperBin?.upper ?? null,
      bin_indices: binIndexRange(minIndex, maxIndex)
    }
  };
}

function binIndexRange(lower: number, upper: number): number[] {
  const out: number[] = [];
  for (let index = lower; index <= upper; index += 1) out.push(index);
  return out;
}

// --- Shared deterministic helpers (kept local to avoid an aggregation cycle) ---

function distributionLabel(distribution: ParameterDistribution): string {
  if (distribution.distribution === "fixed") {
    return `fixed(${scalarDisplay(distribution.value)})`;
  }
  if (distribution.distribution === "discrete") {
    return `discrete(${distribution.values.map(scalarDisplay).join("|")})`;
  }
  return `${distribution.distribution}(${distribution.min}..${distribution.max}${distribution.integer ? ", integer" : ""})`;
}

function scalarDisplay(value: JsonScalar): string {
  return value === null ? "null" : String(value);
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
  return out;
}

function formatRate(rate: number): string {
  return `${roundNumber(rate * 100)}%`;
}

function compareNumbersDesc(a: number, b: number): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

function roundNumber(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1_000_000) / 1_000_000;
}
