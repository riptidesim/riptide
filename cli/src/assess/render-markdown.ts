import { renderRiskSurfaceNarrative } from "../report/surface-narrative.js";

import type {
  AssessmentCoverageAxis,
  AssessmentCoverageCellCoord,
  AssessmentCoverageGap,
  AssessmentCoverageRow,
  AssessmentFlatNoSignalRegion,
  AssessmentFinding,
  AssessmentHotRegion,
  AssessmentModel,
  AssessmentNarrative,
  AssessmentReproduction,
  AssessmentSimulation,
  CoverageStatus
} from "./model.js";

/**
 * render-markdown.ts — the byte-deterministic assessment markdown renderer (R2).
 *
 * ## What this is
 *
 * Renders the full Sprint 38 assessment template from the hashed
 * {@link AssessmentModel} plus the {@link AssessmentNarrative} prose blocks
 * (R2.5): executive summary, scope + claim boundary, Risk Plan, coverage matrix,
 * the embedded risk-surface section (R2.2), simulations run, findings,
 * non-findings, blocked/out-of-scope surfaces, the reproduction block (commands +
 * paths + hashes, R2.3), recommended next work, and the reviewer checklist.
 *
 * The model carries facts; the narrative carries prose. This module owns only
 * *structure* — section order, table layout, and number formatting — and slots
 * the narrative blocks into the corresponding sections through the T01
 * interface, so the renderer (T02) and the narrative generator (T03) compose
 * without either reaching into the other's internals.
 *
 * ## Determinism (R2.4 — load-bearing)
 *
 * The output is byte-stable for a fixed `(model, narrative)` pair so a reviewer
 * reruns `riptide assess` and `sha256sum assessment.md` to an identical value:
 *
 * 1. **Fixed section order.** Sections are appended in a single fixed sequence;
 *    nothing is reordered by data.
 * 2. **Pre-sorted rows.** Coverage rows arrive already sorted by the model
 *    (`(priority rank, flow)`); simulations and findings follow their declared
 *    order. This module never re-sorts on unstable keys.
 * 3. **Fixed number formatting.** Percentages use one fixed format; the model's
 *    values are already rounded.
 * 4. **No environment input.** No wall-clock, randomness, or `Map`/`Object`
 *    insertion-order dependence; `null` identity fields render as a fixed
 *    placeholder rather than sampling the environment.
 * 5. **Cell escaping.** Table cells escape `|` and collapse newlines so prose
 *    can never break the table grid.
 */
export function renderAssessmentMarkdown(
  model: AssessmentModel,
  narrative: AssessmentNarrative
): string {
  const lines: string[] = [];
  renderHeader(model, lines);
  renderExecutiveSummary(model, narrative, lines);
  renderScope(model, lines);
  renderRiskPlan(model, lines);
  renderCoverageLimits(model, narrative, lines);
  renderCoverageMatrix(model, lines);
  renderSurfaceSection(model, lines);
  renderSimulations(model, lines);
  renderFindings(narrative, lines);
  renderNonFindings(narrative, lines);
  renderBlockedAndOutOfScope(model, lines);
  renderReproduction(model, lines);
  renderExecutionHonesty(model, lines);
  renderRecommendedNextWork(model, narrative, lines);
  renderToolchain(model, lines);
  renderReviewerChecklist(lines);
  // Single trailing newline; the body uses no other terminal whitespace.
  return lines.join("\n").replace(/\s+$/, "") + "\n";
}

// ---------------------------------------------------------------------------
// Header + disclaimer
// ---------------------------------------------------------------------------

function renderHeader(model: AssessmentModel, lines: string[]): void {
  lines.push(`# Protocol assessment — ${model.protocol.name}`, "");
  lines.push(
    "This report records simulation evidence. It is not audit signoff, complete " +
      "protocol safety, formal verification, mainnet monitoring, or certification.",
    ""
  );
}

