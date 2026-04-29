import type {
  ExpressionInvariantRow,
  InvariantFiredRow,
  SimEvent,
  SimulationResult,
  TickSnapshot
} from "../compiler/schema.js";

import type { InvariantFire, ScenarioRecord } from "./last-run.js";

export type Verdict =
  | "failure-observed"
  | "no-failure-observed"
  | "inconclusive"
  | "setup-error";

export type Confidence = "high" | "medium" | "low" | "none";

export type Coverage = "exercised" | "partial" | "unexercised" | "unknown";

export type Severity = "critical" | "warning" | "info" | "none";

export type CoverageCheckStatus = "pass" | "warn" | "fail";

export type CoverageCheckName =
  | "tick_progression"
  | "event_stream"
  | "state_movement"
  | "invariant_inventory"
  | "semantics_evaluated"
  | "agent_roster"
  | "artifact_readability";

export interface CoverageCheck {
  name: CoverageCheckName;
  status: CoverageCheckStatus;
  detail: string;
}

export interface RunInterpretation {
  verdict: Verdict;
  confidence: Confidence;
  coverage: Coverage;
  severity: Severity;
  summary: string;
  next_action: string;
  evidence: string[];
  reasons: string[];
  coverage_checks: CoverageCheck[];
}

export interface ArtifactReadability {
  simulationResultJson: boolean;
  reportMarkdown: boolean;
}

export interface InterpretScenarioInput {
  record: ScenarioRecord;
  result?: SimulationResult | null;
  /**
   * Adapter-declared invariant names, when the caller has already
   * parsed them. Omitting this keeps the check conservative because the
   * interpreter cannot prove whether an empty invariant rollup was
   * expected from the SimulationResult alone.
   */
  declaredInvariants?: readonly string[];
  /** Explicit scenario metadata for no-op baseline fixtures. */
  staticBaseline?: boolean;
  /** Set when the run stopped before the requested tick budget. */
  earlyTerminationReason?: string;
  /** Readability facts gathered by a caller that has access to disk. */
  artifactReadability?: ArtifactReadability;
}

interface InvariantObservation {
  count: number;
  errorExpressionCount: number;
  fires: InvariantFire[];
  firingRows: InvariantFiredRow[];
  expressionFiringRows: ExpressionInvariantRow[];
}

export function interpretScenarioResult(input: InterpretScenarioInput): RunInterpretation {
  const setupReason = setupErrorReason(input);
  if (setupReason) {
    const coverageChecks = setupErrorChecks(setupReason);
    return {
      verdict: "setup-error",
      confidence: "none",
      coverage: "unknown",
      severity: "warning",
      summary: `Setup failed: ${firstLine(setupReason)}.`,
      next_action: "Fix setup or adapter configuration, then rerun the scenario.",
      evidence: [`setup error: ${firstLine(setupReason)}`],
      reasons: ["No trustworthy SimulationResult was available for interpretation."],
      coverage_checks: coverageChecks
    };
  }

  const result = input.result!;
  const invariantObservation = observeInvariantFires(input.record, result);
  const coverageChecks = buildCoverageChecks(input, result, invariantObservation);
  const coverage = classifyCoverage(coverageChecks, invariantObservation);
  const verdict = classifyVerdict(
    coverage,
    invariantObservation.count,
    invariantObservation.errorExpressionCount
  );
  const confidence = classifyConfidence(verdict, coverage, coverageChecks);
  const severity = classifySeverity(verdict);
  const evidence = buildEvidence(input, result, invariantObservation);
  const reasons = buildReasons(verdict, coverage, coverageChecks, invariantObservation);

  return {
    verdict,
    confidence,
    coverage,
    severity,
    summary: summaryFor(verdict, invariantObservation.count),
    next_action: nextActionFor(verdict),
    evidence,
    reasons,
    coverage_checks: coverageChecks
  };
}

