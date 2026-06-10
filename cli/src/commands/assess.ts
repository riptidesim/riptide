// `riptide assess <campaign-root>` — ingest existing campaign artifacts and
// generate a protocol assessment (canonical-hashed assessment.json +
// byte-deterministic assessment.md). Ingest-only: it never runs the engine or a
// campaign. Run `riptide campaign run` first, then assess the root it writes.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { Command } from "commander";

import {
  ASSESSMENT_VERDICTS,
  AssessmentIngestError,
  COVERAGE_STATUSES,
  GUIDED_SIM_ADAPTER,
  assessmentShape,
  ingestAssessmentWorkspace,
  requireCartographyModel,
  serializeAssessment,
  withExecutionHonesty,
  workspaceRelative,
  type AssessmentInputs,
  type AssessmentModel,
  type AssessmentVerdict,
  type CartographyAssessmentModel
} from "../assess/model.js";
import {
  failedGates,
  reverifyAtEmit,
  type ExecutionHonestyReport
} from "../sim/honesty-gates.js";
import { generateAssessmentNarrative } from "../assess/narrative.js";
import { renderAssessmentHtml } from "../assess/render-html.js";
import { renderAssessmentMarkdown } from "../assess/render-markdown.js";
import { printBanner } from "../banner.js";
import {
  pickColorizer,
  relativizePath,
  shouldUseColor,
  type Colorizer
} from "../display/index.js";
import { renderCliError } from "../errors/render.js";

const execFileAsync = promisify(execFile);

const ASSESSMENT_JSON_FILE = "assessment.json";
const ASSESSMENT_MD_FILE = "assessment.md";
const ASSESSMENT_HTML_FILE = "assessment.html";
const ASSESSMENT_PDF_FILE = "assessment.pdf";

/** Chromium/Chrome binaries probed for the PDF binder, in order. */
const CHROMIUM_BINARIES = [
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
  "chrome"
];

export interface AssessOptions {
  out?: string;
  input?: string;
  protocolName?: string;
  repository?: string;
  commit?: string;
  riptideVersion?: string;
  assessmentDate?: string;
  verdict?: string;
  html?: boolean;
  pdf?: boolean;
  json?: boolean;
  quiet?: boolean;
}

export interface AssessCommandDeps {
  stdoutWrite?: (chunk: string) => void;
  stderrWrite?: (chunk: string) => void;
  cwd?: string;
  color?: boolean;
}

/** Thrown for CLI-input problems (bad flag, malformed input file). Message-first. */
export class AssessmentInputError extends Error {
  readonly hint: string | undefined;
  constructor(message: string, hint?: string) {
    super(hint ? `${message}\n  next: ${hint}` : message);
    this.name = "AssessmentInputError";
    this.hint = hint;
  }
}

export function createAssessCommand(deps: AssessCommandDeps = {}): Command {
  return new Command("assess")
    .description(
      "Generate a protocol assessment (assessment.json + assessment.md) from an existing campaign root. " +
        "Ingest-only: it reports simulation evidence over the campaign's declared region, not audit signoff or protocol safety."
    )
    .argument("<campaign-root>", "Path to a campaign root written by `riptide campaign run`")
    .option("--out <dir>", "Directory to write assessment artifacts (default: the campaign root)")
    .option("--input <file>", "JSON file of Risk Plan / coverage / verdict inputs to fold over campaign defaults")
    .option("--protocol-name <name>", "Protocol display name (default: the campaign name)")
    .option("--repository <url>", "Protocol repository, recorded in the executive summary")
    .option("--commit <sha>", "Assessed commit SHA, recorded in the executive summary")
    .option("--riptide-version <version>", "Riptide version or commit, recorded in the toolchain section")
    .option("--assessment-date <iso-date>", "Assessment date (ISO); omitted by default so output stays deterministic")
    .option(
      `--verdict <verdict>`,
      `Declared send/readiness verdict (one of: ${ASSESSMENT_VERDICTS.join(", ")}); derived from the campaign when omitted`
    )
    .option("--html", "Also write a design-system-styled assessment.html presentation export (out of the byte-hash gate)", false)
    .option("--pdf", "Also write assessment.pdf rendered from the HTML via a local headless browser (implies --html)", false)
    .option("--json", "Emit a machine-readable result instead of the cold-read summary", false)
    .option("--quiet", "Suppress the interactive banner", false)
    .action(async (campaignRoot: string, options: AssessOptions) => {
      printBanner({ flags: { json: Boolean(options.json), quiet: Boolean(options.quiet) } });
      const exitCode = await runAssess(campaignRoot, options, deps);
      process.exit(exitCode);
    });
}