// ---------------------------------------------------------------------------
// Executive summary (R2.1)
// ---------------------------------------------------------------------------

function renderExecutiveSummary(
  model: AssessmentModel,
  narrative: AssessmentNarrative,
  lines: string[]
): void {
  lines.push("## Executive summary", "");
  lines.push(`- **Protocol:** ${model.protocol.name}`);
  // Identity metadata is rendered only when populated (R2.1/R2.2): a null field
  // is omitted cleanly rather than printed as "not specified" in the headline.
  pushIfPresent("Repository", model.protocol.repository, lines);
  pushIfPresent("Commit", model.protocol.commit, lines);
  pushIfPresent("Assessment date", model.protocol.assessment_date, lines);
  pushIfPresent("Riptide version or commit", model.protocol.riptide_version, lines);
  lines.push(`- **Verdict:** ${model.verdict.value}`);
  lines.push(`- **Headline claim:** ${narrative.headline_claim}`);
  lines.push(`- **Main finding:** ${narrative.main_finding}`);
  lines.push(`- **Main limit:** ${narrative.main_limit}`);
  lines.push("");
  lines.push("Short summary:", "");
  for (const paragraph of narrative.executive_summary) {
    lines.push(paragraph, "");
  }
}

// ---------------------------------------------------------------------------
// Scope (R2.1)
// ---------------------------------------------------------------------------

function renderScope(model: AssessmentModel, lines: string[]): void {
  lines.push("## Scope", "");
  lines.push("### In scope", "");
  pushBullets(model.scope.in_scope, "No in-scope surfaces were declared.", lines);
  lines.push("### Out of scope", "");
  pushBullets(model.scope.out_of_scope, "No out-of-scope surfaces were declared.", lines);
  lines.push("### Claim boundary", "");
  lines.push(model.scope.claim_boundary, "");
}

// ---------------------------------------------------------------------------
// Risk Plan (R2.1)
// ---------------------------------------------------------------------------

function renderRiskPlan(model: AssessmentModel, lines: string[]): void {
  const plan = model.risk_plan;
  lines.push("## Risk Plan", "");
  lines.push(`- **Protocol class:** ${plan.protocol_class}`);
  lines.push(`- **Target claim:** ${plan.target_claim}`);
  lines.push(`- **Evidence profile:** ${joinInline(plan.evidence_profile)}`);
  lines.push(`- **P0 flows:** ${joinInline(plan.p0_flows)}`);
  lines.push(`- **P1 flows:** ${joinInline(plan.p1_flows)}`);
  lines.push(`- **Expected failure modes:** ${joinInline(plan.expected_failure_modes)}`);
  lines.push(`- **Guided-sim boundaries:** ${joinInline(plan.guided_sim_boundaries)}`);
  lines.push(`- **Known coverage limits:** ${joinInline(plan.known_coverage_limits)}`);
  lines.push("");
}

// ---------------------------------------------------------------------------
// Coverage & Limits (Sprint 46 R2) — one reader-facing negative-space map
// ---------------------------------------------------------------------------

const COVERAGE_LIMIT_PREVIEW = 12;

function renderCoverageLimits(
  model: AssessmentModel,
  narrative: AssessmentNarrative,
  lines: string[]
): void {
  lines.push("## Coverage & Limits", "");
  lines.push(
    "This is the negative-space map for the assessment: what Riptide probed, where risk signals concentrated, " +
      "where the campaign produced no signal, and which declared flows were blocked, out of scope, or not assessed. " +
      "Flat or zero-failure entries mean no signal in this campaign, not safety.",
    ""
  );

  renderCoverageLimitsProbed(model, lines);
  renderCoverageLimitsHotRegions(model.coverage_statement.hot_regions, lines);
  renderCoverageLimitsNoSignal(model.coverage_statement.flat_no_signal_regions, lines);
  renderCoverageLimitsGaps(model.coverage_statement.blocked, narrative, lines);
}

