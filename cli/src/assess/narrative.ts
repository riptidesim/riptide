import type { RiskSurfaceAxisBound } from "../campaign/surface.js";

import {
  ASSESSMENT_NARRATIVE_SCHEMA,
  assessmentShape,
  requireCartographyModel,
  GUIDED_SIM_ADAPTER,
  GUIDED_SIM_PROVENANCE_DISCLOSURE,
  type AssessmentCorrectnessEvidence,
  type AssessmentFinding,
  type AssessmentModel,
  type AssessmentNarrative,
  type AssessmentNonFinding,
  type AssessmentRecommendation,
  type CartographyAssessmentModel,
  type NarrativeProvider
} from "./model.js";

/**
 * narrative.ts — the deterministic auto-narrative generator (R3).
 *
 * ## What this is
 *
 * A pure projection from the hashed {@link AssessmentModel} (facts) to the
 * {@link AssessmentNarrative} blocks (prose) the markdown renderer slots
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
export const generateAssessmentNarrative: NarrativeProvider = (rawModel) => {
  // Branch on shape: the surface-less correctness assessment (NAV-vault-shaped)
  // gets its own guided-sim-led narrative; the cartography (risk-surface-led)
  // path is unchanged below.
  if (assessmentShape(rawModel) === "correctness") {
    return generateCorrectnessNarrative(rawModel);
  }
  const model = requireCartographyModel(rawModel);
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
// Correctness narrative (R4.2/R4.3) — guided-sim-led, surface-less
// ---------------------------------------------------------------------------

/**
 * The surface-less correctness narrative. Findings vs non-findings are derived
 * from the guided-sim totals (R4.2): a run with zero unexpected errors and zero
 * panics whose negative controls were all rejected is a single bounded
 * non-finding; any unexpected error or panic is a finding. Language is
 * flow-scoped and bounded — never "proven safe" (R4.3). There is no parameter
 * region, so the recommendation is the `none` kind (no safe-region bounds).
 */
function generateCorrectnessNarrative(model: AssessmentModel): AssessmentNarrative {
  const gs = model.correctness?.guided_sim ?? null;
  const findings = buildCorrectnessFindings(model, gs);
  const nonFindings = buildCorrectnessNonFindings(gs);
  return {
    schema: ASSESSMENT_NARRATIVE_SCHEMA,
    executive_summary: buildCorrectnessExecutiveSummary(model, gs),
    headline_claim: model.risk_plan.target_claim,
    main_finding: findings.length > 0 ? findings[0]!.title : "No finding under the declared inputs.",
    main_limit: buildMainLimit(model),
    findings,
    non_findings: nonFindings,
    recommendation: buildCorrectnessRecommendation(gs)
  };
}

type GuidedSim = NonNullable<AssessmentCorrectnessEvidence["guided_sim"]>;

function buildCorrectnessExecutiveSummary(model: AssessmentModel, gs: GuidedSim | null): string[] {
  const verdict = `Verdict — ${humanVerdict(model.verdict.value)}: ${model.verdict.rationale}`;
  if (!gs) {
    return [
      `${model.protocol.name} was assessed for correctness, but no guided-sim evidence was ingested.`,
      verdict,
      model.claim_boundary
    ];
  }
  const whatRan =
    `${model.protocol.name} was assessed against guided-simulation evidence: ${gs.flows} flow(s) dispatched ` +
    `across ${gs.iterations} iteration(s) (${gs.tx_success} transaction success(es), ${gs.expected_errors} ` +
    `expected rejection(s)), with ${gs.unexpected_errors} unexpected error(s) and ${gs.panics} panic(s).`;
  const clean = gs.unexpected_errors === 0 && gs.panics === 0;
  const evidence = clean
    ? "No unexpected error or panic was observed across the assessed flows, and the negative-control actions were " +
      "rejected as expected. This is correctness evidence over the declared flows — binary accounting and authority " +
      "properties — not a parameter-failure gradient, so the report leads with the coverage matrix rather than a heatmap."
    : `${gs.unexpected_errors} unexpected error(s) and ${gs.panics} panic(s) were observed across the assessed flows; ` +
      "see the finding below.";
  return [whatRan, verdict, evidence, model.claim_boundary];
}

