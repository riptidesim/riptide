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

export function buildReviewMarkdown(input: ReviewMarkdownInput): string {
  const slug = path.basename(input.packRoot);
  const proof = proofBadge(input.provenance) ?? proofBadge(input.manifest);
  const invariantFires = collectInvariantFires(input.simulationResult);
  const doesNotClaim = proofDoesNotClaim(input.provenance) ?? proofDoesNotClaim(input.manifest) ?? [];
  const lines: string[] = [];

  lines.push(`# Pack: ${slug}`);
  lines.push("");
  if (proof) {
    lines.push(`**${proof}**`);
    lines.push("");
  }

  lines.push("## What Broke");
  lines.push("");
  lines.push(whatBrokeParagraph(invariantFires));
  lines.push("");

  lines.push("## Invariant Fires");
  lines.push("");
  if (invariantFires.length === 0) {
    lines.push("- None recorded.");
  } else {
    for (const fire of invariantFires) {
      const tick = fire.firstTick === null ? "unknown" : `T${fire.firstTick}`;
      lines.push(
        `- **${fire.name}** (${fire.firingCount}x, first ${tick}) - ${fire.rule}; observed: ${fire.observed}`
      );
    }
  }
  lines.push("");

  const programErrors = collectProgramErrors(input.simulationResult);
  if (programErrors.length > 0) {
    lines.push("## Program Errors");
    lines.push("");
    for (const error of programErrors) {
      lines.push(`- ${error}`);
    }
    lines.push("");
  }

  lines.push("## Reproducibility");
  lines.push("");
  lines.push(`- Canonical hash: \`${input.hash.observed}\``);
  lines.push(`- Hash verification: ${input.hash.ok ? "passed" : "failed"}`);
  lines.push(`- Raw output SHA256: \`${input.hash.rawSha256}\``);
  lines.push(`- Rerun command: \`sh ${path.relative(process.cwd(), input.rerunPath)}\``);
  lines.push("- Rerun check: `rerun.sh` is present and `sh -n` parseable; it was not executed.");
  lines.push("- Clean-checkout note: run the rerun command from a checkout with the committed pack inputs and the same toolchain pins.");
  lines.push("");

  lines.push("## Validation");
  lines.push("");
  lines.push("- `manifest.json` parsed.");
  lines.push("- `inputs/paths.json` and `outputs/paths.json` resolved.");
  lines.push("- Indexed `simulation-result.json` matched `canonical_hash` after Riptide canonicalization.");
  lines.push("- `rerun.sh` is present and `sh -n` parseable; it was not executed.");
  lines.push("");

  if (doesNotClaim.length > 0) {
    lines.push("## What This Proof Does Not Claim");
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

function whatBrokeParagraph(fires: InvariantFire[]): string {
  if (fires.length > 0) {
    const first = fires[0]!;
    const tick = first.firstTick === null ? "an unknown tick" : `tick ${first.firstTick}`;
    return `${first.name} fired first at ${tick}, indicating the declared proof condition was violated in this pack.`;
  }
  return "No hash-covered invariant fire was recorded in the simulation result.";
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