function renderCoverageLimitsProbed(model: AssessmentModel, lines: string[]): void {
  const probed = model.coverage_statement.probed;
  lines.push("### Probed surface", "");

  if (probed.kind === "swept-gradient") {
    lines.push(
      `Riptide probed the \`${probed.risk_objective}\` surface with ${probed.completed_runs} completed ` +
        `run(s) under the ${probed.seed_policy} seed policy; ${probed.invariant_failed_runs} run(s) fired ` +
        `a declared invariant (${formatPercent(probed.invariant_failure_rate)}).`,
      ""
    );
    if (probed.axes.length === 0) {
      lines.push("No varying parameter axis was recorded for this campaign.", "");
      return;
    }
    lines.push(
      "| Axis | Range | Granularity | Populated bins | Runs | Failed runs | Failure rate |",
      "| --- | --- | --- | ---: | ---: | ---: | ---: |"
    );
    for (const axis of probed.axes) {
      lines.push(
        `| ${cell(axis.axis)} | ${cell(formatAxisRange(axis))} | ${cell(formatAxisGranularity(axis))} | ` +
          `${axis.populated_bins}/${axis.granularity.bin_count} | ${axis.run_count} | ${axis.failed_runs} | ` +
          `${formatPercent(axis.invariant_failure_rate)} |`
      );
    }
    lines.push("");
    return;
  }

  const gs = probed.guided_sim;
  if (gs) {
    lines.push(
      `Riptide probed guided-sim flow coverage with \`${gs.label}\` (status \`${gs.status}\`): ` +
        `${gs.flows} flow(s) across ${gs.iterations} iteration(s), ${gs.tx_success} transaction success(es), ` +
        `${gs.expected_errors} expected rejection(s), ${gs.unexpected_errors} unexpected error(s), and ` +
        `${gs.panics} panic(s).`,
      ""
    );
  } else {
    lines.push("No guided-sim evidence was ingested for this correctness-shaped assessment.", "");
  }

  if (probed.flows.length === 0) {
    lines.push("No guided-sim flow coverage rows were recorded.", "");
    return;
  }
  lines.push(
    "| Flow | Guided-sim flow | Status | Evidence tier | Dispatched | Negative control | Expected rejections | Unexpected errors | Panics |",
    "| --- | --- | --- | --- | ---: | --- | ---: | ---: | ---: |"
  );
  for (const flow of probed.flows) {
    lines.push(
      `| ${cell(flow.flow)} | ${cell(flow.guided_sim_flow ?? "—")} | ${cell(flow.status)} | ${cell(flow.evidence_tier)} | ` +
        `${formatNullableNumber(flow.dispatched_count)} | ${flow.negative_control ? "yes" : "no"} | ${formatNullableNumber(flow.expected_rejections)} | ` +
        `${formatNullableNumber(flow.unexpected_errors)} | ${formatNullableNumber(flow.panics)} |`
    );
  }
  lines.push("");
}

function renderCoverageLimitsHotRegions(regions: AssessmentHotRegion[], lines: string[]): void {
  lines.push("### Hot regions", "");
  if (regions.length === 0) {
    lines.push(
      "No hot region was recorded by the coverage statement for the assessed inputs.",
      ""
    );
    return;
  }
  lines.push(
    "| Region | Runs or dispatches | Observed signal | Notes |",
    "| --- | ---: | --- | --- |"
  );
  for (const region of regions.slice(0, COVERAGE_LIMIT_PREVIEW)) {
    if (region.kind === "failing_cell") {
      lines.push(
        `| ${cell(formatCoords(region.coords))} | ${region.run_count} | ` +
          `${cell(`${region.failed_runs} failed run(s), ${formatPercent(region.invariant_failure_rate)} failure rate`)} | ` +
          `${region.sparse ? "sparse cell" : "populated cell"} |`
      );
    } else {
      lines.push(
        `| ${cell(region.flow)} | ${region.dispatched_count} | ` +
          `${cell(`${region.unexpected_errors} unexpected error(s), ${region.panics} panic(s)`)} | ` +
          `${cell(`status ${region.status}${region.evidence ? `; evidence ${region.evidence}` : ""}`)} |`
      );
    }
  }
  pushAdditionalCount(regions.length, "hot region", lines);
}