function buildCorrectnessFindings(model: AssessmentModel, gs: GuidedSim | null): AssessmentFinding[] {
  if (!gs || (gs.unexpected_errors === 0 && gs.panics === 0)) return [];
  return [
    {
      title: "Unexpected error or panic in the guided-sim run",
      severity: "P0",
      affected_flow: gs.flow_counts[0] ? `guided-sim flow \`${gs.flow_counts[0].flow}\`` : "assessed guided-sim flows",
      evidence_tier: "guided sim",
      observed:
        `${gs.unexpected_errors} unexpected error(s) and ${gs.panics} panic(s) were observed across the ${gs.flows} ` +
        `assessed guided-sim flow(s) (run status \`${gs.status}\`).`,
      why_it_matters:
        "An unexpected error or panic under the declared inputs is a correctness defect in an assessed flow, not an " +
        "expected negative-control rejection; it must be resolved before this evidence can support sending.",
      recommended: "Resolve the unexpected error or panic, then re-run the guided sim and reassess.",
      reproduction_command: model.reproduction.commands[0] ?? null,
      artifacts: [gs.path],
      hashes: gs.sha256 ? [`guided-sim-run.json sha256 ${gs.sha256}`] : []
    }
  ];
}

function buildCorrectnessNonFindings(gs: GuidedSim | null): AssessmentNonFinding[] {
  if (!gs || gs.unexpected_errors > 0 || gs.panics > 0) return [];
  const evidence = gs.sha256 ? `guided-sim-run.json sha256 ${gs.sha256}` : `guided-sim run \`${gs.label}\``;
  return [
    {
      flow: "assessed guided-sim flows",
      evidence,
      statement:
        "No accounting drift, double-payment, wrong-recipient settlement, or unauthorized-control success was " +
        "observed under the declared inputs; all negative-control actions were rejected as expected.",
      limit:
        "Evidence is bounded to the guided-sim flows exercised under a fixed seed; flows outside the coverage matrix " +
        "are not assessed."
    }
  ];
}

function buildCorrectnessRecommendation(gs: GuidedSim | null): AssessmentRecommendation {
  const statement =
    gs && (gs.unexpected_errors > 0 || gs.panics > 0)
      ? "Resolve the unexpected error or panic observed in the guided-sim run, then re-run the guided sim and reassess."
      : "Extend the guided-sim flow set (and its negative controls) to cover flows outside the current coverage matrix " +
        "before relying on this evidence beyond the assessed scope.";
  return { kind: "none", primary_axis: null, statement, threshold: 0, bounds: [] };
}

// ---------------------------------------------------------------------------
// Executive summary (R3.1)
// ---------------------------------------------------------------------------

function buildExecutiveSummary(
  model: CartographyAssessmentModel,
  recommendation: AssessmentRecommendation
): string[] {
  const totals = model.totals;
  const guidedSim = model.campaign.adapter === GUIDED_SIM_ADAPTER;
  const swept = sweptAxes(model);
  const sweptPhrase =
    swept.length > 0
      ? `, sweeping ${joinList(swept.map((axis) => `\`${axis}\``))}`
      : ", with no varying parameters";

  const whatRan = guidedSim
    ? `${model.protocol.name} was assessed over a guided-simulation sweep \`${model.campaign.name}\` ` +
      `(${model.campaign.class}), rendered as cartography artifacts: ${totals.completed_runs} of ` +
      `${totals.requested_runs} swept iteration(s) completed under the ${model.campaign.seed_policy} ` +
      `seed policy${sweptPhrase}.`
    : `${model.protocol.name} was assessed over the \`${model.campaign.name}\` ${model.campaign.class} ` +
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

  // Lead with the provenance disclosure for guided-sim-derived cartography so
  // the report names its true evidence source up front.
  return guidedSim
    ? [GUIDED_SIM_PROVENANCE_DISCLOSURE, whatRan, verdict, evidence, model.claim_boundary]
    : [whatRan, verdict, evidence, model.claim_boundary];
}

// ---------------------------------------------------------------------------
// Findings (R3.1 / R3.2)
// ---------------------------------------------------------------------------

