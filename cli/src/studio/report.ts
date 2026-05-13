// Studio report reader.
//
// Resolves an artifact id (returned by the indexer) to a concrete
// markdown or json blob the UI can render. The resolver is read-only,
// stays inside the workspace root, and refuses paths that escape it.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { runReview } from "../commands/review.js";
import { indexWorkspaceArtifacts } from "./artifacts.js";

export type StudioReportContentType = "markdown" | "json" | "toml";

export interface StudioReportPayload {
  schema_version: "studio-report.v1";
  workspace_id: string;
  artifact_id: string;
  /** What the body is encoded as. */
  content_type: StudioReportContentType;
  /** Display label. */
  label: string;
  /** Workspace-relative path of the file being shown. */
  relative_path: string;
  /** Related workspace-local artifacts that explain or reproduce this report. */
  source_links: StudioReportSourceLink[];
  /** UTF-8 body. */
  body: string;
}

export interface StudioReportSourceLink {
  label: string;
  kind: "report" | "artifact" | "config" | "rerun" | "manifest";
  relative_path: string;
}

export interface ResolveReportOptions {
  workspaceId: string;
  workspacePath: string;
  artifactId: string;
}

const RUN_REPORT_FILES = ["report.md", "summary.md"] as const;
const CAMPAIGN_REPORT_FILES = ["campaign-summary.md", "summary.md", "README.md"] as const;
const PACK_REPORT_FILES = ["summary.md", "trace.md", "README.md"] as const;
const SIM_REPORT_FILES = ["report.md", "README.md"] as const;

export async function resolveStudioReport(
  options: ResolveReportOptions
): Promise<StudioReportPayload | null> {
  const root = path.resolve(options.workspacePath);
  const index = await indexWorkspaceArtifacts({
    workspaceId: options.workspaceId,
    workspacePath: root
  });
  const artifact = index.artifacts.find((a) => a.id === options.artifactId);
  if (!artifact) return null;

  const artifactPath = ensureInsideRoot(root, artifact.path);
  if (!artifactPath) return null;

  const generatedReview = await renderReviewReportIfSupported(root, artifactPath, artifact.kind);
  const target = await resolveTargetFile(artifactPath, artifact.kind);
  const safePath = target ? ensureInsideRoot(root, target.absolutePath) : null;
  if (target && !safePath) return null;
  if (!generatedReview && !target) return null;

  const body = generatedReview?.body ?? await readFile(safePath!, "utf8");
  return {
    schema_version: "studio-report.v1",
    workspace_id: options.workspaceId,
    artifact_id: options.artifactId,
    content_type: generatedReview ? "markdown" : target!.contentType,
    label: generatedReview?.label ?? target!.label,
    relative_path: generatedReview?.relativePath ?? (path.relative(root, safePath!) || "."),
    source_links: await sourceLinksForArtifact(
      root,
      artifactPath,
      artifact.kind,
      generatedReview ? artifactPath : safePath ?? artifactPath
    ),
    body
  };
}

interface ResolvedTarget {
  absolutePath: string;
  contentType: StudioReportContentType;
  label: string;
}

async function resolveTargetFile(
  artifactPath: string,
  kind: string
): Promise<ResolvedTarget | null> {
  const absPath = path.resolve(artifactPath);
  const stat = await safeStat(absPath);
  if (!stat) return null;

  // Single-file artifacts: serve directly.
  if (stat.isFile()) {
    return {
      absolutePath: absPath,
      contentType: contentTypeForPath(absPath),
      label: path.basename(absPath)
    };
  }

  // Directory artifacts: look for a Markdown summary first, then JSON.
  const candidates = candidateFilesForKind(kind);
  for (const candidate of candidates) {
    const file = path.join(absPath, candidate);
    const candStat = await safeStat(file);
    if (candStat?.isFile()) {
      return {
        absolutePath: file,
        contentType: contentTypeForPath(file),
        label: candidate
      };
    }
  }
  return null;
}

function contentTypeForPath(file: string): StudioReportContentType {
  if (file.endsWith(".json")) return "json";
  if (file.endsWith(".toml")) return "toml";
  return "markdown";
}