function renderCoverageLimitsNoSignal(regions: AssessmentFlatNoSignalRegion[], lines: string[]): void {
  lines.push("### Flat and no-signal regions", "");
  lines.push(
    "These entries are negative space. They record no signal in this campaign, not safety; use them as targets " +
      "for additional scenarios, manual review, or prover work when the claim matters.",
    ""
  );
  if (regions.length === 0) {
    lines.push("No flat/no-signal region was recorded by the coverage statement.", "");
    return;
  }
  lines.push(
    "| Region | Signal type | Runs or dispatches | Observed signal | Interpretation |",
    "| --- | --- | ---: | --- | --- |"
  );
  for (const region of regions.slice(0, COVERAGE_LIMIT_PREVIEW)) {
    lines.push(
      `| ${cell(formatNoSignalRegion(region))} | ${cell(region.signal_type)} | ${formatNoSignalCount(region)} | ` +
        `${cell(formatNoSignalObserved(region))} | no signal in this campaign; not safety |`
    );
  }
  pushAdditionalNoSignalCount(regions.length, lines);
}

function renderCoverageLimitsGaps(
  gaps: AssessmentCoverageGap[],
  narrative: AssessmentNarrative,
  lines: string[]
): void {
  lines.push("### Blocked or out of scope", "");
  lines.push(`Primary limit: ${narrative.main_limit}`, "");
  if (gaps.length === 0) {
    lines.push(
      "No blocked, out-of-scope, or not-assessed flow is recorded in the coverage statement.",
      ""
    );
    return;
  }
  lines.push(
    "| Flow | Status | Evidence tier | Notes |",
    "| --- | --- | --- | --- |"
  );
  for (const gap of gaps) {
    lines.push(`| ${cell(gap.flow)} | ${cell(gap.status)} | ${cell(gap.evidence_tier)} | ${cell(gap.notes)} |`);
  }
  lines.push("");
}

function formatAxisRange(axis: AssessmentCoverageAxis): string {
  const range = axis.range;
  if (range.kind === "values") {
    return `{${range.values.map(formatScalar).join(", ")}}`;
  }
  const lower = range.lower === null ? "(open)" : String(range.lower);
  const upper = range.upper === null ? "(open)" : String(range.upper);
  const edges = range.edges.length > 0 ? `; edges ${range.edges.join(", ")}` : "";
  return `[${lower}, ${upper}]${edges}${axis.unit ? ` ${axis.unit}` : ""}`;
}

function formatAxisGranularity(axis: AssessmentCoverageAxis): string {
  return `${axis.granularity.method}, ${axis.granularity.bin_count} bin(s), min cell run count ${axis.granularity.min_cell_run_count}`;
}

function formatNoSignalRegion(region: AssessmentFlatNoSignalRegion): string {
  switch (region.kind) {
    case "flat_axis_zero_failure":
      return region.axis ? `flat axis ${region.axis}` : "flat axis";
    case "zero_failure_cell":
      return `zero-failure cell ${formatCoords(region.coords ?? [])}`;
    case "unpopulated_cell":
      return `unpopulated cell ${formatCoords(region.coords ?? [])}`;
    case "no_swept_gradient":
      return region.flow;
    case "guided_sim_no_unexpected_result":
      return region.flow;
  }
}

function formatNoSignalCount(region: AssessmentFlatNoSignalRegion): string {
  if ("dispatched_count" in region) return String(region.dispatched_count);
  return String(region.run_count);
}