function buildFindings(
  model: CartographyAssessmentModel,
  recommendation: AssessmentRecommendation
): AssessmentFinding[] {
  const failed = model.totals.invariant_failed_runs;
  if (failed === 0) return [];

  const top = model.surface_highlights.most_sensitive_axis;
  const topEntry = top ? model.surface.sensitivity.ranking.find((entry) => entry.axis === top) ?? null : null;
  const worst = formatRate(model.surface_highlights.worst_cell_failure_rate);
  const shape = topEntry ? trendPhrase(topEntry.monotonic) : null;

  // On a guided-sim sweep the axis is the applied stress, not a protocol
  // setting, so the headline names what fired rather than implying the axis is
  // actionable. Real-campaign titles below are byte-frozen.
  const guidedSimInvariant =
    model.campaign.adapter === GUIDED_SIM_ADAPTER ? singleFiredInvariant(model) : null;

  const title = guidedSimInvariant
    ? guidedSimFindingTitle(guidedSimInvariant, top, topEntry?.monotonic ?? null)
    : top && shape
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
      evidence_tier:
        model.campaign.adapter === GUIDED_SIM_ADAPTER ? "guided-sim sweep" : "focused campaign",
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

function buildNonFindings(model: CartographyAssessmentModel): AssessmentNonFinding[] {
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

function buildRecommendation(model: CartographyAssessmentModel): AssessmentRecommendation {
  const highlights = model.surface_highlights;
  const threshold = highlights.safe_region_threshold;
  const thresholdText = formatRate(threshold);

  // On a guided-sim sweep the swept axis is an applied exogenous stress, so
  // "keep the axis here" would read as protocol advice about a knob nobody
  // controls. The guided-sim statements below characterize the observed
  // resilience boundary instead; only the human `statement` string differs —
  // the kind/threshold/bounds/primary_axis data fields are shared, and the
  // real-campaign statements are byte-frozen.
  const guidedSim = model.campaign.adapter === GUIDED_SIM_ADAPTER;
  const invariant = guidedSim ? singleFiredInvariant(model) : null;

  if (highlights.safe_region_status === "none") {
    const axisText = highlights.most_sensitive_axis
      ? `\`${highlights.most_sensitive_axis}\``
      : "the swept stress";
    return {
      kind: "none",
      primary_axis: highlights.most_sensitive_axis,
      statement: guidedSim
        ? `No swept sub-region held the invariant-failure rate at or under the ${thresholdText} threshold: ` +
          `${invariant ? `\`${invariant}\`` : "the declared invariant"} fired beyond the threshold across the ` +
          `declared, fixed-seed swept region, so no observed safe region bounds the protocol's resilience to ` +
          `${axisText} under the tested configuration.`
        : `No parameter sub-region held the invariant-failure rate at or under the ${thresholdText} threshold within ` +
          "the declared, fixed-seed parameter region; tune the campaign toward a safer region before relying on these inputs.",
      threshold,
      bounds: highlights.safe_region_bounds
    };
  }

  if (highlights.safe_region_status === "entire-region") {
    const axisText = highlights.most_sensitive_axis
      ? `swept \`${highlights.most_sensitive_axis}\``
      : "swept stress";
    return {
      kind: "entire-region",
      primary_axis: highlights.most_sensitive_axis,
      statement: guidedSim
        ? `Every populated cell held the invariant-failure rate at or under the ${thresholdText} threshold: the ` +
          `tested ${axisText} range stayed within the protocol's observed resilience under this configuration, ` +
          "and no failure boundary was crossed inside the declared, fixed-seed swept region. Stresses beyond the " +
          "swept region were not tested."
        : `Every populated cell held the invariant-failure rate at or under the ${thresholdText} threshold; keeping ` +
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

  if (guidedSim) {
    const heldSubject = invariant ? `\`${invariant}\`` : "The declared invariant";
    const onset = primaryBound ? boundaryOnset(model, primaryBound) : null;
    const heldClause = onset
      ? `${heldSubject} held while ${axisText} stayed at or below ${onset} and began to fire beyond that bound`
      : primaryBound
        ? `${heldSubject} held while ${axisText} stayed ${where} and fired outside that observed region`
        : `${heldSubject} held inside the recommended bounds and fired outside them`;
    return {
      kind: "bounded",
      primary_axis: primary,
      statement:
        `${heldClause}. This bounds the protocol's observed resilience to ${axisText} under the tested ` +
        `configuration: a safe region observed at or under the ${thresholdText} failure-rate threshold within ` +
        "the declared, fixed-seed swept region — an observed boundary, not a parameter to set.",
      threshold,
      bounds: highlights.safe_region_bounds
    };
  }

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
// Guided-sim resilience-boundary phrasing
// ---------------------------------------------------------------------------

/**
 * The single invariant a guided-sim narrative can honestly name. Sources, in
 * order: invariant names recorded on retained failing cases, then the risk
 * plan's failure modes — both the generated ``invariant `<name>` firing`` form
 * and the authored `<name>: <explanation>` form. Exactly one distinct name is
 * required; anything else returns `null` so the caller keeps the generic
 * phrasing instead of guessing between invariants.
 */
function singleFiredInvariant(model: CartographyAssessmentModel): string | null {
  const names = new Set<string>();
  for (const entry of model.retained_evidence) {
    for (const name of entry.risk_signals?.invariant_names ?? []) names.add(name);
  }
  if (names.size === 0) {
    for (const mode of model.risk_plan.expected_failure_modes) {
      const generated = /^invariant `([^`]+)` firing$/.exec(mode);
      const authored = /^([A-Za-z_][A-Za-z0-9_.-]*):\s/.exec(mode);
      const name = generated?.[1] ?? authored?.[1];
      if (name) names.add(name);
    }
  }
  if (names.size !== 1) return null;
  return [...names][0] ?? null;
}

/** Guided-sim finding title: what fired, as the stress varies — never axis advice. */
function guidedSimFindingTitle(invariant: string, axis: string | null, monotonic: string | null): string {
  if (!axis) return `\`${invariant}\` fires within the swept parameter region`;
  switch (monotonic) {
    case "increasing":
      return `\`${invariant}\` fires as \`${axis}\` deepens`;
    case "decreasing":
      return `\`${invariant}\` fires as \`${axis}\` recedes`;
    default:
      return `\`${invariant}\` fires across the swept \`${axis}\` range`;
  }
}

/**
 * The onset bound for the boundary phrasing: the highest swept value the safe
 * region reaches before the invariant starts firing. Read from the safe-region
 * bound against the surface's declared bins — never recomputed. Returns `null`
 * whenever the safe region is not exactly the low end of the sweep (a
 * non-prefix region has no single "beyond this" value), so the caller falls
 * back to region phrasing.
 */
function boundaryOnset(
  model: CartographyAssessmentModel,
  bound: RiskSurfaceAxisBound
): string | null {
  const axis = model.surface.axes.find((entry) => entry.name === bound.axis);
  if (!axis) return null;

  if (bound.kind === "discrete") {
    const declared = bound.allowed_values ?? [];
    const allowed = declared.filter((value): value is number => typeof value === "number");
    if (allowed.length === 0 || allowed.length !== declared.length) return null;
    const swept = axis.bins
      .map((bin) => bin.value)
      .filter((value): value is number => typeof value === "number");
    if (swept.length !== axis.bins.length) return null;
    // The whole sweep being allowed leaves no observed boundary on this axis.
    if (allowed.length === swept.length) return null;
    const onset = Math.max(...allowed);
    const lowEnd = swept.filter((value) => value <= onset).sort((a, b) => a - b);
    const sorted = [...allowed].sort((a, b) => a - b);
    if (lowEnd.length !== sorted.length) return null;
    if (!sorted.every((value, index) => value === lowEnd[index])) return null;
    return String(onset);
  }

  const range = bound.bin_range;
  if (!range || range.upper === null) return null;
  if (range.lower !== null) {
    const sweepFloor = axis.bins[0]?.lower;
    if (sweepFloor === undefined || sweepFloor === null || range.lower !== sweepFloor) return null;
  }
  return String(range.upper);
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
    const verb = /\b(paths|flows|controls|helpers|surfaces)\b/i.test(top.flow) ? "are" : "is";
    return `${top.flow} ${verb} ${top.status}: ${top.notes}`;
  }
  return "Flows, parameters, and seeds outside this campaign's declared region are not assessed.";
}

// ---------------------------------------------------------------------------
// Deterministic formatting + phrasing helpers
// ---------------------------------------------------------------------------

function sweptAxes(model: CartographyAssessmentModel): string[] {
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
      return "show no axis gradient across";
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