export async function runAssess(
  campaignRoot: string,
  options: AssessOptions,
  deps: AssessCommandDeps = {}
): Promise<number> {
  const stdout = deps.stdoutWrite ?? ((chunk: string) => process.stdout.write(chunk));
  const stderr = deps.stderrWrite ?? ((chunk: string) => process.stderr.write(chunk));
  const cwd = path.resolve(deps.cwd ?? process.cwd());

  try {
    const root = path.resolve(cwd, campaignRoot);
    const inputs = await resolveInputs(cwd, options);

    // The reviewer-facing root label is repo/workspace-relative (R1): it is the
    // prefix every rendered artifact path inherits, so relativizing it here keeps
    // the whole assessment free of absolute machine paths and byte-stable across
    // checkouts. The on-disk artifacts still write to the absolute `root`.
    const campaignRootLabel = workspaceRelative(root, cwd);

    const model = await ingestAssessmentWorkspace({ campaignRoot: root, campaignRootLabel, inputs });

    // Execution-honesty gate (guided-sim only): re-verify the gate report the
    // producer recorded in campaign-summary.json and BLOCK emit on a failed
    // gate. Gated on the guided-sim adapter so real-campaign assessments — and
    // the frozen cartography bytes — are never affected. Runs before any
    // artifact is written so a blocked report is never emitted.
    const executionHonesty = await resolveExecutionHonesty(root, model);
    if (executionHonesty && executionHonesty.status === "blocked") {
      throw new AssessmentIngestError(
        "execution-honesty gates blocked this guided-sim assessment:\n" +
          failedGates(executionHonesty)
            .map((gate) => `    ✗ ${gate.id}: ${gate.detail}`)
            .join("\n"),
        "Fix the guided sim (declare/pass a positive control, run the full lifecycle, keep the surface deterministic), re-run `riptide sim run` + `riptide sim surface`, then assess again."
      );
    }

    const emittedModel = withExecutionHonesty(model, executionHonesty);
    const narrative = generateAssessmentNarrative(emittedModel);
    const markdown = renderAssessmentMarkdown(emittedModel, narrative);
    const json = serializeAssessment(emittedModel);

    const outDir = options.out ? path.resolve(cwd, options.out) : root;
    const jsonPath = path.join(outDir, ASSESSMENT_JSON_FILE);
    const mdPath = path.join(outDir, ASSESSMENT_MD_FILE);
    if (executionHonesty) {
      await assertAssessmentArtifactsStableAtEmit({ jsonPath, mdPath, json, markdown });
    }
    // assessment.json is the canonical, self-digested model; assessment.md is the
    // byte-deterministic render the digest transitively covers. The markdown
    // already ends in a single trailing newline; the JSON is written verbatim.
    await writeFile(jsonPath, json, "utf8");
    await writeFile(mdPath, markdown, "utf8");

    // Presentation exports (R5): a styled HTML rendering of the hashed markdown,
    // and optionally a PDF from that HTML. Explicitly out of the byte-hash gate.
    const exports = await writePresentationExports(emittedModel, markdown, outDir, options);

    if (options.json) {
      stdout(
        JSON.stringify(
          {
            schema_version: "assess-cli.v1",
            assessment_digest: emittedModel.assessment_digest,
            verdict: { value: emittedModel.verdict.value, source: emittedModel.verdict.source },
            artifacts: {
              assessment_json: jsonPath,
              assessment_md: mdPath,
              ...(exports.htmlPath ? { assessment_html: exports.htmlPath } : {}),
              ...(exports.pdfPath ? { assessment_pdf: exports.pdfPath } : {})
            },
            ...(exports.pdfSkipped ? { pdf_skipped: exports.pdfSkipped } : {}),
            shape: assessmentShape(emittedModel),
            ...(emittedModel.campaign
              ? {
                  campaign: {
                    campaign_id: emittedModel.campaign.campaign_id,
                    campaign_digest: emittedModel.campaign.campaign_digest,
                    surface_sha256: emittedModel.reproduction.hashes.surface_sha256
                  }
                }
              : {}),
            ...(executionHonesty ? { execution_honesty: executionHonesty } : {})
          },
          null,
          2
        ) + "\n"
      );
    } else {
      const summaryArtifacts: SummaryArtifacts = { jsonPath, mdPath, campaignRootPath: root, ...exports };
      stdout(
        assessmentShape(emittedModel) === "correctness"
          ? renderCorrectnessSummary(emittedModel, summaryArtifacts, cwd, deps)
          : renderAssessSummary(
              requireCartographyModel(emittedModel),
              summaryArtifacts,
              cwd,
              deps,
              executionHonesty
            )
      );
    }
    return 0;
  } catch (error) {
    const exitCode = error instanceof AssessmentIngestError || error instanceof AssessmentInputError ? 1 : 2;
    stderr(
      renderCliError(withHint(error), {
        env: process.env,
        color: deps.color,
        isTTY: Boolean(process.stderr.isTTY)
      })
    );
    return exitCode;
  }
}