function formatNoSignalObserved(region: AssessmentFlatNoSignalRegion): string {
  if ("dispatched_count" in region) {
    return `${region.unexpected_errors} unexpected error(s), ${region.panics} panic(s), ${region.expected_rejections} expected rejection(s)`;
  }
  if (region.invariant_failure_rate === null) return "no runs placed";
  return `${region.failed_runs} failed run(s), ${formatPercent(region.invariant_failure_rate)} failure rate`;
}

function formatCoords(coords: AssessmentCoverageCellCoord[]): string {
  if (coords.length === 0) return "aggregate region";
  return coords.map((coord) => `${coord.axis}=${coord.bin_label}`).join(", ");
}

function pushAdditionalCount(total: number, label: string, lines: string[]): void {
  const remaining = total - COVERAGE_LIMIT_PREVIEW;
  if (remaining > 0) {
    lines.push(`| ${remaining} additional ${label}(s) | — | recorded in \`assessment.json\` \`coverage_statement\` | — |`);
  }
  lines.push("");
}

function pushAdditionalNoSignalCount(total: number, lines: string[]): void {
  const remaining = total - COVERAGE_LIMIT_PREVIEW;
  if (remaining > 0) {
    lines.push(
      `| ${remaining} additional flat/no-signal region(s) | — | — | recorded in \`assessment.json\` \`coverage_statement\` | no signal in this campaign; not safety |`
    );
  }
  lines.push("");
}

function formatNullableNumber(value: number | null): string {
  return value === null ? "—" : String(value);
}

function formatScalar(value: string | number | boolean | null): string {
  return value === null ? "null" : String(value);
}

/** Fixed one-decimal percentage, matching the risk-surface narrative renderer. */
function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Coverage matrix (R2.1)
// ---------------------------------------------------------------------------

function renderCoverageMatrix(model: AssessmentModel, lines: string[]): void {
  lines.push("## Coverage Matrix", "");
  lines.push(
    "Status values: `covered`, `covered by guided sim`, `blocked`, `out of scope`, `not assessed`.",
    ""
  );
  if (model.coverage_matrix.length === 0) {
    lines.push("No coverage rows were derived for this campaign.", "");
    return;
  }
  lines.push(
    "| Priority | Flow | Status | Evidence tier | Commands | Artifacts | Notes |",
    "| --- | --- | --- | --- | --- | --- | --- |"
  );
  for (const row of model.coverage_matrix) {
    lines.push(
      `| ${cell(row.priority)} | ${cell(row.flow)} | ${cell(row.status)} | ${cell(row.evidence_tier)} | ` +
        `${cellCommands(row.commands)} | ${cellList(row.artifacts)} | ${cell(row.notes)} |`
    );
  }
  lines.push("");
}

// ---------------------------------------------------------------------------
// Risk surface section (R2.2) — reuse the surface-narrative renderer
// ---------------------------------------------------------------------------

function renderSurfaceSection(model: AssessmentModel, lines: string[]): void {
  if (model.surface) {
    lines.push(renderRiskSurfaceNarrative(model.surface).trimEnd(), "");
    return;
  }
  // Surface-less (correctness) shape: degrade honestly (R3.1). State why there is
  // no heatmap rather than rendering an empty widget; the coverage matrix and
  // findings/non-findings below carry the report.
  lines.push("## Risk Surface", "");
  lines.push(
    "This is a correctness-dominated assessment, so there is no risk-surface heatmap. The risks tested are binary " +
      "accounting and authority properties — accounting drift, double-payment, wrong-recipient settlement, and " +
      "unauthorized control — not a parameter-failure gradient, so a parameter sweep would not produce a meaningful " +
      "failure surface.",
    ""
  );
  lines.push(
    "The evidence is invalid-action rejection plus accounting-invariant holds, exercised by guided simulation. The " +
      "Coverage Matrix, Findings/Non-Findings, and Reproduction sections carry this report in place of a heatmap.",
    ""
  );
}

// ---------------------------------------------------------------------------
// Simulations run (R2.1)
// ---------------------------------------------------------------------------

