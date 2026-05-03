// `riptide readiness` — read-only external protocol support inspection.
//
// The command surfaces Sprint 25B readiness reports without depending on
// campaign execution internals. JSON mode is stable and banner-free; Markdown
// mode is reviewer-facing and uses the same report model.

import { existsSync } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";

import {
  inspectAndAnalyzeReadiness,
  readinessReportToJson,
  renderReadinessBatchMarkdown,
  renderReadinessMarkdown,
  stableJsonStringify,
  type AnalyzeReadinessGapsOptions,
  type ReadinessBatchReport,
  type ReadinessReport,
} from "../readiness/index.js";
import { renderCliError } from "../errors/render.js";

export const DEFAULT_CASE_STUDIES_ROOT = "case-studies";

interface CaseStudyCandidate {
  candidate: string;
  localName: string;
}

const DEFAULT_CASE_STUDY_CANDIDATES = [
  { candidate: "0xNineteen/anchor-uniswap-v2", localName: "anchor-uniswap-v2" },
  { candidate: "ChiefWoods/cpamm", localName: "cpamm" },
  { candidate: "ChiefWoods/lending", localName: "lending" },
  { candidate: "ChiefWoods/stablecoin", localName: "stablecoin" },
  { candidate: "Jayant818/perpPrime", localName: "perpPrime" },
  {
    candidate: "Mythic-Project/solana-program-library",
    localName: "solana-program-library",
  },
  {
    candidate: "Mythic-Project/solana-program-library#spl-token-subset",
    localName: "solana-program-library",
  },
  { candidate: "askibin/perpetuals", localName: "askibin-perpetuals" },
  { candidate: "blocknetics/stablecoin-protocol", localName: "stablecoin-protocol" },
  { candidate: "blockworks-foundation/mango-v4", localName: "mango-v4" },
  { candidate: "drift-labs/protocol-v2", localName: "protocol-v2" },
  { candidate: "marinade-finance/liquid-staking-program", localName: "liquid-staking-program" },
  { candidate: "orca-so/whirlpools", localName: "whirlpools" },
  { candidate: "solana-labs/perpetuals", localName: "perpetuals" },
  { candidate: "vvizardev/marinade-liquid-stake-fork", localName: "marinade-liquid-stake-fork" },
] as const satisfies readonly CaseStudyCandidate[];

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
  | { kind: "batch"; batch: ReadinessBatchReport; markdown: string; json: string };

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
    const targets = await caseStudyTargets(root);
    const reports = await Promise.all(
      targets.map(async (target) => {
        const { report } = await inspectAndAnalyze(target.path, {
          ...analyzerOptions,
          candidate: target.candidate,
        });
        return report;
      })
    );
    const batch: ReadinessBatchReport = {
      schemaVersion: "readiness-batch.v1",
      caseStudiesRoot: root,
      reports: reports.sort((left, right) =>
        compareStrings(left.repo.candidate ?? "", right.repo.candidate ?? "")
      ),
    };
    return {
      kind: "batch",
      batch,
      markdown: renderReadinessBatchMarkdown(batch),
      json: stableJsonStringify(batch),
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

async function caseStudyTargets(root: string): Promise<Array<{ path: string; candidate: string }>> {
  if (!existsSync(root)) {
    throw new Error(`riptide readiness: case-study root not found: ${root}`);
  }
  const rootStats = await stat(root);
  if (!rootStats.isDirectory()) {
    throw new Error(`riptide readiness: case-study root is not a directory: ${root}`);
  }
  const entries = await readdir(root, { withFileTypes: true });
  const childDirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort(compareStrings);
  const defaultCandidates = defaultCaseStudyCandidatesFor(root);
  if (defaultCandidates.length === 0) {
    return childDirs.map((entry) => ({
      path: path.join(root, entry),
      candidate: entry,
    }));
  }

  const plannedLocalNames = new Set(defaultCandidates.map((entry) => entry.localName));
  const plannedTargets = defaultCandidates.map((entry) => ({
    path: path.join(root, entry.localName),
    candidate: entry.candidate,
  }));
  const extraTargets = childDirs
    .filter((entry) => !plannedLocalNames.has(entry))
    .map((entry) => ({
      path: path.join(root, entry),
      candidate: entry,
    }));
  return [...plannedTargets, ...extraTargets].sort((left, right) =>
    compareStrings(left.candidate, right.candidate)
  );
}

function defaultCaseStudyCandidatesFor(root: string): readonly CaseStudyCandidate[] {
  return path.basename(path.resolve(root)) === DEFAULT_CASE_STUDIES_ROOT
    ? DEFAULT_CASE_STUDY_CANDIDATES
    : [];
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