/**
 * Resolve the execution-honesty gate report for a guided-sim assessment. Reads
 * the report the producer recorded in `campaign-summary.json` and re-verifies
 * the determinism gate against the freshly hashed on-disk `risk-surface.json`
 * (`model.reproduction.hashes.surface_sha256`). Returns `null` for non-guided-sim
 * assessments (the gates do not apply). A guided-sim surface with no recorded
 * report is itself blocked: the gates are mandatory for guided-sim emit.
 */
async function resolveExecutionHonesty(
  root: string,
  model: AssessmentModel
): Promise<ExecutionHonestyReport | null> {
  if (model.campaign?.adapter !== GUIDED_SIM_ADAPTER) return null;

  const recorded = await readRecordedHonesty(root);
  if (!recorded) {
    return {
      schema_version: "execution-honesty.v1",
      status: "blocked",
      gates: [
        {
          id: "positive_control",
          status: "fail",
          detail:
            "no execution-honesty gate report recorded in campaign-summary.json; re-run `riptide sim surface` with the current CLI."
        }
      ],
      surface_sha256: model.reproduction.hashes.surface_sha256 ?? ""
    };
  }
  const actualSurfaceSha256 = model.reproduction.hashes.surface_sha256 ?? "";
  return reverifyAtEmit(recorded, actualSurfaceSha256);
}

/** Read the `execution_honesty` block out of the ingested campaign-summary.json, if present. */
async function readRecordedHonesty(root: string): Promise<ExecutionHonestyReport | null> {
  try {
    const raw = await readFile(path.join(root, "campaign-summary.json"), "utf8");
    const parsed = JSON.parse(raw) as { execution_honesty?: ExecutionHonestyReport };
    return parsed.execution_honesty ?? null;
  } catch {
    return null;
  }
}

async function assertAssessmentArtifactsStableAtEmit(input: {
  jsonPath: string;
  mdPath: string;
  json: string;
  markdown: string;
}): Promise<void> {
  const drifts = (
    await Promise.all([
      artifactDrift(input.jsonPath, ASSESSMENT_JSON_FILE, input.json),
      artifactDrift(input.mdPath, ASSESSMENT_MD_FILE, input.markdown)
    ])
  ).filter((detail): detail is string => detail !== null);

  if (drifts.length === 0) return;
  throw new AssessmentIngestError(
    "execution-honesty gates blocked this guided-sim assessment:\n" +
      drifts.map((detail) => `    ✗ determinism: ${detail}`).join("\n"),
    "The existing assessment artifact(s) do not match the freshly rendered bytes. Re-run `riptide assess` into a clean output directory, or perform a documented additive re-pin."
  );
}

