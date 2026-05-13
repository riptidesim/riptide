// `riptide review <pack>` — read-only evidence-pack reviewer surface.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { Command } from "commander";

import { canonicalRetainedCaseDigestPayload } from "../campaign/aggregation.js";
import {
  pickColorizer,
  shouldUseColor,
  type Colorizer
} from "../display/index.js";
import { renderCliError } from "../errors/render.js";
import { verifyCanonicalHash } from "../review/hash.js";
import { buildReviewJsonPayload } from "../review/json.js";
import { buildReviewMarkdown, collectInvariantFires } from "../review/markdown.js";
import { loadPackManifest, ReviewValidationError, type ValidationResult } from "../review/manifest.js";
import { printBanner } from "../banner.js";
import { canonicalJson, sha256Hex, type JsonValue } from "../state-pack/json.js";

const execFileAsync = promisify(execFile);

export interface ReviewOptions {
  out?: string;
  json?: boolean;
  quiet?: boolean;
}

export interface ReviewCommandDeps {
  stdoutWrite?: (chunk: string) => void;
  stderrWrite?: (chunk: string) => void;
  cwd?: string;
  color?: boolean;
}

type JsonRecord = Record<string, unknown>;

interface GuidedTraceStepSummary {
  iteration: number | string;
  step_index: number;
  flow_index: number;
  flow_name: string;
  tx_log_start: number;
  tx_log_end: number;
  service_ticks_before: number;
  service_ticks_after: number;
  status: "passed" | "returned_error" | "panic";
  expected_errors: number;
  unexpected_errors: number;
  failure_message: string | null;
}

interface GuidedFirstFailureSummary {
  iteration: number | string;
  stage: string;
  status: "returned_error" | "panic";
  step_index: number | null;
  flow_index: number | null;
  flow_name: string | null;
  tx_log_start: number;
  tx_log_end: number;
  service_ticks_before: number;
  service_ticks_after: number;
  failure_message: string;
}

interface GuidedTraceIterationSummary {
  iteration: number | string;
  status: string;
  steps: number;
  passed_steps: number;
  returned_error_steps: number;
  panic_steps: number;
  flow_sequence_preview: string[];
  flow_sequence_truncated: boolean;
  tx_log_start: number | null;
  tx_log_end: number | null;
  expected_errors: number;
  unexpected_errors: number;
  first_failing_flow_step: GuidedTraceStepSummary | null;
  first_failure: GuidedFirstFailureSummary | null;
}

interface GuidedTraceSummary {
  available: boolean;
  schema_version: number | null;
  iterations: GuidedTraceIterationSummary[];
  first_failing_flow_step: GuidedTraceStepSummary | null;
  first_failure: GuidedFirstFailureSummary | null;
}

const GUIDED_TRACE_PREVIEW_LIMIT = 8;
const GUIDED_TRACE_STEP_STATUSES = new Set(["passed", "returned_error", "panic"]);
const GUIDED_FAILURE_STATUSES = new Set(["returned_error", "panic"]);

export function createReviewCommand(deps: ReviewCommandDeps = {}): Command {
  return new Command("review")
    .description("Validate a Riptide evidence pack, campaign root, or guided-sim artifact and emit reviewer markdown")
    .argument("<pack>", "Path to a Riptide evidence pack, campaign root, retained campaign case, or guided-sim artifact")
    .option("--out <md-path>", "Write reviewer markdown to a file instead of stdout")
    .option("--json", "Emit a structured JSON review payload", false)
    .option("--quiet", "Suppress interactive banner", false)
    .action(async (pack: string, options: ReviewOptions) => {
      printBanner({ flags: { json: Boolean(options.json), quiet: Boolean(options.quiet) } });
      const exitCode = await runReview(pack, options, deps);
      process.exit(exitCode);
    });
}

export async function runReview(
  pack: string,
  options: ReviewOptions,
  deps: ReviewCommandDeps = {}
): Promise<number> {
  const stdout = deps.stdoutWrite ?? ((chunk: string) => process.stdout.write(chunk));
  const stderr = deps.stderrWrite ?? ((chunk: string) => process.stderr.write(chunk));

  try {
    const reviewCwd = path.resolve(deps.cwd ?? process.cwd());
    const reviewRoot = path.resolve(reviewCwd, pack);
    if (isCampaignRoot(reviewRoot)) {
      return await runCampaignReview(reviewRoot, options, deps);
    }
    if (isRetainedCaseRoot(reviewRoot)) {
      return await runRetainedCaseReview(reviewRoot, options, deps);
    }
    if (guidedSimArtifactPath(reviewRoot) !== null) {
      return await runGuidedSimReview(reviewRoot, options, deps);
    }

    const packData = await loadPackManifest(reviewRoot, { workspaceRoot: reviewCwd });
    const validationResults: ValidationResult[] = [...packData.validationResults];
    const warnings: string[] = [];

    const { result: simulationResult, verification } = await verifyCanonicalHash(
      packData.manifest,
      packData.simulationResultPath,
      validationResults
    );

    const rerunPath = path.join(packData.packRoot, "rerun.sh");
    await validateRerunScript(rerunPath, validationResults);

    const provenancePath = path.join(packData.packRoot, "provenance.json");
    let provenance: Record<string, unknown> | undefined;
    if (existsSync(provenancePath)) {
      provenance = await readOptionalJson(provenancePath);
      validationResults.push({
        step: "provenance",
        status: "pass",
        message: "provenance.json present",
        path: provenancePath,
      });
    } else if (!manifestHasProofMetadata(packData.manifest)) {
      const message = "provenance.json missing and manifest has no proof metadata; omitting proof-level badge";
      warnings.push(message);
      validationResults.push({
        step: "provenance",
        status: "warn",
        message,
        path: provenancePath,
      });
    }

    const invariantFires = collectInvariantFires(simulationResult);
    const markdown = buildReviewMarkdown({
      packRoot: packData.packRoot,
      manifest: packData.manifest,
      provenance,
      simulationResult,
      hash: verification,
      rerunPath,
    });

    if (options.json) {
      stdout(
        JSON.stringify(
          buildReviewJsonPayload({
            manifest: packData.manifest,
            manifestDigest: sha256(Buffer.from(packData.manifestRaw, "utf8")),
            validationResults,
            invariantFires,
            hash: verification,
            warnings,
          }),
          null,
          2
        ) + "\n"
      );
    } else if (typeof options.out === "string" && options.out.length > 0) {
      const outPath = path.resolve(deps.cwd ?? process.cwd(), options.out);
      await writeFile(outPath, markdown, "utf8");
      stdout(`wrote review markdown: ${outPath}\n`);
    } else {
      stdout(colorizeReviewMarkdown(markdown, deps));
    }

    return warnings.length > 0 ? 1 : 0;
  } catch (error) {
    const exitCode = error instanceof ReviewValidationError ? error.exitCode : 2;
    stderr(
      renderCliError(error, {
        env: process.env,
        color: deps.color,
        isTTY: Boolean(process.stderr.isTTY),
      })
    );
    return exitCode;
  }
}

