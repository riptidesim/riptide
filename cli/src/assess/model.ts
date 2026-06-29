import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type {
  CampaignRetentionManifest,
  CampaignRetentionRiskSignals,
  CampaignSummaryJson
} from "../campaign/aggregation.js";
import type {
  RiskSurfaceAxis,
  RiskSurfaceAxisBound,
  RiskSurfaceCell,
  RiskSurfaceDocument,
  RiskSurfaceSafeRegionStatus
} from "../campaign/surface.js";
import type { JsonScalar } from "../campaign/schema.js";
import type { ExecutionHonestyReport } from "../sim/honesty-gates.js";
import { RISK_SURFACE_HASH_PREFIX } from "../campaign/surface.js";
import { canonicalJson, sha256Hex, type JsonValue } from "../state-pack/json.js";

/**
 * assessment.v1 — the deterministic protocol-assessment model + ingestion.
 *
 * ## What this is (R1.2)
 *
 * Sprint 39 produced the quantitative substrate: a campaign root holding
 * `campaign-summary.json` (identity + totals + lending observations), a
 * canonical-hashed `risk-surface.json` ({@link RiskSurfaceDocument}: per-cell
 * failure rate, sensitivity ranking, safe-region recommendation), and a
 * retention manifest. This module fuses those existing artifacts — plus
 * optional run/pack evidence and the Sprint 38 Risk Plan / coverage / verdict
 * vocabulary — into a single `assessment.v1` model that the markdown renderer
 * (T02) and auto-narrative generator (T03) consume.
 *
 * ## Ingest-only (R1.5)
 *
 * Ingestion is pure I/O over already-written artifacts: it reads the three JSON
 * files from a campaign root and folds caller-supplied scoping inputs over
 * them. It NEVER runs the engine. You run `riptide sim run` then
 * `riptide sim surface` to write the root, then `riptide assess <guided-sim-root>`.
 *
 * ## Determinism contract (load-bearing, mirrors `surface.ts`)
 *
 * `assessment.json` must be byte-stable for fixed inputs so a reviewer can
 * rerun `riptide assess` and `sha256sum assessment.json` to an identical value
 * (the R6.4 gate). Every ordering and numeric choice is fixed and derived only
 * from the ingested artifacts + declared inputs — never from wall-clock, file
 * order, or `Map`/`Object` insertion order:
 *
 * 1. **No wall-clock.** `assessment_date` is explicit-input first, then derived
 *    from deterministic evidence metadata (run-collection dates or declared
 *    fixed seed dates). `riptide_version` defaults to `null`; nothing samples the
 *    environment at build time.
 * 2. **Row ordering.** Coverage rows sort by `(priority rank, flow name)`;
 *    retained-evidence rows follow the manifest's already-deterministic label
 *    order; simulation rows follow their declared order then objective.
 * 3. **Number formatting.** Rates are rounded to 6 decimals with the shared
 *    {@link roundNumber} convention (the same one `aggregation.ts`/`surface.ts`
 *    use) so floating-point tails cannot perturb the bytes.
 * 4. **Embedded surface.** The full {@link RiskSurfaceDocument} is embedded
 *    verbatim (it is already canonical + self-digested) so the assessment hash
 *    transitively covers the surface, and T02 can render the heatmap from the
 *    model alone.
 * 5. **Canonical JSON + self-digest.** Serialized via `canonicalJson`; the
 *    embedded {@link AssessmentModel.assessment_digest} uses the same
 *    domain-prefixed self-hash pattern as the surface + retained-case manifest.
 *
 * ## Narrative seam (R2.5 / R3 — defined here so T02 + T03 parallelize)
 *
 * The hashed model is *facts only*. Prose (executive summary, findings,
 * non-findings, the safe-region recommendation) is a separate deterministic
 * projection over the model: {@link AssessmentNarrative}, produced by a
 * {@link NarrativeProvider}. T03 implements the real generator in
 * `narrative.ts`; this module ships {@link stubNarrative} so T02 can render and
 * the build compiles before T03 lands. Keeping prose out of `assessment.json`
 * avoids a circular hash (narrative derived from a model that contains it) and
 * keeps the canonical artifact stable while the narrative generator evolves.
 */
export const ASSESSMENT_SCHEMA_VERSION = "assessment.v1" as const;

/** Domain-separation prefix for the embedded {@link AssessmentModel.assessment_digest}. */
export const ASSESSMENT_HASH_PREFIX = "riptide-assessment-v1" as const;

/**
 * The bounded-claim string stamped on every assessment (R3.3 / Sprint 38
 * boundary). Simulation evidence over a declared, fixed-seed region — never
 * audit signoff, formal verification, complete protocol safety, or a mainnet
 * prediction.
 */
export const ASSESSMENT_CLAIM_BOUNDARY =
  "This assessment records simulation evidence observed within the campaign's " +
  "declared, fixed-seed parameter region and run budget. It is evidence over " +
  "that region only — not audit signoff, formal verification, complete " +
  "protocol safety, or a prediction of mainnet behavior.";

// ---------------------------------------------------------------------------
// Vocabulary (R1.3)
// ---------------------------------------------------------------------------

/** Sprint 38 coverage-matrix status values. */
export const COVERAGE_STATUSES = [
  "covered",
  "covered by guided sim",
  "blocked",
  "out of scope",
  "not assessed"
] as const;

export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

/** Send/readiness verdict vocabulary. */
export const ASSESSMENT_VERDICTS = [
  "ready_to_send",
  "needs_guided_sim",
  "needs_campaign_tuning",
  "blocked",
  "unsupported"
] as const;

export type AssessmentVerdict = (typeof ASSESSMENT_VERDICTS)[number];

/**
 * Assessment **shape** discriminator (R1.1). A `cartography` assessment is the
 * Sprint 39/40 parameter-swept, risk-surface-led shape (failure gradient over a
 * declared region). A `correctness` assessment is the surface-less, binary-risk
 * shape (accounting drift / double-payment / wrong-recipient / unauthorized
 * control) whose evidence is guided-sim rejection + invariant holds, not a
 * heatmap.
 *
 * Discriminator-stability note: the field is deliberately *optional* on
 * {@link AssessmentModel}. The cartography builder NEVER sets it, so Sprint 46's
 * additive `coverage_statement` JSON move does not also churn a `shape` key; a
 * `cartography` model is recognized by `surface !== null`. Only the correctness
 * builder stamps `shape: "correctness"`. Use {@link assessmentShape} to read the
 * effective shape from any model.
 */
export const ASSESSMENT_SHAPES = ["cartography", "correctness"] as const;

export type AssessmentShape = (typeof ASSESSMENT_SHAPES)[number];

/** Additive, machine-readable negative-space block embedded in `assessment.json`. */
export const ASSESSMENT_COVERAGE_STATEMENT_SCHEMA =
  "assessment-coverage-statement.v1" as const;

// ---------------------------------------------------------------------------
// Model root
// ---------------------------------------------------------------------------

/** Top-level `assessment.json` document — the canonical, self-digested model. */
export interface AssessmentModel {
  schema_version: typeof ASSESSMENT_SCHEMA_VERSION;
  /**
   * Assessment shape (R1.1). **Optional and absent on cartography models** so
   * the additive Sprint 46 `coverage_statement` JSON move does not also introduce
   * discriminator churn; present and set to `"correctness"` only on surface-less
   * models. Read via {@link assessmentShape}.
   */
  shape?: AssessmentShape;
  protocol: AssessmentProtocolIdentity;
  /** Campaign identity, or `null` on a correctness assessment with no campaign. */
  campaign: AssessmentCampaignReference | null;
  /** Run totals, or `null` on a correctness assessment with no campaign. */
  totals: AssessmentCampaignTotals | null;
  verdict: AssessmentVerdictBlock;
  risk_plan: AssessmentRiskPlan;
  scope: AssessmentScope;
  /** Sorted by `(priority rank, flow)`. */
  coverage_matrix: AssessmentCoverageRow[];
  /**
   * Additive structured coverage / negative-space block: what was probed, where
   * failures concentrated, where the model saw no signal, and which declared
   * flows were blocked, out of scope, or not assessed. It is facts only and is
   * included in the assessment digest.
   */
  coverage_statement: AssessmentCoverageStatement;
  /** Simulation evidence rows; the ingested campaign plus any attached evidence. */
  simulations: AssessmentSimulation[];
  /**
   * The full, verbatim risk-surface document (already canonical + self-digested),
   * or `null` on a correctness assessment. When `null` it serializes
   * deterministically as `"surface":null` (R1.3 — no field churn).
   */
  surface: RiskSurfaceDocument | null;
  /** Deterministic distillation of the surface for verdict + narrative use; `null` when there is no surface. */
  surface_highlights: AssessmentSurfaceHighlights | null;
  /**
   * Correctness-shape evidence (guided-sim + run/pack), **optional and absent on
   * cartography models** so their bytes are untouched; present on correctness
   * models. The surface-less analogue of {@link AssessmentModel.surface}.
   */
  correctness?: AssessmentCorrectnessEvidence;
  /** Retained evidence, in the manifest's declared label order. */
  retained_evidence: AssessmentRetainedEvidence[];
  /** Optional attached run/pack evidence (ingest-only references). */
  external_evidence: AssessmentExternalEvidence[];
  /**
   * Guided-sim-only execution-honesty gate report. Absent for real campaign
   * assessments so frozen campaign artifacts do not pick up guided-sim state.
   */
  execution_honesty?: ExecutionHonestyReport;
  reproduction: AssessmentReproduction;
  claim_boundary: string;
  /**
   * Self-digest: `sha256Hex(`${ASSESSMENT_HASH_PREFIX}\n${canonicalJson(model
   * without this field)}`)`.
   */
  assessment_digest: string;
}

/**
 * A cartography assessment narrowed so the surface, its highlights, and the
 * campaign identity/totals are guaranteed present. {@link buildAssessmentModel}
 * and {@link ingestAssessment} return this; the existing renderer + narrative
 * (the cartography path) operate on it so the Sprint 40 flagship path keeps its
 * non-null guarantees with no churn. Use {@link requireCartographyModel} to
 * narrow an arbitrary {@link AssessmentModel}.
 */
export interface CartographyAssessmentModel extends AssessmentModel {
  campaign: AssessmentCampaignReference;
  totals: AssessmentCampaignTotals;
  surface: RiskSurfaceDocument;
  surface_highlights: AssessmentSurfaceHighlights;
}

/** Protocol identity (Sprint 38 executive-summary header). */
export interface AssessmentProtocolIdentity {
  name: string;
  repository: string | null;
  commit: string | null;
  /** Riptide version/commit; `null` unless the caller passes it (determinism). */
  riptide_version: string | null;
  /** ISO date string from explicit inputs or deterministic evidence metadata. */
  assessment_date: string | null;
}

/** Campaign identity mirrored from `campaign-summary.v1` (no absolute paths). */
export interface AssessmentCampaignReference {
  campaign_id: string;
  campaign_digest: string;
  name: string;
  class: string;
  risk_objective: string;
  seed_policy: string;
  run_budget: number;
  requested_runs: number;
  adapter: string;
}

/** Run totals copied from `campaign-summary.v1`. */
export interface AssessmentCampaignTotals {
  requested_runs: number;
  completed_runs: number;
  passed_runs: number;
  invariant_failed_runs: number;
  setup_errors: number;
  skipped_runs: number;
  invariant_failure_rate: number;
}

/** The send/readiness verdict + how it was reached. */
export interface AssessmentVerdictBlock {
  value: AssessmentVerdict;
  /** `declared` when the caller set it; `derived` when computed from the campaign. */
  source: "declared" | "derived";
  /** Deterministic, bounded one-line rationale. */
  rationale: string;
}

/** Sprint 38 Risk Plan vocabulary. */
export interface AssessmentRiskPlan {
  protocol_class: string;
  target_claim: string;
  evidence_profile: string[];
  p0_flows: string[];
  p1_flows: string[];
  expected_failure_modes: string[];
  guided_sim_boundaries: string[];
  known_coverage_limits: string[];
}

/** In/out scope + the claim boundary. */
export interface AssessmentScope {
  in_scope: string[];
  out_of_scope: string[];
  claim_boundary: string;
}

/** One coverage-matrix row. */
export interface AssessmentCoverageRow {
  priority: string;
  flow: string;
  status: CoverageStatus;
  evidence_tier: string;
  commands: string[];
  artifacts: string[];
  notes: string;
}

/** Structured coverage / negative-space facts embedded in `assessment.json`. */
export interface AssessmentCoverageStatement {
  schema_version: typeof ASSESSMENT_COVERAGE_STATEMENT_SCHEMA;
  shape: AssessmentShape;
  probed: AssessmentCoverageProbe;
  /** Failing cells or guided-sim unexpected results, sorted hottest first. */
  hot_regions: AssessmentHotRegion[];
  /**
   * Regions with no observed signal in this campaign. These are explicitly not
   * safety claims; consumers must treat them as negative space, not clearance.
   */
  flat_no_signal_regions: AssessmentFlatNoSignalRegion[];
  /** Coverage rows whose status is blocked, out of scope, or not assessed. */
  blocked: AssessmentCoverageGap[];
}

export type AssessmentCoverageProbe =
  | AssessmentCartographyCoverageProbe
  | AssessmentCorrectnessCoverageProbe;

export interface AssessmentCartographyCoverageProbe {
  kind: "swept-gradient";
  risk_objective: string;
  seed_policy: string;
  run_budget: number;
  completed_runs: number;
  invariant_failed_runs: number;
  invariant_failure_rate: number;
  axes: AssessmentCoverageAxis[];
}

export interface AssessmentCoverageAxis {
  axis: string;
  kind: RiskSurfaceAxis["kind"];
  distribution: string;
  unit?: string;
  range: AssessmentCoverageAxisRange;
  granularity: AssessmentCoverageAxisGranularity;
  populated_bins: number;
  run_count: number;
  failed_runs: number;
  invariant_failure_rate: number;
  bins: AssessmentCoverageAxisBin[];
}

export type AssessmentCoverageAxisRange =
  | {
      kind: "values";
      values: JsonScalar[];
    }
  | {
      kind: "interval";
      lower: number | null;
      upper: number | null;
      edges: number[];
    };

export interface AssessmentCoverageAxisGranularity {
  method: "value" | "fixed-width";
  bin_count: number;
  min_cell_run_count: number;
}