function setupErrorReason(input: InterpretScenarioInput): string | null {
  if (!input.result) {
    return input.record.error ?? "missing SimulationResult";
  }
  if (input.record.status === "error") {
    return input.record.error ?? "scenario ended with setup error status";
  }
  return null;
}

function setupErrorChecks(reason: string): CoverageCheck[] {
  const detail = `not checked: ${firstLine(reason)}`;
  return [
    { name: "tick_progression", status: "fail", detail },
    { name: "event_stream", status: "fail", detail },
    { name: "state_movement", status: "fail", detail },
    { name: "invariant_inventory", status: "fail", detail },
    { name: "agent_roster", status: "fail", detail },
    { name: "artifact_readability", status: "fail", detail }
  ];
}

function buildCoverageChecks(
  input: InterpretScenarioInput,
  result: SimulationResult,
  invariantObservation: InvariantObservation
): CoverageCheck[] {
  const checks: CoverageCheck[] = [
    checkTickProgression(input, result),
    checkEventStream(result),
    checkStateMovement(input, result),
    checkInvariantInventory(input, result, invariantObservation),
    checkAgentRoster(result),
    checkArtifactReadability(input)
  ];
  if (result.semantics) {
    checks.push(checkSemanticsEvaluated(result));
  }
  return checks;
}

function checkTickProgression(
  input: InterpretScenarioInput,
  result: SimulationResult
): CoverageCheck {
  const requested = result.run_config.ticks;
  const observed = Math.max(result.total_ticks, maxObservedTick(result));
  if (observed >= requested) {
    return {
      name: "tick_progression",
      status: "pass",
      detail: `observed ${observed} of ${requested} requested ticks`
    };
  }
  if (input.earlyTerminationReason && input.earlyTerminationReason.trim().length > 0) {
    return {
      name: "tick_progression",
      status: "warn",
      detail:
        `observed ${observed} of ${requested} requested ticks; ` +
        `early termination noted: ${firstLine(input.earlyTerminationReason)}`
    };
  }
  return {
    name: "tick_progression",
    status: "fail",
    detail: `observed ${observed} of ${requested} requested ticks without an early termination reason`
  };
}

function checkEventStream(result: SimulationResult): CoverageCheck {
  const expectsAction =
    result.run_config.agents > 0 ||
    result.run_config.personas.length > 0 ||
    isReplayRun(result);
  if (!expectsAction) {
    return {
      name: "event_stream",
      status: "warn",
      detail: "run config does not claim agent action"
    };
  }

  const scenarioEvents = result.events.filter((event) => isScenarioEvent(result, event));
  if (scenarioEvents.length > 0) {
    return {
      name: "event_stream",
      status: "pass",
      detail: `${scenarioEvents.length} scenario event${scenarioEvents.length === 1 ? "" : "s"} observed`
    };
  }

  if (result.events.length > 0) {
    return {
      name: "event_stream",
      status: "warn",
      detail: `${result.events.length} engine-only event${result.events.length === 1 ? "" : "s"} observed`
    };
  }

  return {
    name: "event_stream",
    status: "fail",
    detail: "scenario claimed agent action but emitted no scenario events"
  };
}

function checkStateMovement(
  input: InterpretScenarioInput,
  result: SimulationResult
): CoverageCheck {
  if (input.staticBaseline) {
    return {
      name: "state_movement",
      status: "pass",
      detail: "scenario marked as an explicit static baseline"
    };
  }

  const movement = findNumericTimeseriesMovement(result.timeseries);
  if (movement) {
    return {
      name: "state_movement",
      status: "pass",
      detail: movement
    };
  }

  return {
    name: "state_movement",
    status: "fail",
    detail: "no numeric timeseries field changed"
  };
}

