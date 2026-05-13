import path from "node:path";

import type { HashVerification } from "./hash.js";
import type { ReviewManifest } from "./manifest.js";
import { labelForDerivedObservation } from "../serve/labels.js";

export interface ReviewMarkdownInput {
  packRoot: string;
  manifest: ReviewManifest;
  provenance?: Record<string, unknown>;
  simulationResult: Record<string, unknown>;
  hash: HashVerification;
  rerunPath: string;
}

export interface InvariantFire {
  name: string;
  rule: string;
  firstTick: number | null;
  firingCount: number;
  observed: string;
}

interface DeclaredInvariant {
  name: string;
  rule: string;
  firingCount: number;
}

interface RiskRow {
  signal: string;
  observed: string;
  meaning: string;
}

interface RelevantEventRow {
  tick: string;
  actor: string;
  action: string;
  outcome: string;
  detail: string;
}

export function buildReviewMarkdown(input: ReviewMarkdownInput): string {
  const slug = path.basename(input.packRoot);
  const proof = proofBadge(input.provenance) ?? proofBadge(input.manifest);
  const invariantFires = collectInvariantFires(input.simulationResult);
  const declaredInvariants = collectDeclaredInvariants(input.simulationResult);
  const programErrors = collectProgramErrors(input.simulationResult);
  const relevantEvents = collectRelevantEvents(input.simulationResult, invariantFires);
  const doesNotClaim = proofDoesNotClaim(input.provenance) ?? proofDoesNotClaim(input.manifest) ?? [];
  const lines: string[] = [];

  lines.push(`# Pack: ${slug}`);
  lines.push("");
  if (proof) {
    lines.push(`**${proof}**`);
    lines.push("");
  }

  lines.push("## Executive Summary");
  lines.push("");
  lines.push(executiveSummaryParagraph(input, invariantFires, programErrors));
  lines.push("");
  lines.push(`- **Outcome:** ${outcomeLabel(invariantFires, programErrors)}`);
  lines.push(`- **Scenario:** \`${String(input.manifest.scenario ?? scenarioFromResult(input.simulationResult) ?? "unknown")}\``);
  lines.push(`- **Evidence type:** ${String(input.manifest.kind ?? "pack")}`);
  lines.push(`- **Scope:** ${scopeSummary(input)}`);
  lines.push("- **Boundary:** Simulation evidence, not audit signoff or protocol safety certification.");
  lines.push("");

  lines.push("## Outcome");
  lines.push("");
  lines.push("| Check | Result | Evidence |");
  lines.push("|---|---|---|");
  lines.push(`| Canonical hash | ${input.hash.ok ? "pass" : "fail"} | \`${input.hash.observed}\` |`);
  lines.push(`| Invariants | ${invariantFires.length > 0 ? "fail" : "pass"} | ${invariantOutcomeEvidence(invariantFires, declaredInvariants)} |`);
  lines.push(`| Program errors | ${programErrors.length > 0 ? "warn" : "pass"} | ${programErrors.length > 0 ? `${programErrors.length} recorded` : "none recorded"} |`);
  lines.push(`| Rerun recipe | pass | \`${rerunCommand(input.rerunPath)}\` parses with \`sh -n\`; review did not execute it. |`);
  lines.push("");

  lines.push("## Risk Map");
  lines.push("");
  lines.push("| Signal | Observed | Reviewer meaning |");
  lines.push("|---|---|---|");
  for (const row of riskRows(input.simulationResult, invariantFires, programErrors)) {
    lines.push(`| ${row.signal} | ${row.observed} | ${row.meaning} |`);
  }
  lines.push("");

  lines.push("## Invariant Explanation");
  lines.push("");
  if (invariantFires.length === 0) {
    lines.push("No hash-covered invariant fire was recorded in `simulation-result.json`.");
  } else {
    lines.push("The rows below come from hash-covered simulation output, not from editable summary prose.");
    lines.push("");
    lines.push("| Invariant | Rule | Firings | First tick | Observed value |");
    lines.push("|---|---|---:|---:|---|");
    for (const fire of invariantFires) {
      lines.push(
        `| ${fire.name} | ${tableCell(fire.rule)} | ${fire.firingCount} | ${fire.firstTick === null ? "unknown" : String(fire.firstTick)} | ${tableCell(fire.observed)} |`
      );
    }
  }
  if (declaredInvariants.length > 0 && invariantFires.length === 0) {
    lines.push("");
    lines.push("| Declared invariant | Rule | Firings |");
    lines.push("|---|---|---:|");
    for (const invariant of declaredInvariants) {
      lines.push(`| ${invariant.name} | ${tableCell(invariant.rule)} | ${invariant.firingCount} |`);
    }
  }
  lines.push("");

  lines.push("## Scenario Parameters");
  lines.push("");
  lines.push("| Parameter | Value |");
  lines.push("|---|---|");
  for (const [key, value] of scenarioParameterRows(input)) {
    lines.push(`| ${key} | ${tableCell(value)} |`);
  }
  lines.push("");

  lines.push("## Relevant Events");
  lines.push("");
  if (relevantEvents.length === 0) {
    lines.push("No invariant, program-error, failure, or terminal events were found in the event log.");
  } else {
    lines.push("| Tick | Actor | Action | Outcome | Detail |");
    lines.push("|---:|---|---|---|---|");
    for (const event of relevantEvents) {
      lines.push(`| ${event.tick} | ${tableCell(event.actor)} | ${tableCell(event.action)} | ${tableCell(event.outcome)} | ${tableCell(event.detail)} |`);
    }
  }
  lines.push("");

  lines.push("## Rerun Command");
  lines.push("");
  lines.push(`\`\`\`sh`);
  lines.push(rerunCommand(input.rerunPath));
  lines.push("```");
  lines.push("");
  lines.push("The review command validated that `rerun.sh` is present and parseable; it did not execute the rerun recipe.");
  lines.push("");

  lines.push("## Technical Appendix");
  lines.push("");
  lines.push("### Reproducibility");
  lines.push("");
  lines.push(`- Canonical hash: \`${input.hash.observed}\``);
  lines.push(`- Hash verification: ${input.hash.ok ? "passed" : "failed"}`);
  lines.push(`- Raw output SHA256: \`${input.hash.rawSha256}\``);
  lines.push(`- Rerun command: \`${rerunCommand(input.rerunPath)}\``);
  lines.push("- Rerun check: `rerun.sh` is present and `sh -n` parseable; it was not executed.");
  lines.push("- Clean-checkout note: run the rerun command from a checkout with the committed pack inputs and the same toolchain pins.");
  lines.push("");

  lines.push("### Source Artifacts");
  lines.push("");
  lines.push(`- Pack root: \`${input.packRoot}\``);
  for (const [key, value] of artifactPathRows(input.manifest)) {
    lines.push(`- ${key}: \`${value}\``);
  }
  lines.push("");

  lines.push("### Validation");
  lines.push("");
  lines.push("- `manifest.json` parsed.");
  lines.push("- `inputs/paths.json` and `outputs/paths.json` resolved.");
  lines.push("- Indexed `simulation-result.json` matched `canonical_hash` after Riptide canonicalization.");
  lines.push("- `rerun.sh` is present and `sh -n` parseable; it was not executed.");
  lines.push("");

  const boundaries = simulationBoundaries(input);
  if (boundaries.length > 0) {
    lines.push("### Evidence Boundaries");
    lines.push("");
    for (const boundary of boundaries) {
      lines.push(`- ${boundary}`);
    }
    lines.push("");
  }

  if (doesNotClaim.length > 0) {
    lines.push("### What This Proof Does Not Claim");
    lines.push("");
    for (const claim of doesNotClaim) {
      lines.push(`- ${claim}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

export function collectInvariantFires(simulationResult: Record<string, unknown>): InvariantFire[] {
  const semanticClass = semanticClassFromResult(simulationResult);
  const expressionRows = semanticClass
    ? expressionInvariantRows(simulationResult, semanticClass)
    : [];
  return expressionRows.length > 0
    ? expressionRows
    : legacyInvariantRows(simulationResult, semanticClass);
}

function collectDeclaredInvariants(simulationResult: Record<string, unknown>): DeclaredInvariant[] {
  const summary = objectValue(simulationResult.summary);
  const rows: DeclaredInvariant[] = [];
  const expressionRows = Array.isArray(summary?.expression_invariants) ? summary.expression_invariants : [];
  for (const raw of expressionRows) {
    const row = objectValue(raw);
    if (!row) continue;
    rows.push({
      name: String(row.name ?? "unnamed_expression_invariant"),
      rule: String(row.expr ?? "expression unavailable"),
      firingCount: Number(row.firing_count ?? row.firings ?? 0),
    });
  }
  const legacyRows = Array.isArray(summary?.invariants_fired) ? summary.invariants_fired : [];
  for (const raw of legacyRows) {
    const row = objectValue(raw);
    if (!row) continue;
    rows.push({
      name: String(row.name ?? "unnamed_invariant"),
      rule: `${String(row.field ?? "field")} ${String(row.op ?? "op")} ${formatValue(row.value)}`,
      firingCount: Number(row.firings ?? 0),
    });
  }
  return rows;
}

function expressionInvariantRows(
  simulationResult: Record<string, unknown>,
  semanticClass: string
): InvariantFire[] {
  const summary = objectValue(simulationResult.summary);
  const rows = Array.isArray(summary?.expression_invariants) ? summary.expression_invariants : [];
  return rows
    .map((row) => objectValue(row))
    .filter((row): row is Record<string, unknown> => {
      if (!row) return false;
      return Number(row.firing_count ?? row.firings ?? 0) > 0;
    })
    .map((row) => {
      const observedEntries = Array.isArray(row.observed) ? row.observed : [];
      const observed = observedEntries.length > 0
        ? observedEntries
            .map((entry) => {
              const record = objectValue(entry);
              const tick = typeof record?.tick === "number" ? `T${record.tick}` : "T?";
              return `${tick}: ${formatObservedCell(record?.values, semanticClass)}`;
            })
            .join(" | ")
        : "observed values unavailable";
      const firstTick = typeof row.first_tick === "number"
        ? row.first_tick
        : typeof row.first_fired_tick === "number"
          ? row.first_fired_tick
          : null;
      return {
        name: String(row.name ?? "unnamed_expression_invariant"),
        rule: String(row.expr ?? "expression unavailable"),
        firstTick,
        firingCount: Number(row.firing_count ?? row.firings ?? 0),
        observed,
      };
    });
}

function legacyInvariantRows(
  simulationResult: Record<string, unknown>,
  semanticClass: string | undefined
): InvariantFire[] {
  const summary = objectValue(simulationResult.summary);
  const rows = Array.isArray(summary?.invariants_fired) ? summary.invariants_fired : [];
  const events = Array.isArray(simulationResult.events) ? simulationResult.events : [];
  return rows
    .filter((row) => objectValue(row) && Number((row as Record<string, unknown>).firings ?? 0) > 0)
    .map((row) => {
      const record = row as Record<string, unknown>;
      const name = String(record.name ?? "unnamed_invariant");
      const event = events
        .map((entry) => objectValue(entry))
        .find((entry) => entry?.action === `invariant_violation:${name}`);
      const params = objectValue(event?.params);
      const observed =
        params && "observed" in params
          ? formatObservedCell(params.observed, semanticClass)
          : "see trace.md";
      const firstTick = typeof event?.tick === "number"
        ? event.tick
        : typeof record.first_tick === "number"
          ? record.first_tick
          : null;
      return {
        name,
        rule: `${String(record.field ?? "field")} ${String(record.op ?? "op")} ${formatValue(record.value)}`,
        firstTick,
        firingCount: Number(record.firings ?? 0),
        observed,
      };
    });
}

function formatObservedCell(value: unknown, semanticClass: string | undefined): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return formatValue(value);
  }
  return Object.entries(value as Record<string, unknown>)
    .map(([name, observed]) => {
      const meta = labelForDerivedObservation(semanticClass, name);
      return `${meta?.label ?? name}: ${formatValue(observed)}`;
    })
    .join(", ");
}

function semanticClassFromResult(simulationResult: Record<string, unknown>): string | undefined {
  const semantics = objectValue(simulationResult.semantics);
  return typeof semantics?.class === "string" ? semantics.class : undefined;
}

function collectProgramErrors(simulationResult: Record<string, unknown>): string[] {
  const events = Array.isArray(simulationResult.events) ? simulationResult.events : [];
  const out: string[] = [];
  for (const raw of events) {
    const event = objectValue(raw);
    const programError = objectValue(event?.program_error);
    if (!event || !programError) continue;
    const code = Number(programError.code);
    const label = typeof programError.label === "string" ? programError.label : null;
    const interpretation =
      typeof programError.interpretation === "string" ? programError.interpretation : null;
    const rendered = label && interpretation
      ? `${label} · code ${code} · ${interpretation}`
      : `Custom(${code})`;
    out.push(`T${String(event.tick)} ${String(event.action)} failed: ${rendered}`);
  }
  return out;
}

function collectRelevantEvents(
  simulationResult: Record<string, unknown>,
  invariantFires: InvariantFire[]
): RelevantEventRow[] {
  const events = Array.isArray(simulationResult.events) ? simulationResult.events : [];
  const selected: RelevantEventRow[] = [];
  for (const raw of events) {
    const event = objectValue(raw);
    if (!event) continue;
    const action = String(event.action ?? "");
    const outcome = String(event.outcome ?? "");
    const programError = objectValue(event.program_error);
    const detail =
      typeof event.outcome_detail === "string"
        ? event.outcome_detail
        : programError
          ? formatProgramError(programError)
          : paramsBrief(event.params);
    const important =
      action.includes("invariant") ||
      outcome === "failed" ||
      outcome === "error" ||
      Boolean(programError);
    if (!important) continue;
    selected.push({
      tick: typeof event.tick === "number" ? String(event.tick) : "unknown",
      actor: String(event.persona_label ?? event.persona_id ?? event.agent_id ?? "unknown"),
      action: action || "unknown",
      outcome: outcome || "unknown",
      detail: detail || "",
    });
  }
  if (selected.length === 0 && events.length > 0 && invariantFires.length === 0) {
    const last = objectValue(events[events.length - 1]);
    if (last) {
      selected.push({
        tick: typeof last.tick === "number" ? String(last.tick) : "unknown",
        actor: String(last.persona_label ?? last.persona_id ?? last.agent_id ?? "unknown"),
        action: String(last.action ?? "last event"),
        outcome: String(last.outcome ?? "unknown"),
        detail: typeof last.outcome_detail === "string" ? last.outcome_detail : paramsBrief(last.params),
      });
    }
  }
  return selected.slice(0, 8);
}

function executiveSummaryParagraph(
  input: ReviewMarkdownInput,
  invariantFires: InvariantFire[],
  programErrors: string[]
): string {
  const first = invariantFires[0];
  const scenario = String(input.manifest.scenario ?? scenarioFromResult(input.simulationResult) ?? "this scenario");
  if (first) {
    const tick = first.firstTick === null ? "an unknown tick" : `tick ${first.firstTick}`;
    return `Failure observed in ${scenario}: \`${first.name}\` fired at ${tick}. The canonical hash verified, so this summary is derived from hash-covered simulation output rather than editable report prose.`;
  }
  if (programErrors.length > 0) {
    return `No invariant fire was recorded in ${scenario}, but ${programErrors.length} program error${programErrors.length === 1 ? "" : "s"} appeared in the event log. Treat this as a reviewable risk signal, not a safety certificate.`;
  }
  return `No invariant fire or program error was recorded in ${scenario}. This is evidence for the declared scenario boundary only; it is not proof of complete protocol safety.`;
}

function outcomeLabel(invariantFires: InvariantFire[], programErrors: string[]): string {
  if (invariantFires.length > 0) {
    return `${invariantFires.length} invariant ${invariantFires.length === 1 ? "condition fired" : "conditions fired"}`;
  }
  if (programErrors.length > 0) {
    return `no invariant fire observed, ${programErrors.length} program error${programErrors.length === 1 ? "" : "s"} recorded`;
  }
  return "no invariant failure observed";
}

function invariantOutcomeEvidence(
  invariantFires: InvariantFire[],
  declaredInvariants: DeclaredInvariant[]
): string {
  if (invariantFires.length > 0) {
    const first = invariantFires[0]!;
    const tick = first.firstTick === null ? "unknown tick" : `tick ${first.firstTick}`;
    return `${first.name} fired ${first.firingCount}x, first at ${tick}`;
  }
  if (declaredInvariants.length > 0) {
    return `${declaredInvariants.length} declared invariant${declaredInvariants.length === 1 ? "" : "s"} held in this output`;
  }
  return "no declared invariant rows found";
}

function riskRows(
  simulationResult: Record<string, unknown>,
  invariantFires: InvariantFire[],
  programErrors: string[]
): RiskRow[] {
  const summary = objectValue(simulationResult.summary);
  const rows: RiskRow[] = [];
  rows.push({
    signal: "Invariant fires",
    observed: invariantFires.length > 0 ? `${invariantFires.length} firing row${invariantFires.length === 1 ? "" : "s"}` : "0",
    meaning: invariantFires.length > 0
      ? "At least one declared proof condition did not hold under this scenario."
      : "No declared invariant violation was observed in this run.",
  });
  if (programErrors.length > 0) {
    rows.push({
      signal: "Program errors",
      observed: String(programErrors.length),
      meaning: "Runtime failures appeared in the event log and should be inspected before widening claims.",
    });
  }
  const metrics: Array<[string, string, string]> = [
    ["total_bad_debt", "Bad debt", "Debt left uncovered by the modeled liquidation path."],
    ["total_liquidations", "Liquidations", "Number of liquidation events summarized by the run."],
    ["final_utilization", "Final utilization", "Terminal borrow utilization reported by the scenario."],
    ["final_tvl", "Final TVL", "Terminal liquidity/value summary reported by the scenario."],
    ["agents_liquidated", "Liquidated agents", "Agents ending the run in a liquidated state."],
    ["largest_single_tick_drawdown", "Largest one-tick drawdown", "Sharpest single-tick TVL drop observed by the run."],
  ];
  for (const [key, label, meaning] of metrics) {
    if (!summary || !(key in summary)) continue;
    rows.push({ signal: label, observed: formatValue(summary[key]), meaning });
  }
  return rows;
}

function scenarioParameterRows(input: ReviewMarkdownInput): Array<[string, string]> {
  const runConfig = objectValue(input.simulationResult.run_config);
  const rows: Array<[string, string]> = [];
  rows.push(["run_id", String(input.manifest.run_id ?? "(unknown)")]);
  rows.push(["scenario", String(input.manifest.scenario ?? runConfig?.scenario ?? "(unknown)")]);
  rows.push(["seed", String(input.simulationResult.seed ?? runConfig?.seed ?? "(unknown)")]);
  rows.push(["ticks", String(input.manifest.total_ticks ?? input.simulationResult.total_ticks ?? runConfig?.ticks ?? "(unknown)")]);
  rows.push(["agents", String(input.manifest.agents ?? runConfig?.agents ?? "(unknown)")]);
  rows.push(["adapter", String(input.manifest.adapter ?? "(unknown)")]);
  const outputPath = stringValue(runConfig?.output_path);
  if (outputPath) rows.push(["output_path", outputPath]);
  const personas = Array.isArray(runConfig?.personas) ? runConfig.personas.length : null;
  if (personas !== null) rows.push(["persona_count", String(personas)]);
  return rows;
}

function artifactPathRows(manifest: ReviewManifest): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  const inputs = objectValue(manifest.inputs);
  const outputs = objectValue(manifest.outputs);
  if (inputs) {
    for (const [key, value] of Object.entries(inputs)) {
      if (typeof value === "string") rows.push([`input.${key}`, value]);
    }
  }
  if (outputs) {
    for (const [key, value] of Object.entries(outputs)) {
      if (typeof value === "string") rows.push([`output.${key}`, value]);
    }
  }
  return rows;
}

function simulationBoundaries(input: ReviewMarkdownInput): string[] {
  const fromResult = Array.isArray(input.simulationResult.simulation_boundaries)
    ? input.simulationResult.simulation_boundaries
    : [];
  const fromManifest = Array.isArray(input.manifest.simulation_boundaries)
    ? input.manifest.simulation_boundaries
    : [];
  return [...fromManifest, ...fromResult].filter(
    (entry, index, arr): entry is string =>
      typeof entry === "string" && entry.length > 0 && arr.indexOf(entry) === index
  );
}

function scopeSummary(input: ReviewMarkdownInput): string {
  const ticks = input.manifest.total_ticks ?? input.simulationResult.total_ticks;
  const agents = input.manifest.agents ?? objectValue(input.simulationResult.run_config)?.agents;
  const eventCount = input.manifest.event_count ?? (Array.isArray(input.simulationResult.events) ? input.simulationResult.events.length : null);
  return `${displayUnknown(agents)} agents, ${displayUnknown(ticks)} ticks, ${displayUnknown(eventCount)} events`;
}

function scenarioFromResult(simulationResult: Record<string, unknown>): string | null {
  const runConfig = objectValue(simulationResult.run_config);
  return stringValue(runConfig?.scenario);
}

function rerunCommand(rerunPath: string): string {
  const relative = path.relative(process.cwd(), rerunPath);
  return `sh ${shellQuotePath(relative.length > 0 ? relative : rerunPath)}`;
}

function formatProgramError(programError: Record<string, unknown>): string {
  const code = Number(programError.code);
  const label = typeof programError.label === "string" ? programError.label : null;
  const interpretation =
    typeof programError.interpretation === "string" ? programError.interpretation : null;
  if (label && interpretation) return `${label} · code ${code} · ${interpretation}`;
  return Number.isFinite(code) ? `Custom(${code})` : "program error";
}

function paramsBrief(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 4);
  return entries.map(([key, raw]) => `${key}=${formatValue(raw)}`).join(", ");
}