export interface AssessmentCoverageAxisBin {
  index: number;
  label: string;
  value?: JsonScalar;
  lower?: number | null;
  upper?: number | null;
  run_count: number;
  failed_runs: number;
  invariant_failure_rate: number;
}

export interface AssessmentCorrectnessCoverageProbe {
  kind: "guided-sim-flow-coverage";
  guided_sim: AssessmentGuidedSimProbe | null;
  flows: AssessmentGuidedSimFlowProbe[];
  negative_controls: AssessmentGuidedSimFlowProbe[];
}

export interface AssessmentGuidedSimProbe {
  label: string;
  status: string;
  iterations: number;
  flows: number;
  tx_success: number;
  expected_errors: number;
  unexpected_errors: number;
  panics: number;
  path: string;
  sha256: string | null;
}

export interface AssessmentGuidedSimFlowProbe {
  flow: string;
  /** Raw guided-sim family name when this coverage row maps to one. */
  guided_sim_flow: string | null;
  status: CoverageStatus;
  evidence_tier: string;
  dispatched_count: number | null;
  negative_control: boolean;
  expected_rejections: number | null;
  unexpected_errors: number | null;
  panics: number | null;
  artifacts: string[];
}

export type AssessmentHotRegion =
  | AssessmentSurfaceHotRegion
  | AssessmentGuidedSimHotRegion;

export interface AssessmentSurfaceHotRegion {
  kind: "failing_cell";
  coords: AssessmentCoverageCellCoord[];
  run_count: number;
  failed_runs: number;
  invariant_failure_rate: number;
  sparse: boolean;
}

export interface AssessmentGuidedSimHotRegion {
  kind: "guided_sim_unexpected_result";
  flow: string;
  dispatched_count: number;
  expected_rejections: number;
  unexpected_errors: number;
  panics: number;
  status: string;
  evidence: string | null;
}

export type AssessmentFlatNoSignalRegion =
  | AssessmentSurfaceNoSignalRegion
  | AssessmentCorrectnessNoSignalRegion;

export interface AssessmentSurfaceNoSignalRegion {
  kind: "zero_failure_cell" | "unpopulated_cell" | "flat_axis_zero_failure";
  signal_type: "invariant_failure";
  interpretation: "no signal in this campaign";
  not_safety_claim: true;
  axis?: string;
  coords?: AssessmentCoverageCellCoord[];
  run_count: number;
  failed_runs: number;
  invariant_failure_rate: number | null;
  sparse: boolean;
}

export interface AssessmentCorrectnessNoSignalRegion {
  kind: "no_swept_gradient" | "guided_sim_no_unexpected_result";
  signal_type: "parameter_gradient" | "unexpected_error_or_panic";
  interpretation: "no signal in this campaign";
  not_safety_claim: true;
  flow: string;
  dispatched_count: number;
  expected_rejections: number;
  unexpected_errors: number;
  panics: number;
}

export interface AssessmentCoverageCellCoord {
  axis: string;
  bin_index: number;
  bin_label: string;
}

export interface AssessmentCoverageGap {
  priority: string;
  flow: string;
  status: Extract<CoverageStatus, "blocked" | "out of scope" | "not assessed">;
  evidence_tier: string;
  commands: string[];
  artifacts: string[];
  notes: string;
}

/** One simulation-evidence row (the ingested campaign, or attached evidence). */
export interface AssessmentSimulation {
  kind: "focused campaign" | "adversarial campaign" | "calibration" | "guided sim" | "negative control";
  objective: string;
  command: string;
  result: string;
  retained_evidence: string | null;
  hashes: string[];
  notes: string;
}

/** Deterministic distillation of the embedded surface. */
export interface AssessmentSurfaceHighlights {
  populated_cells: number;
  total_cells: number;
  worst_cell_failure_rate: number;
  most_sensitive_axis: string | null;
  most_sensitive_spread: number | null;
  safe_region_status: RiskSurfaceSafeRegionStatus;
  safe_region_threshold: number;
  /** The recommended bounds verbatim from the surface, for the narrative + report. */
  safe_region_bounds: RiskSurfaceAxisBound[];
}

/** One retained-evidence entry distilled from the retention manifest. */
export interface AssessmentRetainedEvidence {
  label: string;
  status: "selected" | "warning";
  run_id: string | null;
  case_digest: string | null;
  score: number | null;
  reason: string | null;
  rerun_command: string | null;
  risk_signals: AssessmentRetainedRiskSignals | null;
  warning: string | null;
}

/** The numeric risk signals carried on a selected retained case. */
export interface AssessmentRetainedRiskSignals {
  status: string;
  first_failure_tick: number | null;
  invariant_names: string[];
  total_bad_debt: number | null;
  total_liquidations: number | null;
  max_utilization: number | null;
  min_tvl: number | null;
  risk_score: number;
}

/** An optional attached run/pack evidence reference (ingest-only). */
export interface AssessmentExternalEvidence {
  kind: "run" | "pack" | "guided sim" | "retained case";
  label: string;
  /** Campaign-root-relative or repo-relative path, as supplied by the caller. */
  path: string;
  sha256: string | null;
  notes: string | null;
}

/** Reproduction block: exact rerun commands, artifact paths, and hashes (R2.3). */
export interface AssessmentReproduction {
  /** A stable label for the campaign root (its basename), never an absolute path. */
  campaign_root: string;
  commands: string[];
  artifacts: AssessmentArtifactRef[];
  hashes: AssessmentReproductionHashes;
}

export interface AssessmentArtifactRef {
  /** Campaign-root-relative path. */
  path: string;
  /** A canonical hash or self-digest, or `null` when none is emitted. */
  hash: string | null;
}

export interface AssessmentReproductionHashes {
  /** `null` on a correctness assessment with no campaign. */
  campaign_digest: string | null;
  /** `null` on a correctness assessment with no risk surface. */
  surface_digest: string | null;
  /** `sha256sum risk-surface.json` of the on-disk bytes; `null` when there is no surface. */
  surface_sha256: string | null;
}

// ---------------------------------------------------------------------------
// Correctness-shape evidence (R1.2) — guided-sim + run/pack ingestion types
// ---------------------------------------------------------------------------

/**
 * The on-disk `guided-sim-run.json` schema emitted by `riptide sim run` (guided
 * mode): per-run totals plus per-iteration `flow_counts` and status. Only the
 * fields the assessment consumes are typed; extra fields are ignored. The
 * correctness shape's primary evidence (R1.2).
 */
export interface GuidedSimRunDocument {
  schema_version: number;
  status: string;
  iterations_requested: number;
  flows_per_iteration: number;
  base_seed: string;
  retained_failing_seed: string | null;
  totals: GuidedSimRunTotals;
  iterations: GuidedSimRunIteration[];
}

/** Aggregate totals across all guided-sim iterations. */
export interface GuidedSimRunTotals {
  iterations: number;
  flows: number;
  tx_success: number;
  /** Negative-control rejections that were *expected* (correctness evidence, not failures). */
  expected_errors: number;
  /** Rejections/errors that were *not* expected — each is a candidate finding. */
  unexpected_errors: number;
  compute_units: number;
  service_ticks: number;
  errors: number;
  panics: number;
}

/** One guided-sim iteration's status + per-family flow dispatch counts. */
export interface GuidedSimRunIteration {
  iteration: number;
  seed: string;
  status: string;
  dispatched_flows: number;
  /** Flows dispatched per scenario family in this iteration. */
  flow_counts: Record<string, number>;
  /** Optional per-flow trace emitted by newer guided-sim runs. */
  flow_trace?: GuidedSimFlowTraceStep[];
  service_ticks: number;
  error: string | null;
  panic: boolean;
}

/** One optional guided-sim trace step, when the artifact carries per-flow counters. */
export interface GuidedSimFlowTraceStep {
  flow_name: string;
  expected_errors?: number;
  unexpected_errors?: number;
}

/** A flow family and how many flows it dispatched, aggregated across iterations. */
export interface AssessmentGuidedSimFlowCount {
  flow: string;
  count: number;
  /** Per-flow expected rejections, or `null` when the artifact only exposes run totals. */
  expected_errors: number | null;
  /** Per-flow unexpected errors, or `null` when the artifact only exposes run totals. */
  unexpected_errors: number | null;
}

/**
 * The deterministic distillation of a {@link GuidedSimRunDocument} embedded in a
 * correctness assessment: scalar totals + per-family flow counts sorted by flow
 * name (so the assessment hash is byte-stable regardless of iteration order).
 */
export interface AssessmentGuidedSimEvidence {
  label: string;
  status: string;
  iterations: number;
  flows: number;
  tx_success: number;
  expected_errors: number;
  unexpected_errors: number;
  errors: number;
  panics: number;
  /** Sorted by `flow`. */
  flow_counts: AssessmentGuidedSimFlowCount[];
  /** Workspace-relative path to `guided-sim-run.json`. */
  path: string;
  sha256: string | null;
}

/** A run-collection evidence reference (ingest-only). */
export interface AssessmentRunEvidence {
  label: string;
  /** Workspace-relative path to the run / run collection. */
  path: string;
  status: string | null;
  sha256: string | null;
  notes: string | null;
}

/** A pack evidence reference (ingest-only). */
export interface AssessmentPackEvidence {
  label: string;
  /** Workspace-relative path to the pack. */
  path: string;
  sha256: string | null;
  notes: string | null;
}

/**
 * The correctness shape's evidence bundle — the surface-less analogue of the
 * embedded {@link RiskSurfaceDocument}. Guided-sim is the primary signal; runs
 * and packs are supporting evidence references. Embedded verbatim in the model
 * so the assessment hash transitively covers it.
 */
export interface AssessmentCorrectnessEvidence {
  guided_sim: AssessmentGuidedSimEvidence | null;
  /** Sorted by `label`. */
  runs: AssessmentRunEvidence[];
  /** Sorted by `label`. */
  packs: AssessmentPackEvidence[];
}

// ---------------------------------------------------------------------------
// Narrative seam (R2.5 / R3) — interface only; T03 implements the real one
// ---------------------------------------------------------------------------

export const ASSESSMENT_NARRATIVE_SCHEMA = "assessment-narrative.v1" as const;

/**
 * The narrative blocks T02 renders into prose and T03 generates from the model.
 * Defined here so the renderer and the narrative generator can be built in
 * parallel against a fixed contract. Deterministic by construction (no prose
 * may read wall-clock or randomness).
 */
export interface AssessmentNarrative {
  schema: typeof ASSESSMENT_NARRATIVE_SCHEMA;
  /** Executive-summary paragraphs (rendered in order). */
  executive_summary: string[];
  /** One narrow claim tied to the Risk Plan + evidence. */
  headline_claim: string;
  /** Main finding, or "No finding under the declared inputs." */
  main_finding: string;
  /** Largest blocked / out-of-scope / not-assessed surface. */
  main_limit: string;
  findings: AssessmentFinding[];
  non_findings: AssessmentNonFinding[];
  recommendation: AssessmentRecommendation;
}

/** A reproducible finding (R3.1). */
export interface AssessmentFinding {
  title: string;
  severity: string;
  affected_flow: string;
  evidence_tier: string;
  observed: string;
  why_it_matters: string;
  recommended: string;
  reproduction_command: string | null;
  artifacts: string[];
  hashes: string[];
}

/** A non-finding: tested, no declared invariant fired under the listed inputs (R3.2). */
export interface AssessmentNonFinding {
  flow: string;
  evidence: string;
  /** Bounded statement, e.g. "No declared invariant fired under these inputs." */
  statement: string;
  limit: string;
}

/** The safe-region recommendation (R3.1 / R3.3). */
export interface AssessmentRecommendation {
  kind: "bounded" | "entire-region" | "none";
  /** The most-sensitive axis the recommendation centers on, or `null`. */
  primary_axis: string | null;
  /** Bounded statement, e.g. "keep whale_share_bps within [500, 1750]". */
  statement: string;
  /** The declared failure-rate threshold this recommendation cites. */
  threshold: number;
  /** The recommended bounds verbatim from the surface. */
  bounds: RiskSurfaceAxisBound[];
}

/** A pure function from the hashed model to narrative blocks. T03 supplies the real one. */
export type NarrativeProvider = (model: AssessmentModel) => AssessmentNarrative;

// ---------------------------------------------------------------------------
// Caller-supplied inputs (Risk Plan / coverage / verdict / protocol) — R1.2/R4.2
// ---------------------------------------------------------------------------

/** Optional scoping inputs folded over the ingested campaign. Each defaults sensibly. */
export interface AssessmentInputs {
  protocol?: Partial<AssessmentProtocolIdentity> & { name?: string };
  riskPlan?: Partial<AssessmentRiskPlan>;
  /** Explicit coverage rows; when omitted, defaults are derived from the campaign. */
  coverage?: AssessmentCoverageRow[];
  /** Declared verdict; when omitted, derived deterministically from the campaign. */
  verdict?: AssessmentVerdict;
  /** Attached run/pack evidence references (ingest-only). */
  externalEvidence?: AssessmentExternalEvidence[];
  /** Override the reproduction command list; defaults to reassessing the exact campaign root. */
  reproductionCommands?: string[];
  /** Override simulation-evidence rows; defaults to a single focused-campaign row. */
  simulations?: AssessmentSimulation[];
}

/** Everything {@link buildAssessmentModel} needs from disk + the caller. */
export interface BuildAssessmentInput {
  /** Reviewer-facing campaign root path used in commands and artifact refs. */
  campaignRootLabel: string;
  summary: CampaignSummaryJson;
  surface: RiskSurfaceDocument;
  /** Raw on-disk bytes of `risk-surface.json`, hashed for the reproduction block. */
  surfaceRawBytes: string;
  retentionManifest: CampaignRetentionManifest;
  inputs?: AssessmentInputs;
}

export interface IngestAssessmentOptions {
  /** Path to a guided-sim root produced by `riptide sim surface`. */
  campaignRoot: string;
  /** Override the reviewer-facing root path. Defaults to the exact resolved campaign root. */
  campaignRootLabel?: string;
  inputs?: AssessmentInputs;
}

/** Thrown when a required campaign artifact is missing or malformed (R4.4). */
export class AssessmentIngestError extends Error {
  /** A short, actionable next step rendered after the message. */
  readonly hint: string | undefined;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = "AssessmentIngestError";
    this.hint = hint;
  }
}

// ---------------------------------------------------------------------------
// Ingestion (R1.2 / R1.5) — read the campaign root, fold inputs, build the model
// ---------------------------------------------------------------------------

