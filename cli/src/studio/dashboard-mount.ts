// Studio drilldown adapter for the existing run/replay dashboard.
//
// Studio embeds the dashboard.html shell at `/dashboard` and serves
// the same `/api/collection`, `/api/result`, `/api/report`, and
// `/api/labels` shapes the existing `riptide run --serve` /
// `riptide replay --serve` dashboard does — but scoped to a chosen
// workspace + artifact via a `?source=<workspace-relative-path>`
// query parameter. The handlers reuse the helpers in
// `cli/src/serve/index.ts` so the parsing and relativization stay
// identical between Studio and the standalone dashboard.

import path from "node:path";

import {
  collectionForSource,
  makeDashboardSource,
  readOptionalFile,
  relativizeDisplayPaths,
  selectFileFromSource,
  type DashboardSource
} from "../serve/index.js";
import { SEMANTIC_LABELS } from "../serve/labels.js";

export interface ResolvedDashboardSource {
  source: DashboardSource;
  /** Resolved absolute path used to construct the source. */
  absolutePath: string;
  /** Workspace-relative path that the UI should keep using in URLs. */
  relativePath: string;
}

export interface DashboardSourceError {
  status: number;
  payload: Record<string, unknown>;
}

const DEFAULT_SOURCES = [
  ".riptide/run-collection.json",
  ".riptide/runs",
  ".riptide/last-run.json"
] as const;

interface PackManifest {
  outputs?: {
    simulation_result?: string | null;
  };
}

export async function resolveDashboardSource(
  workspacePath: string,
  rawSource: string | null
): Promise<ResolvedDashboardSource | DashboardSourceError> {
  const root = path.resolve(workspacePath);
  const requested = (rawSource ?? "").trim();

  if (requested.length > 0) {
    const safe = ensureInsideRoot(root, requested);
    if (!safe) {
      return {
        status: 400,
        payload: {
          error: "invalid_source",
          message:
            "source must be a workspace-relative path that does not escape the workspace root"
        }
      };
    }
    const packSource = await resolvePackSource(root, safe.absolutePath);
    if (packSource) {
      return packSource;
    }
    return {
      source: makeDashboardSource(safe.absolutePath),
      absolutePath: safe.absolutePath,
      relativePath: safe.relativePath
    };
  }

  for (const candidate of DEFAULT_SOURCES) {
    const safe = ensureInsideRoot(root, candidate);
    if (!safe) continue;
    if (await pathExists(safe.absolutePath)) {
      return {
        source: makeDashboardSource(safe.absolutePath),
        absolutePath: safe.absolutePath,
        relativePath: safe.relativePath
      };
    }
  }

  return {
    status: 404,
    payload: {
      error: "no_dashboard_source",
      message:
        "no run-collection.json, runs/ folder, or last-run.json was found in this workspace",
      tried: DEFAULT_SOURCES,
      next_action:
        "Run `riptide run` in this workspace, or pass `?source=<path>` pointing at a valid artifact."
    }
  };
}

export async function readCollectionPayload(
  source: DashboardSource
): Promise<unknown> {
  return collectionForSource(source);
}

export async function readResultBody(
  source: DashboardSource,
  searchParams: URLSearchParams
): Promise<{ ok: true; body: string } | { ok: false; status: number; payload: Record<string, unknown> }> {
  const selection = await selectFileFromSource(source, searchParams, "result");
  if ("error" in selection) {
    return { ok: false, status: selection.status, payload: selection.payload };
  }
  const raw = await readOptionalFile(selection.filePath);
  if (raw === null) {
    return {
      ok: false,
      status: 404,
      payload: { error: "result_missing", message: selection.missingMessage }
    };
  }
  return { ok: true, body: relativizeDisplayPaths(raw, selection.displayBaseDir) };
}

export async function readReportBody(
  source: DashboardSource,
  searchParams: URLSearchParams
): Promise<{ ok: true; body: string } | { ok: false; status: number; payload: Record<string, unknown> }> {
  const selection = await selectFileFromSource(source, searchParams, "report");
  if ("error" in selection) {
    return { ok: false, status: selection.status, payload: selection.payload };
  }
  const raw = await readOptionalFile(selection.filePath);
  if (raw === null) {
    return {
      ok: false,
      status: 404,
      payload: { error: "report_missing", message: selection.missingMessage }
    };
  }
  return { ok: true, body: relativizeDisplayPaths(raw, selection.displayBaseDir) };
}

export function dashboardLabels(): Record<string, unknown> {
  return SEMANTIC_LABELS;
}

interface SafePath {
  absolutePath: string;
  relativePath: string;
}

function ensureInsideRoot(root: string, requested: string): SafePath | null {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, requested);
  const rel = path.relative(resolvedRoot, candidate);
  if (rel === "") return { absolutePath: candidate, relativePath: "." };
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return { absolutePath: candidate, relativePath: rel };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    const fs = await import("node:fs/promises");
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function resolvePackSource(
  workspaceRoot: string,
  requestedPath: string
): Promise<ResolvedDashboardSource | null> {
  const fs = await import("node:fs/promises");
  const candidateManifest = requestedPath.endsWith("manifest.json")
    ? requestedPath
    : path.join(requestedPath, "manifest.json");
  let raw: string;
  try {
    raw = await fs.readFile(candidateManifest, "utf8");
  } catch {
    return null;
  }

  let parsed: PackManifest;
  try {
    parsed = JSON.parse(raw) as PackManifest;
  } catch {
    return null;
  }

  const relSimulationResult = parsed.outputs?.simulation_result;
  if (!relSimulationResult) return null;
  const safeResult = ensureInsideRoot(workspaceRoot, relSimulationResult);
  if (!safeResult) return null;

  const artifactDir = path.dirname(safeResult.absolutePath);
  try {
    await fs.stat(path.join(artifactDir, "simulation-result.json"));
  } catch {
    return null;
  }

  return {
    source: makeDashboardSource(artifactDir),
    absolutePath: artifactDir,
    relativePath: path.relative(path.resolve(workspaceRoot), artifactDir) || "."
  };
}