async function runGuidedSimReview(
  inputPath: string,
  options: ReviewOptions,
  deps: ReviewCommandDeps
): Promise<number> {
  const stdout = deps.stdoutWrite ?? ((chunk: string) => process.stdout.write(chunk));
  const artifactPath = guidedSimArtifactPath(inputPath);
  if (!artifactPath) {
    throw new ReviewValidationError(
      `guided-sim artifact not found\n  path: ${inputPath}\n  next: pass a directory containing guided-sim-run.json or the JSON file itself`
    );
  }
  const artifactRoot = path.dirname(artifactPath);
  const artifact = await readRequiredJsonObject(artifactPath, "guided-sim-run.json");
  const validationResults: ValidationResult[] = [
    {
      step: "guided-sim-artifact",
      status: "pass",
      message: "guided-sim-run.json exists and parses",
      path: artifactPath,
    }
  ];
  validateGuidedSimArtifact(artifactPath, artifact, validationResults);
  const traceSummary = summarizeGuidedSimTrace(artifactPath, artifact, validationResults);

  const rerunPath = path.join(artifactRoot, "rerun.sh");
  let rerunCommand = await readGuidedSimRerunCommand(rerunPath);
  if (existsSync(rerunPath)) {
    await validateRerunScript(rerunPath, validationResults);
  } else {
    validationResults.push({
      step: "rerun-sh",
      status: "warn",
      message: "rerun.sh missing; inferred command uses <sim-dir> placeholder",
      path: rerunPath,
    });
  }
  rerunCommand ??= inferGuidedSimRerunCommand(artifactRoot, artifact);

  const markdown = renderGuidedSimReviewMarkdown({
    artifactRoot,
    artifactPath,
    artifact,
    traceSummary,
    validationResults,
    rerunCommand
  });

  if (options.json) {
    stdout(
      JSON.stringify(
        {
          schema_version: "guided-sim-review.v1",
          artifact_root: artifactRoot,
          artifact_path: artifactPath,
          status: stringValue(artifact.status) ?? "unknown",
          retained_failing_seed: stringValue(artifact.retained_failing_seed),
          failure_reason: firstGuidedSimFailure(artifact),
          first_failure: traceSummary.first_failure,
          first_failing_flow_step: traceSummary.first_failing_flow_step,
          trace_summary: traceSummary,
          flow_counts: aggregateGuidedSimFlows(artifact),
          tx_outcomes: guidedSimTxOutcomes(artifact),
          rerun_command: rerunCommand,
          validation: validationResults,
          artifact
        },
        null,
        2
      ) + "\n"
    );
  } else if (typeof options.out === "string" && options.out.length > 0) {
    const outPath = path.resolve(deps.cwd ?? process.cwd(), options.out);
    await writeFile(outPath, markdown, "utf8");
    stdout(`wrote review markdown: ${outPath}\n`);
  } else {
    stdout(colorizeReviewMarkdown(markdown, deps));
  }

  return validationResults.some((result) => result.status === "fail") ? 2 : 0;
}

function guidedSimArtifactPath(candidate: string): string | null {
  if (existsSync(candidate) && path.basename(candidate) === "guided-sim-run.json") {
    return candidate;
  }
  const nested = path.join(candidate, "guided-sim-run.json");
  return existsSync(nested) ? nested : null;
}

function validateGuidedSimArtifact(
  artifactPath: string,
  artifact: JsonRecord,
  validationResults: ValidationResult[]
): void {
  if (numberValue(artifact.schema_version) !== 1) {
    throw new ReviewValidationError(
      `unsupported guided-sim artifact schema\n  path: ${artifactPath}\n  expected: schema_version 1`
    );
  }
  if (!stringValue(artifact.status)) {
    throw new ReviewValidationError(
      `guided-sim artifact is missing status\n  path: ${artifactPath}`
    );
  }
  if (!Array.isArray(artifact.iterations)) {
    throw new ReviewValidationError(
      `guided-sim artifact is missing iterations array\n  path: ${artifactPath}`
    );
  }
  validationResults.push({
    step: "guided-sim-schema",
    status: "pass",
    message: "schema_version 1 with status and iterations",
    path: artifactPath,
  });
}

function renderGuidedSimReviewMarkdown(input: {
  artifactRoot: string;
  artifactPath: string;
  artifact: JsonRecord;
  traceSummary: GuidedTraceSummary;
  validationResults: ValidationResult[];
  rerunCommand: string;
}): string {
  const totals = objectValue(input.artifact.totals) ?? {};
  const failure = firstGuidedSimFailure(input.artifact);
  const retainedSeed = stringValue(input.artifact.retained_failing_seed) ?? "(none)";
  const lines: string[] = [
    `# Guided Simulation Review: ${path.basename(input.artifactRoot)}`,
    "",
    "## Outcome",
    "",
    `- Status: ${stringValue(input.artifact.status) ?? "unknown"}`,
    `- Artifact: \`${input.artifactPath}\``,
    `- Base seed: \`${stringValue(input.artifact.base_seed) ?? ""}\``,
    `- Retained failing seed: \`${retainedSeed}\``,
    `- Iterations: ${numberDisplay(totals.iterations)} of ${numberDisplay(input.artifact.iterations_requested)}`,
    `- Flow calls: ${numberDisplay(totals.flows)}`,
    `- Service ticks: ${numberDisplay(totals.service_ticks)}`,
    `- Transaction successes: ${numberDisplay(totals.tx_success)}`,
    `- Expected errors: ${numberDisplay(totals.expected_errors)}`,
    `- Unexpected errors: ${numberDisplay(totals.unexpected_errors)}`,
    `- Panics: ${numberDisplay(totals.panics)}`,
    "",
    "## Flow Table",
    "",
    "| Flow | Calls |",
    "|---|---|"
  ];

  const flows = aggregateGuidedSimFlows(input.artifact);
  for (const [name, count] of Object.entries(flows)) {
    lines.push(`| ${tableCell(name)} | ${count} |`);
  }
  if (Object.keys(flows).length === 0) {
    lines.push("| (none recorded) | 0 |");
  }

  lines.push(
    "",
    "## Flow Trace",
    ""
  );
  appendGuidedTraceMarkdown(lines, input.traceSummary);

  lines.push(
    "",
    "## Transaction Labels",
    "",
    "| Iteration | Label | Status | Expected error | Compute units | Error |",
    "|---|---|---|---|---|---|"
  );
  const txRows = guidedSimTxOutcomes(input.artifact);
  for (const row of txRows) {
    lines.push(
      `| ${row.iteration} | ${tableCell(row.label)} | ${row.ok ? "ok" : "error"} | ${row.expected_error ? "yes" : "no"} | ${row.compute_units_consumed} | ${tableCell(row.error ?? "")} |`
    );
  }
  if (txRows.length === 0) {
    lines.push("| - | (no transactions recorded) | - | - | - | - |");
  }

  lines.push(
    "",
    "## Failure",
    "",
    `- Failure reason: ${failure ? tableCell(failure) : "none"}`,
    `- First failing flow step: ${formatFirstFailingFlowStep(input.traceSummary.first_failing_flow_step)}`,
    `- First failure stage: ${formatFirstFailure(input.traceSummary.first_failure)}`,
    `- Rerun command: \`${input.rerunCommand}\``,
    "",
    "## Validation",
    ""
  );
  for (const result of input.validationResults) {
    lines.push(`- ${result.status}: ${result.message}`);
  }
  lines.push(
    "",
    "## Boundary",
    "",
    "This review validates a guided-sim artifact and rerun recipe. It does not claim adapter campaign coverage, complete guided-run coverage, audit signoff, or protocol safety beyond the declared manifest, Rust flows, services, seeds, and artifacts.",
    ""
  );
  return lines.join("\n");
}