const CAMPAIGN_SUMMARY_FILE = "campaign-summary.json";
const RISK_SURFACE_FILE = "risk-surface.json";
const RETENTION_MANIFEST_FILE = "retention-manifest.json";

/**
 * Read a campaign root and build the canonical {@link AssessmentModel}. Pure I/O
 * over existing artifacts — no engine, no campaign execution (R1.5). Throws
 * {@link AssessmentIngestError} with a message-first explanation when an artifact
 * is missing or malformed.
 */
export async function ingestAssessment(options: IngestAssessmentOptions): Promise<CartographyAssessmentModel> {
  const root = path.resolve(options.campaignRoot);
  const summary = await readArtifact<CampaignSummaryJson>(
    path.join(root, CAMPAIGN_SUMMARY_FILE),
    CAMPAIGN_SUMMARY_FILE,
    "campaign-summary.v1",
    "Run `riptide sim run` then `riptide sim surface` to write the root first, then `riptide assess <guided-sim-root>`."
  );
  if (summary.schema_version !== "campaign-summary.v1") {
    throw new AssessmentIngestError(
      `${CAMPAIGN_SUMMARY_FILE} is schema ${JSON.stringify(summary.schema_version)}, not "campaign-summary.v1".`,
      "assessment.v1 ingests campaign-summary.v1 artifacts; regenerate the campaign with the current CLI."
    );
  }
  const surfaceRawBytes = await readRaw(
    path.join(root, RISK_SURFACE_FILE),
    RISK_SURFACE_FILE,
    "The risk surface is the quantitative core of the assessment; rerun the campaign to emit it."
  );
  const surface = parseJson<RiskSurfaceDocument>(surfaceRawBytes, RISK_SURFACE_FILE);
  const retentionManifest = await readArtifact<CampaignRetentionManifest>(
    path.join(root, RETENTION_MANIFEST_FILE),
    RETENTION_MANIFEST_FILE,
    "campaign-retention-manifest.v1",
    "The retention manifest names the retained evidence; rerun the campaign to emit it."
  );

  return buildAssessmentModel({
    campaignRootLabel: options.campaignRootLabel ?? root,
    summary,
    surface,
    surfaceRawBytes,
    retentionManifest,
    inputs: options.inputs
  });
}

const GUIDED_SIM_FILE = "guided-sim-run.json";
const LAST_RUN_FILE = "last-run.json";
const RUN_COLLECTION_FILE = "run-collection.json";
const SIM_ARTIFACTS_DIR = path.join("sim", "artifacts");
const PACK_DIR = "pack";
const PACK_MANIFEST_FILE = "manifest.json";

/** A run-collection scenario row; only the fields the assessment references are typed. */
interface RunCollectionScenario {
  name?: unknown;
  status?: unknown;
  artifacts_dir?: unknown;
  simulation_result_path?: unknown;
  interpretation?: { summary?: unknown } | null;
}

interface RunCollectionDocument {
  started_at?: unknown;
  finished_at?: unknown;
  scenarios?: RunCollectionScenario[];
}

/**
 * Ingest an assessment from a workspace or campaign root, branching on shape
 * (R2.1/R2.2). A `campaign-summary.json` marks the Sprint 39/40 parameter-swept
 * (cartography) root and delegates to {@link ingestAssessment} unchanged (R2.4).
 * Otherwise the root is treated as a surface-less correctness workspace: its
 * guided-sim, run-collection, and pack evidence are read and folded into a
 * correctness model. A truly empty root (no evidence of either shape) is a
 * message-first failure. Ingest-only — no engine, no campaign execution (R2.3).
 */
export async function ingestAssessmentWorkspace(
  options: IngestAssessmentOptions
): Promise<AssessmentModel> {
  const root = path.resolve(options.campaignRoot);
  if (await fileExists(path.join(root, CAMPAIGN_SUMMARY_FILE))) {
    return ingestAssessment(options);
  }

  const evidence = await ingestCorrectnessEvidence(root);
  if (!evidence.guided_sim && evidence.runs.length === 0 && evidence.packs.length === 0) {
    throw new AssessmentIngestError(
      `no assessable evidence was found under ${root}.`,
      "Point `riptide assess` at a campaign root (campaign-summary.json + risk-surface.json) or a workspace " +
        "with guided-sim evidence (sim/artifacts/<run>/guided-sim-run.json), a run-collection.json, or packs."
    );
  }

  return buildCorrectnessAssessmentModel({
    campaignRootLabel: options.campaignRootLabel ?? options.campaignRoot,
    protocolName: deriveWorkspaceProtocolName(root),
    assessmentDateFallback: await readCorrectnessAssessmentDate(root),
    evidence,
    inputs: options.inputs
  });
}

/**
 * Read the correctness evidence bundle from a workspace root: the guided-sim run
 * (the primary signal), the run-collection (supporting run references), and the
 * packs. Pure I/O over already-written artifacts; missing pieces are simply
 * absent, not errors (the caller decides whether the bundle is empty).
 */
async function ingestCorrectnessEvidence(root: string): Promise<AssessmentCorrectnessEvidence> {
  const [guided_sim, runs, packs] = await Promise.all([
    ingestGuidedSimEvidence(root),
    ingestRunEvidence(root),
    ingestPackEvidence(root)
  ]);
  return { guided_sim, runs, packs };
}

/**
 * Select and distill the guided-sim run. When a workspace holds several runs
 * (e.g. a smoke run plus the main run), the one with the most flows wins, with a
 * label tie-break, so the choice — and the resulting hash — is deterministic.
 */
async function ingestGuidedSimEvidence(root: string): Promise<AssessmentGuidedSimEvidence | null> {
  const artifactsDir = path.join(root, SIM_ARTIFACTS_DIR);
  let entries: Dirent[];
  try {
    entries = await readdir(artifactsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates: Array<{ label: string; relPath: string; doc: GuidedSimRunDocument; sha256: string }> = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(artifactsDir, entry.name, GUIDED_SIM_FILE);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      continue;
    }
    const doc = parseJson<GuidedSimRunDocument>(raw, GUIDED_SIM_FILE);
    validateGuidedSimRun(doc, entry.name);
    candidates.push({
      label: entry.name,
      relPath: toPosixRelative(root, filePath),
      doc,
      sha256: sha256Hex(raw)
    });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.doc.totals.flows - a.doc.totals.flows || a.label.localeCompare(b.label));
  const chosen = candidates[0]!;
  return summarizeGuidedSimRun(chosen.doc, {
    label: chosen.label,
    path: chosen.relPath,
    sha256: chosen.sha256
  });
}

/** Read run-collection.json (if present) into one run-evidence row per scenario. */
async function ingestRunEvidence(root: string): Promise<AssessmentRunEvidence[]> {
  const filePath = path.join(root, RUN_COLLECTION_FILE);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  const doc = parseJson<RunCollectionDocument>(raw, RUN_COLLECTION_FILE);
  const scenarios = Array.isArray(doc.scenarios) ? doc.scenarios : [];
  const rows: AssessmentRunEvidence[] = [];
  for (const scenario of scenarios) {
    const label = typeof scenario.name === "string" ? scenario.name : null;
    if (!label) continue;
    const rawRefPath =
      (typeof scenario.artifacts_dir === "string" && scenario.artifacts_dir) ||
      (typeof scenario.simulation_result_path === "string" && scenario.simulation_result_path) ||
      RUN_COLLECTION_FILE;
    rows.push({
      label,
      path: normalizeWorkspaceArtifactRef(root, rawRefPath),
      status: typeof scenario.status === "string" ? scenario.status : null,
      sha256: null,
      notes:
        scenario.interpretation && typeof scenario.interpretation.summary === "string"
          ? scenario.interpretation.summary
          : null
    });
  }
  return rows;
}