const SIMULATION_SECTIONS: Array<{ kind: AssessmentSimulation["kind"]; heading: string }> = [
  { kind: "calibration", heading: "Calibration" },
  { kind: "focused campaign", heading: "Focused campaigns" },
  { kind: "adversarial campaign", heading: "Adversarial campaigns" },
  { kind: "guided sim", heading: "Guided sims" },
  { kind: "negative control", heading: "Negative controls" }
];

function renderSimulations(model: AssessmentModel, lines: string[]): void {
  lines.push("## Simulations run", "");
  if (model.simulations.length === 0) {
    lines.push("No simulations were recorded for this assessment.", "");
    return;
  }
  for (const section of SIMULATION_SECTIONS) {
    const rows = model.simulations.filter((sim) => sim.kind === section.kind);
    if (rows.length === 0) continue;
    lines.push(`### ${section.heading}`, "");
    lines.push(
      "| Objective | Command | Result | Retained evidence | Hashes | Notes |",
      "| --- | --- | --- | --- | --- | --- |"
    );
    for (const sim of rows) {
      lines.push(
        `| ${cell(sim.objective)} | ${cellCommands([sim.command])} | ${cell(sim.result)} | ` +
          `${cell(sim.retained_evidence ?? "—")} | ${cellList(sim.hashes)} | ${cell(sim.notes)} |`
      );
    }
    lines.push("");
  }
}

// ---------------------------------------------------------------------------
// Findings (R2.1) — from the narrative
// ---------------------------------------------------------------------------

function renderFindings(narrative: AssessmentNarrative, lines: string[]): void {
  lines.push("## Findings", "");
  lines.push(
    "Reproducible issues or risk signals observed in the declared simulations.",
    ""
  );
  if (narrative.findings.length === 0) {
    lines.push("No finding under the declared inputs.", "");
    return;
  }
  narrative.findings.forEach((finding, index) => {
    renderFinding(finding, index + 1, lines);
  });
}

function renderFinding(finding: AssessmentFinding, ordinal: number, lines: string[]): void {
  lines.push(`### Finding ${ordinal}: ${finding.title}`, "");
  lines.push(`- **Severity or priority:** ${finding.severity}`);
  lines.push(`- **Affected flow:** ${finding.affected_flow}`);
  lines.push(`- **Evidence tier:** ${finding.evidence_tier}`);
  if (finding.reproduction_command) {
    lines.push("- **Reproduction command:**", "");
    lines.push("  ```bash", `  ${finding.reproduction_command}`, "  ```");
  } else {
    lines.push("- **Reproduction command:** none emitted");
  }
  lines.push(`- **Artifacts:** ${joinInline(finding.artifacts)}`);
  lines.push(`- **Hashes:** ${joinInline(finding.hashes)}`);
  lines.push(`- **Observed result:** ${finding.observed}`);
  lines.push(`- **Why it matters:** ${finding.why_it_matters}`);
  lines.push(`- **Recommended fix or review:** ${finding.recommended}`);
  lines.push("");
}

// ---------------------------------------------------------------------------
// Non-findings (R2.1) — from the narrative, kept separate from findings
// ---------------------------------------------------------------------------

function renderNonFindings(narrative: AssessmentNarrative, lines: string[]): void {
  lines.push("## Non-Findings", "");
  lines.push(
    "Tested claims where no declared invariant fired under the listed inputs. A non-finding is not proof " +
      "that the protocol is safe.",
    ""
  );
  if (narrative.non_findings.length === 0) {
    lines.push("No non-findings were recorded for this assessment.", "");
    return;
  }
  lines.push("| Flow | Evidence | Statement | Limit |", "| --- | --- | --- | --- |");
  for (const nf of narrative.non_findings) {
    lines.push(`| ${cell(nf.flow)} | ${cell(nf.evidence)} | ${cell(nf.statement)} | ${cell(nf.limit)} |`);
  }
  lines.push("");
}

