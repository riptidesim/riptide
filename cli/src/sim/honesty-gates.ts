import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import TOML from "toml";

import type { GuidedSimRunDocument } from "./cartography.js";

/**
 * Execution-honesty gates: the buildable partial oracle that refuses to let a
 * guided-sim sweep be emitted as an assessment unless three checks pass.
 *
 * Riptide has no automatic oracle for "is this finding real and honestly
 * framed", so these gates verify the *execution* of the chosen scenario (they
 * do not — and cannot — verify that the right scenario was chosen; that stays
 * the skill's expertise + honest scoping):
 *
 * 1. **Positive control** — the sweep must declare a control coordinate whose
 *    outcome is known-correct (e.g. no-shock / fresh-true NAV pays exact
 *    pro-rata) and that coordinate must actually pass. Without it, a flat-zero
 *    surface is unfalsifiable.
 * 2. **Lifecycle executed** — the intended core transactions must really have
 *    run on-chain. A flat/zero result from a lifecycle that never executed (the
 *    `--flows 1` no-op) is "no-op, not robustness".
 * 3. **Determinism** — `risk-surface.json` must be byte-stable; the producer
 *    builds it twice and records its hash, and the emit step re-checks the
 *    on-disk bytes against that hash so drift or tampering is caught.
 *
 * The gates are evaluated where the producer knows the run (`sim surface`),
 * recorded into the guided-sim `campaign-summary.json` (additive, guided-sim
 * only — never on real-campaign summaries, so frozen campaign bytes are
 * untouched), and enforced at report-emit (`assess`) time. `sim run` evaluates
 * the run-only gates and warns, so authoring iterations are not blocked.
 */

export const EXECUTION_HONESTY_SCHEMA = "execution-honesty.v1" as const;

export type GateId = "positive_control" | "lifecycle_executed" | "determinism";
export type GateStatus = "pass" | "fail" | "warn";

export interface GateResult {
  id: GateId;
  status: GateStatus;
  /** One-line, deterministic explanation suitable for the cold-read summary. */
  detail: string;
}

export interface ExecutionHonestyReport {
  schema_version: typeof EXECUTION_HONESTY_SCHEMA;
  /** `blocked` when any gate failed; otherwise `pass`. */
  status: "pass" | "blocked";
  gates: GateResult[];
  /**
   * sha256 of the `risk-surface.json` bytes the producer emitted, recorded so
   * the emit step can re-verify determinism across the surface→assess boundary.
   */
  surface_sha256: string;
}

export interface PositiveControlConfig {
  /** Swept axis the control coordinate lives on; defaults to the sweep name. */
  parameter: string;
  /** The control value on that axis (e.g. `0` = no shock / fresh-true NAV). */
  value: number;
}

export interface LifecycleConfig {
  /**
   * Core transaction labels that must each execute successfully somewhere in
   * the run for it to be honest evidence (the program's real lifecycle). When
   * absent, the gate falls back to "at least one core transaction executed".
   */
  required_flows: string[];
}

const FLOAT_TOLERANCE = 1e-9;

// ---------------------------------------------------------------------------
// Manifest config readers
// ---------------------------------------------------------------------------

/** Read `[sim.positive_control]` from a sim manifest. Returns null when absent. */
export async function readPositiveControlConfig(
  manifestPath: string,
  fallbackParameter: string
): Promise<PositiveControlConfig | null> {
  const block = await readSimBlock(manifestPath, "positive_control");
  if (!block) return null;
  const value = typeof block.value === "number" && Number.isFinite(block.value) ? block.value : null;
  if (value === null) return null;
  const parameter =
    typeof block.parameter === "string" && block.parameter.length > 0
      ? block.parameter
      : fallbackParameter;
  return { parameter, value };
}

/** Read `[sim.lifecycle]` from a sim manifest. Returns null when absent. */
export async function readLifecycleConfig(manifestPath: string): Promise<LifecycleConfig | null> {
  const block = await readSimBlock(manifestPath, "lifecycle");
  if (!block) return null;
  const required = Array.isArray(block.required_flows)
    ? block.required_flows.filter((f): f is string => typeof f === "string" && f.trim().length > 0)
    : [];
  return { required_flows: required };
}

