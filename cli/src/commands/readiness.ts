// `riptide readiness` — read-only protocol support inspection plus the
// static health check (toolchain presence, adapter load + lint).
//
// The command surfaces readiness reports without depending on campaign
// execution internals. JSON mode is stable and banner-free; Markdown mode is
// reviewer-facing and uses the same report model.
//
// A single-repo run also reports health for that repo. `--json` carries it
// as `data.health`; a failing health check turns the envelope into the
// error shape with the full report still attached as `data`. The files
// `--out` and `--markdown` write stay readiness-only. A produced report
// exits 0 even when health warns (the verdict is in the report); a failing
// health check or any other error exits 2. A `--case-studies` corpus run
// has no health block.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";

import {
  inspectAndAnalyzeReadiness,
  createReadinessCorpusReport,
  ReadinessInputError,
  discoverCaseStudyTargets,
  readinessReportToJson,
  renderReadinessCorpusMarkdown,
  renderReadinessMarkdown,
  stableJsonStringify,
  type AnalyzeReadinessGapsOptions,
  type ReadinessCorpusReport,
  type ReadinessReport,
} from "../readiness/index.js";
import {
  errorEnvelope,
  oneLineMessage,
  renderEnvelope,
  resolveCommandIO,
  successEnvelope,
  type CommandError,
  type CommandIO,
} from "../contract/index.js";
import { renderCliError } from "../errors/render.js";
import { buildHealthReport, type HealthReport } from "../health/index.js";
import { healthFailure, healthReportJson, renderHealthReport } from "../health/render.js";

export const DEFAULT_CASE_STUDIES_ROOT = "case-studies";

export interface ReadinessOptions {
  json?: boolean;
  markdown?: string;
  out?: string;
  caseStudies?: boolean | string;
  slice?: string;
}

export interface ReadinessCommandDeps extends CommandIO {
  inspectAndAnalyzeImpl?: typeof inspectAndAnalyzeReadiness;
  /** Test seam — override the health report builder (toolchain probe stubs). */
  buildHealth?: typeof buildHealthReport;
  /** Test seam — force color on/off in the health section. */
  color?: boolean;
  /** Test seam — override env. */
  env?: NodeJS.ProcessEnv;
}

type ReadinessOutput =
  | { kind: "single"; target: string; report: ReadinessReport; markdown: string; json: string }
  | { kind: "corpus"; corpus: ReadinessCorpusReport; markdown: string; json: string };

export function createReadinessCommand(deps: ReadinessCommandDeps = {}): Command {
  return new Command("readiness")
    .description(
      "Inspect local protocol readiness evidence and toolchain and adapter health, and report support level, missing inputs, and next action"
    )
    .argument("[path]", "Protocol repo or .riptide workspace path")
    .option("--json", "Emit the report as a command envelope", false)
    .option("--markdown <file>", "Write reviewer Markdown to a file")
    .option("--out <dir>", "Write readiness.json and readiness.md into a directory")
    .option(
      "--case-studies [root]",
      `Inspect each immediate child repo under a case-study root (default: ${DEFAULT_CASE_STUDIES_ROOT})`
    )
    .option("--slice <name>", "Focus on .riptide/slices/<name>.toml")
    .action(async (inputPath: string | undefined, options: ReadinessOptions) => {
      const exitCode = await runReadiness(inputPath, options, deps);
      process.exit(exitCode);
    });
}

export async function runReadiness(
  inputPath: string | undefined,
  options: ReadinessOptions,
  deps: ReadinessCommandDeps = {}
): Promise<number> {
  const { stdout, stderr, cwd } = resolveCommandIO(deps);

  let output: ReadinessOutput;
  let health: HealthReport | null = null;
  try {
    output = await buildReadinessOutput(inputPath, options, deps);
    await persistReadinessOutput(output, options, cwd);
    if (output.kind === "single") {
      health = await buildHealth(output.target, deps);
    }
  } catch (error) {
    if (options.json) {
      stdout(renderEnvelope(errorEnvelope("readiness", readinessFailure(error))));
      return 2;
    }
    stderr(
      renderCliError(error, {
        env: process.env,
        isTTY: Boolean(process.stderr.isTTY),
      })
    );
    return 2;
  }

  if (health === null) {
    stdout(
      options.json
        ? renderEnvelope(successEnvelope("readiness", JSON.parse(output.json) as unknown))
        : output.markdown
    );
    return 0;
  }

  if (options.json) {
    const data = { ...(JSON.parse(output.json) as object), health: healthReportJson(health) };
    stdout(
      renderEnvelope(
        health.exitCode === 2
          ? errorEnvelope("readiness", healthFailure(health), data)
          : successEnvelope("readiness", data)
      )
    );
  } else {
    stdout(`${output.markdown}\n${renderHealthReport(health, { color: deps.color })}`);
  }
  return health.exitCode === 2 ? 2 : 0;
}

