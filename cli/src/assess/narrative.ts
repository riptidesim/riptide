import type { RiskSurfaceAxisBound } from "../campaign/surface.js";

import {
  ASSESSMENT_NARRATIVE_SCHEMA,
  type AssessmentFinding,
  type AssessmentModel,
  type AssessmentNarrative,
  type AssessmentNonFinding,
  type AssessmentRecommendation,
  type NarrativeProvider
} from "./model.js";

/**
 * narrative.ts — the deterministic auto-narrative generator (R3).
 *
 * ## What this is
 *
 * A pure projection from the hashed {@link AssessmentModel} (facts) to the
 * {@link AssessmentNarrative} blocks (prose) the markdown renderer (T02) slots
 * into the report. It replaces the terse {@link import("./model.js").stubNarrative}
 * with the real generator: an executive summary, a finding when a declared
 * invariant fired, explicit non-findings when it did not, and the safe-region
 * recommendation.
 *
 * ## Honesty by construction (R3.2 / R3.3)
 *
 * Over-claiming is made hard structurally, not by review:
 *
 * 1. **Findings vs non-findings never blur.** A finding is only emitted when the
 *    model records invariant-failed runs. A clean surface produces a
 *    *non-finding* whose statement is "No declared invariant fired under these
 *    inputs." — never "proven safe", "guaranteed", or "certified".
 * 2. **Every claim is region-bounded.** Each block ties its statement to the
 *    campaign's declared, fixed-seed parameter region and run budget. The
 *    recommendation cites the declared failure-rate threshold explicitly.
 * 3. **The claim boundary is echoed verbatim.** The executive summary closes
 *    with {@link AssessmentModel.claim_boundary} so the simulation-evidence
 *    scope travels with the prose.
 * 4. **No audit-equivalent vocabulary.** Generated sentences never assert audit
 *    signoff, formal verification, complete protocol safety, or mainnet
 *    behavior; those words appear only inside the negated claim boundary.
 *
 * ## Determinism (R3.1)
 *
 * Every string is derived only from the model — no wall-clock, randomness, or
 * insertion-order dependence. Numbers reuse the model's already-rounded values
 * and a fixed percentage format, so two runs over the same model produce
 * byte-identical narrative blocks (the byte-stability the renderer relies on).
 */
export const generateAssessmentNarrative: NarrativeProvider = (model) => {
  const recommendation = buildRecommendation(model);
  const findings = buildFindings(model, recommendation);
  const nonFindings = buildNonFindings(model);
  return {
    schema: ASSESSMENT_NARRATIVE_SCHEMA,
    executive_summary: buildExecutiveSummary(model, recommendation),
    headline_claim: model.risk_plan.target_claim,
    main_finding: findings.length > 0 ? findings[0]!.title : "No finding under the declared inputs.",
    main_limit: buildMainLimit(model),
    findings,
    non_findings: nonFindings,
    recommendation
  };
};

// ---------------------------------------------------------------------------
// Executive summary (R3.1)
// ---------------------------------------------------------------------------

function buildExecutiveSummary(
  model: AssessmentModel,
  recommendation: AssessmentRecommendation
): string[] {
  const totals = model.totals;
  const swept = sweptAxes(model);
  const sweptPhrase =
    swept.length > 0
      ? `, sweeping ${joinList(swept.map((axis) => `\`${axis}\``))}`
      : ", with no varying parameters";

  const whatRan =
    `${model.protocol.name} was assessed over the \`${model.campaign.name}\` ${model.campaign.class} ` +
    `campaign: ${totals.completed_runs} of ${totals.requested_runs} requested run(s) completed under the ` +
    `${model.campaign.seed_policy} seed policy${sweptPhrase}.`;

  const verdict = `Verdict — ${humanVerdict(model.verdict.value)}: ${model.verdict.rationale}`;

  const failed = totals.invariant_failed_runs;
  const top = model.surface_highlights.most_sensitive_axis;
  const evidence =
    failed > 0
      ? `A declared invariant fired in ${formatRate(totals.invariant_failure_rate)} of completed runs` +
        (top ? `, and \`${top}\` moved the failure rate most across the swept region` : "") +
        `. ${recommendation.statement}`
      : `No declared invariant fired across the ${totals.completed_runs} completed run(s) within the declared ` +
        `parameter region. ${recommendation.statement}`;

  return [whatRan, verdict, evidence, model.claim_boundary];
}