function displayUnknown(value: unknown): string {
  return value === null || value === undefined || value === "" ? "unknown" : String(value);
}

function proofBadge(manifest: Record<string, unknown> | undefined): string | null {
  if (!manifest) return null;
  const proof = manifest.proof;
  if (proof && typeof proof === "object" && !Array.isArray(proof)) {
    const proofRecord = proof as Record<string, unknown>;
    if (typeof proofRecord.level === "number") {
      return `Proof level ${proofRecord.level}${typeof proofRecord.label === "string" ? ` - ${proofRecord.label}` : ""}`;
    }
  }
  const proofLevel = manifest.proof_level;
  if (typeof proofLevel === "number") {
    return `Proof level ${proofLevel}${typeof manifest.proof_level_label === "string" ? ` - ${manifest.proof_level_label}` : ""}`;
  }
  if (proofLevel && typeof proofLevel === "object" && !Array.isArray(proofLevel)) {
    const proofRecord = proofLevel as Record<string, unknown>;
    if (typeof proofRecord.level === "number") {
      return `Proof level ${proofRecord.level}${typeof proofRecord.label === "string" ? ` - ${proofRecord.label}` : ""}`;
    }
  }
  return null;
}

function proofDoesNotClaim(manifest: Record<string, unknown> | undefined): string[] | null {
  if (!manifest) return null;
  const raw =
    manifest.what_this_proof_does_not_claim ??
    manifest.does_not_claim ??
    manifest.scope_of_claim_bullets;
  if (Array.isArray(raw)) {
    return raw.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  }
  if (typeof raw === "string" && raw.length > 0) {
    return [raw];
  }
  return null;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function tableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function shellQuotePath(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