/** Read pack manifests (if present) into pack-evidence rows. */
async function ingestPackEvidence(root: string): Promise<AssessmentPackEvidence[]> {
  const packRoot = path.join(root, PACK_DIR);
  let entries: Dirent[];
  try {
    entries = await readdir(packRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const rows: AssessmentPackEvidence[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(packRoot, entry.name, PACK_MANIFEST_FILE);
    let raw: string;
    try {
      raw = await readFile(manifestPath, "utf8");
    } catch {
      continue;
    }
    let canonicalHash: string | null = null;
    try {
      const manifest = JSON.parse(raw) as { canonical_hash?: unknown };
      if (typeof manifest.canonical_hash === "string") canonicalHash = manifest.canonical_hash;
    } catch {
      // A malformed pack manifest is a soft skip: packs are supporting evidence.
    }
    rows.push({
      label: entry.name,
      path: toPosixRelative(root, path.join(packRoot, entry.name)),
      sha256: null,
      notes: canonicalHash ? `canonical hash ${canonicalHash}` : null
    });
  }
  return rows;
}

/**
 * Deterministic date fallback for correctness workspaces (T02). Prefer the run
 * collection's recorded start/finish date, then last-run metadata, then a
 * guided-sim base-seed date. These are all already-written inputs; no wall-clock
 * is sampled during assessment rendering.
 */
async function readCorrectnessAssessmentDate(root: string): Promise<string | null> {
  const runCollectionDate = await readAssessmentDateFromJsonFile(path.join(root, RUN_COLLECTION_FILE));
  if (runCollectionDate) return runCollectionDate;

  const lastRunDate = await readAssessmentDateFromJsonFile(path.join(root, LAST_RUN_FILE));
  if (lastRunDate) return lastRunDate;

  return readGuidedSimSeedDate(root);
}

async function readAssessmentDateFromJsonFile(filePath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return null;
  }
  try {
    const doc = JSON.parse(raw) as { started_at?: unknown; finished_at?: unknown };
    return extractAssessmentDate(doc.started_at) ?? extractAssessmentDate(doc.finished_at);
  } catch {
    return null;
  }
}

async function readGuidedSimSeedDate(root: string): Promise<string | null> {
  const artifactsDir = path.join(root, SIM_ARTIFACTS_DIR);
  let entries: Dirent[];
  try {
    entries = await readdir(artifactsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates: Array<{ label: string; flows: number; date: string }> = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    let raw: string;
    try {
      raw = await readFile(path.join(artifactsDir, entry.name, GUIDED_SIM_FILE), "utf8");
    } catch {
      continue;
    }
    try {
      const doc = JSON.parse(raw) as Partial<GuidedSimRunDocument>;
      const date = extractAssessmentDate(doc.base_seed);
      const flows = typeof doc.totals?.flows === "number" && Number.isFinite(doc.totals.flows) ? doc.totals.flows : 0;
      if (date) candidates.push({ label: entry.name, flows, date });
    } catch {
      continue;
    }
  }
  candidates.sort((a, b) => b.flows - a.flows || a.label.localeCompare(b.label));
  return candidates[0]?.date ?? null;
}

/** Light structural validation of a `guided-sim-run.json` before it is trusted. */
function validateGuidedSimRun(doc: GuidedSimRunDocument, label: string): void {
  const file = `${SIM_ARTIFACTS_DIR}/${label}/${GUIDED_SIM_FILE}`;
  const root = requireObject(doc, file, "document");
  requireString(root, file, "status");
  const totals = requireObject(root.totals, file, "totals");
  for (const key of ["flows", "tx_success", "expected_errors", "unexpected_errors", "errors", "panics"]) {
    requireNumber(totals, file, `totals.${key}`);
  }
}

/**
 * Derive a protocol display name from the workspace root. A `.riptide` root is
 * named for its parent (the case-study/project directory); otherwise the root's
 * own basename is used. The caller can always override with `--protocol-name`.
 */
function deriveWorkspaceProtocolName(root: string): string {
  const base = path.basename(root);
  if (base === ".riptide") return path.basename(path.dirname(root)) || base;
  return base;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Workspace-relative path with POSIX separators, for portable, deterministic artifact refs. */
function toPosixRelative(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

/**
 * Reviewer-facing, repo/workspace-relative label for a campaign or workspace root
 * (R1.1/R1.3/R1.4). Resolves `target` relative to the nearest enclosing
 * repository root — the first ancestor (inclusive) holding a `.git` entry —
 * falling back to `cwd`, then to the basename. The result is POSIX-separated and
 * carries no absolute machine path, so a reviewer on a different checkout reads
 * and reruns identical bytes (`riptide assess <label>` is runnable from the repo
 * root). Pure path math over the detected root; never samples the wall-clock.
 *
 * This is the single relativizer every rendered path inherits: the label is the
 * prefix {@link rootedArtifactPath} (and the reproduction/coverage/simulation
 * derivations) stamp onto every artifact ref, so relativizing it here makes the
 * whole assessment — `assessment.json`, `assessment.md`, and the HTML/PDF — free
 * of absolute paths and stable across machines.
 */
export function workspaceRelative(target: string, cwd: string = process.cwd()): string {
  const abs = path.resolve(target);
  const base = findRepoRoot(abs) ?? path.resolve(cwd);
  let rel = path.relative(base, abs);
  if (rel === "" || rel === ".") rel = path.basename(abs);
  // A target outside the detected base (different tree or drive) would relativize
  // to a `../../…` ladder or an absolute path; fall back to the basename so the
  // label stays a clean, portable token rather than leaking the layout above it.
  if (rel.startsWith("..") || path.isAbsolute(rel)) rel = path.basename(abs);
  return rel.split(path.sep).join("/");
}

/** Nearest ancestor (inclusive) of `start` that contains a `.git` entry, or `null`. */
function findRepoRoot(start: string): string | null {
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Normalize supporting evidence paths to the assessed workspace root. Older
 * run-collection files may store paths from the project root (`.riptide/...`);
 * correctness assessments are rooted at the `.riptide` workspace, so strip that
 * prefix before later rendering every artifact under the same campaign root.
 */
function normalizeWorkspaceArtifactRef(root: string, artifactPath: string): string {
  let normalized = artifactPath.trim().split(path.sep).join("/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);

  if (path.isAbsolute(artifactPath)) {
    const relative = path.relative(root, artifactPath);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      return relative.split(path.sep).join("/");
    }
    return normalized;
  }

  const rootBase = path.basename(root);
  if (rootBase && normalized === rootBase) return ".";
  if (rootBase && normalized.startsWith(`${rootBase}/`)) {
    return normalized.slice(rootBase.length + 1);
  }
  return normalized;
}

/**
 * Build the canonical assessment model from already-read artifacts + inputs.
 * Pure and deterministic; serialize with {@link serializeAssessment}.
 */
export function buildAssessmentModel(input: BuildAssessmentInput): CartographyAssessmentModel {
  const { summary, surface, retentionManifest } = input;
  const inputs = input.inputs ?? {};

  validateAssessmentArtifacts(summary, surface, retentionManifest);

  const protocol = resolveProtocol(summary, inputs.protocol);
  const campaign = resolveCampaignReference(summary);
  const totals = resolveTotals(summary);
  const highlights = surfaceHighlights(surface);
  const verdict = resolveVerdict(summary, surface, highlights, inputs.verdict);
  const riskPlan = resolveRiskPlan(summary, inputs.riskPlan);
  const scope = resolveScope(summary, surface, riskPlan);
  const coverage = inputs.coverage
    ? sortCoverageRows(inputs.coverage)
    : deriveCoverageRows(summary, riskPlan, input.campaignRootLabel);
  const surfaceSha256 = sha256Hex(input.surfaceRawBytes);
  const simulations = inputs.simulations ?? deriveSimulations(summary, surfaceSha256, input.campaignRootLabel);
  const retainedEvidence = resolveRetainedEvidence(retentionManifest);
  const reproduction = resolveReproduction(
    input.campaignRootLabel,
    campaign,
    surface,
    surfaceSha256,
    inputs.reproductionCommands
  );

  // NOTE: this literal must NOT gain a `shape` or `correctness` key — the
  // cartography canonical bytes (and the Sprint 40 lending flagship pins) are
  // byte-frozen. Guided-sim-only `execution_honesty` is optional and absent on
  // real campaign artifacts. The correctness shape is built by
  // buildCorrectnessAssessmentModel.
  const documentFacts: Omit<CartographyAssessmentModel, "assessment_digest" | "coverage_statement"> = {
    schema_version: ASSESSMENT_SCHEMA_VERSION,
    protocol,
    campaign,
    totals,
    verdict,
    risk_plan: riskPlan,
    scope,
    coverage_matrix: coverage,
    simulations,
    surface,
    surface_highlights: highlights,
    retained_evidence: retainedEvidence,
    external_evidence: [...(inputs.externalEvidence ?? [])],
    ...(isGuidedSimDerived(summary) && summary.execution_honesty
      ? { execution_honesty: summary.execution_honesty }
      : {}),
    reproduction,
    claim_boundary: ASSESSMENT_CLAIM_BOUNDARY
  };
  const document: Omit<CartographyAssessmentModel, "assessment_digest"> = {
    ...documentFacts,
    coverage_statement: buildCoverageStatementFromFacts(documentFacts)
  };

  const digest = sha256Hex(
    `${ASSESSMENT_HASH_PREFIX}\n${canonicalJson(document as unknown as JsonValue)}`
  );
  return { ...document, assessment_digest: digest };
}

/**
 * Return a model whose canonical digest covers the final execution-honesty
 * report. `riptide assess` uses this after re-verifying the producer-recorded
 * report at emit time, so the rendered assessment artifacts contain the same
 * gate state the command enforced.
 */
export function withExecutionHonesty<T extends AssessmentModel>(
  model: T,
  executionHonesty: ExecutionHonestyReport | null
): T {
  const { assessment_digest: _oldDigest, ...facts } = model;
  const document = executionHonesty
    ? { ...facts, execution_honesty: executionHonesty }
    : facts;
  const digest = sha256Hex(
    `${ASSESSMENT_HASH_PREFIX}\n${canonicalJson(document as unknown as JsonValue)}`
  );
  return { ...(document as Omit<T, "assessment_digest">), assessment_digest: digest } as T;
}

/**
 * Read the effective {@link AssessmentShape} of any model. A `cartography` model
 * carries no `shape` field (to keep its bytes frozen) and is identified by a
 * present `surface`; a `correctness` model stamps `shape: "correctness"`.
 */
export function assessmentShape(model: AssessmentModel): AssessmentShape {
  return model.shape ?? (model.surface === null ? "correctness" : "cartography");
}

/**
 * Narrow an {@link AssessmentModel} to a {@link CartographyAssessmentModel},
 * asserting the surface + campaign are present. The cartography renderer and
 * narrative use this so they keep their non-null guarantees; a correctness model
 * routed here throws rather than rendering an empty heatmap.
 */
export function requireCartographyModel(model: AssessmentModel): CartographyAssessmentModel {
  if (
    model.surface === null ||
    model.surface_highlights === null ||
    model.campaign === null ||
    model.totals === null
  ) {
    throw new Error(
      "expected a cartography assessment model with an embedded risk surface; " +
        "correctness-shape (surface-less) models render through the correctness path."
    );
  }
  return model as CartographyAssessmentModel;
}

// ---------------------------------------------------------------------------
// Correctness-shape model construction (R1.2 / R1.4)
// ---------------------------------------------------------------------------

/** Everything {@link buildCorrectnessAssessmentModel} needs from the caller + ingested evidence. */
export interface BuildCorrectnessAssessmentInput {
  /** Reviewer-facing workspace/campaign root label used in commands + artifact refs. */
  campaignRootLabel: string;
  /** Protocol display name (e.g. the case-study name). */
  protocolName: string;
  /** Deterministic fallback date from already-written evidence metadata. */
  assessmentDateFallback?: string | null;
  /** The ingested correctness evidence bundle (guided-sim + run/pack). */
  evidence: AssessmentCorrectnessEvidence;
  inputs?: AssessmentInputs;
}

/**
 * Distill an on-disk {@link GuidedSimRunDocument} into the deterministic
 * {@link AssessmentGuidedSimEvidence} embedded in a correctness assessment.
 * Aggregates per-iteration `flow_counts` and sorts by flow name so the bytes are
 * stable regardless of iteration ordering.
 */
export function summarizeGuidedSimRun(
  doc: GuidedSimRunDocument,
  ref: { label: string; path: string; sha256?: string | null }
): AssessmentGuidedSimEvidence {
  const counts = new Map<string, number>();
  const traceStats = new Map<string, { expected_errors: number; unexpected_errors: number }>();
  for (const iteration of doc.iterations ?? []) {
    for (const [flow, count] of Object.entries(iteration.flow_counts ?? {})) {
      if (typeof count !== "number" || !Number.isFinite(count)) continue;
      counts.set(flow, (counts.get(flow) ?? 0) + count);
    }
    for (const step of iteration.flow_trace ?? []) {
      const flow = typeof step.flow_name === "string" ? step.flow_name : "";
      if (!flow) continue;
      const expected =
        typeof step.expected_errors === "number" && Number.isFinite(step.expected_errors)
          ? step.expected_errors
          : 0;
      const unexpected =
        typeof step.unexpected_errors === "number" && Number.isFinite(step.unexpected_errors)
          ? step.unexpected_errors
          : 0;
      const current = traceStats.get(flow) ?? { expected_errors: 0, unexpected_errors: 0 };
      current.expected_errors += expected;
      current.unexpected_errors += unexpected;
      traceStats.set(flow, current);
    }
  }
  const flowCounts: AssessmentGuidedSimFlowCount[] = [...counts.entries()]
    .map(([flow, count]) => {
      const stats = traceStats.get(flow);
      return {
        flow,
        count,
        expected_errors: stats?.expected_errors ?? null,
        unexpected_errors: stats?.unexpected_errors ?? null
      };
    })
    .sort((a, b) => a.flow.localeCompare(b.flow));
  const totals = doc.totals;
  return {
    label: ref.label,
    status: doc.status,
    iterations: totals.iterations,
    flows: totals.flows,
    tx_success: totals.tx_success,
    expected_errors: totals.expected_errors,
    unexpected_errors: totals.unexpected_errors,
    errors: totals.errors,
    panics: totals.panics,
    flow_counts: flowCounts,
    path: ref.path,
    sha256: ref.sha256 ?? null
  };
}

/**
 * Build the canonical, surface-less correctness {@link AssessmentModel} from an
 * evidence bundle + caller inputs. Pure + deterministic; serialize with
 * {@link serializeAssessment}. Coverage rows + the full findings/non-findings
 * mapping are folded in by the caller (T04) via {@link AssessmentInputs}; this
 * builder owns the shape, the bounded verdict (R1.4), and the byte-stable
 * null-surface serialization (R1.3).
 */
export function buildCorrectnessAssessmentModel(
  input: BuildCorrectnessAssessmentInput
): AssessmentModel {
  const inputs = input.inputs ?? {};
  const evidence = normalizeCorrectnessEvidence(input.evidence);
  const protocol = resolveCorrectnessProtocol(input.protocolName, inputs.protocol, input.assessmentDateFallback);
  const verdict = resolveCorrectnessVerdict(evidence, inputs.verdict);
  const riskPlan = resolveCorrectnessRiskPlan(evidence, inputs.riskPlan);
  const scope = resolveCorrectnessScope(evidence, riskPlan);
  const coverage = inputs.coverage
    ? sortCoverageRows(inputs.coverage)
    : deriveCorrectnessCoverageRows(input.campaignRootLabel, evidence, riskPlan);
  const simulations = inputs.simulations ?? deriveCorrectnessSimulations(input.campaignRootLabel, evidence);
  const reproduction = resolveCorrectnessReproduction(
    input.campaignRootLabel,
    evidence,
    inputs.reproductionCommands
  );

  const documentFacts: Omit<AssessmentModel, "assessment_digest" | "coverage_statement"> = {
    schema_version: ASSESSMENT_SCHEMA_VERSION,
    shape: "correctness",
    protocol,
    campaign: null,
    totals: null,
    verdict,
    risk_plan: riskPlan,
    scope,
    coverage_matrix: coverage,
    simulations,
    surface: null,
    surface_highlights: null,
    correctness: evidence,
    retained_evidence: [],
    external_evidence: [...(inputs.externalEvidence ?? [])],
    reproduction,
    claim_boundary: ASSESSMENT_CLAIM_BOUNDARY
  };
  const document: Omit<AssessmentModel, "assessment_digest"> = {
    ...documentFacts,
    coverage_statement: buildCoverageStatementFromFacts(documentFacts)
  };

  const digest = sha256Hex(
    `${ASSESSMENT_HASH_PREFIX}\n${canonicalJson(document as unknown as JsonValue)}`
  );
  return { ...document, assessment_digest: digest };
}

/** Sort the run/pack arrays so the embedded evidence is byte-stable. */
function normalizeCorrectnessEvidence(
  evidence: AssessmentCorrectnessEvidence
): AssessmentCorrectnessEvidence {
  return {
    guided_sim: evidence.guided_sim,
    runs: [...evidence.runs].sort((a, b) => a.label.localeCompare(b.label)),
    packs: [...evidence.packs].sort((a, b) => a.label.localeCompare(b.label))
  };
}

function resolveCorrectnessProtocol(
  name: string,
  overrides: AssessmentInputs["protocol"],
  assessmentDateFallback: string | null | undefined
): AssessmentProtocolIdentity {
  return {
    name: nonEmpty(overrides?.name) ?? name,
    repository: nonEmpty(overrides?.repository ?? undefined) ?? null,
    commit: nonEmpty(overrides?.commit ?? undefined) ?? null,
    riptide_version: nonEmpty(overrides?.riptide_version ?? undefined) ?? null,
    assessment_date: nonEmpty(overrides?.assessment_date ?? undefined) ?? assessmentDateFallback ?? null
  };
}

/**
 * Bounded, flow-scoped verdict for a surface-less assessment (R1.4). A clean
 * guided-sim run (no unexpected error, no panic, status passed) is send-ready
 * *for the assessed flows only* — never a claim of complete protocol safety. An
 * unexpected error or panic is a finding that blocks; absent guided-sim evidence
 * is unsupported.
 */
function resolveCorrectnessVerdict(
  evidence: AssessmentCorrectnessEvidence,
  declared: AssessmentVerdict | undefined
): AssessmentVerdictBlock {
  if (declared) {
    return { value: declared, source: "declared", rationale: declaredRationale(declared) };
  }
  const gs = evidence.guided_sim;
  if (!gs) {
    return {
      value: "unsupported",
      source: "derived",
      rationale:
        "No guided-sim evidence was ingested, so there is no correctness evidence over declared flows to assess."
    };
  }
  if (gs.unexpected_errors > 0 || gs.panics > 0) {
    return {
      value: "blocked",
      source: "derived",
      rationale:
        `${gs.unexpected_errors} unexpected error(s) and ${gs.panics} panic(s) were observed across the ` +
        `${gs.flows} guided-sim flow(s); resolve them before this can be sent.`
    };
  }
  if (gs.status !== "passed") {
    return {
      value: "blocked",
      source: "derived",
      rationale:
        `The guided-sim run did not pass (status \`${gs.status}\`); resolve the failure before this can be sent.`
    };
  }
  return {
    value: "ready_to_send",
    source: "derived",
    rationale:
      `No unexpected error or panic was observed across the ${gs.flows} guided-sim flow(s); ` +
      `${gs.expected_errors} negative-control action(s) were rejected as expected. ` +
      "Evidence is bounded to the assessed flows and declared inputs."
  };
}

function resolveCorrectnessRiskPlan(
  evidence: AssessmentCorrectnessEvidence,
  overrides: AssessmentInputs["riskPlan"]
): AssessmentRiskPlan {
  const gs = evidence.guided_sim;
  const flows = gs ? gs.flow_counts.map((fc) => `guided-sim flow \`${fc.flow}\``) : [];
  const defaultTarget =
    "Bounded correctness claim: no unexpected error, panic, or accounting-invariant breach was observed " +
    "across the assessed guided-sim flows under the declared, fixed-seed inputs.";
  return {
    protocol_class: nonEmpty(overrides?.protocol_class) ?? "correctness",
    target_claim: nonEmpty(overrides?.target_claim) ?? defaultTarget,
    evidence_profile: dedupeSorted(overrides?.evidence_profile ?? ["guided sim"]),
    p0_flows: overrides?.p0_flows ?? flows,
    p1_flows: overrides?.p1_flows ?? [],
    expected_failure_modes:
      overrides?.expected_failure_modes ??
      ["accounting drift", "double-payment", "wrong-recipient settlement", "unauthorized control"],
    guided_sim_boundaries: overrides?.guided_sim_boundaries ?? [],
    known_coverage_limits:
      overrides?.known_coverage_limits ??
      [
        "Evidence is bounded to the guided-sim flows exercised under a fixed seed.",
        "Flows outside the coverage matrix are not assessed."
      ]
  };
}

function resolveCorrectnessScope(
  evidence: AssessmentCorrectnessEvidence,
  riskPlan: AssessmentRiskPlan
): AssessmentScope {
  const gs = evidence.guided_sim;
  const inScope = dedupeStable([
    ...(gs ? [`guided-sim run \`${gs.label}\` (${gs.flows} flow(s), status ${gs.status})`] : []),
    ...(gs ? gs.flow_counts.map((fc) => `guided-sim flow \`${fc.flow}\` (${fc.count} dispatched)`) : [])
  ]);
  const outOfScope = [
    "Mainnet behavior, historical replay, and live monitoring.",
    "Audit signoff, formal verification, and complete protocol safety.",
    "Flows, inputs, and seeds outside the assessed guided-sim evidence.",
    ...riskPlan.guided_sim_boundaries.map((boundary) => `Guided-sim boundary: ${boundary}`)
  ];
  return {
    in_scope: inScope,
    out_of_scope: outOfScope,
    claim_boundary: ASSESSMENT_CLAIM_BOUNDARY
  };
}

function deriveCorrectnessSimulations(
  campaignRootLabel: string,
  evidence: AssessmentCorrectnessEvidence
): AssessmentSimulation[] {
  const gs = evidence.guided_sim;
  if (!gs) return [];
  const guidedSimPath = rootedArtifactPath(campaignRootLabel, gs.path);
  const result =
    gs.unexpected_errors > 0 || gs.panics > 0
      ? `${gs.unexpected_errors} unexpected error(s), ${gs.panics} panic(s) across ${gs.flows} flow(s)`
      : `${gs.flows} flow(s) dispatched, ${gs.tx_success} tx success, ${gs.expected_errors} expected ` +
        "rejection(s), 0 unexpected errors, 0 panics";
  return [
    {
      kind: "guided sim",
      objective:
        "Exercise happy-path settlement and negative-control rejection without unexpected error, panic, or accounting drift.",
      // Concise command; the evidence path lives in the Retained-evidence column
      // rather than being duplicated inline (R3.1/R3.2).
      command: "riptide sim run (guided)",
      result,
      retained_evidence: guidedSimPath,
      hashes: gs.sha256 ? [`guided-sim-run.json sha256 ${gs.sha256}`] : [],
      notes: `Status ${gs.status} over ${gs.iterations} iteration(s).`
    }
  ];
}

/**
 * Map guided-sim `flow_counts` to coverage rows (R4.1), deterministically. Each
 * exercised flow family becomes a `covered by guided sim` row; negative-control
 * families are tagged as rejection evidence; any declared P0 flow the guided sim
 * never exercised becomes a `not assessed` row. Rows are sorted by
 * `(priority rank, flow)` so the embedded matrix is byte-stable regardless of the
 * flow-count map's key order.
 */
function deriveCorrectnessCoverageRows(
  campaignRootLabel: string,
  evidence: AssessmentCorrectnessEvidence,
  riskPlan: AssessmentRiskPlan
): AssessmentCoverageRow[] {
  const gs = evidence.guided_sim;
  const rows: AssessmentCoverageRow[] = [];
  const coveredFlows = new Set<string>();
  if (gs) {
    const guidedSimPath = rootedArtifactPath(campaignRootLabel, gs.path);
    // Concise command; the evidence path lives in the Artifacts column rather
    // than being duplicated inline in every coverage row (R3.1/R3.2).
    const command = "riptide sim run (guided)";
    const artifacts = [guidedSimPath];
    for (const fc of gs.flow_counts) {
      const flowLabel = `guided-sim flow \`${fc.flow}\``;
      coveredFlows.add(flowLabel);
      const negative = isNegativeControlFlow(fc.flow);
      rows.push({
        priority: "P0",
        flow: flowLabel,
        status: "covered by guided sim",
        evidence_tier: negative ? "guided sim (negative control)" : "guided sim",
        commands: [command],
        artifacts,
        notes: negative
          ? `${fc.count} negative-control flow(s) dispatched; invalid actions were rejected as expected ` +
            `(${gs.expected_errors} expected rejection(s) across the run, ${gs.unexpected_errors} unexpected).`
          : `${fc.count} flow(s) dispatched; ${gs.unexpected_errors} unexpected error(s), ${gs.panics} panic(s) observed.`
      });
    }
  }
  for (const flow of riskPlan.p0_flows) {
    if (coveredFlows.has(flow)) continue;
    rows.push({
      priority: "P0",
      flow,
      status: "not assessed",
      evidence_tier: "none",
      commands: [],
      artifacts: [],
      notes: "Declared P0 flow not exercised by the ingested guided-sim evidence."
    });
  }
  return sortCoverageRows(rows);
}

/** A flow family is a negative control when its name marks invalid-action rejection. */
function isNegativeControlFlow(flow: string): boolean {
  return /negative|reject|invalid|control/i.test(flow);
}

function resolveCorrectnessReproduction(
  campaignRootLabel: string,
  evidence: AssessmentCorrectnessEvidence,
  commandOverride: string[] | undefined
): AssessmentReproduction {
  const commands = commandOverride ?? [`riptide assess ${shellQuote(campaignRootLabel)}`];
  const artifacts: AssessmentArtifactRef[] = [];
  if (evidence.guided_sim) {
    artifacts.push({
      path: rootedArtifactPath(campaignRootLabel, evidence.guided_sim.path),
      hash: evidence.guided_sim.sha256
    });
  }
  for (const runEvidence of evidence.runs) {
    artifacts.push({ path: rootedArtifactPath(campaignRootLabel, runEvidence.path), hash: runEvidence.sha256 });
  }
  for (const packEvidence of evidence.packs) {
    artifacts.push({ path: rootedArtifactPath(campaignRootLabel, packEvidence.path), hash: packEvidence.sha256 });
  }
  return {
    campaign_root: campaignRootLabel,
    commands,
    artifacts,
    hashes: { campaign_digest: null, surface_digest: null, surface_sha256: null }
  };
}

function rootedArtifactPath(rootLabel: string, artifactPath: string): string {
  const normalized = artifactPath.trim().split(path.sep).join("/");
  if (path.isAbsolute(artifactPath) || normalized.startsWith("/")) return normalized;
  if (normalized === "." || normalized.length === 0) return rootLabel;
  const cleanRoot = rootLabel.replace(/\/+$/, "");
  const cleanArtifact = normalized.replace(/^\.?\//, "");
  return `${cleanRoot}/${cleanArtifact}`;
}

/** Serialize an assessment model to its canonical, byte-stable on-disk form. */
export function serializeAssessment(model: AssessmentModel): string {
  return canonicalJson(model as unknown as JsonValue);
}

type AssessmentModelFacts = Omit<AssessmentModel, "assessment_digest" | "coverage_statement"> & {
  assessment_digest?: string;
  coverage_statement?: AssessmentCoverageStatement;
};

type CartographyCoverageFacts = AssessmentModelFacts & {
  campaign: AssessmentCampaignReference;
  totals: AssessmentCampaignTotals;
  surface: RiskSurfaceDocument;
  surface_highlights: AssessmentSurfaceHighlights;
};

/**
 * Derive the structured coverage / negative-space block from an assessment
 * model. The builder ignores any existing embedded block, so tests and future
 * consumers can recompute it over the same model and get byte-identical facts.
 */
export function buildCoverageStatement(model: AssessmentModel): AssessmentCoverageStatement {
  return buildCoverageStatementFromFacts(model);
}

function buildCoverageStatementFromFacts(model: AssessmentModelFacts): AssessmentCoverageStatement {
  const shape = effectiveAssessmentShape(model);
  if (
    shape === "cartography" &&
    model.campaign !== null &&
    model.totals !== null &&
    model.surface !== null &&
    model.surface_highlights !== null
  ) {
    return buildCartographyCoverageStatement(model as CartographyCoverageFacts);
  }
  return buildCorrectnessCoverageStatement(model);
}

function effectiveAssessmentShape(model: AssessmentModelFacts): AssessmentShape {
  return model.shape ?? (model.surface === null ? "correctness" : "cartography");
}

function buildCartographyCoverageStatement(
  model: CartographyCoverageFacts
): AssessmentCoverageStatement {
  return {
    schema_version: ASSESSMENT_COVERAGE_STATEMENT_SCHEMA,
    shape: "cartography",
    probed: {
      kind: "swept-gradient",
      risk_objective: model.campaign.risk_objective,
      seed_policy: model.campaign.seed_policy,
      run_budget: model.campaign.run_budget,
      completed_runs: model.totals.completed_runs,
      invariant_failed_runs: model.totals.invariant_failed_runs,
      invariant_failure_rate: roundNumber(model.totals.invariant_failure_rate),
      axes: model.surface.axes.map((axis) => coverageAxis(model.surface, axis))
    },
    hot_regions: surfaceHotRegions(model.surface),
    flat_no_signal_regions: surfaceNoSignalRegions(model.surface),
    blocked: coverageGaps(model.coverage_matrix)
  };
}

function buildCorrectnessCoverageStatement(model: AssessmentModelFacts): AssessmentCoverageStatement {
  const guidedSim = model.correctness?.guided_sim ?? null;
  const flowRows = model.coverage_matrix.filter(
    (row) => row.status === "covered" || row.status === "covered by guided sim"
  );
  const flows = flowRows.map((row) => guidedSimFlowProbe(row, guidedSim));
  const negativeControls = flows.filter((flow) => flow.negative_control);
  const flatNoSignal: AssessmentFlatNoSignalRegion[] = [
    {
      kind: "no_swept_gradient",
      signal_type: "parameter_gradient",
      interpretation: "no signal in this campaign",
      not_safety_claim: true,
      flow: "surface-less correctness assessment",
      dispatched_count: guidedSim?.flows ?? 0,
      expected_rejections: guidedSim?.expected_errors ?? 0,
      unexpected_errors: guidedSim?.unexpected_errors ?? 0,
      panics: guidedSim?.panics ?? 0
    }
  ];
  if (guidedSim && guidedSim.unexpected_errors === 0 && guidedSim.panics === 0) {
    flatNoSignal.push({
      kind: "guided_sim_no_unexpected_result",
      signal_type: "unexpected_error_or_panic",
      interpretation: "no signal in this campaign",
      not_safety_claim: true,
      flow: "assessed guided-sim flows",
      dispatched_count: guidedSim.flows,
      expected_rejections: guidedSim.expected_errors,
      unexpected_errors: guidedSim.unexpected_errors,
      panics: guidedSim.panics
    });
  }

  return {
    schema_version: ASSESSMENT_COVERAGE_STATEMENT_SCHEMA,
    shape: "correctness",
    probed: {
      kind: "guided-sim-flow-coverage",
      guided_sim: guidedSim
        ? {
            label: guidedSim.label,
            status: guidedSim.status,
            iterations: guidedSim.iterations,
            flows: guidedSim.flows,
            tx_success: guidedSim.tx_success,
            expected_errors: guidedSim.expected_errors,
            unexpected_errors: guidedSim.unexpected_errors,
            panics: guidedSim.panics,
            path: guidedSim.path,
            sha256: guidedSim.sha256
          }
        : null,
      flows,
      negative_controls: negativeControls
    },
    hot_regions: correctnessHotRegions(guidedSim),
    flat_no_signal_regions: flatNoSignal,
    blocked: coverageGaps(model.coverage_matrix)
  };
}

function coverageAxis(surface: RiskSurfaceDocument, axis: RiskSurfaceAxis): AssessmentCoverageAxis {
  const bins = axis.bins.map((bin) => {
    const pooled = poolSurfaceCells(surface.cells, [[axis.name, bin.index]]);
    return {
      index: bin.index,
      label: bin.label,
      ...(bin.value !== undefined ? { value: bin.value } : {}),
      ...(bin.lower !== undefined ? { lower: bin.lower } : {}),
      ...(bin.upper !== undefined ? { upper: bin.upper } : {}),
      run_count: pooled.run_count,
      failed_runs: pooled.failed_runs,
      invariant_failure_rate: pooled.invariant_failure_rate ?? 0
    };
  });
  const runCount = bins.reduce((sum, bin) => sum + bin.run_count, 0);
  const failedRuns = bins.reduce((sum, bin) => sum + bin.failed_runs, 0);
  return {
    axis: axis.name,
    kind: axis.kind,
    distribution: axis.distribution,
    ...(axis.unit !== undefined ? { unit: axis.unit } : {}),
    range: coverageAxisRange(axis),
    granularity: {
      method: axis.binning.method,
      bin_count: axis.bins.length,
      min_cell_run_count: surface.config.min_cell_run_count
    },
    populated_bins: bins.filter((bin) => bin.run_count > 0).length,
    run_count: runCount,
    failed_runs: failedRuns,
    invariant_failure_rate: runCount === 0 ? 0 : roundNumber(failedRuns / runCount),
    bins
  };
}

function coverageAxisRange(axis: RiskSurfaceAxis): AssessmentCoverageAxisRange {
  if (axis.kind === "discrete") {
    return {
      kind: "values",
      values: axis.bins.map((bin) => bin.value ?? null)
    };
  }
  const edges = axis.binning.method === "fixed-width" ? axis.binning.edges : [];
  return {
    kind: "interval",
    lower: axis.bins[0]?.lower ?? null,
    upper: axis.bins[axis.bins.length - 1]?.upper ?? null,
    edges
  };
}

function surfaceHotRegions(surface: RiskSurfaceDocument): AssessmentSurfaceHotRegion[] {
  const hot = surface.cells
    .map((cell) => {
      const failedRuns = failedRunsForCell(cell);
      return { cell, failedRuns };
    })
    .filter(({ cell, failedRuns }) => failedRuns > 0 || cell.invariant_failure_rate > 0)
    .map(({ cell, failedRuns }) => ({
      kind: "failing_cell" as const,
      coords: cellCoordRefs(surface, cell),
      run_count: cell.run_count,
      failed_runs: failedRuns,
      invariant_failure_rate: roundNumber(cell.invariant_failure_rate),
      sparse: cell.sparse
    }));
  hot.sort(
    (a, b) =>
      compareNumbersDesc(a.invariant_failure_rate, b.invariant_failure_rate) ||
      compareNumbersDesc(a.failed_runs, b.failed_runs) ||
      compareNumbersDesc(a.run_count, b.run_count) ||
      coordKey(a.coords).localeCompare(coordKey(b.coords))
  );
  return hot;
}

function correctnessHotRegions(guidedSim: AssessmentGuidedSimEvidence | null): AssessmentHotRegion[] {
  if (!guidedSim || (guidedSim.unexpected_errors === 0 && guidedSim.panics === 0)) return [];
  return [
    {
      kind: "guided_sim_unexpected_result",
      flow: "assessed guided-sim flows",
      dispatched_count: guidedSim.flows,
      expected_rejections: guidedSim.expected_errors,
      unexpected_errors: guidedSim.unexpected_errors,
      panics: guidedSim.panics,
      status: guidedSim.status,
      evidence: guidedSim.path
    }
  ];
}

function surfaceNoSignalRegions(surface: RiskSurfaceDocument): AssessmentFlatNoSignalRegion[] {
  const regions: AssessmentFlatNoSignalRegion[] = [];
  for (const entry of surface.sensitivity.ranking) {
    if (entry.monotonic !== "flat" || entry.min_bin_failure_rate !== 0 || entry.max_bin_failure_rate !== 0) {
      continue;
    }
    const axis = surface.axes.find((candidate) => candidate.name === entry.axis);
    if (!axis) continue;
    const pooled = poolSurfaceCells(surface.cells, []);
    regions.push({
      kind: "flat_axis_zero_failure",
      signal_type: "invariant_failure",
      interpretation: "no signal in this campaign",
      not_safety_claim: true,
      axis: axis.name,
      run_count: pooled.run_count,
      failed_runs: 0,
      invariant_failure_rate: 0,
      sparse: pooled.run_count < surface.config.min_cell_run_count
    });
  }
  for (const cell of surface.cells) {
    const failedRuns = failedRunsForCell(cell);
    if (cell.run_count === 0) {
      regions.push({
        kind: "unpopulated_cell",
        signal_type: "invariant_failure",
        interpretation: "no signal in this campaign",
        not_safety_claim: true,
        coords: cellCoordRefs(surface, cell),
        run_count: 0,
        failed_runs: 0,
        invariant_failure_rate: null,
        sparse: cell.sparse
      });
      continue;
    }
    if (failedRuns === 0 && cell.invariant_failure_rate === 0) {
      regions.push({
        kind: "zero_failure_cell",
        signal_type: "invariant_failure",
        interpretation: "no signal in this campaign",
        not_safety_claim: true,
        coords: cellCoordRefs(surface, cell),
        run_count: cell.run_count,
        failed_runs: 0,
        invariant_failure_rate: 0,
        sparse: cell.sparse
      });
    }
  }
  regions.sort(
    (a, b) =>
      noSignalKindRank(a.kind) - noSignalKindRank(b.kind) ||
      noSignalSortKey(a).localeCompare(noSignalSortKey(b))
  );
  return regions;
}

interface SurfacePool {
  run_count: number;
  failed_runs: number;
  invariant_failure_rate: number | null;
}

function poolSurfaceCells(
  cells: RiskSurfaceCell[],
  constraints: Array<[string, number]>
): SurfacePool {
  let runCount = 0;
  let failedRuns = 0;
  for (const cell of cells) {
    if (!cellMatches(cell, constraints)) continue;
    runCount += cell.run_count;
    failedRuns += failedRunsForCell(cell);
  }
  return {
    run_count: runCount,
    failed_runs: failedRuns,
    invariant_failure_rate: runCount === 0 ? null : roundNumber(failedRuns / runCount)
  };
}

function cellMatches(cell: RiskSurfaceCell, constraints: Array<[string, number]>): boolean {
  return constraints.every(([axis, binIndex]) =>
    cell.coords.some((coord) => coord.axis === axis && coord.bin_index === binIndex)
  );
}

function failedRunsForCell(cell: RiskSurfaceCell): number {
  return Math.round(cell.invariant_failure_rate * cell.run_count);
}

function cellCoordRefs(
  surface: RiskSurfaceDocument,
  cell: RiskSurfaceCell
): AssessmentCoverageCellCoord[] {
  return cell.coords.map((coord) => {
    const axis = surface.axes.find((candidate) => candidate.name === coord.axis);
    const bin = axis?.bins.find((candidate) => candidate.index === coord.bin_index);
    return {
      axis: coord.axis,
      bin_index: coord.bin_index,
      bin_label: bin?.label ?? String(coord.bin_index)
    };
  });
}

function coordKey(coords: AssessmentCoverageCellCoord[]): string {
  return coords.map((coord) => `${coord.axis}:${coord.bin_index}:${coord.bin_label}`).join("|");
}

function noSignalKindRank(kind: AssessmentFlatNoSignalRegion["kind"]): number {
  switch (kind) {
    case "flat_axis_zero_failure":
      return 0;
    case "zero_failure_cell":
      return 1;
    case "unpopulated_cell":
      return 2;
    case "guided_sim_no_unexpected_result":
      return 3;
    case "no_swept_gradient":
      return 4;
  }
}

function noSignalSortKey(region: AssessmentFlatNoSignalRegion): string {
  if ("axis" in region && region.axis) return region.axis;
  if ("coords" in region) return coordKey(region.coords ?? []);
  if ("flow" in region) return region.flow;
  return "";
}

function guidedSimFlowProbe(
  row: AssessmentCoverageRow,
  guidedSim: AssessmentGuidedSimEvidence | null
): AssessmentGuidedSimFlowProbe {
  const matchedFlow = guidedSimFlowMatch(row.flow, guidedSim);
  const negative = isNegativeCoverageRow(row);
  return {
    flow: row.flow,
    guided_sim_flow: matchedFlow?.flow ?? null,
    status: row.status,
    evidence_tier: row.evidence_tier,
    dispatched_count: matchedFlow?.count ?? null,
    negative_control: negative,
    expected_rejections: negative ? matchedFlow?.expected_errors ?? null : null,
    unexpected_errors: matchedFlow?.unexpected_errors ?? guidedSimZeroUnexpected(guidedSim),
    panics: guidedSim?.panics ?? null,
    artifacts: [...row.artifacts]
  };
}

function guidedSimFlowMatch(
  flow: string,
  guidedSim: AssessmentGuidedSimEvidence | null
): AssessmentGuidedSimFlowCount | null {
  if (!guidedSim) return null;
  const rawFlow = unwrapGuidedSimFlow(flow);
  const direct = guidedSim.flow_counts.find(
    (entry) => entry.flow === rawFlow || `guided-sim flow \`${entry.flow}\`` === flow
  );
  if (direct) return direct;

  const aliases = guidedSimFlowAliases(rawFlow);
  for (const alias of aliases) {
    const match = guidedSim.flow_counts.find((entry) => entry.flow === alias);
    if (match) return match;
  }

  const rowWords = guidedSimWords(rawFlow);
  let best: { entry: AssessmentGuidedSimFlowCount; score: number } | null = null;
  for (const entry of guidedSim.flow_counts) {
    const entryWords = guidedSimWords(entry.flow);
    const score = [...entryWords].filter((word) => rowWords.has(word)).length;
    if (score < 2) continue;
    if (!best || score > best.score || (score === best.score && entry.flow.localeCompare(best.entry.flow) < 0)) {
      best = { entry, score };
    }
  }
  return best?.entry ?? null;
}

function unwrapGuidedSimFlow(flow: string): string {
  const match = /^guided-sim flow `(.+)`$/.exec(flow);
  return match?.[1] ?? flow;
}

function guidedSimFlowAliases(flow: string): string[] {
  const words = guidedSimWords(flow);
  const has = (word: string): boolean => words.has(word);
  const aliases: string[] = [];

  if (has("payout") && has("session") && (has("negative") || has("control") || has("controls"))) {
    aliases.push("payout_session_negative_controls");
  }
  if (has("payout") && has("session") && (has("happy") || has("path"))) {
    aliases.push("payout_session_happy_path");
  }
  if (has("withdrawal") && (has("negative") || has("control") || has("controls"))) {
    aliases.push("withdrawal_negative_controls");
  }
  if ((has("withdrawal") || has("token")) && (has("finalize") || has("finalization") || has("finalizing"))) {
    aliases.push("withdrawal_finalize_token_happy_path");
  }
  if (has("cpi")) {
    aliases.push("cpi_paths");
  }
  if (has("authority") || has("unauthorized") || has("nav") || has("whitelist") || has("fee")) {
    aliases.push("authority_paths");
  }

  return aliases;
}

function guidedSimWords(value: string): Set<string> {
  return new Set(
    value
      .replace(/`/g, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 0 && word !== "and" && word !== "the")
  );
}

function guidedSimZeroUnexpected(guidedSim: AssessmentGuidedSimEvidence | null): number | null {
  if (!guidedSim) return null;
  return guidedSim.unexpected_errors === 0 ? 0 : null;
}

function isNegativeCoverageRow(row: AssessmentCoverageRow): boolean {
  return /negative control/i.test(row.evidence_tier) || isNegativeControlFlow(unwrapGuidedSimFlow(row.flow));
}

function coverageGaps(rows: AssessmentCoverageRow[]): AssessmentCoverageGap[] {
  return rows.filter(isCoverageGap).map((row) => ({
    priority: row.priority,
    flow: row.flow,
    status: row.status,
    evidence_tier: row.evidence_tier,
    commands: [...row.commands],
    artifacts: [...row.artifacts],
    notes: row.notes
  }));
}

function isCoverageGap(row: AssessmentCoverageRow): row is AssessmentCoverageRow & {
  status: AssessmentCoverageGap["status"];
} {
  return row.status === "blocked" || row.status === "out of scope" || row.status === "not assessed";
}

// ---------------------------------------------------------------------------
// Derivations (all deterministic)
// ---------------------------------------------------------------------------

function resolveProtocol(
  summary: CampaignSummaryJson,
  overrides: AssessmentInputs["protocol"]
): AssessmentProtocolIdentity {
  return {
    name: nonEmpty(overrides?.name) ?? summary.campaign.name,
    repository: nonEmpty(overrides?.repository ?? undefined) ?? null,
    commit: nonEmpty(overrides?.commit ?? undefined) ?? null,
    riptide_version: nonEmpty(overrides?.riptide_version ?? undefined) ?? null,
    assessment_date:
      nonEmpty(overrides?.assessment_date ?? undefined) ??
      assessmentDateFromSeedPolicy(summary.campaign.seed_policy) ??
      null
  };
}

function resolveCampaignReference(summary: CampaignSummaryJson): AssessmentCampaignReference {
  const c = summary.campaign;
  return {
    campaign_id: c.campaign_id,
    campaign_digest: c.campaign_digest,
    name: c.name,
    class: c.class,
    risk_objective: c.risk_objective,
    seed_policy: c.seed_policy,
    run_budget: c.run_budget,
    requested_runs: c.requested_runs,
    adapter: c.adapter
  };
}

function resolveTotals(summary: CampaignSummaryJson): AssessmentCampaignTotals {
  const t = summary.totals;
  return {
    requested_runs: t.requested_runs,
    completed_runs: t.completed_runs,
    passed_runs: t.passed_runs,
    invariant_failed_runs: t.invariant_failed_runs,
    setup_errors: t.setup_errors,
    skipped_runs: t.skipped_runs,
    invariant_failure_rate: roundNumber(t.invariant_failure_rate)
  };
}

function surfaceHighlights(surface: RiskSurfaceDocument): AssessmentSurfaceHighlights {
  const populated = surface.cells.filter((cell) => cell.run_count > 0);
  const worst = populated.length === 0
    ? 0
    : roundNumber(Math.max(...populated.map((cell) => cell.invariant_failure_rate)));
  const top = surface.sensitivity.ranking[0] ?? null;
  return {
    populated_cells: populated.length,
    total_cells: surface.cells.length,
    worst_cell_failure_rate: worst,
    most_sensitive_axis: top ? top.axis : null,
    most_sensitive_spread: top ? roundNumber(top.failure_rate_spread) : null,
    safe_region_status: surface.safe_region.status,
    safe_region_threshold: roundNumber(surface.safe_region.threshold),
    safe_region_bounds: surface.safe_region.bounds
  };
}

/**
 * Deterministic verdict derivation when the caller does not declare one. The
 * mapping is conservative and bounded: incomplete evidence blocks; failures
 * with a representable safe region invite tuning; a clean surface over real
 * runs is send-ready *for the declared region only*. `needs_guided_sim` is
 * reserved for coverage-declared use (defaults never silently emit it).
 */
function resolveVerdict(
  summary: CampaignSummaryJson,
  surface: RiskSurfaceDocument,
  highlights: AssessmentSurfaceHighlights,
  declared: AssessmentVerdict | undefined
): AssessmentVerdictBlock {
  if (declared) {
    return { value: declared, source: "declared", rationale: declaredRationale(declared) };
  }
  if (highlights.populated_cells === 0) {
    return {
      value: "unsupported",
      source: "derived",
      rationale:
        "No campaign runs were placed on the risk surface, so there is no simulation evidence over a declared region to assess."
    };
  }
  if (summary.totals.setup_errors > 0) {
    return {
      value: "blocked",
      source: "derived",
      rationale:
        `${summary.totals.setup_errors} setup error(s) left the campaign evidence incomplete; resolve them before this can be sent.`
    };
  }
  if (summary.totals.invariant_failed_runs > 0) {
    const rate = formatRate(summary.totals.invariant_failure_rate);
    if (surface.safe_region.status === "none") {
      return {
        value: "needs_campaign_tuning",
        source: "derived",
        rationale:
          `An invariant fired in ${rate} of completed runs and no region stayed under the ` +
          `${formatRate(surface.safe_region.threshold)} threshold within the declared region; tune the campaign before sending.`
      };
    }
    return {
      value: "needs_campaign_tuning",
      source: "derived",
      rationale:
        `An invariant fired in ${rate} of completed runs; a bounded region stayed under the ` +
        `${formatRate(surface.safe_region.threshold)} threshold, so tune parameters into it before sending.`
    };
  }
  return {
    value: "ready_to_send",
    source: "derived",
    rationale:
      "No declared invariant fired across the completed runs within the declared, fixed-seed parameter region."
  };
}

function declaredRationale(verdict: AssessmentVerdict): string {
  switch (verdict) {
    case "ready_to_send":
      return "Declared ready to send for the declared, fixed-seed simulation region.";
    case "needs_guided_sim":
      return "Declared as needing guided simulation to cover a dynamic flow before sending.";
    case "needs_campaign_tuning":
      return "Declared as needing campaign tuning into a safer parameter region before sending.";
    case "blocked":
      return "Declared blocked: required evidence is missing or a coverage flow is blocked.";
    case "unsupported":
      return "Declared unsupported for this assessment in the current scope.";
  }
}

/** Adapter marker the guided-sim → cartography producer stamps on its summary. */
export const GUIDED_SIM_ADAPTER = "guided-sim";

/** Reproduction command for guided-sim-derived cartography. */
const GUIDED_SIM_REPRODUCTION_COMMAND =
  "riptide sim run (sweep) -> riptide sim surface -> riptide assess";

/**
 * First-screen provenance disclosure for guided-sim-derived cartography. The
 * gradient and failure rates are real on-chain guided-sim execution, and the
 * cartography artifacts were synthesized from a sweep by `riptide sim surface`.
 * Stated up front so the report names its true evidence source.
 */
export const GUIDED_SIM_PROVENANCE_DISCLOSURE =
  "Evidence source: a guided-simulation parameter sweep converted into " +
  "campaign-cartography artifacts via `riptide sim surface`. " +
  "The failure rates and gradient are real guided-sim execution over the declared, " +
  "fixed-seed swept region.";

/** True when the cartography root was synthesized from a guided-sim sweep. */
function isGuidedSimDerived(summary: CampaignSummaryJson): boolean {
  return summary.campaign.adapter === GUIDED_SIM_ADAPTER;
}

function resolveRiskPlan(
  summary: CampaignSummaryJson,
  overrides: AssessmentInputs["riskPlan"]
): AssessmentRiskPlan {
  const sweptAxes = Object.entries(summary.parameters)
    .filter(([name, parameter]) => name !== "fixed_one" && parameter.values.length > 1)
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));
  const families = Object.keys(summary.scenario_families).sort((a, b) => a.localeCompare(b));
  const invariantNames = summary.lending?.liquidation_safety_failures.invariant_names ?? [];

  const guidedSim = isGuidedSimDerived(summary);
  const defaultP0 = families.map((family) => `scenario family \`${family}\``);
  const defaultEvidence = [guidedSim ? "guided-sim sweep" : "focused campaign"];
  const defaultFailureModes = invariantNames.length > 0
    ? invariantNames.map((name) => `invariant \`${name}\` firing`)
    : ["invariant firing under the swept parameter region"];
  const defaultTarget =
    `Bounded simulation-evidence claim for ${summary.campaign.name} (${summary.campaign.class}) over the ` +
    `declared ${summary.campaign.run_budget}-run, ${summary.campaign.seed_policy} parameter region: ${summary.campaign.risk_objective}.`;

  return {
    protocol_class: nonEmpty(overrides?.protocol_class) ?? summary.campaign.class,
    target_claim: nonEmpty(overrides?.target_claim) ?? defaultTarget,
    evidence_profile: dedupeSorted(overrides?.evidence_profile ?? defaultEvidence),
    p0_flows: overrides?.p0_flows ?? defaultP0,
    p1_flows: overrides?.p1_flows ?? [],
    expected_failure_modes: overrides?.expected_failure_modes ?? defaultFailureModes,
    guided_sim_boundaries: overrides?.guided_sim_boundaries ?? [],
    known_coverage_limits:
      overrides?.known_coverage_limits ??
      [
        `Evidence is bounded to the swept axes ${sweptAxes.length > 0 ? sweptAxes.map((a) => `\`${a}\``).join(", ") : "(none varied)"} over a fixed seed.`,
        "Flows outside the coverage matrix are not assessed."
      ]
  };
}

function resolveScope(
  summary: CampaignSummaryJson,
  surface: RiskSurfaceDocument,
  riskPlan: AssessmentRiskPlan
): AssessmentScope {
  const axes = surface.axes.map((axis) => `parameter axis \`${axis.name}\` (${axis.distribution})`);
  const families = Object.keys(summary.scenario_families)
    .sort((a, b) => a.localeCompare(b))
    .map((family) => `scenario family \`${family}\``);
  // Guided-sim-derived cartography names the real protocol flows it exercised
  // (read from recorded transaction labels) so the report does not read as an
  // opaque single dispatch. Gated on the guided-sim adapter, so real-campaign
  // scope bytes are unchanged.
  const guidedSimFlows =
    isGuidedSimDerived(summary) && summary.guided_sim_flows
      ? summary.guided_sim_flows
          .slice()
          .sort((a, b) => a.localeCompare(b))
          .map((flow) => `guided-sim flow \`${flow}\``)
      : [];
  const inScope = dedupeStable([
    ...families,
    ...guidedSimFlows,
    ...axes,
    `risk objective \`${summary.campaign.risk_objective}\` over the ${summary.campaign.seed_policy} seed policy`
  ]);
  const outOfScope = [
    "Mainnet behavior, historical replay, and live monitoring.",
    "Audit signoff, formal verification, and complete protocol safety.",
    "Flows, parameters, and seeds outside this campaign's declared region.",
    ...riskPlan.guided_sim_boundaries.map((boundary) => `Guided-sim boundary: ${boundary}`)
  ];
  return {
    in_scope: inScope,
    out_of_scope: outOfScope,
    claim_boundary: ASSESSMENT_CLAIM_BOUNDARY
  };
}

const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

function sortCoverageRows(rows: AssessmentCoverageRow[]): AssessmentCoverageRow[] {
  return [...rows].sort(
    (a, b) =>
      (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) ||
      a.priority.localeCompare(b.priority) ||
      a.flow.localeCompare(b.flow)
  );
}

function deriveCoverageRows(
  summary: CampaignSummaryJson,
  riskPlan: AssessmentRiskPlan,
  campaignRootLabel: string
): AssessmentCoverageRow[] {
  const guidedSim = isGuidedSimDerived(summary);
  const command = guidedSim
    ? GUIDED_SIM_REPRODUCTION_COMMAND
    : "original campaign command not recorded in campaign artifacts";
  const familyTier = guidedSim ? "guided-sim sweep" : "focused campaign";
  const adversarialTier = guidedSim ? "guided-sim adversarial sweep" : "adversarial campaign";
  const artifacts = [`${campaignRootLabel}/risk-surface.json`];
  const rows: AssessmentCoverageRow[] = [];
  for (const [family, row] of Object.entries(summary.scenario_families).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const failed = row.invariant_failed_runs;
    const status: CoverageStatus = row.completed_runs > 0 ? "covered" : "not assessed";
    rows.push({
      priority: "P0",
      flow: `scenario family \`${family}\``,
      status,
      evidence_tier: familyTier,
      commands: [command],
      artifacts,
      notes:
        row.completed_runs > 0
          ? `${row.completed_runs} completed run(s), ${failed} with an invariant failure.`
          : "No completed run landed in this family within the budget."
    });
  }
  // Each declared expected failure mode that maps to an observed invariant.
  for (const mode of riskPlan.expected_failure_modes) {
    rows.push({
      priority: "P0",
      flow: mode,
      status: summary.totals.invariant_failed_runs > 0 ? "covered" : "not assessed",
      evidence_tier: adversarialTier,
      commands: [command],
      artifacts,
      notes:
        summary.totals.invariant_failed_runs > 0
          ? `Observed in ${formatRate(summary.totals.invariant_failure_rate)} of completed runs.`
          : "Not exercised to failure within this campaign's budget."
    });
  }
  return sortCoverageRows(rows);
}

function deriveSimulations(
  summary: CampaignSummaryJson,
  surfaceSha256: string,
  campaignRootLabel: string
): AssessmentSimulation[] {
  const guidedSim = isGuidedSimDerived(summary);
  const objective = summary.campaign.risk_objective;
  const result =
    summary.totals.setup_errors > 0
      ? `${summary.totals.setup_errors} setup error(s)`
      : summary.totals.invariant_failed_runs > 0
        ? `${summary.totals.invariant_failed_runs} of ${summary.totals.completed_runs} runs fired an invariant`
        : `${summary.totals.completed_runs} runs completed with no invariant failure`;
  return [
    {
      kind: guidedSim ? "guided sim" : "focused campaign",
      objective,
      command: guidedSim
        ? GUIDED_SIM_REPRODUCTION_COMMAND
        : "original campaign command not recorded in campaign artifacts",
      result,
      retained_evidence: `${campaignRootLabel}/retention-manifest.json`,
      hashes: [
        `campaign-digest ${summary.campaign.campaign_digest}`,
        `risk-surface.json sha256 ${surfaceSha256}`
      ],
      notes:
        `Failure rate ${formatRate(summary.totals.invariant_failure_rate)} over the declared ` +
        `${summary.campaign.seed_policy} region.`
    }
  ];
}

function resolveRetainedEvidence(manifest: CampaignRetentionManifest): AssessmentRetainedEvidence[] {
  return manifest.entries.map((entry) => {
    if (entry.status === "selected") {
      return {
        label: entry.label,
        status: "selected",
        run_id: entry.run_id,
        case_digest: entry.case_digest ?? null,
        score: entry.score,
        reason: entry.reason,
        rerun_command: entry.rerun_command,
        risk_signals: distillRiskSignals(entry.risk_signals),
        warning: null
      };
    }
    return {
      label: entry.label,
      status: "warning",
      run_id: null,
      case_digest: null,
      score: null,
      reason: null,
      rerun_command: null,
      risk_signals: null,
      warning: entry.warning
    };
  });
}

function distillRiskSignals(signals: CampaignRetentionRiskSignals): AssessmentRetainedRiskSignals {
  return {
    status: signals.status,
    first_failure_tick: signals.first_failure_tick,
    invariant_names: [...signals.invariant_names].sort((a, b) => a.localeCompare(b)),
    total_bad_debt: signals.total_bad_debt,
    total_liquidations: signals.total_liquidations,
    max_utilization: signals.max_utilization,
    min_tvl: signals.min_tvl,
    risk_score: signals.risk_score
  };
}

function resolveReproduction(
  campaignRootLabel: string,
  campaign: AssessmentCampaignReference,
  surface: RiskSurfaceDocument,
  surfaceSha256: string,
  commandOverride: string[] | undefined
): AssessmentReproduction {
  const commands = commandOverride ?? [`riptide assess ${shellQuote(campaignRootLabel)}`];
  return {
    campaign_root: campaignRootLabel,
    commands,
    artifacts: [
      { path: `${campaignRootLabel}/campaign-summary.json`, hash: null },
      { path: `${campaignRootLabel}/risk-surface.json`, hash: surfaceSha256 },
      { path: `${campaignRootLabel}/retention-manifest.json`, hash: null }
    ],
    hashes: {
      campaign_digest: campaign.campaign_digest,
      surface_digest: surface.surface_digest,
      surface_sha256: surfaceSha256
    }
  };
}

// ---------------------------------------------------------------------------
// Stub narrative (T03 replaces this in narrative.ts) — keeps T02 buildable
// ---------------------------------------------------------------------------

/**
 * A minimal, deterministic narrative so the renderer (T02) compiles and renders
 * before the real generator (T03) lands. It separates findings from
 * non-findings and uses bounded language, but is intentionally terse; T03 owns
 * the full prose.
 */
export const stubNarrative: NarrativeProvider = (rawModel) => {
  const model = requireCartographyModel(rawModel);
  const failed = model.totals.invariant_failed_runs;
  const top = model.surface_highlights.most_sensitive_axis;
  const recommendation = recommendationFromModel(model);
  const findings: AssessmentFinding[] = failed > 0
    ? [
        {
          title: `Invariant failures concentrated on \`${top ?? "the swept region"}\``,
          severity: "P0",
          affected_flow: model.risk_plan.p0_flows[0] ?? "swept parameter region",
          evidence_tier: "focused campaign",
          observed: `${failed} of ${model.totals.completed_runs} completed runs fired an invariant.`,
          why_it_matters:
            "Failures cluster in part of the declared region, so a parameter bound is recommended over the whole region.",
          recommended: recommendation.statement,
          reproduction_command: model.reproduction.commands[0] ?? null,
          artifacts: [`${model.reproduction.campaign_root}/risk-surface.json`],
          hashes: [`surface sha256 ${model.reproduction.hashes.surface_sha256}`]
        }
      ]
    : [];
  const nonFindings: AssessmentNonFinding[] = failed === 0
    ? [
        {
          flow: model.risk_plan.p0_flows[0] ?? "swept parameter region",
          evidence: `risk-surface.json sha256 ${model.reproduction.hashes.surface_sha256}`,
          statement: "No declared invariant fired under these inputs.",
          limit: "Evidence is bounded to the declared, fixed-seed parameter region."
        }
      ]
    : [];
  return {
    schema: ASSESSMENT_NARRATIVE_SCHEMA,
    executive_summary: [
      `${model.protocol.name}: ${model.verdict.rationale}`,
      model.claim_boundary
    ],
    headline_claim: model.risk_plan.target_claim,
    main_finding: failed > 0 ? (findings[0]?.title ?? "") : "No finding under the declared inputs.",
    main_limit: "Flows, parameters, and seeds outside this campaign's declared region are not assessed.",
    findings,
    non_findings: nonFindings,
    recommendation
  };
};

function recommendationFromModel(model: CartographyAssessmentModel): AssessmentRecommendation {
  const highlights = model.surface_highlights;
  const threshold = highlights.safe_region_threshold;
  if (highlights.safe_region_status === "none") {
    return {
      kind: "none",
      primary_axis: highlights.most_sensitive_axis,
      statement:
        `No parameter region stayed at or under the ${formatRate(threshold)} failure-rate threshold within the declared region.`,
      threshold,
      bounds: highlights.safe_region_bounds
    };
  }
  const primary = highlights.most_sensitive_axis;
  const bound = highlights.safe_region_bounds.find((b) => b.axis === primary) ?? highlights.safe_region_bounds[0];
  const boundText = bound ? describeBound(bound) : "the declared region";
  return {
    kind: highlights.safe_region_status === "entire-region" ? "entire-region" : "bounded",
    primary_axis: primary,
    statement:
      highlights.safe_region_status === "entire-region"
        ? `Every populated cell stayed at or under the ${formatRate(threshold)} threshold; keep parameters within the declared region.`
        : `Keep ${primary ? `\`${primary}\`` : "parameters"} within ${boundText} to stay at or under the ${formatRate(threshold)} failure-rate threshold.`,
    threshold,
    bounds: highlights.safe_region_bounds
  };
}

function describeBound(bound: RiskSurfaceAxisBound): string {
  if (bound.kind === "discrete") {
    const values = bound.allowed_values ?? [];
    if (values.length === 0) return "no value that stays under threshold";
    return `{${values.map((value) => (value === null ? "null" : String(value))).join(", ")}}`;
  }
  const range = bound.bin_range;
  if (!range) return "no range that stays under threshold";
  const lower = range.lower === null ? "(open)" : String(range.lower);
  const upper = range.upper === null ? "(open)" : String(range.upper);
  return `[${lower}, ${upper}]`;
}

// ---------------------------------------------------------------------------
// I/O + shared deterministic helpers
// ---------------------------------------------------------------------------

function validateAssessmentArtifacts(
  summary: CampaignSummaryJson,
  surface: RiskSurfaceDocument,
  retentionManifest: CampaignRetentionManifest
): void {
  validateCampaignSummary(summary);
  validateRiskSurface(surface);
  validateRetentionManifest(retentionManifest);
  validateArtifactIdentity(summary, surface, retentionManifest);
  validateSurfaceDigest(surface);
}

function validateCampaignSummary(summary: CampaignSummaryJson): void {
  const root = requireObject(summary, CAMPAIGN_SUMMARY_FILE, "document");
  const schema = requireString(root, CAMPAIGN_SUMMARY_FILE, "schema_version");
  if (schema !== "campaign-summary.v1") {
    throw new AssessmentIngestError(
      `${CAMPAIGN_SUMMARY_FILE} is schema ${JSON.stringify(schema)}, not "campaign-summary.v1".`,
      "assessment.v1 ingests campaign-summary.v1 artifacts; regenerate the campaign with the current CLI."
    );
  }
  const campaign = requireObject(root.campaign, CAMPAIGN_SUMMARY_FILE, "campaign");
  requireString(campaign, CAMPAIGN_SUMMARY_FILE, "campaign.campaign_id");
  requireString(campaign, CAMPAIGN_SUMMARY_FILE, "campaign.campaign_digest");
  requireString(campaign, CAMPAIGN_SUMMARY_FILE, "campaign.name");
  requireString(campaign, CAMPAIGN_SUMMARY_FILE, "campaign.class");
  requireString(campaign, CAMPAIGN_SUMMARY_FILE, "campaign.risk_objective");
  requireString(campaign, CAMPAIGN_SUMMARY_FILE, "campaign.seed_policy");
  requireString(campaign, CAMPAIGN_SUMMARY_FILE, "campaign.adapter");
  requireNumber(campaign, CAMPAIGN_SUMMARY_FILE, "campaign.run_budget");
  requireNumber(campaign, CAMPAIGN_SUMMARY_FILE, "campaign.requested_runs");
  requireObject(root.totals, CAMPAIGN_SUMMARY_FILE, "totals");
  requireObject(root.scenario_families, CAMPAIGN_SUMMARY_FILE, "scenario_families");
  requireObject(root.parameters, CAMPAIGN_SUMMARY_FILE, "parameters");
}

function validateRiskSurface(surface: RiskSurfaceDocument): void {
  const root = requireObject(surface, RISK_SURFACE_FILE, "document");
  const schema = requireString(root, RISK_SURFACE_FILE, "schema_version");
  if (schema !== "risk-surface.v1") {
    throw new AssessmentIngestError(
      `${RISK_SURFACE_FILE} is schema ${JSON.stringify(schema)}, not "risk-surface.v1".`,
      "assessment.v1 requires a Sprint 39 risk-surface.v1 artifact; rerun the campaign with the current CLI."
    );
  }
  const campaign = requireObject(root.campaign, RISK_SURFACE_FILE, "campaign");
  requireString(campaign, RISK_SURFACE_FILE, "campaign.campaign_id");
  requireString(campaign, RISK_SURFACE_FILE, "campaign.campaign_digest");
  requireString(campaign, RISK_SURFACE_FILE, "campaign.name");
  requireString(campaign, RISK_SURFACE_FILE, "campaign.class");
  requireString(campaign, RISK_SURFACE_FILE, "campaign.risk_objective");
  requireArray(root.axes, RISK_SURFACE_FILE, "axes");
  requireArray(root.cells, RISK_SURFACE_FILE, "cells");
  requireArray(root.metrics, RISK_SURFACE_FILE, "metrics");
  const sensitivity = requireObject(root.sensitivity, RISK_SURFACE_FILE, "sensitivity");
  requireArray(sensitivity.ranking, RISK_SURFACE_FILE, "sensitivity.ranking");
  const safeRegion = requireObject(root.safe_region, RISK_SURFACE_FILE, "safe_region");
  const status = requireString(safeRegion, RISK_SURFACE_FILE, "safe_region.status");
  if (!["found", "none", "entire-region"].includes(status)) {
    throw malformedArtifact(
      RISK_SURFACE_FILE,
      `safe_region.status must be one of "found", "none", or "entire-region", got ${JSON.stringify(status)}`
    );
  }
  requireNumber(safeRegion, RISK_SURFACE_FILE, "safe_region.threshold");
  requireArray(safeRegion.bounds, RISK_SURFACE_FILE, "safe_region.bounds");
  requireString(root, RISK_SURFACE_FILE, "surface_digest");
}

function validateRetentionManifest(manifest: CampaignRetentionManifest): void {
  const root = requireObject(manifest, RETENTION_MANIFEST_FILE, "document");
  const schema = requireString(root, RETENTION_MANIFEST_FILE, "schema_version");
  if (schema !== "campaign-retention-manifest.v1") {
    throw new AssessmentIngestError(
      `${RETENTION_MANIFEST_FILE} is schema ${JSON.stringify(schema)}, not "campaign-retention-manifest.v1".`,
      "assessment.v1 requires the campaign retention manifest emitted by the campaign runner; regenerate the campaign artifacts."
    );
  }
  requireString(root, RETENTION_MANIFEST_FILE, "campaign_id");
  requireString(root, RETENTION_MANIFEST_FILE, "campaign_digest");
  requireString(root, RETENTION_MANIFEST_FILE, "class");
  requireString(root, RETENTION_MANIFEST_FILE, "risk_objective");
  const entries = requireArray(root.entries, RETENTION_MANIFEST_FILE, "entries");
  for (let index = 0; index < entries.length; index += 1) {
    validateRetentionEntry(entries[index], index);
  }
}

function validateRetentionEntry(entry: unknown, index: number): void {
  const record = requireObject(entry, RETENTION_MANIFEST_FILE, `entries[${index}]`);
  const status = requireString(record, RETENTION_MANIFEST_FILE, `entries[${index}].status`);
  if (status === "selected") {
    requireString(record, RETENTION_MANIFEST_FILE, `entries[${index}].run_id`);
    requireString(record, RETENTION_MANIFEST_FILE, `entries[${index}].reason`);
    requireString(record, RETENTION_MANIFEST_FILE, `entries[${index}].rerun_command`);
    const signals = requireObject(record.risk_signals, RETENTION_MANIFEST_FILE, `entries[${index}].risk_signals`);
    requireString(signals, RETENTION_MANIFEST_FILE, `entries[${index}].risk_signals.status`);
    requireArray(signals.invariant_names, RETENTION_MANIFEST_FILE, `entries[${index}].risk_signals.invariant_names`);
    requireNumber(signals, RETENTION_MANIFEST_FILE, `entries[${index}].risk_signals.risk_score`);
    return;
  }
  if (status === "warning") {
    requireString(record, RETENTION_MANIFEST_FILE, `entries[${index}].warning`);
    return;
  }
  throw malformedArtifact(
    RETENTION_MANIFEST_FILE,
    `entries[${index}].status must be "selected" or "warning", got ${JSON.stringify(status)}`
  );
}

function validateArtifactIdentity(
  summary: CampaignSummaryJson,
  surface: RiskSurfaceDocument,
  manifest: CampaignRetentionManifest
): void {
  const summaryCampaign = summary.campaign;
  const surfaceCampaign = surface.campaign;
  requireSameIdentity(
    RISK_SURFACE_FILE,
    "campaign.campaign_id",
    surfaceCampaign.campaign_id,
    CAMPAIGN_SUMMARY_FILE,
    "campaign.campaign_id",
    summaryCampaign.campaign_id
  );
  requireSameIdentity(
    RISK_SURFACE_FILE,
    "campaign.campaign_digest",
    surfaceCampaign.campaign_digest,
    CAMPAIGN_SUMMARY_FILE,
    "campaign.campaign_digest",
    summaryCampaign.campaign_digest
  );
  requireSameIdentity(
    RETENTION_MANIFEST_FILE,
    "campaign_id",
    manifest.campaign_id,
    CAMPAIGN_SUMMARY_FILE,
    "campaign.campaign_id",
    summaryCampaign.campaign_id
  );
  requireSameIdentity(
    RETENTION_MANIFEST_FILE,
    "campaign_digest",
    manifest.campaign_digest,
    CAMPAIGN_SUMMARY_FILE,
    "campaign.campaign_digest",
    summaryCampaign.campaign_digest
  );
  requireSameIdentity(
    RISK_SURFACE_FILE,
    "campaign.class",
    surfaceCampaign.class,
    CAMPAIGN_SUMMARY_FILE,
    "campaign.class",
    summaryCampaign.class
  );
  requireSameIdentity(
    RETENTION_MANIFEST_FILE,
    "class",
    manifest.class,
    CAMPAIGN_SUMMARY_FILE,
    "campaign.class",
    summaryCampaign.class
  );
  requireSameIdentity(
    RISK_SURFACE_FILE,
    "campaign.risk_objective",
    surfaceCampaign.risk_objective,
    CAMPAIGN_SUMMARY_FILE,
    "campaign.risk_objective",
    summaryCampaign.risk_objective
  );
  requireSameIdentity(
    RETENTION_MANIFEST_FILE,
    "risk_objective",
    manifest.risk_objective,
    CAMPAIGN_SUMMARY_FILE,
    "campaign.risk_objective",
    summaryCampaign.risk_objective
  );
}

function validateSurfaceDigest(surface: RiskSurfaceDocument): void {
  const { surface_digest: surfaceDigest, ...document } = surface as RiskSurfaceDocument & Record<string, unknown>;
  const expected = sha256Hex(
    `${RISK_SURFACE_HASH_PREFIX}\n${canonicalJson(document as unknown as JsonValue)}`
  );
  if (surfaceDigest !== expected) {
    throw new AssessmentIngestError(
      `${RISK_SURFACE_FILE} surface_digest ${JSON.stringify(surfaceDigest)} does not match the document contents.`,
      "Regenerate the campaign artifacts; assessment ingestion refuses a risk surface whose embedded digest does not verify."
    );
  }
}

function requireSameIdentity(
  leftFile: string,
  leftPath: string,
  leftValue: string,
  rightFile: string,
  rightPath: string,
  rightValue: string
): void {
  if (leftValue !== rightValue) {
    throw new AssessmentIngestError(
      `${leftFile} ${leftPath} ${JSON.stringify(leftValue)} does not match ` +
        `${rightFile} ${rightPath} ${JSON.stringify(rightValue)}.`,
      "Use artifacts from the same campaign root, or rerun the campaign so summary, surface, and retention manifest agree."
    );
  }
}

async function readRaw(filePath: string, fileLabel: string, hint: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (err) {
    if (isNotFound(err)) {
      throw new AssessmentIngestError(`${fileLabel} not found at ${filePath}.`, hint);
    }
    throw new AssessmentIngestError(`could not read ${fileLabel} at ${filePath}: ${errMessage(err)}`, hint);
  }
}

async function readArtifact<T>(
  filePath: string,
  fileLabel: string,
  _schemaLabel: string,
  hint: string
): Promise<T> {
  const raw = await readRaw(filePath, fileLabel, hint);
  return parseJson<T>(raw, fileLabel);
}

function parseJson<T>(raw: string, fileLabel: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new AssessmentIngestError(
      `${fileLabel} is not valid JSON: ${errMessage(err)}.`,
      "Regenerate the campaign artifacts; assessment ingestion does not repair malformed JSON."
    );
  }
}

function requireObject(value: unknown, fileLabel: string, pathLabel: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw malformedArtifact(fileLabel, `${pathLabel} must be a JSON object`);
  }
  return value;
}

function requireArray(value: unknown, fileLabel: string, pathLabel: string): unknown[] {
  if (!Array.isArray(value)) {
    throw malformedArtifact(fileLabel, `${pathLabel} must be an array`);
  }
  return value;
}

function requireString(
  object: Record<string, unknown>,
  fileLabel: string,
  pathLabel: string
): string {
  const key = leafKey(pathLabel);
  const value = object[key];
  if (typeof value !== "string" || value.length === 0) {
    throw malformedArtifact(fileLabel, `${pathLabel} must be a non-empty string`);
  }
  return value;
}

function requireNumber(
  object: Record<string, unknown>,
  fileLabel: string,
  pathLabel: string
): number {
  const key = leafKey(pathLabel);
  const value = object[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw malformedArtifact(fileLabel, `${pathLabel} must be a finite number`);
  }
  return value;
}

function leafKey(pathLabel: string): string {
  const bracket = pathLabel.match(/\.?([^.[\]]+)$/);
  return bracket ? bracket[1]! : pathLabel;
}

function malformedArtifact(fileLabel: string, detail: string): AssessmentIngestError {
  return new AssessmentIngestError(
    `${fileLabel} is malformed: ${detail}.`,
    "Regenerate the campaign artifacts; assessment ingestion only accepts complete, current campaign artifacts."
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function assessmentDateFromSeedPolicy(seedPolicy: string): string | null {
  const match = seedPolicy.trim().match(/^fixed:(\d{4})(\d{2})(\d{2})$/);
  return match ? isoDateFromParts(match[1]!, match[2]!, match[3]!) : null;
}

function extractAssessmentDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:T|$)/);
  if (iso) return isoDateFromParts(iso[1]!, iso[2]!, iso[3]!);

  // Guided-sim base seeds often start with YYYYMMDD followed by deterministic
  // seed material, e.g. 202605220000...
  const compact = trimmed.match(/^(\d{4})(\d{2})(\d{2})/);
  return compact ? isoDateFromParts(compact[1]!, compact[2]!, compact[3]!) : null;
}

function isoDateFromParts(yearText: string, monthText: string, dayText: string): string | null {
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${yearText}-${monthText}-${dayText}`;
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function dedupeSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function dedupeStable(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
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

function shellQuote(value: string): string {
  return /[^A-Za-z0-9_./-]/.test(value) ? `'${value.replace(/'/g, "'\\''")}'` : value;
}

function roundNumber(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1_000_000) / 1_000_000;
}