function summarizeGuidedSimTrace(
  artifactPath: string,
  artifact: JsonRecord,
  validationResults: ValidationResult[]
): GuidedTraceSummary {
  const iterations = guidedSimIterations(artifact);
  const traceSchemaPresent = hasOwn(artifact, "trace_schema_version");
  const traceFieldsPresent = iterations.some((iteration) =>
    hasOwn(iteration, "flow_trace") ||
    hasOwn(iteration, "first_failing_flow_step") ||
    hasOwn(iteration, "first_failure")
  );

  if (!traceSchemaPresent && !traceFieldsPresent) {
    validationResults.push({
      step: "guided-sim-trace",
      status: "pass",
      message: "trace metadata absent; reviewing legacy guided-sim artifact",
      path: artifactPath,
    });
    return {
      available: false,
      schema_version: null,
      iterations: [],
      first_failing_flow_step: null,
      first_failure: null,
    };
  }

  if (!traceSchemaPresent) {
    throw guidedTraceValidationError(
      artifactPath,
      "trace_schema_version",
      "expected trace_schema_version: 1 when flow_trace fields are present"
    );
  }

  if (integerValue(artifact.trace_schema_version) !== 1) {
    throw guidedTraceValidationError(
      artifactPath,
      "trace_schema_version",
      "expected number 1"
    );
  }

  const summaries: GuidedTraceIterationSummary[] = [];
  let firstFailingFlowStep: GuidedTraceStepSummary | null = null;
  let firstFailure: GuidedFirstFailureSummary | null = null;
  for (const [iterationIndex, iteration] of iterations.entries()) {
    const iterationId = numberValue(iteration.iteration) ?? iterationIndex;
    const outcomes = Array.isArray(iteration.tx_outcomes) ? iteration.tx_outcomes : [];
    if (!Array.isArray(iteration.flow_trace)) {
      throw guidedTraceValidationError(
        artifactPath,
        `iterations[${iterationIndex}].flow_trace`,
        "expected an array of flow trace steps"
      );
    }
    const steps = iteration.flow_trace.map((step, stepIndex) =>
      parseGuidedTraceStep(
        artifactPath,
        step,
        `iterations[${iterationIndex}].flow_trace[${stepIndex}]`,
        iterationId,
        outcomes.length
      )
    );
    const parsedFirstStep = parseNullableGuidedTraceStep(
      artifactPath,
      iteration.first_failing_flow_step,
      `iterations[${iterationIndex}].first_failing_flow_step`,
      iterationId,
      outcomes.length
    );
    if (parsedFirstStep?.status === "passed") {
      throw guidedTraceValidationError(
        artifactPath,
        `iterations[${iterationIndex}].first_failing_flow_step.status`,
        "expected returned_error or panic"
      );
    }
    const parsedFirstFailure = parseNullableGuidedFirstFailure(
      artifactPath,
      iteration.first_failure,
      `iterations[${iterationIndex}].first_failure`,
      iterationId,
      outcomes.length
    );
    if (firstFailingFlowStep === null && parsedFirstStep !== null) {
      firstFailingFlowStep = parsedFirstStep;
    }
    if (firstFailure === null && parsedFirstFailure !== null) {
      firstFailure = parsedFirstFailure;
    }
    summaries.push(summarizeGuidedTraceIteration(iteration, iterationId, steps, parsedFirstStep, parsedFirstFailure));
  }

  validationResults.push({
    step: "guided-sim-trace",
    status: "pass",
    message: `trace_schema_version 1 with ${summaries.reduce((sum, iteration) => sum + iteration.steps, 0)} flow step${summaries.reduce((sum, iteration) => sum + iteration.steps, 0) === 1 ? "" : "s"}`,
    path: artifactPath,
  });

  return {
    available: true,
    schema_version: 1,
    iterations: summaries,
    first_failing_flow_step: firstFailingFlowStep,
    first_failure: firstFailure,
  };
}

function summarizeGuidedTraceIteration(
  iteration: JsonRecord,
  iterationId: number | string,
  steps: GuidedTraceStepSummary[],
  firstFailingFlowStep: GuidedTraceStepSummary | null,
  firstFailure: GuidedFirstFailureSummary | null
): GuidedTraceIterationSummary {
  const txStarts = steps.map((step) => step.tx_log_start);
  const txEnds = steps.map((step) => step.tx_log_end);
  return {
    iteration: iterationId,
    status: stringValue(iteration.status) ?? "unknown",
    steps: steps.length,
    passed_steps: steps.filter((step) => step.status === "passed").length,
    returned_error_steps: steps.filter((step) => step.status === "returned_error").length,
    panic_steps: steps.filter((step) => step.status === "panic").length,
    flow_sequence_preview: steps.slice(0, GUIDED_TRACE_PREVIEW_LIMIT).map((step) => step.flow_name),
    flow_sequence_truncated: steps.length > GUIDED_TRACE_PREVIEW_LIMIT,
    tx_log_start: txStarts.length > 0 ? Math.min(...txStarts) : null,
    tx_log_end: txEnds.length > 0 ? Math.max(...txEnds) : null,
    expected_errors: steps.reduce((sum, step) => sum + step.expected_errors, 0),
    unexpected_errors: steps.reduce((sum, step) => sum + step.unexpected_errors, 0),
    first_failing_flow_step: firstFailingFlowStep,
    first_failure: firstFailure,
  };
}

function parseNullableGuidedTraceStep(
  artifactPath: string,
  value: unknown,
  fieldPath: string,
  iteration: number | string,
  txOutcomeCount: number
): GuidedTraceStepSummary | null {
  if (value === null) return null;
  if (value === undefined) {
    throw guidedTraceValidationError(artifactPath, fieldPath, "expected null or a trace step object");
  }
  return parseGuidedTraceStep(artifactPath, value, fieldPath, iteration, txOutcomeCount);
}

function parseGuidedTraceStep(
  artifactPath: string,
  value: unknown,
  fieldPath: string,
  iteration: number | string,
  txOutcomeCount: number
): GuidedTraceStepSummary {
  const record = objectValue(value);
  if (!record) {
    throw guidedTraceValidationError(artifactPath, fieldPath, "expected a trace step object");
  }
  const status = expectEnumField(
    artifactPath,
    record,
    "status",
    `${fieldPath}.status`,
    GUIDED_TRACE_STEP_STATUSES
  ) as GuidedTraceStepSummary["status"];
  const failureMessage = expectNullableStringField(
    artifactPath,
    record,
    "failure_message",
    `${fieldPath}.failure_message`
  );
  if (status === "passed" && failureMessage !== null) {
    throw guidedTraceValidationError(
      artifactPath,
      `${fieldPath}.failure_message`,
      "expected null for passed trace steps"
    );
  }
  if (status !== "passed" && !failureMessage) {
    throw guidedTraceValidationError(
      artifactPath,
      `${fieldPath}.failure_message`,
      "expected a non-empty failure message for returned_error or panic steps"
    );
  }

  const txLogStart = expectIntegerField(artifactPath, record, "tx_log_start", `${fieldPath}.tx_log_start`);
  const txLogEnd = expectIntegerField(artifactPath, record, "tx_log_end", `${fieldPath}.tx_log_end`);
  if (txLogEnd < txLogStart) {
    throw guidedTraceValidationError(
      artifactPath,
      `${fieldPath}.tx_log_end`,
      "expected tx_log_end to be greater than or equal to tx_log_start"
    );
  }
  if (txLogEnd > txOutcomeCount) {
    throw guidedTraceValidationError(
      artifactPath,
      `${fieldPath}.tx_log_end`,
      `expected tx_log_end <= tx_outcomes.length (${txOutcomeCount})`
    );
  }

  const serviceTicksBefore = expectIntegerField(
    artifactPath,
    record,
    "service_ticks_before",
    `${fieldPath}.service_ticks_before`
  );
  const serviceTicksAfter = expectIntegerField(
    artifactPath,
    record,
    "service_ticks_after",
    `${fieldPath}.service_ticks_after`
  );
  if (serviceTicksAfter < serviceTicksBefore) {
    throw guidedTraceValidationError(
      artifactPath,
      `${fieldPath}.service_ticks_after`,
      "expected service_ticks_after to be greater than or equal to service_ticks_before"
    );
  }

  return {
    iteration,
    step_index: expectIntegerField(artifactPath, record, "step_index", `${fieldPath}.step_index`),
    flow_index: expectIntegerField(artifactPath, record, "flow_index", `${fieldPath}.flow_index`),
    flow_name: expectStringField(artifactPath, record, "flow_name", `${fieldPath}.flow_name`),
    tx_log_start: txLogStart,
    tx_log_end: txLogEnd,
    service_ticks_before: serviceTicksBefore,
    service_ticks_after: serviceTicksAfter,
    status,
    expected_errors: expectIntegerField(artifactPath, record, "expected_errors", `${fieldPath}.expected_errors`),
    unexpected_errors: expectIntegerField(artifactPath, record, "unexpected_errors", `${fieldPath}.unexpected_errors`),
    failure_message: failureMessage,
  };
}