function checkInvariantInventory(
  input: InterpretScenarioInput,
  result: SimulationResult,
  invariantObservation: InvariantObservation
): CoverageCheck {
  const rows = invariantInventoryRows(result);
  const declared = input.declaredInvariants;

  if (declared !== undefined) {
    if (declared.length === 0) {
      return {
        name: "invariant_inventory",
        status: "pass",
        detail: "adapter declares no invariants"
      };
    }
    if (rows.length === 0) {
      return {
        name: "invariant_inventory",
        status: "fail",
        detail: `adapter declared ${declared.length} invariant${declared.length === 1 ? "" : "s"} but result has no invariant rows`
      };
    }

    const rowNames = new Set(rows.map((row) => row.name));
    const missing = declared.filter((name) => !rowNames.has(name));
    if (missing.length > 0) {
      return {
        name: "invariant_inventory",
        status: "fail",
        detail: `missing invariant row${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`
      };
    }
    return {
      name: "invariant_inventory",
      status: "pass",
      detail: `${rows.length} declared invariant row${rows.length === 1 ? "" : "s"} present`
    };
  }

  if (rows.length > 0) {
    return {
      name: "invariant_inventory",
      status: "pass",
      detail: `${rows.length} invariant row${rows.length === 1 ? "" : "s"} present in summary`
    };
  }

  if (invariantObservation.count > 0) {
    return {
      name: "invariant_inventory",
      status: "warn",
      detail: "invariant fire events observed but no invariant rollup rows were present"
    };
  }

  return {
    name: "invariant_inventory",
    status: "warn",
    detail: "adapter invariant declarations were not provided to the interpreter"
  };
}

function invariantInventoryRows(result: SimulationResult): Array<{ name: string }> {
  return [...invariantRows(result), ...expressionInvariantRows(result)];
}

function checkAgentRoster(result: SimulationResult): CoverageCheck {
  const summaryAgents = summaryAgentCount(result);
  if (isReplayRun(result)) {
    if (result.agents.length > 0) {
      return {
        name: "agent_roster",
        status: "pass",
        detail: `${result.agents.length} replay agent${result.agents.length === 1 ? "" : "s"} present`
      };
    }
    if (summaryAgents > 0 || result.events.some((event) => isScenarioEvent(result, event))) {
      return {
        name: "agent_roster",
        status: "pass",
        detail: `replay aggregate present for ${summaryAgents || result.run_config.agents} agent${(summaryAgents || result.run_config.agents) === 1 ? "" : "s"}`
      };
    }
    return {
      name: "agent_roster",
      status: "warn",
      detail: "replay run has no agent roster or replay aggregate events"
    };
  }

  if (result.run_config.personas.length === 0) {
    if (result.agents.length > 0 && result.events.some((event) => isScenarioEvent(result, event))) {
      return {
        name: "agent_roster",
        status: "pass",
        detail:
          `${result.agents.length} final agent${result.agents.length === 1 ? "" : "s"} ` +
          "using inline adapter personas"
      };
    }
    return {
      name: "agent_roster",
      status: "fail",
      detail: "synthetic run config has no personas"
    };
  }
  if (result.agents.length === 0) {
    return {
      name: "agent_roster",
      status: "fail",
      detail: "synthetic run produced no final agent roster"
    };
  }
  if (summaryAgents > 0 && summaryAgents !== result.run_config.agents) {
    return {
      name: "agent_roster",
      status: "warn",
      detail:
        `summary reports ${summaryAgents} agents for ` +
        `${result.run_config.agents} configured agents`
    };
  }
  return {
    name: "agent_roster",
    status: "pass",
    detail:
      `${result.agents.length} final agent${result.agents.length === 1 ? "" : "s"} ` +
      `across ${result.run_config.personas.length} persona${result.run_config.personas.length === 1 ? "" : "s"}`
  };
}

function checkSemanticsEvaluated(result: SimulationResult): CoverageCheck {
  const evaluated = result.timeseries.some((snapshot) => {
    const derived = (snapshot as Record<string, unknown>).derived_observations;
    return (
      derived !== null &&
      typeof derived === "object" &&
      !Array.isArray(derived) &&
      Object.keys(derived).length > 0
    );
  });
  if (evaluated) {
    return {
      name: "semantics_evaluated",
      status: "pass",
      detail: "derived observations computed for at least one tick"
    };
  }
  return {
    name: "semantics_evaluated",
    status: "fail",
    detail: "semantics block present but no derived observations were computed"
  };
}

