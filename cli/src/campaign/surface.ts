import type { JsonScalar } from "./schema.js";

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
 * any retained-case bytes. The summary/manifest gain only an additive *path
 * reference* to it (added in T02), never a reordering of existing fields.
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
   * Monotonicity note over the axis's bins by increasing bin index (R3.1,
   * cuttable). `null` when undefined (fewer than two populated bins).
   */
  monotonic: RiskSurfaceMonotonicity | null;
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