function parseNullableGuidedFirstFailure(
  artifactPath: string,
  value: unknown,
  fieldPath: string,
  iteration: number | string,
  txOutcomeCount: number
): GuidedFirstFailureSummary | null {
  if (value === null) return null;
  if (value === undefined) {
    throw guidedTraceValidationError(artifactPath, fieldPath, "expected null or a first-failure object");
  }
  const record = objectValue(value);
  if (!record) {
    throw guidedTraceValidationError(artifactPath, fieldPath, "expected a first-failure object");
  }
  const txLogStart = expectIntegerField(artifactPath, record, "tx_log_start", `${fieldPath}.tx_log_start`);
  const txLogEnd = expectIntegerField(artifactPath, record, "tx_log_end", `${fieldPath}.tx_log_end`);
  if (txLogEnd < txLogStart) {
    throw guidedTraceValidationError(
      artifactPath,
      `${fieldPath}.tx_log_end`,
      "expected tx_log_end to be greater than or equal to tx_log_start"
    );
  }
  if (txLogEnd > txOutcomeCount) {
    throw guidedTraceValidationError(
      artifactPath,
      `${fieldPath}.tx_log_end`,
      `expected tx_log_end <= tx_outcomes.length (${txOutcomeCount})`
    );
  }
  const serviceTicksBefore = expectIntegerField(
    artifactPath,
    record,
    "service_ticks_before",
    `${fieldPath}.service_ticks_before`
  );
  const serviceTicksAfter = expectIntegerField(
    artifactPath,
    record,
    "service_ticks_after",
    `${fieldPath}.service_ticks_after`
  );
  if (serviceTicksAfter < serviceTicksBefore) {
    throw guidedTraceValidationError(
      artifactPath,
      `${fieldPath}.service_ticks_after`,
      "expected service_ticks_after to be greater than or equal to service_ticks_before"
    );
  }
  return {
    iteration,
    stage: expectStringField(artifactPath, record, "stage", `${fieldPath}.stage`),
    status: expectEnumField(
      artifactPath,
      record,
      "status",
      `${fieldPath}.status`,
      GUIDED_FAILURE_STATUSES
    ) as GuidedFirstFailureSummary["status"],
    step_index: nullableIntegerField(artifactPath, record, "step_index", `${fieldPath}.step_index`),
    flow_index: nullableIntegerField(artifactPath, record, "flow_index", `${fieldPath}.flow_index`),
    flow_name: nullableStringField(artifactPath, record, "flow_name", `${fieldPath}.flow_name`),
    tx_log_start: txLogStart,
    tx_log_end: txLogEnd,
    service_ticks_before: serviceTicksBefore,
    service_ticks_after: serviceTicksAfter,
    failure_message: expectStringField(artifactPath, record, "failure_message", `${fieldPath}.failure_message`),
  };
}

function appendGuidedTraceMarkdown(lines: string[], summary: GuidedTraceSummary): void {
  if (!summary.available) {
    lines.push("- Trace metadata: not present; using legacy flow counts and transaction labels.");
    return;
  }
  lines.push(
    `- Trace schema: ${summary.schema_version}`,
    "",
    "| Iteration | Steps | Status | Flow preview | Tx range | Expected errors | Unexpected errors |",
    "|---|---:|---|---|---|---:|---:|"
  );
  for (const iteration of summary.iterations) {
    lines.push(
      `| ${iteration.iteration} | ${iteration.steps} | ${traceStatusDisplay(iteration)} | ${tableCell(traceFlowPreview(iteration))} | ${traceTxRange(iteration)} | ${iteration.expected_errors} | ${iteration.unexpected_errors} |`
    );
  }
  if (summary.iterations.length === 0) {
    lines.push("| - | 0 | (none) | (none) | - | 0 | 0 |");
  }
}

function traceStatusDisplay(iteration: GuidedTraceIterationSummary): string {
  const parts = [];
  if (iteration.passed_steps > 0) parts.push(`${iteration.passed_steps} passed`);
  if (iteration.returned_error_steps > 0) parts.push(`${iteration.returned_error_steps} returned_error`);
  if (iteration.panic_steps > 0) parts.push(`${iteration.panic_steps} panic`);
  return parts.length > 0 ? parts.join(", ") : iteration.status;
}

function traceFlowPreview(iteration: GuidedTraceIterationSummary): string {
  if (iteration.flow_sequence_preview.length === 0) return "(none)";
  const suffix = iteration.flow_sequence_truncated ? " -> ..." : "";
  return `${iteration.flow_sequence_preview.join(" -> ")}${suffix}`;
}

function traceTxRange(iteration: GuidedTraceIterationSummary): string {
  if (iteration.tx_log_start === null || iteration.tx_log_end === null) return "-";
  return `${iteration.tx_log_start}..${iteration.tx_log_end}`;
}

function formatFirstFailingFlowStep(step: GuidedTraceStepSummary | null): string {
  if (!step) return "none";
  const failure = step.failure_message ? `; ${tableCell(step.failure_message)}` : "";
  return `iteration ${step.iteration}, step ${step.step_index}, flow ${step.flow_name} (#${step.flow_index}), status ${step.status}, tx ${step.tx_log_start}..${step.tx_log_end}, service ticks ${step.service_ticks_before}->${step.service_ticks_after}${failure}`;
}

function formatFirstFailure(failure: GuidedFirstFailureSummary | null): string {
  if (!failure) return "none";
  const flow = failure.flow_name === null ? "" : `, flow ${failure.flow_name} (#${failure.flow_index ?? ""})`;
  const step = failure.step_index === null ? "" : `, step ${failure.step_index}`;
  return `iteration ${failure.iteration}, stage ${failure.stage}, status ${failure.status}${step}${flow}, tx ${failure.tx_log_start}..${failure.tx_log_end}, service ticks ${failure.service_ticks_before}->${failure.service_ticks_after}; ${tableCell(failure.failure_message)}`;
}

function aggregateGuidedSimFlows(artifact: JsonRecord): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const iteration of guidedSimIterations(artifact)) {
    const counts = objectValue(iteration.flow_counts);
    if (!counts) continue;
    for (const [name, raw] of Object.entries(counts)) {
      const count = numberValue(raw);
      if (count === null) continue;
      totals[name] = (totals[name] ?? 0) + count;
    }
  }
  return Object.fromEntries(Object.entries(totals).sort(([a], [b]) => a.localeCompare(b)));
}

function guidedSimTxOutcomes(artifact: JsonRecord): Array<{
  iteration: number | string;
  label: string;
  ok: boolean;
  expected_error: boolean;
  compute_units_consumed: number;
  error: string | null;
}> {
  const rows = [];
  for (const iteration of guidedSimIterations(artifact)) {
    const iterationId = numberValue(iteration.iteration) ?? "";
    const outcomes = Array.isArray(iteration.tx_outcomes) ? iteration.tx_outcomes : [];
    for (const outcome of outcomes) {
      const record = objectValue(outcome);
      if (!record) continue;
      rows.push({
        iteration: iterationId,
        label: stringValue(record.label) ?? "(unlabelled)",
        ok: record.ok === true,
        expected_error: record.expected_error === true,
        compute_units_consumed: numberValue(record.compute_units_consumed) ?? 0,
        error: stringValue(record.error)
      });
    }
  }
  return rows;
}

function firstGuidedSimFailure(artifact: JsonRecord): string | null {
  for (const iteration of guidedSimIterations(artifact)) {
    const error = stringValue(iteration.error);
    if (error) return error;
  }
  return null;
}

function guidedSimIterations(artifact: JsonRecord): JsonRecord[] {
  return Array.isArray(artifact.iterations)
    ? artifact.iterations.filter((iteration): iteration is JsonRecord => objectValue(iteration) !== null)
    : [];
}