function checkArtifactReadability(input: InterpretScenarioInput): CoverageCheck {
  if (!input.record.artifacts_dir) {
    return {
      name: "artifact_readability",
      status: "warn",
      detail: "scenario record has no artifacts directory"
    };
  }
  if (!input.artifactReadability) {
    return {
      name: "artifact_readability",
      status: "warn",
      detail: "artifacts directory recorded but readability was not checked"
    };
  }
  if (input.artifactReadability.simulationResultJson && input.artifactReadability.reportMarkdown) {
    return {
      name: "artifact_readability",
      status: "pass",
      detail: "simulation-result.json and report.md are readable"
    };
  }

  const missing: string[] = [];
  if (!input.artifactReadability.simulationResultJson) missing.push("simulation-result.json");
  if (!input.artifactReadability.reportMarkdown) missing.push("report.md");
  return {
    name: "artifact_readability",
    status: "fail",
    detail: `missing readable artifact${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`
  };
}

function classifyCoverage(
  checks: CoverageCheck[],
  invariantObservation: InvariantObservation
): Coverage {
  const byName = new Map(checks.map((check) => [check.name, check.status]));
  if (
    byName.get("event_stream") === "fail" &&
    byName.get("state_movement") === "fail"
  ) {
    return "unexercised";
  }
  if (byName.get("tick_progression") === "fail") {
    return "unexercised";
  }
  if (byName.get("agent_roster") === "fail") {
    return "unexercised";
  }
  if (
    byName.get("invariant_inventory") === "fail" &&
    invariantObservation.count === 0
  ) {
    return "unexercised";
  }
  if (checks.some((check) => check.status === "fail" || check.status === "warn")) {
    return "partial";
  }
  return "exercised";
}

function classifyVerdict(
  coverage: Coverage,
  invariantFireCount: number,
  errorExpressionInvariantFireCount: number
): Verdict {
  if (coverage === "unknown") return "setup-error";
  if (errorExpressionInvariantFireCount > 0) return "failure-observed";
  if (coverage === "unexercised") return "inconclusive";
  if (invariantFireCount > 0) return "failure-observed";
  return "no-failure-observed";
}

function classifyConfidence(
  verdict: Verdict,
  coverage: Coverage,
  checks: CoverageCheck[]
): Confidence {
  if (verdict === "setup-error") return "none";
  if (verdict === "inconclusive") return "low";
  if (verdict === "failure-observed") {
    return coverage === "exercised" ? "high" : "medium";
  }
  if (coverage === "exercised") return "medium";
  if (checks.some((check) => check.status === "fail")) return "low";
  return "low";
}

function classifySeverity(verdict: Verdict): Severity {
  if (verdict === "failure-observed") return "critical";
  if (verdict === "inconclusive" || verdict === "setup-error") return "warning";
  return "info";
}

function summaryFor(verdict: Verdict, invariantFireCount: number): string {
  switch (verdict) {
    case "failure-observed":
      return (
        `Failure observed in this run: ${invariantFireCount} invariant ` +
        `fire${invariantFireCount === 1 ? "" : "s"} recorded.`
      );
    case "no-failure-observed":
      return "No failure observed in this run.";
    case "inconclusive":
      return "Scenario inconclusive: coverage checks did not show meaningful scenario exercise.";
    case "setup-error":
      return "Setup failed.";
  }
}

function nextActionFor(verdict: Verdict): string {
  switch (verdict) {
    case "failure-observed":
      return "Review the first invariant fire and inspect simulation artifacts before changing the scenario or adapter.";
    case "no-failure-observed":
      return "Review coverage checks and artifacts before using this run as evidence.";
    case "inconclusive":
      return "Add agent activity, state movement, or invariant inventory, then rerun the scenario.";
    case "setup-error":
      return "Fix setup or adapter configuration, then rerun the scenario.";
  }
}

