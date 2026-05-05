// `riptide readiness` — read-only external protocol support inspection.
//
// The command surfaces readiness reports without depending on campaign
// execution internals. JSON mode is stable and banner-free; Markdown mode is
// reviewer-facing and uses the same report model.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";

import {
  inspectAndAnalyzeReadiness,
  createReadinessCorpusReport,
  discoverCaseStudyTargets,
  readinessReportToJson,
  renderReadinessCorpusMarkdown,
  renderReadinessMarkdown,
  stableJsonStringify,
  type AnalyzeReadinessGapsOptions,
  type ReadinessCorpusReport,
  type ReadinessReport,
} from "../readiness/index.js";
import { renderCliError } from "../errors/render.js";

export const DEFAULT_CASE_STUDIES_ROOT = "case-studies";

export interface ReadinessOptions {
  json?: boolean;
  markdown?: string;
  out?: string;
  caseStudies?: boolean | string;
  slice?: string;
}

export interface ReadinessCommandDeps {
  stdoutWrite?: (chunk: string) => void;
  stderrWrite?: (chunk: string) => void;
  cwd?: string;
  inspectAndAnalyzeImpl?: typeof inspectAndAnalyzeReadiness;
}

type ReadinessOutput =
  | { kind: "single"; report: ReadinessReport; markdown: string; json: string }
  | { kind: "corpus"; corpus: ReadinessCorpusReport; markdown: string; json: string };

export function createReadinessCommand(deps: ReadinessCommandDeps = {}): Command {
  return new Command("readiness")
    .description(
      "Inspect local protocol readiness evidence and report observed support level, missing inputs, and next action"
    )
    .argument("[path]", "Protocol repo or .riptide workspace path")
    .option("--json", "Emit stable machine-readable JSON", false)
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
  const stdout = deps.stdoutWrite ?? ((chunk: string) => process.stdout.write(chunk));
  const stderr = deps.stderrWrite ?? ((chunk: string) => process.stderr.write(chunk));
  const cwd = deps.cwd ?? process.cwd();

  try {
    const output = await buildReadinessOutput(inputPath, options, deps);
    await persistReadinessOutput(output, options, cwd);
    stdout(options.json ? `${output.json}\n` : output.markdown);
    return 0;
  } catch (error) {
    stderr(
      renderCliError(error, {
        env: process.env,
        isTTY: Boolean(process.stderr.isTTY),
      })
    );
    return 2;
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
    throw new Error("riptide readiness: provide <path> or --case-studies");
  }

  const target = path.resolve(cwd, inputPath);
  const { report } = await inspectAndAnalyze(target, analyzerOptions);
  return {
    kind: "single",
    report,
    markdown: renderReadinessMarkdown(report),
    json: readinessReportToJson(report),
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