async function readGuidedSimRerunCommand(rerunPath: string): Promise<string | null> {
  if (!existsSync(rerunPath)) return null;
  const lines = (await readFile(rerunPath, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#") && line !== "set -eu");
  const command = lines.find((line) => line.includes("riptide sim run"));
  return command ? command.replace(/^exec\s+/, "") : null;
}

function inferGuidedSimRerunCommand(artifactRoot: string, artifact: JsonRecord): string {
  const parts = ["riptide", "sim", "run", "<sim-dir>"];
  const iterations = numberValue(artifact.iterations_requested);
  if (iterations !== null) parts.push("--iterations", String(iterations));
  const flows = numberValue(artifact.flows_per_iteration);
  if (flows !== null) parts.push("--flows", String(flows));
  const seed = stringValue(artifact.base_seed);
  if (seed) parts.push("--seed", seed);
  parts.push("--out", shellQuotePath(artifactRoot));
  return parts.join(" ");
}

async function runCampaignReview(
  campaignRoot: string,
  options: ReviewOptions,
  deps: ReviewCommandDeps
): Promise<number> {
  const stdout = deps.stdoutWrite ?? ((chunk: string) => process.stdout.write(chunk));
  const summary = await readRequiredJsonObject(
    path.join(campaignRoot, "campaign-summary.json"),
    "campaign-summary.json"
  );
  const manifest = await readRequiredJsonObject(
    path.join(campaignRoot, "retention-manifest.json"),
    "retention-manifest.json"
  );
  const entries = retentionEntries(manifest);
  const selected = entries.filter((entry) => entry.status === "selected");
  if (selected.length === 0) {
    throw new ReviewValidationError(
      `campaign has no retained cases\n  path: ${campaignRoot}\n  next: rerun the campaign with at least one retention label that selects evidence`
    );
  }

  const validationResults: ValidationResult[] = [
    {
      step: "campaign-summary",
      status: "pass",
      message: "campaign-summary.json exists and parses",
      path: path.join(campaignRoot, "campaign-summary.json"),
    },
    {
      step: "retention-manifest",
      status: "pass",
      message: "retention-manifest.json exists and parses",
      path: path.join(campaignRoot, "retention-manifest.json"),
    }
  ];

  for (const entry of selected) {
    await validateRetainedCase(campaignRoot, entry, validationResults);
  }

  const markdown = renderCampaignReviewMarkdown({
    campaignRoot,
    summary,
    manifest,
    selected,
    validationResults
  });

  if (options.json) {
    stdout(
      JSON.stringify(
        {
          schema_version: "campaign-review.v1",
          campaign_root: campaignRoot,
          campaign: objectValue(summary.campaign) ?? {},
          totals: objectValue(summary.totals) ?? {},
          retained_cases: selected,
          validation: validationResults,
          warnings: Array.isArray(manifest.warnings) ? manifest.warnings : []
        },
        null,
        2
      ) + "\n"
    );
  } else if (typeof options.out === "string" && options.out.length > 0) {
    const outPath = path.resolve(deps.cwd ?? process.cwd(), options.out);
    await writeFile(outPath, markdown, "utf8");
    stdout(`wrote review markdown: ${outPath}\n`);
  } else {
    stdout(colorizeReviewMarkdown(markdown, deps));
  }

  return 0;
}

async function runRetainedCaseReview(
  caseRoot: string,
  options: ReviewOptions,
  deps: ReviewCommandDeps
): Promise<number> {
  const stdout = deps.stdoutWrite ?? ((chunk: string) => process.stdout.write(chunk));
  const casePath = path.join(caseRoot, "case.json");
  const caseRecord = await readRequiredJsonObject(casePath, "case.json");
  const validationResults: ValidationResult[] = [
    {
      step: "retained-case",
      status: "pass",
      message: "case.json exists and parses",
      path: casePath,
    }
  ];
  validateCaseDigest(casePath, caseRecord, validationResults);
  await validateRerunScript(path.join(caseRoot, "rerun.sh"), validationResults);

  const markdown = renderRetainedCaseReviewMarkdown(caseRoot, caseRecord, validationResults);
  if (options.json) {
    stdout(
      JSON.stringify(
        {
          schema_version: "campaign-retained-case-review.v1",
          case_root: caseRoot,
          case: caseRecord,
          validation: validationResults
        },
        null,
        2
      ) + "\n"
    );
  } else if (typeof options.out === "string" && options.out.length > 0) {
    const outPath = path.resolve(deps.cwd ?? process.cwd(), options.out);
    await writeFile(outPath, markdown, "utf8");
    stdout(`wrote review markdown: ${outPath}\n`);
  } else {
    stdout(colorizeReviewMarkdown(markdown, deps));
  }
  return 0;
}

function isCampaignRoot(candidate: string): boolean {
  return (
    existsSync(path.join(candidate, "campaign-summary.json")) &&
    existsSync(path.join(candidate, "retention-manifest.json"))
  );
}

function isRetainedCaseRoot(candidate: string): boolean {
  return existsSync(path.join(candidate, "case.json")) && existsSync(path.join(candidate, "rerun.sh"));
}

async function validateRetainedCase(
  campaignRoot: string,
  entry: JsonRecord,
  validationResults: ValidationResult[]
): Promise<void> {
  const paths = objectValue(entry.paths);
  const label = stringValue(entry.label) ?? "unknown";
  const runId = stringValue(entry.run_id) ?? "unknown";
  const caseManifestPath = resolveEvidencePath(campaignRoot, stringValue(paths?.case_manifest));
  if (!caseManifestPath) {
    throw new ReviewValidationError(
      `retained case manifest path missing\n  label: ${label}\n  run: ${runId}\n  next: regenerate campaign retained evidence`
    );
  }
  const caseRecord = await readRequiredJsonObject(caseManifestPath, "retained case manifest");
  validateCaseDigest(caseManifestPath, caseRecord, validationResults);
  validationResults.push({
    step: "retained-case",
    status: "pass",
    message: `${label} maps to ${runId}`,
    path: caseManifestPath,
  });

  const rerunPath = resolveEvidencePath(campaignRoot, stringValue(paths?.rerun_sh));
  if (!rerunPath) {
    throw new ReviewValidationError(
      `retained rerun script path missing\n  label: ${label}\n  run: ${runId}\n  next: regenerate campaign retained evidence`
    );
  }
  await validateRerunScript(rerunPath, validationResults);
}

function validateCaseDigest(
  casePath: string,
  caseRecord: JsonRecord,
  validationResults: ValidationResult[]
): void {
  const digest = stringValue(caseRecord.case_digest);
  if (!digest) {
    throw new ReviewValidationError(
      `retained case digest missing\n  path: ${casePath}\n  next: regenerate the retained case manifest`
    );
  }
  const observed = sha256Hex(
    `riptide-campaign-retained-case-v1\n${canonicalJson(
      canonicalRetainedCaseDigestPayload(caseRecord as Record<string, JsonValue>)
    )}`
  );
  if (observed !== digest) {
    throw new ReviewValidationError(
      `retained case digest mismatch\n  path: ${casePath}\n  expected: ${digest}\n  observed: ${observed}\n  next: regenerate the retained case manifest from campaign artifacts`
    );
  }
  validationResults.push({
    step: "case-digest",
    status: "pass",
    message: `retained case digest verified: ${observed}`,
    path: casePath,
  });
}

function renderCampaignReviewMarkdown(input: {
  campaignRoot: string;
  summary: JsonRecord;
  manifest: JsonRecord;
  selected: JsonRecord[];
  validationResults: ValidationResult[];
}): string {
  const campaign = objectValue(input.summary.campaign) ?? {};
  const totals = objectValue(input.summary.totals) ?? {};
  const parameterRows = campaignParameterRows(input.summary);
  const warnings = Array.isArray(input.manifest.warnings)
    ? input.manifest.warnings.filter((entry): entry is string => typeof entry === "string")
    : [];
  const lines: string[] = [
    `# Campaign Review: ${stringValue(campaign.name) ?? path.basename(input.campaignRoot)}`,
    "",
    "## Executive Summary",
    "",
    campaignExecutiveSummary(input),
    "",
    `- **Outcome:** ${campaignOutcomeLabel(totals)}`,
    `- **Campaign ID:** \`${stringValue(campaign.campaign_id) ?? ""}\``,
    `- **Risk objective:** ${stringValue(campaign.risk_objective) ?? "unknown"}`,
    `- **Run budget:** ${numberDisplay(campaign.run_budget)} planned, ${numberDisplay(totals.completed_runs)} completed`,
    "- **Boundary:** Simulation evidence from retained campaign artifacts, not audit signoff or complete protocol safety.",
    "",
    "## Outcome",
    "",
    "| Check | Result | Evidence |",
    "|---|---|---|",
    `| Completed runs | ${numberValue(totals.completed_runs) === numberValue(totals.requested_runs) ? "pass" : "warn"} | ${numberDisplay(totals.completed_runs)} / ${numberDisplay(totals.requested_runs)} requested |`,
    `| Invariant failures | ${numberValue(totals.invariant_failed_runs) && numberValue(totals.invariant_failed_runs)! > 0 ? "fail" : "pass"} | ${numberDisplay(totals.invariant_failed_runs)} runs |`,
    `| Setup errors | ${numberValue(totals.setup_errors) && numberValue(totals.setup_errors)! > 0 ? "fail" : "pass"} | ${numberDisplay(totals.setup_errors)} setup errors |`,
    `| Retained cases | ${input.selected.length > 0 ? "pass" : "warn"} | ${input.selected.length} selected for review |`,
    "",
    "## Risk Map",
    "",
    "| Signal | Observed | Reviewer meaning |",
    "|---|---|---|"
  ];

  for (const row of campaignRiskRows(input.summary, totals, input.selected)) {
    lines.push(`| ${row.signal} | ${row.observed} | ${row.meaning} |`);
  }

  lines.push(
    "",
    "## Invariant Explanation",
    "",
    campaignInvariantExplanation(input.summary, input.selected),
    "",
    "## Scenario Parameters",
    "",
    "| Parameter | Distribution | Samples | Observed range |",
    "|---|---|---:|---|"
  );
  if (parameterRows.length === 0) {
    lines.push("| (none recorded) | - | 0 | - |");
  } else {
    for (const row of parameterRows) {
      lines.push(`| ${row.name} | ${tableCell(row.distribution)} | ${row.samples} | ${tableCell(row.range)} |`);
    }
  }

  lines.push(
    "",
    "## Relevant Events",
    "",
    "Retained cases are the campaign events to inspect first. Each row links the sampled parameters, risk result, source artifact, and exact rerun recipe.",
    "",
    "| Label | Run | Parameters | Risk result | Source artifact | Rerun |",
    "|---|---|---|---|---|---|"
  );
  for (const entry of input.selected) {
    lines.push(
      `| ${stringValue(entry.label) ?? ""} | \`${stringValue(entry.run_id) ?? ""}\` | ${tableCell(sampledParametersDisplay(objectValue(entry.sampled_parameters)))} | ${tableCell(retainedRiskDisplay(entry))} | \`${sourceArtifactForRetainedCase(entry)}\` | \`${stringValue(entry.rerun_command) ?? ""}\` |`
    );
  }

  lines.push(
    "",
    "## Rerun Command",
    "",
    "Review the campaign root:",
    "",
    "```sh",
    `riptide review ${shellQuotePath(relativizeIfInside(process.cwd(), input.campaignRoot))}`,
    "```",
    "",
    "Rerun commands for retained cases are listed in Relevant Events. The review command validated their `rerun.sh` files with `sh -n`; it did not execute them.",
    "",
    "## Technical Appendix",
    "",
    "### Reproducibility",
    "",
    `- Campaign digest: \`${stringValue(campaign.campaign_digest) ?? ""}\``,
    `- Campaign root: \`${input.campaignRoot}\``,
    `- Summary: \`${path.join(input.campaignRoot, "campaign-summary.json")}\``,
    `- Retention manifest: \`${path.join(input.campaignRoot, "retention-manifest.json")}\``,
    "",
    "### Validation",
    ""
  );
  for (const result of input.validationResults) {
    lines.push(`- ${result.status}: ${result.message}`);
  }
  if (warnings.length > 0) {
    lines.push("", "### Warnings", "");
    for (const warning of warnings) {
      lines.push(`- ${warning}`);
    }
  }
  lines.push("", "### Evidence Boundaries", "");
  lines.push("- This review validates campaign-retained evidence and rerun recipes.");
  lines.push("- It does not claim complete protocol safety beyond the campaign inputs, run budget, and retained artifacts.");
  lines.push("");
  return lines.join("\n");
}

function renderRetainedCaseReviewMarkdown(
  caseRoot: string,
  caseRecord: JsonRecord,
  validationResults: ValidationResult[]
): string {
  const label = stringValue(caseRecord.label) ?? path.basename(caseRoot);
  const runId = stringValue(caseRecord.run_id) ?? "unknown";
  const campaignId = stringValue(caseRecord.campaign_id) ?? "unknown";
  const riskResult = retainedRiskDisplay(caseRecord);
  const rerunCommand = stringValue(caseRecord.rerun_command) ?? `sh ${shellQuotePath(path.join(caseRoot, "rerun.sh"))}`;
  const sampledParameters = objectValue(caseRecord.sampled_parameters);
  const riskSignals = objectValue(caseRecord.risk_signals) ?? {};
  const invariantNames = Array.isArray(riskSignals.invariant_names)
    ? riskSignals.invariant_names.filter((value): value is string => typeof value === "string")
    : [];
  const semanticSignals = Array.isArray(riskSignals.semantic_signal_names)
    ? riskSignals.semantic_signal_names.filter((value): value is string => typeof value === "string")
    : [];
  const paths = objectValue(caseRecord.paths);
  const sourceArtifact = sourceArtifactForRetainedCase(caseRecord);
  const lines: string[] = [
    `# Retained Campaign Case: ${stringValue(caseRecord.label) ?? path.basename(caseRoot)}`,
    "",
    "## Executive Summary",
    "",
    `${label} retains run \`${runId}\` from campaign \`${campaignId}\` for focused review. The retained risk result is ${riskResult}; use the rerun recipe and source artifact below before treating this case as explanatory evidence.`,
    "",
    `- **Outcome:** ${riskResult}`,
    `- **Campaign ID:** \`${campaignId}\``,
    `- **Run ID:** \`${runId}\``,
    `- **Boundary:** Simulation evidence from one retained campaign case, not audit signoff or complete protocol safety.`,
    "",
    "## Outcome",
    "",
    "| Check | Result | Evidence |",
    "|---|---|---|",
    `| Retained case digest | pass | \`${stringValue(caseRecord.case_digest) ?? ""}\` |`,
    `| Rerun recipe | pass | \`rerun.sh\` parses with \`sh -n\`; review did not execute it. |`,
    `| Risk signals | ${invariantNames.length > 0 ? "fail" : semanticSignals.length > 0 ? "warn" : "pass"} | ${tableCell(riskResult)} |`,
    "",
    "## Risk Map",
    "",
    "| Signal | Observed | Reviewer meaning |",
    "|---|---|---|",
    `| Retention reason | ${tableCell(stringValue(caseRecord.reason) ?? "not recorded")} | Why this case was selected from the campaign frontier. |`,
    `| Invariant names | ${invariantNames.length > 0 ? invariantNames.map((name) => `\`${name}\``).join(", ") : "none recorded"} | Error-severity invariant failures attached to the retained case. |`,
    `| Semantic warning signals | ${semanticSignals.length > 0 ? semanticSignals.map((name) => `\`${name}\``).join(", ") : "none recorded"} | Non-fatal risk signals that still explain reviewer attention. |`,
    `| Source artifact | \`${sourceArtifact}\` | Raw simulation evidence to inspect before changing assumptions. |`,
    "",
    "## Invariant Explanation",
    "",
    retainedCaseInvariantExplanation(invariantNames, semanticSignals),
    "",
    "## Scenario Parameters",
    "",
    "| Parameter | Value |",
    "|---|---|"
  ];
  const parameterEntries = sampledParameters ? Object.entries(sampledParameters).sort(([a], [b]) => a.localeCompare(b)) : [];
  if (parameterEntries.length === 0) {
    lines.push("| (none recorded) | - |");
  } else {
    for (const [name, value] of parameterEntries) {
      lines.push(`| ${tableCell(name)} | ${tableCell(formatJsonValue(value))} |`);
    }
  }
  lines.push(
    "",
    "## Relevant Events",
    "",
    "| Evidence | Path or command |",
    "|---|---|",
    `| Case manifest | \`${path.join(caseRoot, "case.json")}\` |`,
    `| Rerun script | \`${path.join(caseRoot, "rerun.sh")}\` |`,
    `| Simulation result | \`${stringValue(paths?.simulation_result) ?? sourceArtifact}\` |`,
    `| Run config | \`${stringValue(paths?.run_config) ?? "not recorded"}\` |`,
    "",
    "## Rerun Command",
    "",
    "```sh",
    rerunCommand,
    "```",
    "",
    "The review command validated the retained case digest and `rerun.sh` shell syntax; it did not execute the rerun recipe.",
    "",
    "## Technical Appendix",
    "",
    "### Reproducibility",
    "",
    `- Case root: \`${caseRoot}\``,
    `- Campaign digest: \`${stringValue(caseRecord.campaign_digest) ?? ""}\``,
    `- Case digest: \`${stringValue(caseRecord.case_digest) ?? ""}\``,
    `- Review command: \`${stringValue(caseRecord.review_command) ?? `riptide review ${shellQuotePath(caseRoot)}`}\``,
    "",
    "### Validation",
    ""
  );
  for (const result of validationResults) {
    lines.push(`- ${result.status}: ${result.message}`);
  }
  lines.push("", "### Evidence Boundaries", "");
  lines.push("- This review validates one retained campaign case and its rerun recipe.");
  lines.push("- It does not claim complete protocol safety beyond the campaign inputs, run budget, and retained artifact.");
  lines.push("");
  return lines.join("\n");
}