class HealthReportError extends Error {}

async function buildHealth(target: string, deps: ReadinessCommandDeps): Promise<HealthReport> {
  const builder = deps.buildHealth ?? buildHealthReport;
  try {
    return await builder({ cwd: target, env: deps.env ?? process.env });
  } catch (error) {
    throw new HealthReportError(
      `riptide readiness: failed to assemble the health report: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function buildReadinessOutput(
  inputPath: string | undefined,
  options: ReadinessOptions,
  deps: ReadinessCommandDeps
): Promise<ReadinessOutput> {
  const cwd = deps.cwd ?? process.cwd();
  const inspectAndAnalyze = deps.inspectAndAnalyzeImpl ?? inspectAndAnalyzeReadiness;
  const analyzerOptions: AnalyzeReadinessGapsOptions = {
    ...(options.slice ? { sliceName: options.slice } : {}),
  };

  if (options.caseStudies !== undefined && options.caseStudies !== false) {
    const root = resolveCaseStudiesRoot(inputPath, options.caseStudies, cwd);
    const targets = await discoverCaseStudyTargets(root);
    const rows = await Promise.all(
      targets.map(async (target) => {
        const { inspection, report } = await inspectAndAnalyze(target.path, {
          ...analyzerOptions,
          candidate: target.slug,
          includeTargetArtifacts: false,
          validateAdapters: false,
        });
        return { caseStudiesRoot: root, inspection, report };
      })
    );
    const corpus = createReadinessCorpusReport({ caseStudiesRoot: root, rows });
    return {
      kind: "corpus",
      corpus,
      markdown: renderReadinessCorpusMarkdown(corpus),
      json: stableJsonStringify(corpus),
    };
  }

  if (!inputPath) {
    throw new ReadinessInputError(
      "riptide readiness: provide <path> or --case-studies",
      "readiness_missing_target",
      "rerun with the repo path, e.g. `riptide readiness . --json`"
    );
  }

  const target = path.resolve(cwd, inputPath);
  const { report } = await inspectAndAnalyze(target, analyzerOptions);
  return {
    kind: "single",
    target,
    report,
    markdown: renderReadinessMarkdown(report),
    json: readinessReportToJson(report),
  };
}

function readinessFailure(error: unknown): CommandError {
  if (error instanceof ReadinessInputError) {
    return { code: error.code, message: oneLineMessage(error.message), next: error.next };
  }
  if (error instanceof HealthReportError) {
    return {
      code: "health_report_failed",
      message: oneLineMessage(error.message),
      next: "check that the repo and its .riptide/adapters/ are readable, then rerun `riptide readiness <path> --json`",
    };
  }
  return {
    code: "readiness_failed",
    message: oneLineMessage(error instanceof Error ? error.message : String(error)),
    next: "fix the path, adapter or output directory named in the message, then rerun `riptide readiness <path> --json`",
  };
}

async function persistReadinessOutput(
  output: ReadinessOutput,
  options: ReadinessOptions,
  cwd: string
): Promise<void> {
  if (options.out) {
    const outDir = path.resolve(cwd, options.out);
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "readiness.json"), `${output.json}\n`, "utf8");
    await writeFile(path.join(outDir, "readiness.md"), output.markdown, "utf8");
  }

  if (options.markdown) {
    const markdownPath = path.resolve(cwd, options.markdown);
    await mkdir(path.dirname(markdownPath), { recursive: true });
    await writeFile(markdownPath, output.markdown, "utf8");
  }
}

function resolveCaseStudiesRoot(
  inputPath: string | undefined,
  caseStudiesOption: boolean | string,
  cwd: string
): string {
  if (typeof caseStudiesOption === "string" && caseStudiesOption.length > 0) {
    return path.resolve(cwd, caseStudiesOption);
  }
  if (inputPath) return path.resolve(cwd, inputPath);
  return DEFAULT_CASE_STUDIES_ROOT;
}