async function artifactDrift(
  filePath: string,
  label: string,
  expectedBytes: string
): Promise<string | null> {
  let existing: string;
  try {
    existing = await readFile(filePath, "utf8");
  } catch {
    return null;
  }
  if (existing === expectedBytes) return null;
  return `${label} drift: existing sha256 ${sha256(existing).slice(0, 16)}… does not match freshly rendered sha256 ${sha256(expectedBytes).slice(0, 16)}….`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// ---------------------------------------------------------------------------
// Input resolution: flags + optional JSON input file, flags win
// ---------------------------------------------------------------------------

async function resolveInputs(cwd: string, options: AssessOptions): Promise<AssessmentInputs> {
  const fromFile = options.input ? await readInputFile(cwd, options.input) : {};

  const protocolOverrides = {
    ...(fromFile.protocol ?? {}),
    ...definedProtocol(options)
  };
  const protocol = Object.keys(protocolOverrides).length > 0 ? protocolOverrides : undefined;

  const verdict = options.verdict ? parseVerdict(options.verdict) : fromFile.verdict;
  if (verdict !== undefined) validateVerdict(verdict);
  if (fromFile.coverage) validateCoverage(fromFile.coverage);

  return {
    ...fromFile,
    ...(protocol ? { protocol } : {}),
    ...(verdict !== undefined ? { verdict } : {})
  };
}

function definedProtocol(options: AssessOptions): AssessmentInputs["protocol"] {
  const protocol: Record<string, string> = {};
  if (options.protocolName) protocol.name = options.protocolName;
  if (options.repository) protocol.repository = options.repository;
  if (options.commit) protocol.commit = options.commit;
  if (options.riptideVersion) protocol.riptide_version = options.riptideVersion;
  if (options.assessmentDate) protocol.assessment_date = options.assessmentDate;
  return protocol as AssessmentInputs["protocol"];
}

async function readInputFile(cwd: string, file: string): Promise<AssessmentInputs> {
  const inputPath = path.resolve(cwd, file);
  let raw: string;
  try {
    raw = await readFile(inputPath, "utf8");
  } catch (err) {
    if (isNotFound(err)) {
      throw new AssessmentInputError(
        `assessment input file not found at ${inputPath}.`,
        "Point --input at a JSON file of Risk Plan / coverage / verdict inputs, or omit it to use campaign-derived defaults."
      );
    }
    throw new AssessmentInputError(`could not read assessment input file at ${inputPath}: ${errMessage(err)}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new AssessmentInputError(
      `assessment input file is not valid JSON: ${errMessage(err)}.`,
      "The --input file must be a JSON object of assessment inputs (protocol, riskPlan, coverage, verdict, ...)."
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AssessmentInputError(
      "assessment input file must be a JSON object.",
      "Wrap the inputs in an object, e.g. {\"verdict\": \"ready_to_send\", \"riskPlan\": { ... }}."
    );
  }
  return parsed as AssessmentInputs;
}

function parseVerdict(value: string): AssessmentVerdict {
  validateVerdict(value);
  return value as AssessmentVerdict;
}

function validateVerdict(value: string): void {
  if (!(ASSESSMENT_VERDICTS as readonly string[]).includes(value)) {
    throw new AssessmentInputError(
      `unknown verdict ${JSON.stringify(value)}.`,
      `Use one of: ${ASSESSMENT_VERDICTS.join(", ")}.`
    );
  }
}

function validateCoverage(coverage: AssessmentInputs["coverage"]): void {
  if (!Array.isArray(coverage)) {
    throw new AssessmentInputError(
      "assessment input `coverage` must be an array of coverage rows.",
      "Each row needs priority, flow, status, evidence_tier, commands, artifacts, and notes."
    );
  }
  for (const row of coverage) {
    if (!row || typeof row !== "object" || !(COVERAGE_STATUSES as readonly string[]).includes(row.status)) {
      throw new AssessmentInputError(
        `coverage row has an unknown status ${JSON.stringify((row as { status?: unknown })?.status)}.`,
        `Use one of: ${COVERAGE_STATUSES.join(", ")}.`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Presentation exports (R5) — styled HTML + optional PDF, out of the byte gate
// ---------------------------------------------------------------------------

interface PresentationExports {
  htmlPath?: string;
  pdfPath?: string;
  /** When the PDF binder was requested but no headless browser was found. */
  pdfSkipped?: string;
}

async function writePresentationExports(
  model: AssessmentModel,
  markdown: string,
  outDir: string,
  options: AssessOptions
): Promise<PresentationExports> {
  const wantHtml = Boolean(options.html) || Boolean(options.pdf);
  if (!wantHtml) return {};

  const htmlPath = path.join(outDir, ASSESSMENT_HTML_FILE);
  const html = renderAssessmentHtml(markdown, model);
  await writeFile(htmlPath, html, "utf8");

  if (!options.pdf) return { htmlPath };

  const pdfPath = path.join(outDir, ASSESSMENT_PDF_FILE);
  const browser = await findChromium();
  if (!browser) {
    return {
      htmlPath,
      pdfSkipped:
        "no local headless browser found (set RIPTIDE_CHROMIUM to a Chromium/Chrome binary). assessment.html still rendered."
    };
  }
  await htmlToPdf(browser, htmlPath, pdfPath);
  return { htmlPath, pdfPath };
}

/** Locate a Chromium/Chrome binary, honoring RIPTIDE_CHROMIUM first. */
async function findChromium(): Promise<string | null> {
  const override = process.env.RIPTIDE_CHROMIUM;
  if (override && override.trim().length > 0) return override;
  for (const candidate of CHROMIUM_BINARIES) {
    try {
      // Probe the binary directly; a missing binary throws ENOENT. No shell, so
      // no arg-escaping deprecation and no PATH-injection surface.
      await execFileAsync(candidate, ["--version"], { timeout: 10_000 });
      return candidate;
    } catch (err) {
      if (isNotFound(err)) continue;
      // The binary exists but `--version` exited non-zero or timed out; still
      // usable for printing, so accept it rather than falling through.
      return candidate;
    }
  }
  return null;
}

/**
 * Render an HTML file to PDF via a headless browser's `--print-to-pdf`. The PDF
 * is a presentation export of the hashed markdown and is NOT byte-gated (PDF
 * engines embed timestamps/object ids that are not byte-stable).
 */
async function htmlToPdf(browser: string, htmlPath: string, pdfPath: string): Promise<void> {
  const url = pathToFileURL(htmlPath).href;
  await execFileAsync(
    browser,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--no-pdf-header-footer",
      `--print-to-pdf=${pdfPath}`,
      url
    ],
    { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }
  );
}

// ---------------------------------------------------------------------------
// Cold-read summary (jest-style with the rest of the CLI)
// ---------------------------------------------------------------------------

interface SummaryArtifacts {
  jsonPath: string;
  mdPath: string;
  campaignRootPath: string;
  htmlPath?: string;
  pdfPath?: string;
  pdfSkipped?: string;
}

function renderAssessSummary(
  model: CartographyAssessmentModel,
  artifacts: SummaryArtifacts,
  cwd: string,
  deps: AssessCommandDeps,
  executionHonesty?: ExecutionHonestyReport | null
): string {
  const c: Colorizer = pickColorizer(deps.color ?? shouldUseColor(process.env, Boolean(process.stdout.isTTY)));
  const highlights = model.surface_highlights;
  const verdictLine = `${model.verdict.value} (${model.verdict.source})`;
  const surfaceLine =
    highlights.populated_cells > 0
      ? `${highlights.populated_cells}/${highlights.total_cells} cells populated, ` +
        `worst cell ${formatRate(highlights.worst_cell_failure_rate)}` +
        (highlights.most_sensitive_axis ? `, most sensitive \`${highlights.most_sensitive_axis}\`` : "")
      : "no runs placed on the surface";

  const lines = [
    `${c.bold("Assessment generated")}: ${c.cyan(model.protocol.name)}`,
    "",
    c.bold("Result"),
    `  Verdict: ${verdictLine}`,
    `  Runs: ${model.totals.completed_runs}/${model.totals.requested_runs} completed, ` +
      `${model.totals.invariant_failed_runs} invariant-failed (${formatRate(model.totals.invariant_failure_rate)})`,
    `  Risk surface: ${surfaceLine}`,
    `  Safe region: ${safeRegionLine(model)}`,
    ...executionHonestyLines(executionHonesty, c),
    "",
    c.bold("Artifacts"),
    `  Assessment: ${c.cyan(relativizePath(artifacts.jsonPath, cwd))}`,
    `  Report: ${c.cyan(relativizePath(artifacts.mdPath, cwd))}`,
    ...(artifacts.htmlPath ? [`  HTML: ${c.cyan(relativizePath(artifacts.htmlPath, cwd))}`] : []),
    ...(artifacts.pdfPath ? [`  PDF: ${c.cyan(relativizePath(artifacts.pdfPath, cwd))}`] : []),
    ...(artifacts.pdfSkipped ? [`  PDF: ${c.yellow(`skipped — ${artifacts.pdfSkipped}`)}`] : []),
    "",
    c.bold("Hashes"),
    `  Assessment digest: ${c.cyan(model.assessment_digest)}`,
    c.dim(`  Campaign digest: ${model.reproduction.hashes.campaign_digest}`),
    c.dim(`  risk-surface.json sha256: ${model.reproduction.hashes.surface_sha256}`),
    "",
    c.bold("Next"),
    `  ${c.cyan(`riptide review ${shellQuote(relativizePath(artifacts.campaignRootPath, cwd))}`)}`,
    "",
    c.bold("Boundary"),
    c.dim(
      "  Simulation evidence over the campaign's declared, fixed-seed region — not audit signoff, " +
        "formal verification, complete protocol safety, or a mainnet prediction."
    ),
    ""
  ];
  return lines.join("\n") + "\n";
}

/** Cold-read lines for the execution-honesty gates (guided-sim only; empty otherwise). */
function executionHonestyLines(
  report: ExecutionHonestyReport | null | undefined,
  c: Colorizer
): string[] {
  if (!report) return [];
  const head = report.status === "blocked" ? c.yellow("blocked") : c.dim("pass");
  const lines = [`  Execution honesty: ${head}`];
  for (const gate of report.gates) {
    const mark = gate.status === "fail" ? c.yellow("✗") : c.dim("✓");
    lines.push(`    ${mark} ${gate.id}`);
  }
  return lines;
}

function safeRegionLine(model: CartographyAssessmentModel): string {
  const highlights = model.surface_highlights;
  const threshold = formatRate(highlights.safe_region_threshold);
  switch (highlights.safe_region_status) {
    case "none":
      return `none under the ${threshold} failure-rate threshold`;
    case "entire-region":
      return `entire declared region at or under ${threshold}`;
    default:
      return `bounded region at or under ${threshold}`;
  }
}

/** Cold-read summary for the surface-less correctness shape (no heatmap to report). */
function renderCorrectnessSummary(
  model: AssessmentModel,
  artifacts: SummaryArtifacts,
  cwd: string,
  deps: AssessCommandDeps
): string {
  const c: Colorizer = pickColorizer(deps.color ?? shouldUseColor(process.env, Boolean(process.stdout.isTTY)));
  const gs = model.correctness?.guided_sim ?? null;
  const guidedSimLine = gs
    ? `${gs.flows} flow(s), ${gs.tx_success} tx success, ${gs.expected_errors} expected rejection(s), ` +
      `${gs.unexpected_errors} unexpected, ${gs.panics} panic(s) (status ${gs.status})`
    : "no guided-sim evidence ingested";
  const coveredRows = model.coverage_matrix.filter((row) => row.status === "covered by guided sim").length;

  const lines = [
    `${c.bold("Assessment generated")}: ${c.cyan(model.protocol.name)} ${c.dim("(correctness shape)")}`,
    "",
    c.bold("Result"),
    `  Verdict: ${model.verdict.value} (${model.verdict.source})`,
    `  Guided sim: ${guidedSimLine}`,
    `  Coverage: ${coveredRows} flow(s) covered by guided sim`,
    `  Risk surface: ${c.dim("none — correctness-dominated (no parameter-failure gradient)")}`,
    "",
    c.bold("Artifacts"),
    `  Assessment: ${c.cyan(relativizePath(artifacts.jsonPath, cwd))}`,
    `  Report: ${c.cyan(relativizePath(artifacts.mdPath, cwd))}`,
    ...(artifacts.htmlPath ? [`  HTML: ${c.cyan(relativizePath(artifacts.htmlPath, cwd))}`] : []),
    ...(artifacts.pdfPath ? [`  PDF: ${c.cyan(relativizePath(artifacts.pdfPath, cwd))}`] : []),
    ...(artifacts.pdfSkipped ? [`  PDF: ${c.yellow(`skipped — ${artifacts.pdfSkipped}`)}`] : []),
    "",
    c.bold("Hashes"),
    `  Assessment digest: ${c.cyan(model.assessment_digest)}`,
    c.dim(`  guided-sim-run.json sha256: ${gs?.sha256 ?? "not emitted"}`),
    "",
    c.bold("Next"),
    `  ${c.cyan(`riptide assess ${shellQuote(relativizePath(artifacts.campaignRootPath, cwd))}`)}`,
    "",
    c.bold("Boundary"),
    c.dim(
      "  Simulation evidence bounded to the assessed guided-sim flows under a fixed seed — not audit signoff, " +
        "formal verification, complete protocol safety, or a mainnet prediction."
    ),
    ""
  ];
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Fold an {@link AssessmentIngestError}'s separate `hint` into its message as a
 * `next:` line so the message-first renderer surfaces the actionable next step,
 * matching the rest of the CLI's error UX. {@link AssessmentInputError} already
 * embeds its hint at construction, so it passes through untouched.
 */
function withHint(error: unknown): unknown {
  if (error instanceof AssessmentIngestError && error.hint && !error.message.includes(error.hint)) {
    error.message = `${error.message}\n  next: ${error.hint}`;
  }
  return error;
}

function formatRate(rate: number): string {
  return `${Math.round(rate * 100 * 1_000_000) / 1_000_000}%`;
}

function shellQuote(value: string): string {
  return /[^A-Za-z0-9_./-]/.test(value) ? `'${value.replace(/'/g, "'\\''")}'` : value;
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
