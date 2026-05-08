// Studio report reader.
//
// Resolves an artifact id (returned by the indexer) to a concrete
// markdown or json blob the UI can render. The resolver is read-only,
// stays inside the workspace root, and refuses paths that escape it.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

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
  /** UTF-8 body. */
  body: string;
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

  const target = await resolveTargetFile(artifact.path, artifact.kind);
  if (!target) return null;

  const safePath = ensureInsideRoot(root, target.absolutePath);
  if (!safePath) return null;

  const body = await readFile(safePath, "utf8");
  return {
    schema_version: "studio-report.v1",
    workspace_id: options.workspaceId,
    artifact_id: options.artifactId,
    content_type: target.contentType,
    label: target.label,
    relative_path: path.relative(root, safePath) || ".",
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
      return ["report.md", "summary.md", "simulation-result.json", "run-config.json"];
    case "scenario":
      return ["README.md", "run-config.json"];
    default:
      return ["report.md", "README.md", "summary.md"];
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