function buildEvidence(
  input: InterpretScenarioInput,
  result: SimulationResult,
  invariantObservation: InvariantObservation
): string[] {
  const evidence: string[] = [];
  if (invariantObservation.fires.length > 0) {
    const first = invariantObservation.fires[0]!;
    evidence.push(`first invariant fire: ${first.name} at tick ${first.tick}`);
  }
  for (const row of invariantObservation.firingRows) {
    evidence.push(
      `invariant rollup: ${row.name} fired ${row.firings} time${row.firings === 1 ? "" : "s"}`
    );
  }
  for (const row of invariantObservation.expressionFiringRows) {
    const count = expressionInvariantFiringCount(row);
    evidence.push(
      `expression invariant rollup: ${row.name} fired ${count} time${count === 1 ? "" : "s"} at severity ${row.severity}`
    );
  }
  evidence.push(`${result.events.length} event${result.events.length === 1 ? "" : "s"} recorded`);
  evidence.push(`${result.timeseries.length} timeseries snapshot${result.timeseries.length === 1 ? "" : "s"} recorded`);
  evidence.push(`${result.agents.length} final agent record${result.agents.length === 1 ? "" : "s"} recorded`);
  if (input.record.artifacts_dir) {
    evidence.push(`artifacts directory: ${input.record.artifacts_dir}`);
  }
  return evidence;
}

function buildReasons(
  verdict: Verdict,
  coverage: Coverage,
  checks: CoverageCheck[],
  invariantObservation: InvariantObservation
): string[] {
  const reasons: string[] = [];
  if (invariantObservation.count > 0) {
    reasons.push(`${invariantObservation.count} invariant fire${invariantObservation.count === 1 ? "" : "s"} observed`);
  } else {
    reasons.push("zero invariant fires observed");
  }
  reasons.push(`coverage classified as ${coverage}`);
  for (const check of checks) {
    if (check.status !== "pass") {
      reasons.push(`${check.name}: ${check.status} - ${check.detail}`);
    }
  }
  if (verdict === "inconclusive" && reasons.every((reason) => !reason.includes("coverage"))) {
    reasons.push("coverage checks did not establish meaningful exercise");
  }
  return reasons;
}

function observeInvariantFires(
  record: ScenarioRecord,
  result: SimulationResult
): InvariantObservation {
  const byKey = new Set<string>();
  const fires: InvariantFire[] = [];
  let expressionEventCount = 0;
  for (const fire of record.invariant_fires) {
    const key = `${fire.name}@${fire.tick}`;
    if (byKey.has(key)) continue;
    byKey.add(key);
    fires.push(fire);
  }

  for (const event of result.events) {
    const name = invariantNameFromEvent(event);
    const expressionName = expressionInvariantNameFromEvent(event);
    if (!name && !expressionName) continue;
    if (expressionName && expressionInvariantEventSeverity(event) !== "error") continue;
    const keyName = name ?? expressionName!;
    const key = `${keyName}@${event.tick}`;
    if (byKey.has(key)) continue;
    byKey.add(key);
    fires.push({ name: keyName, tick: event.tick });
    if (expressionName) expressionEventCount += 1;
  }

  const firingRows = invariantRows(result).filter((row) => row.firings > 0);
  const rowFireCount = firingRows.reduce((acc, row) => acc + row.firings, 0);
  const expressionFiringRows = expressionInvariantRows(result).filter(
    (row) => row.severity === "error" && expressionInvariantFiringCount(row) > 0
  );
  const expressionRowFireCount = expressionFiringRows.reduce(
    (acc, row) => acc + expressionInvariantFiringCount(row),
    0
  );
  return {
    count: fires.length > 0 ? fires.length : rowFireCount + expressionRowFireCount,
    errorExpressionCount:
      expressionEventCount > 0 ? expressionEventCount : expressionRowFireCount,
    fires,
    firingRows,
    expressionFiringRows
  };
}

