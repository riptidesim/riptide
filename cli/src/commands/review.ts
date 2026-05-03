// `riptide review <pack>` — read-only evidence-pack reviewer surface.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { Command } from "commander";

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

export function createReviewCommand(deps: ReviewCommandDeps = {}): Command {
  return new Command("review")
    .description("Validate a Riptide evidence pack or campaign evidence root and emit reviewer markdown")
    .argument("<pack>", "Path to a Riptide evidence pack, campaign root, or retained campaign case")
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
    const reviewRoot = path.resolve(deps.cwd ?? process.cwd(), pack);
    if (isCampaignRoot(reviewRoot)) {
      return await runCampaignReview(reviewRoot, options, deps);
    }
    if (isRetainedCaseRoot(reviewRoot)) {
      return await runRetainedCaseReview(reviewRoot, options, deps);
    }

    const packData = await loadPackManifest(pack);
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
      stdout(markdown);
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
    stdout(markdown);
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
    stdout(markdown);
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
  const { case_digest: _caseDigest, ...withoutDigest } = caseRecord;
  const observed = sha256Hex(
    `riptide-campaign-retained-case-v1\n${canonicalJson(withoutDigest as JsonValue)}`
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
  const lines: string[] = [
    `# Campaign Review: ${stringValue(campaign.name) ?? path.basename(input.campaignRoot)}`,
    "",
    "## Outcome",
    "",
    `- Campaign ID: \`${stringValue(campaign.campaign_id) ?? ""}\``,
    `- Campaign digest: \`${stringValue(campaign.campaign_digest) ?? ""}\``,
    `- Completed runs: ${numberDisplay(totals.completed_runs)}`,
    `- Invariant-failed runs: ${numberDisplay(totals.invariant_failed_runs)}`,
    `- Setup errors: ${numberDisplay(totals.setup_errors)}`,
    "",
    "## Retained Cases",
    "",
    "| Label | Run | Parameters | Risk result | Rerun |",
    "|---|---|---|---|---|"
  ];

  for (const entry of input.selected) {
    lines.push(
      `| ${stringValue(entry.label) ?? ""} | \`${stringValue(entry.run_id) ?? ""}\` | ${sampledParametersDisplay(objectValue(entry.sampled_parameters))} | ${retainedRiskDisplay(entry)} | \`${stringValue(entry.rerun_command) ?? ""}\` |`
    );
  }

  lines.push(
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
    "This review validates campaign-retained evidence and rerun recipes. It does not claim complete protocol safety beyond the campaign inputs, run budget, and retained artifacts.",
    ""
  );
  return lines.join("\n");
}

function renderRetainedCaseReviewMarkdown(
  caseRoot: string,
  caseRecord: JsonRecord,
  validationResults: ValidationResult[]
): string {
  const lines = [
    `# Retained Campaign Case: ${stringValue(caseRecord.label) ?? path.basename(caseRoot)}`,
    "",
    `- Run: \`${stringValue(caseRecord.run_id) ?? ""}\``,
    `- Campaign: \`${stringValue(caseRecord.campaign_id) ?? ""}\``,
    `- Case digest: \`${stringValue(caseRecord.case_digest) ?? ""}\``,
    `- Parameters: ${sampledParametersDisplay(objectValue(caseRecord.sampled_parameters))}`,
    `- Risk result: ${retainedRiskDisplay(caseRecord)}`,
    `- Rerun command: \`${stringValue(caseRecord.rerun_command) ?? ""}\``,
    "",
    "## Validation",
    ""
  ];
  for (const result of validationResults) {
    lines.push(`- ${result.status}: ${result.message}`);
  }
  lines.push("");
  return lines.join("\n");
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

function numberDisplay(value: unknown): string {
  const number = numberValue(value);
  return number === null ? "" : String(number);
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