// ---------------------------------------------------------------------------
// Blocked and out-of-scope surfaces (R2.1) — from the coverage matrix
// ---------------------------------------------------------------------------

const NOT_COVERED: Record<string, { reasonPrefix: string; nextStep: string }> = {
  blocked: {
    reasonPrefix: "Blocked",
    nextStep: "Resolve the blocker and rerun the campaign."
  },
  "not assessed": {
    reasonPrefix: "Not assessed",
    nextStep: "Extend the campaign budget or add a guided sim to cover this flow."
  },
  "out of scope": {
    reasonPrefix: "Out of scope",
    nextStep: "Cover by manual review, audit, or monitoring outside this assessment."
  }
};

function renderBlockedAndOutOfScope(model: AssessmentModel, lines: string[]): void {
  lines.push("## Blocked and out-of-scope surfaces", "");
  const rows = model.coverage_matrix.filter((row) => row.status in NOT_COVERED);
  if (rows.length === 0) {
    lines.push(
      "No blocked, out-of-scope, or not-assessed flows are recorded in the coverage matrix.",
      ""
    );
    return;
  }
  lines.push(
    "| Surface | Status | Reason | Needed next step | Owner |",
    "| --- | --- | --- | --- | --- |"
  );
  for (const row of rows) {
    const meta = NOT_COVERED[row.status]!;
    const reason = row.notes.trim().length > 0 ? row.notes : meta.reasonPrefix;
    lines.push(
      `| ${cell(row.flow)} | ${cell(row.status)} | ${cell(reason)} | ${cell(meta.nextStep)} | protocol owner |`
    );
  }
  lines.push("");
}

// ---------------------------------------------------------------------------
// Reproduction (R2.3) — exact commands, paths, and hashes
// ---------------------------------------------------------------------------

function renderReproduction(model: AssessmentModel, lines: string[]): void {
  const repro: AssessmentReproduction = model.reproduction;
  lines.push("## Reproduction Commands", "");
  const at = model.protocol.commit ? `at commit \`${model.protocol.commit}\`` : "at the assessed checkout";
  lines.push(`Run these commands from the repository root ${at}.`, "");
  lines.push("```bash");
  for (const command of repro.commands) lines.push(command);
  lines.push("```", "");
  lines.push("Expected artifacts:", "");
  lines.push("| Artifact | Hash or result |", "| --- | --- |");
  for (const artifact of repro.artifacts) {
    lines.push(`| ${cell(artifact.path)} | ${cell(artifact.hash ?? "not emitted")} |`);
  }
  lines.push("");
  lines.push("Canonical hashes:", "");
  if (model.surface) {
    lines.push(`- **Campaign digest:** \`${repro.hashes.campaign_digest}\``);
    lines.push(`- **Surface digest:** \`${repro.hashes.surface_digest}\``);
    lines.push(`- **\`risk-surface.json\` sha256:** \`${repro.hashes.surface_sha256}\``);
  } else {
    // Correctness shape: no campaign/surface digests; anchor on the guided-sim hash.
    const guidedSimSha256 = model.correctness?.guided_sim?.sha256 ?? null;
    lines.push(`- **\`guided-sim-run.json\` sha256:** \`${guidedSimSha256 ?? "not emitted"}\``);
  }
  lines.push("");
}

// ---------------------------------------------------------------------------
// Execution honesty (guided-sim only)
// ---------------------------------------------------------------------------

function renderExecutionHonesty(model: AssessmentModel, lines: string[]): void {
  const report = model.execution_honesty;
  if (!report) return;
  lines.push("## Execution Honesty", "");
  lines.push(`- **Status:** \`${report.status}\``);
  lines.push(`- **Surface hash:** \`${report.surface_sha256 || "not recorded"}\``);
  lines.push("");
  lines.push("| Gate | Status | Detail |", "| --- | --- | --- |");
  for (const gate of report.gates) {
    lines.push(`| ${cell(gate.id)} | ${cell(gate.status)} | ${cell(gate.detail)} |`);
  }
  lines.push("");
}