function retainedCaseInvariantExplanation(
  invariantNames: string[],
  semanticSignals: string[]
): string {
  if (invariantNames.length > 0) {
    return `The retained case records fired invariant names: ${invariantNames.map((name) => `\`${name}\``).join(", ")}. Inspect the source simulation result before deciding whether the failure reflects protocol behavior, scenario construction, or harness setup.`;
  }
  if (semanticSignals.length > 0) {
    return `No error-severity invariant name was retained. Semantic warning signals still marked this case for review: ${semanticSignals.map((name) => `\`${name}\``).join(", ")}.`;
  }
  return "No invariant failure or semantic warning signal was recorded on this retained case.";
}

interface CampaignRiskRow {
  signal: string;
  observed: string;
  meaning: string;
}

interface CampaignParameterRow {
  name: string;
  distribution: string;
  samples: string;
  range: string;
}

function campaignExecutiveSummary(input: {
  summary: JsonRecord;
  selected: JsonRecord[];
}): string {
  const campaign = objectValue(input.summary.campaign) ?? {};
  const totals = objectValue(input.summary.totals) ?? {};
  const name = stringValue(campaign.name) ?? "campaign";
  const completed = numberDisplay(totals.completed_runs);
  const requested = numberDisplay(totals.requested_runs);
  const failed = numberValue(totals.invariant_failed_runs) ?? 0;
  const setupErrors = numberValue(totals.setup_errors) ?? 0;
  const retained = input.selected.length;
  if (failed > 0) {
    return `${name} completed ${completed} of ${requested} requested runs and retained ${retained} review case${retained === 1 ? "" : "s"}. ${failed} run${failed === 1 ? "" : "s"} recorded invariant failures; inspect the retained failure rows before changing scenario or protocol assumptions.`;
  }
  if (setupErrors > 0) {
    return `${name} completed ${completed} of ${requested} requested runs but recorded ${setupErrors} setup error${setupErrors === 1 ? "" : "s"}. Treat setup errors as blockers before using this campaign as evidence.`;
  }
  return `${name} completed ${completed} of ${requested} requested runs with no invariant failures or setup errors observed. Retained cases still show the highest-risk frontier inside this bounded campaign, not complete protocol safety.`;
}

function campaignOutcomeLabel(totals: JsonRecord): string {
  const failed = numberValue(totals.invariant_failed_runs) ?? 0;
  const setupErrors = numberValue(totals.setup_errors) ?? 0;
  if (setupErrors > 0) return `${setupErrors} setup error${setupErrors === 1 ? "" : "s"} observed`;
  if (failed > 0) return `${failed} invariant-failed run${failed === 1 ? "" : "s"} observed`;
  return "no invariant failures observed, no setup errors";
}

function campaignRiskRows(
  summary: JsonRecord,
  totals: JsonRecord,
  selected: JsonRecord[]
): CampaignRiskRow[] {
  const rows: CampaignRiskRow[] = [
    {
      signal: "Invariant-failed runs",
      observed: numberDisplay(totals.invariant_failed_runs) || "0",
      meaning: "Runs where a declared invariant fired inside the campaign budget.",
    },
    {
      signal: "Setup errors",
      observed: numberDisplay(totals.setup_errors) || "0",
      meaning: "Runs that failed before producing reviewable simulation evidence.",
    },
  ];
  const lending = objectValue(summary.lending);
  const badDebt = objectValue(lending?.total_bad_debt);
  if (badDebt) {
    rows.push({
      signal: "Bad debt range",
      observed: rangeDisplay(badDebt),
      meaning: "Worst observed uncovered debt across completed campaign runs.",
    });
  }
  const liquidations = objectValue(lending?.total_liquidations);
  if (liquidations) {
    rows.push({
      signal: "Liquidation range",
      observed: rangeDisplay(liquidations),
      meaning: "Liquidation pressure observed across completed campaign runs.",
    });
  }
  const stress = objectValue(lending?.liquidity_stress);
  if (stress) {
    const util = numberValue(stress.max_utilization_observed);
    const tvl = numberValue(stress.min_tvl_observed);
    rows.push({
      signal: "Liquidity stress",
      observed: `max_utilization=${util ?? "n/a"}, min_tvl=${tvl ?? "n/a"}`,
      meaning: "Frontier of liquidity pressure among retained and completed cases.",
    });
  }
  rows.push({
    signal: "Retained evidence",
    observed: `${selected.length} case${selected.length === 1 ? "" : "s"}`,
    meaning: "Selected cases to rerun first when a reviewer wants source evidence.",
  });
  return rows;
}

function campaignInvariantExplanation(summary: JsonRecord, selected: JsonRecord[]): string {
  const totals = objectValue(summary.totals) ?? {};
  const failed = numberValue(totals.invariant_failed_runs) ?? 0;
  const names = selected
    .flatMap((entry) => {
      const signals = objectValue(entry.risk_signals);
      return Array.isArray(signals?.invariant_names)
        ? signals.invariant_names.filter((value): value is string => typeof value === "string")
        : [];
    })
    .filter((value, index, arr) => arr.indexOf(value) === index);
  const warnSignals = selected
    .flatMap((entry) => {
      const signals = objectValue(entry.risk_signals);
      return Array.isArray(signals?.semantic_signal_names)
        ? signals.semantic_signal_names.filter((value): value is string => typeof value === "string")
        : [];
    })
    .filter((value, index, arr) => arr.indexOf(value) === index);
  if (failed > 0) {
    return `Invariant failures were observed in ${failed} completed run${failed === 1 ? "" : "s"}. Fired invariant names: ${names.length > 0 ? names.map((name) => `\`${name}\``).join(", ") : "not retained in the summary"}.`;
  }
  if (warnSignals.length > 0) {
    return `No error-severity invariant failure was retained. Semantic warning signals still marked the campaign frontier: ${warnSignals.map((name) => `\`${name}\``).join(", ")}.`;
  }
  return "No retained case reported an invariant failure or semantic warning signal.";
}

function campaignParameterRows(summary: JsonRecord): CampaignParameterRow[] {
  const parameters = objectValue(summary.parameters);
  if (!parameters) return [];
  return Object.entries(parameters)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, raw]) => {
      const row = objectValue(raw) ?? {};
      return {
        name,
        distribution: stringValue(row.distribution) ?? "(unknown)",
        samples: numberDisplay(row.sampled_count) || "0",
        range: parameterRange(row),
      };
    });
}

function sourceArtifactForRetainedCase(entry: JsonRecord): string {
  const paths = objectValue(entry.paths);
  return stringValue(paths?.report) ??
    stringValue(paths?.simulation_result) ??
    stringValue(paths?.case_manifest) ??
    "(unknown)";
}

function rangeDisplay(row: JsonRecord): string {
  const min = numberValue(row.min);
  const median = numberValue(row.median);
  const max = numberValue(row.max);
  return `min=${min ?? "n/a"}, median=${median ?? "n/a"}, max=${max ?? "n/a"}`;
}

function parameterRange(row: JsonRecord): string {
  const min = numberValue(row.min);
  const median = numberValue(row.median);
  const max = numberValue(row.max);
  const values = Array.isArray(row.values)
    ? row.values.map((value) => String(value)).slice(0, 6)
    : [];
  const unit = stringValue(row.unit);
  if (min !== null || median !== null || max !== null) {
    const suffix = unit ? ` ${unit}` : "";
    return `min=${min ?? "n/a"}${suffix}, median=${median ?? "n/a"}${suffix}, max=${max ?? "n/a"}${suffix}`;
  }
  if (values.length > 0) {
    return values.join(", ");
  }
  return "-";
}

function relativizeIfInside(baseDir: string, value: string): string {
  const rel = path.relative(path.resolve(baseDir), path.resolve(value));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return value;
  return rel;
}

async function readRequiredJsonObject(filePath: string, label: string): Promise<JsonRecord> {
  if (!existsSync(filePath)) {
    throw new ReviewValidationError(
      `${label} not found\n  expected: ${filePath}\n  next: pass a campaign root, retained case directory, or evidence pack directory`
    );
  }
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as JsonRecord;
  } catch (error) {
    throw new ReviewValidationError(
      `malformed ${label}\n  path: ${filePath}\n  parse error: ${errorMessage(error)}`
    );
  }
}

function retentionEntries(manifest: JsonRecord): JsonRecord[] {
  if (!Array.isArray(manifest.entries)) return [];
  return manifest.entries.filter((entry): entry is JsonRecord => objectValue(entry) !== null);
}

function resolveEvidencePath(campaignRoot: string, raw: string | null): string | null {
  if (!raw) return null;
  if (path.isAbsolute(raw)) return raw;
  const campaignRootCandidate = path.resolve(campaignRoot, raw);
  if (existsSync(campaignRootCandidate)) return campaignRootCandidate;
  const cwdCandidate = path.resolve(process.cwd(), raw);
  if (existsSync(cwdCandidate)) return cwdCandidate;
  const stripped = stripCampaignRootPrefix(campaignRoot, raw);
  if (stripped) return stripped;
  return campaignRootCandidate;
}

function retainedRiskDisplay(entry: JsonRecord): string {
  const signals = objectValue(entry.risk_signals) ?? entry;
  const parts: string[] = [];
  const invariantNames = Array.isArray(signals.invariant_names)
    ? signals.invariant_names.filter((value): value is string => typeof value === "string")
    : [];
  if (invariantNames.length > 0) parts.push(`invariants=${invariantNames.join("+")}`);
  const semanticSignalNames = Array.isArray(signals.semantic_signal_names)
    ? signals.semantic_signal_names.filter((value): value is string => typeof value === "string")
    : [];
  if (semanticSignalNames.length > 0) parts.push(`warn_signals=${semanticSignalNames.join("+")}`);
  const badDebt = numberValue(signals.total_bad_debt);
  if (badDebt !== null) parts.push(`bad_debt=${badDebt}`);
  const liquidations = numberValue(signals.total_liquidations);
  if (liquidations !== null) parts.push(`liquidations=${liquidations}`);
  const utilization = numberValue(signals.max_utilization);
  if (utilization !== null) parts.push(`max_utilization=${utilization}`);
  const firstFailure = numberValue(signals.first_failure_tick);
  if (firstFailure !== null) parts.push(`first_failure_tick=${firstFailure}`);
  return parts.length > 0 ? parts.join(", ") : "no numeric risk metric";
}

function stripCampaignRootPrefix(campaignRoot: string, raw: string): string | null {
  const normalized = raw.split(/[\\/]+/).filter((segment) => segment.length > 0);
  const campaignDir = path.basename(campaignRoot);
  const index = normalized.lastIndexOf(campaignDir);
  if (index < 0 || index === normalized.length - 1) return null;
  return path.join(campaignRoot, ...normalized.slice(index + 1));
}

function sampledParametersDisplay(value: JsonRecord | null): string {
  if (!value || Object.keys(value).length === 0) return "(none)";
  return Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, raw]) => `${key}=${String(raw)}`)
    .join(", ");
}

function expectIntegerField(
  artifactPath: string,
  record: JsonRecord,
  key: string,
  fieldPath: string
): number {
  const value = integerValue(record[key]);
  if (value === null) {
    throw guidedTraceValidationError(artifactPath, fieldPath, "expected a non-negative integer");
  }
  return value;
}

function nullableIntegerField(
  artifactPath: string,
  record: JsonRecord,
  key: string,
  fieldPath: string
): number | null {
  if (!hasOwn(record, key) || record[key] === null) return null;
  const value = integerValue(record[key]);
  if (value === null) {
    throw guidedTraceValidationError(artifactPath, fieldPath, "expected null or a non-negative integer");
  }
  return value;
}

function expectStringField(
  artifactPath: string,
  record: JsonRecord,
  key: string,
  fieldPath: string
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw guidedTraceValidationError(artifactPath, fieldPath, "expected a non-empty string");
  }
  return value;
}

function nullableStringField(
  artifactPath: string,
  record: JsonRecord,
  key: string,
  fieldPath: string
): string | null {
  if (!hasOwn(record, key) || record[key] === null) return null;
  const value = record[key];
  if (typeof value !== "string") {
    throw guidedTraceValidationError(artifactPath, fieldPath, "expected null or a string");
  }
  return value;
}

function expectNullableStringField(
  artifactPath: string,
  record: JsonRecord,
  key: string,
  fieldPath: string
): string | null {
  if (!hasOwn(record, key)) {
    throw guidedTraceValidationError(artifactPath, fieldPath, "expected null or a string");
  }
  return nullableStringField(artifactPath, record, key, fieldPath);
}

function expectEnumField(
  artifactPath: string,
  record: JsonRecord,
  key: string,
  fieldPath: string,
  allowed: Set<string>
): string {
  const value = expectStringField(artifactPath, record, key, fieldPath);
  if (!allowed.has(value)) {
    throw guidedTraceValidationError(
      artifactPath,
      fieldPath,
      `expected one of ${Array.from(allowed).join(", ")}`
    );
  }
  return value;
}

function guidedTraceValidationError(
  artifactPath: string,
  fieldPath: string,
  expected: string
): ReviewValidationError {
  return new ReviewValidationError(
    `malformed guided-sim trace metadata\n  path: ${artifactPath}\n  field: ${fieldPath}\n  expected: ${expected}\n  next: regenerate guided-sim-run.json with the current riptide sim run, or remove partial trace fields from a legacy artifact`
  );
}

function hasOwn(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function objectValue(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function integerValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function numberDisplay(value: unknown): string {
  const number = numberValue(value);
  return number === null ? "" : String(number);
}

function formatJsonValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "-";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function tableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function shellQuotePath(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function colorizeReviewMarkdown(markdown: string, deps: ReviewCommandDeps): string {
  const colorize = pickColorizer(
    deps.color ?? shouldUseColor(process.env, Boolean(process.stdout.isTTY))
  );
  return markdown
    .split("\n")
    .map((line) => colorizeReviewLine(line, colorize))
    .join("\n");
}

function colorizeReviewLine(line: string, c: Colorizer): string {
  if (line.startsWith("# ")) return c.bold(c.cyan(line));
  if (line.startsWith("## ")) return c.bold(line);
  if (line.startsWith("|") && !line.startsWith("|---")) {
    return colorizeCodeSpans(line, c);
  }
  if (/^- pass:/.test(line)) {
    return line.replace("- pass:", `- ${c.green("pass")}:`);
  }
  if (/^- warn:/.test(line)) {
    return line.replace("- warn:", `- ${c.yellow("warn")}:`);
  }
  if (/^- fail:/.test(line)) {
    return line.replace("- fail:", `- ${c.red("fail")}:`);
  }
  if (/^- (Invariant-failed runs|Setup errors): 0$/.test(line)) {
    return line.replace(/0$/, c.green("0"));
  }
  if (/^- (Invariant-failed runs|Setup errors): [1-9]/.test(line)) {
    return line.replace(/([1-9]\d*)$/, c.red("$1"));
  }
  if (/^- Completed runs: /.test(line)) {
    return line.replace(/(\d+)$/, c.green("$1"));
  }
  return colorizeCodeSpans(line, c);
}

function colorizeCodeSpans(line: string, c: Colorizer): string {
  return line.replace(/`([^`]+)`/g, (_match, value: string) => c.cyan(`\`${value}\``));
}