function invariantRows(result: SimulationResult): InvariantFiredRow[] {
  const value = result.summary["invariants_fired"];
  if (!Array.isArray(value)) return [];
  return value.filter(isInvariantFiredRow);
}

function isInvariantFiredRow(value: unknown): value is InvariantFiredRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.name === "string" &&
    typeof row.field === "string" &&
    typeof row.op === "string" &&
    (typeof row.value === "number" || row.value === null) &&
    typeof row.firings === "number" &&
    Number.isInteger(row.firings) &&
    row.firings >= 0
  );
}

function expressionInvariantRows(result: SimulationResult): ExpressionInvariantRow[] {
  const value = result.summary["expression_invariants"];
  if (!Array.isArray(value)) return [];
  return value.filter(isExpressionInvariantRow);
}

function isExpressionInvariantRow(value: unknown): value is ExpressionInvariantRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.name === "string" &&
    typeof row.expr === "string" &&
    (row.severity === "error" || row.severity === "warn") &&
    (typeof row.first_tick === "number" || row.first_tick === null) &&
    typeof row.firing_count === "number" &&
    Number.isInteger(row.firing_count) &&
    row.firing_count >= 0 &&
    Array.isArray(row.observed)
  );
}

function expressionInvariantFiringCount(row: ExpressionInvariantRow): number {
  return row.firing_count ?? row.firings ?? 0;
}

function invariantNameFromEvent(event: SimEvent): string | null {
  if (event.persona_id !== "invariant") return null;
  if (!event.action.startsWith("invariant_violation:")) return null;
  return event.action.slice("invariant_violation:".length);
}

function expressionInvariantNameFromEvent(event: SimEvent): string | null {
  if (event.persona_id !== "expression_invariant") return null;
  if (!event.action.startsWith("expression_invariant_fire:")) return null;
  return event.action.slice("expression_invariant_fire:".length);
}

function expressionInvariantEventSeverity(event: SimEvent): string | null {
  const severity = event.params["severity"];
  return typeof severity === "string" ? severity : null;
}

function maxObservedTick(result: SimulationResult): number {
  let max = 0;
  for (const snapshot of result.timeseries) {
    if (typeof snapshot.tick === "number" && Number.isFinite(snapshot.tick)) {
      max = Math.max(max, snapshot.tick);
    }
  }
  for (const event of result.events) {
    max = Math.max(max, event.tick);
  }
  return max;
}

function isScenarioEvent(result: SimulationResult, event: SimEvent): boolean {
  if (invariantNameFromEvent(event)) return false;
  if (expressionInvariantNameFromEvent(event)) return false;
  if (isReplayRun(result)) return event.persona_id !== "invariant";
  if (event.agent_id === "__engine__" || event.persona_id === "__engine__") return false;
  return event.persona_id !== "invariant" && event.persona_id !== "expression_invariant";
}

function findNumericTimeseriesMovement(timeseries: TickSnapshot[]): string | null {
  if (timeseries.length < 2) return null;

  const firstSeen = new Map<string, number>();
  for (const snapshot of timeseries) {
    for (const [key, value] of Object.entries(snapshot)) {
      if (key === "tick") continue;
      if (!isFiniteNumber(value)) continue;
      const first = firstSeen.get(key);
      if (first === undefined) {
        firstSeen.set(key, value);
        continue;
      }
      if (first !== value) {
        return `timeseries field ${key} changed from ${first} to ${value}`;
      }
    }
  }

  return null;
}

function summaryAgentCount(result: SimulationResult): number {
  const active = numericSummaryValue(result, "agents_active");
  const liquidated = numericSummaryValue(result, "agents_liquidated");
  const depleted = numericSummaryValue(result, "agents_depleted");
  return active + liquidated + depleted;
}

function numericSummaryValue(result: SimulationResult, key: string): number {
  const value = result.summary[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isReplayRun(result: SimulationResult): boolean {
  return result.run_config.scenario.startsWith("replay:");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function firstLine(value: string): string {
  const idx = value.indexOf("\n");
  return idx === -1 ? value : value.slice(0, idx);
}