async function renderReviewReportIfSupported(
  workspaceRoot: string,
  artifactPath: string,
  kind: string
): Promise<{ label: string; relativePath: string; body: string } | null> {
  if (!isReviewableKind(kind)) return null;
  let stdout = "";
  let stderr = "";
  const exitCode = await runReview(artifactPath, { quiet: true }, {
    cwd: workspaceRoot,
    color: false,
    stdoutWrite: (chunk) => {
      stdout += chunk;
    },
    stderrWrite: (chunk) => {
      stderr += chunk;
    }
  });
  if (stdout.trim().length === 0 || exitCode >= 2) {
    return {
      label: "riptide review error",
      relativePath: path.relative(workspaceRoot, artifactPath) || ".",
      body: renderReviewFailureMarkdown(workspaceRoot, artifactPath, exitCode, stderr)
    };
  }
  return {
    label: "riptide review",
    relativePath: path.relative(workspaceRoot, artifactPath) || ".",
    body: stdout
  };
}

function renderReviewFailureMarkdown(
  workspaceRoot: string,
  artifactPath: string,
  exitCode: number,
  stderr: string
): string {
  const relativePath = path.relative(workspaceRoot, artifactPath) || ".";
  const details = stderr.trim() || "riptide review returned no diagnostic output.";
  return [
    `# Review Unavailable: ${path.basename(artifactPath)}`,
    "",
    "## Executive Summary",
    "",
    "Studio could not generate the human-readable `riptide review` report for this artifact. Treat this as a report-generation blocker and inspect the linked raw artifacts instead of relying on any stale summary.",
    "",
    "## Outcome",
    "",
    "| Check | Result | Evidence |",
    "|---|---|---|",
    `| Review generation | fail | \`riptide review ${relativePath}\` exited ${exitCode} |`,
    "",
    "## Technical Appendix",
    "",
    "```text",
    details,
    "```",
    ""
  ].join("\n");
}

function isReviewableKind(kind: string): boolean {
  return kind === "campaign-root" ||
    kind === "pack" ||
    kind === "guided-sim" ||
    kind === "retained-case";
}

function candidateFilesForKind(kind: string): readonly string[] {
  switch (kind) {
    case "run":
      return [...RUN_REPORT_FILES, "simulation-result.json"];
    case "campaign-root":
      return [...CAMPAIGN_REPORT_FILES, "campaign-summary.json"];
    case "pack":
      return [...PACK_REPORT_FILES, "manifest.json"];
    case "guided-sim":
      return [...SIM_REPORT_FILES, "guided-sim-run.json", "manifest.json"];
    case "retained-case":
      return ["report.md", "summary.md", "case.json", "simulation-result.json", "run-config.json"];
    case "scenario":
      return ["README.md", "run-config.json"];
    default:
      return ["report.md", "README.md", "summary.md"];
  }
}