async function validateRerunScript(
  rerunPath: string,
  validationResults: ValidationResult[]
): Promise<void> {
  if (!existsSync(rerunPath)) {
    throw new ReviewValidationError(
      `rerun.sh not found\n  expected: ${rerunPath}\n  next: restore the pack rerun recipe before review`
    );
  }
  try {
    await execFileAsync("sh", ["-n", rerunPath]);
  } catch (error) {
    throw new ReviewValidationError(
      `rerun.sh failed POSIX syntax check\n  path: ${rerunPath}\n  reason: ${errorMessage(error)}\n  next: fix shell syntax; review never executes rerun.sh`
    );
  }
  validationResults.push({
    step: "rerun-sh",
    status: "pass",
    message: "rerun.sh is present and sh -n parseable",
    path: rerunPath,
  });
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifestHasProofMetadata(manifest: Record<string, unknown>): boolean {
  if (typeof manifest.proof_level === "number") return true;
  const proofLevel = manifest.proof_level;
  if (proofLevel && typeof proofLevel === "object" && !Array.isArray(proofLevel)) {
    return typeof (proofLevel as Record<string, unknown>).level === "number";
  }
  const proof = manifest.proof;
  if (proof && typeof proof === "object" && !Array.isArray(proof)) {
    return typeof (proof as Record<string, unknown>).level === "number";
  }
  return false;
}

async function readOptionalJson(filePath: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new ReviewValidationError(
      `malformed provenance.json\n  path: ${filePath}\n  parse error: ${errorMessage(error)}\n  next: fix or remove optional provenance.json before review`
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