async function readSimBlock(
  manifestPath: string,
  key: "positive_control" | "lifecycle"
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
// Gate evaluation
// ---------------------------------------------------------------------------

/** True for an iteration that completed without an engine fault or returned error. */
function iterationRan(iteration: GuidedSimRunDocument["iterations"][number]): boolean {
  return iteration.panic !== true && iteration.status !== "panic" && iteration.status !== "failed";
}

/** Distinct labels of transactions that executed successfully (ok, not an expected rejection). */
function successfulFlowLabels(runDoc: GuidedSimRunDocument): Set<string> {
  const labels = new Set<string>();
  for (const iteration of runDoc.iterations) {
    for (const tx of iteration.tx_outcomes ?? []) {
      if (tx.ok !== true || tx.expected_error === true) continue;
      const label = typeof tx.label === "string" ? tx.label.trim() : "";
      if (label.length === 0 || label.startsWith("invariant:")) continue;
      labels.add(label);
    }
  }
  return labels;
}

/**
 * R3.1 — the declared control coordinate must be present and pass (no invariant
 * fire, no engine fault). A missing declaration fails: an undeclared positive
 * control cannot be checked, so a flat surface is unfalsifiable.
 */
export function evaluatePositiveControl(
  runDoc: GuidedSimRunDocument,
  config: PositiveControlConfig | null
): GateResult {
  if (!config) {
    return {
      id: "positive_control",
      status: "fail",
      detail:
        "no positive control declared ([sim.positive_control]); a guided sim destined for an assessment must declare a known-correct baseline."
    };
  }
  const matching = runDoc.iterations.filter((iteration) => {
    const coordinate = iteration.parameters?.[config.parameter];
    return typeof coordinate === "number" && Math.abs(coordinate - config.value) <= FLOAT_TOLERANCE;
  });
  if (matching.length === 0) {
    return {
      id: "positive_control",
      status: "fail",
      detail: `declared positive control ${config.parameter}=${config.value} is absent from the sweep; no baseline was run.`
    };
  }
  const broken = matching.find(
    (iteration) => !iterationRan(iteration) || (iteration.invariant_fires ?? []).length > 0
  );
  if (broken) {
    const fires = (broken.invariant_fires ?? []).join(", ");
    return {
      id: "positive_control",
      status: "fail",
      detail: `positive control ${config.parameter}=${config.value} did not yield the known-correct baseline (${
        iterationRan(broken) ? `invariant fired: ${fires}` : `iteration status ${broken.status}`
      }).`
    };
  }
  return {
    id: "positive_control",
    status: "pass",
    detail: `positive control ${config.parameter}=${config.value} passed across ${matching.length} iteration(s).`
  };
}

/**
 * R3.2 — the intended lifecycle must have executed. With declared
 * `required_flows`, every one must appear as a successful transaction; without
 * a declaration, at least one core transaction must have run (catches the
 * `--flows 1` no-op where the lifecycle never executed).
 */
export function evaluateLifecycle(
  runDoc: GuidedSimRunDocument,
  config: LifecycleConfig | null
): GateResult {
  const executed = successfulFlowLabels(runDoc);
  const required = config?.required_flows ?? [];

  if (required.length > 0) {
    const missing = required.filter((flow) => !executed.has(flow));
    if (missing.length > 0) {
      return {
        id: "lifecycle_executed",
        status: "fail",
        detail: `lifecycle did not execute (no-op, not robustness): required flow(s) never ran — ${missing.join(", ")}.`
      };
    }
    return {
      id: "lifecycle_executed",
      status: "pass",
      detail: `all ${required.length} declared lifecycle flow(s) executed on-chain.`
    };
  }

  if (executed.size === 0) {
    return {
      id: "lifecycle_executed",
      status: "fail",
      detail:
        "lifecycle did not execute (no-op, not robustness): no core transaction succeeded across the sweep."
    };
  }
  return {
    id: "lifecycle_executed",
    status: "pass",
    detail: `${executed.size} core flow(s) executed on-chain (no declared lifecycle to check against).`
  };
}

/**
 * R3.3 — determinism. The producer records the surface hash; the emit step
 * passes the freshly hashed on-disk bytes. A mismatch means the surface drifted
 * or was tampered with between `sim surface` and `assess`. The assess command
 * also compares freshly rendered `assessment.{json,md}` bytes with existing
 * output files when they are present, so the full assessment artifact set is
 * covered without putting self-referential assessment hashes inside
 * `assessment.json`.
 */
export function evaluateDeterminism(recordedSha256: string, actualSha256: string): GateResult {
  if (recordedSha256 === actualSha256) {
    return {
      id: "determinism",
      status: "pass",
      detail:
        `risk-surface.json byte-stable (sha256 ${actualSha256.slice(0, 16)}…); ` +
        "assessment.json and assessment.md are checked for byte-stability at emit time."
    };
  }
  return {
    id: "determinism",
    status: "fail",
    detail: `determinism drift: risk-surface.json sha256 ${actualSha256.slice(
      0,
      16
    )}… does not match the ${recordedSha256.slice(0, 16)}… recorded at surface time.`
  };
}

/**
 * Compose the run-time gates (positive control + lifecycle) the producer can
 * evaluate from the run alone, plus a determinism gate seeded as `pass` with the
 * recorded surface hash (re-verified at emit time). Returns the report stored in
 * the guided-sim `campaign-summary.json`.
 */
export function buildExecutionHonestyReport(input: {
  runDoc: GuidedSimRunDocument;
  positiveControl: PositiveControlConfig | null;
  lifecycle: LifecycleConfig | null;
  surfaceSha256: string;
}): ExecutionHonestyReport {
  const gates: GateResult[] = [
    evaluatePositiveControl(input.runDoc, input.positiveControl),
    evaluateLifecycle(input.runDoc, input.lifecycle),
    {
      id: "determinism",
      status: "pass",
      detail: `surface hash recorded for re-verification (sha256 ${input.surfaceSha256.slice(0, 16)}…).`
    }
  ];
  return finalizeReport(gates, input.surfaceSha256);
}

/**
 * Re-evaluate the report at emit time: keep the producer's positive-control and
 * lifecycle verdicts, but replace the determinism gate with a fresh on-disk hash
 * comparison. Returns the report to surface, recomputing `status`.
 */
export function reverifyAtEmit(
  recorded: ExecutionHonestyReport,
  actualSurfaceSha256: string
): ExecutionHonestyReport {
  const gates = recorded.gates.map((gate) =>
    gate.id === "determinism"
      ? evaluateDeterminism(recorded.surface_sha256, actualSurfaceSha256)
      : gate
  );
  return finalizeReport(gates, recorded.surface_sha256);
}

function finalizeReport(gates: GateResult[], surfaceSha256: string): ExecutionHonestyReport {
  const blocked = gates.some((gate) => gate.status === "fail");
  return {
    schema_version: EXECUTION_HONESTY_SCHEMA,
    status: blocked ? "blocked" : "pass",
    gates,
    surface_sha256: surfaceSha256
  };
}

/** The failed gates, for a blocking error message. */
export function failedGates(report: ExecutionHonestyReport): GateResult[] {
  return report.gates.filter((gate) => gate.status === "fail");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