async function sourceLinksForArtifact(
  root: string,
  artifactPath: string,
  kind: string,
  reportPath: string
): Promise<StudioReportSourceLink[]> {
  const links: StudioReportSourceLink[] = [];
  const seen = new Set<string>();
  const add = async (
    label: string,
    absolutePath: string,
    linkKind: StudioReportSourceLink["kind"]
  ) => {
    const safe = ensureInsideRoot(root, absolutePath);
    if (!safe) return;
    const fileStat = await safeStat(safe);
    if (!fileStat?.isFile()) return;
    const rel = path.relative(root, safe) || ".";
    if (seen.has(rel)) return;
    seen.add(rel);
    links.push({ label, kind: linkKind, relative_path: rel });
  };
  const addFirstExisting = async (
    label: string,
    absolutePaths: string[],
    linkKind: StudioReportSourceLink["kind"]
  ) => {
    const startingCount = links.length;
    for (const absolutePath of absolutePaths) {
      await add(label, absolutePath, linkKind);
      if (links.length > startingCount) return;
    }
  };

  await add("Rendered report", reportPath, "report");

  const absPath = path.resolve(artifactPath);
  const fileStat = await safeStat(absPath);
  if (fileStat?.isFile()) {
    await add("Selected artifact", absPath, sourceKindForPath(absPath));
    return links;
  }

  const byKind = sourceCandidatesForKind(kind);
  for (const candidate of byKind) {
    await add(candidate.label, path.join(absPath, candidate.path), candidate.kind);
  }

  if (kind === "pack") {
    const outputIndex = await readOptionalJsonObject(path.join(absPath, "outputs", "paths.json"));
    const simulationResult = typeof outputIndex?.simulation_result === "string"
      ? outputIndex.simulation_result
      : null;
    if (simulationResult) {
      await addFirstExisting("Simulation result", [
        path.resolve(root, simulationResult),
        path.resolve(absPath, simulationResult)
      ], "artifact");
    }
  }

  if (kind === "retained-case") {
    const caseRecord = await readOptionalJsonObject(path.join(absPath, "case.json"));
    const paths = caseRecord && typeof caseRecord.paths === "object" && !Array.isArray(caseRecord.paths)
      ? caseRecord.paths as Record<string, unknown>
      : null;
    const simulationResult = typeof paths?.simulation_result === "string" ? paths.simulation_result : null;
    if (simulationResult) {
      await addFirstExisting("Simulation result", [
        path.resolve(root, simulationResult),
        path.resolve(absPath, "..", "..", simulationResult),
        path.resolve(absPath, simulationResult)
      ], "artifact");
    }
  }

  return links;
}

function sourceCandidatesForKind(kind: string): Array<{
  label: string;
  path: string;
  kind: StudioReportSourceLink["kind"];
}> {
  switch (kind) {
    case "run":
      return [
        { label: "Run config", path: "run-config.json", kind: "config" },
        { label: "Simulation result", path: "simulation-result.json", kind: "artifact" },
        { label: "Report markdown", path: "report.md", kind: "report" }
      ];
    case "campaign-root":
      return [
        { label: "Campaign summary", path: "campaign-summary.json", kind: "artifact" },
        { label: "Retention manifest", path: "retention-manifest.json", kind: "manifest" },
        { label: "Parameters CSV", path: "parameters.csv", kind: "artifact" },
        { label: "Runs JSONL", path: "runs.jsonl", kind: "artifact" }
      ];
    case "pack":
      return [
        { label: "Manifest", path: "manifest.json", kind: "manifest" },
        { label: "Summary", path: "summary.md", kind: "report" },
        { label: "Trace", path: "trace.md", kind: "artifact" },
        { label: "Rerun script", path: "rerun.sh", kind: "rerun" },
        { label: "Input index", path: path.join("inputs", "paths.json"), kind: "artifact" },
        { label: "Output index", path: path.join("outputs", "paths.json"), kind: "artifact" }
      ];
    case "guided-sim":
      return [
        { label: "Guided sim run", path: "guided-sim-run.json", kind: "artifact" },
        { label: "Rerun script", path: "rerun.sh", kind: "rerun" },
        { label: "Manifest", path: "manifest.json", kind: "manifest" }
      ];
    case "retained-case":
      return [
        { label: "Retained case", path: "case.json", kind: "manifest" },
        { label: "Rerun script", path: "rerun.sh", kind: "rerun" }
      ];
    case "scenario":
      return [
        { label: "Run config", path: "run-config.json", kind: "config" },
        { label: "README", path: "README.md", kind: "report" }
      ];
    default:
      return [];
  }
}

function sourceKindForPath(file: string): StudioReportSourceLink["kind"] {
  if (file.endsWith("rerun.sh")) return "rerun";
  if (file.endsWith("manifest.json")) return "manifest";
  if (file.endsWith("run-config.json") || file.endsWith(".toml")) return "config";
  if (file.endsWith(".md")) return "report";
  return "artifact";
}

async function readOptionalJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function ensureInsideRoot(root: string, target: string): string | null {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return resolvedTarget;
}

async function safeStat(target: string) {
  try {
    return await stat(target);
  } catch {
    return null;
  }
}