// ---------------------------------------------------------------------------
// Recommended next work (R2.1)
// ---------------------------------------------------------------------------

function renderRecommendedNextWork(
  model: AssessmentModel,
  narrative: AssessmentNarrative,
  lines: string[]
): void {
  lines.push("## Recommended next work", "");
  const items: string[] = [narrative.recommendation.statement];
  for (const boundary of model.risk_plan.guided_sim_boundaries) {
    items.push(`Guided sim needed: ${boundary}`);
  }
  for (const limit of model.risk_plan.known_coverage_limits) {
    items.push(`Coverage limit to extend: ${limit}`);
  }
  pushBullets(items, "No further work was recommended.", lines);
}

// ---------------------------------------------------------------------------
// Toolchain (R2.1)
// ---------------------------------------------------------------------------

function renderToolchain(model: AssessmentModel, lines: string[]): void {
  lines.push("## Toolchain", "");
  pushIfPresent("Riptide", model.protocol.riptide_version, lines);
  if (model.campaign) {
    lines.push(`- **Adapter:** ${model.campaign.adapter}`);
    lines.push(`- **Campaign class:** ${model.campaign.class}`);
    lines.push(`- **Seed policy:** ${model.campaign.seed_policy}`);
  }
  lines.push(
    "- **Environment notes:** Assessment is generated from existing campaign artifacts " +
      "(ingest-only); it does not run the engine."
  );
  lines.push("");
}

// ---------------------------------------------------------------------------
// Reviewer checklist (R2.1) — static, deterministic
// ---------------------------------------------------------------------------

const REVIEWER_CHECKLIST = [
  "The commit SHA is present and matches the assessed checkout.",
  "Every headline claim points to a command, artifact, and hash when one was emitted.",
  "Every P0 Risk Plan flow appears in the Coverage Matrix.",
  "`blocked`, `out of scope`, and `not assessed` rows explain why the flow is not covered.",
  "Findings and Non-Findings are separate.",
  'Non-Findings use bounded language such as "no declared invariant fired under these inputs."',
  "Reproduction Commands are exact and runnable from the repository root.",
  "Artifacts are attached or their paths are valid for the reviewer.",
  'Hashes are copied exactly from the Riptide output or marked "not emitted."',
  "The report says this is simulation evidence, not audit signoff or complete protocol safety."
];

function renderReviewerChecklist(lines: string[]): void {
  lines.push("## Reviewer checklist", "");
  lines.push("Before forwarding this report, verify each item.", "");
  for (const item of REVIEWER_CHECKLIST) {
    lines.push(`- [ ] ${item}`);
  }
  lines.push("");
}

// ---------------------------------------------------------------------------
// Deterministic formatting helpers
// ---------------------------------------------------------------------------

/** Push a `- **Label:** value` bullet only when the value is present (R2.2). */
function pushIfPresent(label: string, value: string | null, lines: string[]): void {
  if (value && value.trim().length > 0) lines.push(`- **${label}:** ${value}`);
}

function pushBullets(items: string[], emptyText: string, lines: string[]): void {
  if (items.length === 0) {
    lines.push(emptyText, "");
    return;
  }
  for (const item of items) lines.push(`- ${item}`);
  lines.push("");
}

function joinInline(items: string[]): string {
  return items.length === 0 ? "none" : items.join("; ");
}

/** Escape a markdown table cell: collapse newlines and escape the column separator. */
function cell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

function cellList(items: string[]): string {
  return items.length === 0 ? "none" : cell(items.join("; "));
}

function cellCommands(commands: string[]): string {
  return commands.length === 0
    ? "none"
    : commands.map((command) => `\`${command}\``).map((command) => cell(command)).join("; ");
}

// Re-exported for callers that want to assert the status vocabulary the matrix
// renders (kept here so the renderer is the single source of the rendered set).
export type { AssessmentCoverageRow, CoverageStatus };