// ---------------------------------------------------------------------------
// Findings (R3.1 / R3.2)
// ---------------------------------------------------------------------------

function buildFindings(
  model: AssessmentModel,
  recommendation: AssessmentRecommendation
): AssessmentFinding[] {
  const failed = model.totals.invariant_failed_runs;
  if (failed === 0) return [];

  const top = model.surface_highlights.most_sensitive_axis;
  const topEntry = top ? model.surface.sensitivity.ranking.find((entry) => entry.axis === top) ?? null : null;
  const worst = formatRate(model.surface_highlights.worst_cell_failure_rate);
  const shape = topEntry ? trendPhrase(topEntry.monotonic) : null;

  const title =
    top && shape
      ? `Invariant failures ${shape} \`${top}\``
      : top
        ? `Invariant failures concentrate along \`${top}\``
        : "Invariant failures within the swept parameter region";

  const affectedFlow = top ? `parameter axis \`${top}\`` : (model.risk_plan.p0_flows[0] ?? "swept parameter region");

  const observed =
    `${failed} of ${model.totals.completed_runs} completed run(s) (${formatRate(model.totals.invariant_failure_rate)}) ` +
    `fired a declared invariant; the worst surface cell reached a ${worst} invariant-failure rate.`;

  return [
    {
      title,
      severity: "P0",
      affected_flow: affectedFlow,
      evidence_tier: "focused campaign",
      observed,
      why_it_matters:
        "Failures cluster in part of the declared parameter region rather than spreading uniformly, so a bounded " +
        "parameter recommendation is more actionable than a single region-wide verdict.",
      recommended: recommendation.statement,
      reproduction_command: model.reproduction.commands[0] ?? null,
      artifacts: [`${model.reproduction.campaign_root}/risk-surface.json`],
      hashes: [
        `risk-surface.json sha256 ${model.reproduction.hashes.surface_sha256}`,
        `campaign-digest ${model.reproduction.hashes.campaign_digest}`
      ]
    }
  ];
}

// ---------------------------------------------------------------------------
// Non-findings (R3.2) — tested, no declared invariant fired under the inputs
// ---------------------------------------------------------------------------

function buildNonFindings(model: AssessmentModel): AssessmentNonFinding[] {
  const evidence = `risk-surface.json sha256 ${model.reproduction.hashes.surface_sha256}`;
  const limit = "Evidence is bounded to the declared, fixed-seed parameter region and run budget.";

  if (model.totals.invariant_failed_runs === 0) {
    return [
      {
        flow: model.risk_plan.p0_flows[0] ?? "swept parameter region",
        evidence,
        statement: "No declared invariant fired under these inputs.",
        limit
      }
    ];
  }

  // Failures occurred, but a representable sub-region can still be a bounded
  // non-finding only when the region's own observed failure rate is exactly 0.
  // The safe-region contract is "at or under threshold", and that threshold may
  // be non-zero, so threshold membership alone must not become "no invariant
  // fired" prose.
  const highlights = model.surface_highlights;
  const safeRegionWorst = model.surface.safe_region.worst_case_failure_rate;
  if (
    highlights.safe_region_status !== "none" &&
    highlights.safe_region_bounds.length > 0 &&
    safeRegionWorst === 0
  ) {
    return [
      {
        flow: `recommended parameter region (${describeRegion(highlights.safe_region_bounds)})`,
        evidence,
        statement: "No declared invariant fired under the inputs that fell inside the recommended bounds.",
        limit:
          `Holds only within ${describeRegion(highlights.safe_region_bounds)} at or under the ` +
          `${formatRate(highlights.safe_region_threshold)} failure-rate threshold; cells outside it are covered by the finding above.`
      }
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Recommendation (R3.1 / R3.3) — cites threshold + fixed-seed region
// ---------------------------------------------------------------------------

function buildRecommendation(model: AssessmentModel): AssessmentRecommendation {
  const highlights = model.surface_highlights;
  const threshold = highlights.safe_region_threshold;
  const thresholdText = formatRate(threshold);

  if (highlights.safe_region_status === "none") {
    return {
      kind: "none",
      primary_axis: highlights.most_sensitive_axis,
      statement:
        `No parameter sub-region held the invariant-failure rate at or under the ${thresholdText} threshold within ` +
        "the declared, fixed-seed parameter region; tune the campaign toward a safer region before relying on these inputs.",
      threshold,
      bounds: highlights.safe_region_bounds
    };
  }

  if (highlights.safe_region_status === "entire-region") {
    return {
      kind: "entire-region",
      primary_axis: highlights.most_sensitive_axis,
      statement:
        `Every populated cell held the invariant-failure rate at or under the ${thresholdText} threshold; keeping ` +
        "parameters within the declared, fixed-seed region stayed at or under it.",
      threshold,
      bounds: highlights.safe_region_bounds
    };
  }

  const primary = highlights.most_sensitive_axis;
  const primaryBound =
    (primary ? highlights.safe_region_bounds.find((bound) => bound.axis === primary) : undefined) ??
    highlights.safe_region_bounds[0];
  const where = primaryBound ? describeBound(primaryBound) : "the recommended bounds";
  const axisText = primaryBound ? `\`${primaryBound.axis}\`` : (primary ? `\`${primary}\`` : "parameters");

  return {
    kind: "bounded",
    primary_axis: primary,
    statement:
      `Keep ${axisText} ${where} to hold the invariant-failure rate at or under the ${thresholdText} ` +
      "threshold across the declared, fixed-seed parameter region.",
    threshold,
    bounds: highlights.safe_region_bounds
  };
}

// ---------------------------------------------------------------------------
// Main limit (R3.1) — the largest surface the assessment does not cover
// ---------------------------------------------------------------------------

const LIMIT_STATUS_RANK: Record<string, number> = {
  blocked: 0,
  "not assessed": 1,
  "out of scope": 2
};

function buildMainLimit(model: AssessmentModel): string {
  const candidates = model.coverage_matrix
    .filter((row) => row.status in LIMIT_STATUS_RANK)
    .sort(
      (a, b) =>
        (LIMIT_STATUS_RANK[a.status] ?? 9) - (LIMIT_STATUS_RANK[b.status] ?? 9) ||
        a.flow.localeCompare(b.flow)
    );
  const top = candidates[0];
  if (top) {
    return `${top.flow} is ${top.status}: ${top.notes}`;
  }
  return "Flows, parameters, and seeds outside this campaign's declared region are not assessed.";
}

// ---------------------------------------------------------------------------
// Deterministic formatting + phrasing helpers
// ---------------------------------------------------------------------------

function sweptAxes(model: AssessmentModel): string[] {
  return model.surface.axes.map((axis) => axis.name);
}

function trendPhrase(monotonic: string | null): string | null {
  switch (monotonic) {
    case "increasing":
      return "rise with";
    case "decreasing":
      return "fall with";
    case "non-monotonic":
      return "vary non-monotonically across";
    case "flat":
      return "stay flat across";
    default:
      return null;
  }
}

function humanVerdict(verdict: string): string {
  return verdict.replace(/_/g, " ");
}

function describeRegion(bounds: RiskSurfaceAxisBound[]): string {
  if (bounds.length === 0) return "the recommended bounds";
  return bounds.map((bound) => `\`${bound.axis}\` ${describeBound(bound)}`).join(", ");
}

function describeBound(bound: RiskSurfaceAxisBound): string {
  if (bound.kind === "discrete") {
    const values = bound.allowed_values ?? [];
    if (values.length === 0) return "no value that stays under threshold";
    return `in {${values.map((value) => (value === null ? "null" : String(value))).join(", ")}}`;
  }
  const range = bound.bin_range;
  if (!range) return "no range that stays under threshold";
  const lower = range.lower === null ? "(open)" : String(range.lower);
  const upper = range.upper === null ? "(open)" : String(range.upper);
  return `within [${lower}, ${upper}]`;
}

function joinList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** Fixed percentage format matching the model's rationale strings (e.g. `0.4125 → "41.25%"`). */
function formatRate(rate: number): string {
  return `${roundNumber(rate * 100)}%`;
}

function roundNumber(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1_000_000) / 1_000_000;
}
