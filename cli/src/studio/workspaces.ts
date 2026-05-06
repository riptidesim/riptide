// Studio workspace discovery.
//
// A "workspace" is a directory that contains (or could contain) a
// `.riptide/` folder. Studio shows the current repo as the primary
// workspace and, when `--case-studies-root` is given, every immediate
// subdirectory of that root that has a `.riptide/` folder.
//
// The discovery is read-only and deterministic: results are sorted
// alphabetically by id, with the current workspace pinned first. We
// never traverse `.git`, `target`, `node_modules`, `dist`, or other
// generated-heavy trees from this layer; deeper artifact reads are
// scoped per workspace.

import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export interface StudioWorkspaceWarning {
  message: string;
  next_action: string;
}

export interface StudioWorkspace {
  /** Stable identifier used in API queries — slug for case-studies, "current" for cwd. */
  id: string;
  /** Display label shown in the UI. */
  label: string;
  /** Source: "current" (cwd) or "case-study". */
  source: "current" | "case-study";
  /** Absolute repo path. */
  path: string;
  /** Path to `.riptide/`. May not exist yet. */
  riptide_path: string;
  /** Whether `.riptide/` was found. */
  has_riptide: boolean;
  /** Warnings explaining missing or malformed state and what to do next. */
  warnings: StudioWorkspaceWarning[];
}

export interface DiscoverWorkspacesOptions {
  /** Current working directory or repo root. Required. */
  cwd: string;
  /** Optional case-studies parent directory. Each child with `.riptide/` is a workspace. */
  caseStudiesRoot?: string;
}

const PRIMARY_ID = "current" as const;

export async function discoverStudioWorkspaces(
  options: DiscoverWorkspacesOptions
): Promise<StudioWorkspace[]> {
  const cwd = path.resolve(options.cwd);
  const primary = await describeWorkspace({
    id: PRIMARY_ID,
    label: workspaceLabel(cwd),
    source: "current",
    repoPath: cwd
  });

  const studies = options.caseStudiesRoot
    ? await discoverCaseStudyWorkspaces(path.resolve(options.caseStudiesRoot))
    : [];

  const out = [primary, ...studies];
  return out.sort((a, b) => primaryFirst(a, b) || compareStrings(a.id, b.id));
}

async function discoverCaseStudyWorkspaces(root: string): Promise<StudioWorkspace[]> {
  const rootStat = await safeStat(root);
  if (!rootStat || !rootStat.isDirectory()) return [];

  const entries = await readdir(root, { withFileTypes: true });
  const out: StudioWorkspace[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    const repoPath = path.join(root, entry.name);
    const riptidePath = path.join(repoPath, ".riptide");
    const riptideStat = await safeStat(riptidePath);
    if (!riptideStat || !riptideStat.isDirectory()) continue;
    out.push(
      await describeWorkspace({
        id: entry.name,
        label: entry.name,
        source: "case-study",
        repoPath
      })
    );
  }
  return out.sort((a, b) => compareStrings(a.id, b.id));
}

interface DescribeInput {
  id: string;
  label: string;
  source: "current" | "case-study";
  repoPath: string;
}

async function describeWorkspace(input: DescribeInput): Promise<StudioWorkspace> {
  const riptidePath = path.join(input.repoPath, ".riptide");
  const riptideStat = await safeStat(riptidePath);
  const hasRiptide = Boolean(riptideStat?.isDirectory());
  const warnings: StudioWorkspaceWarning[] = [];
  if (!hasRiptide) {
    warnings.push({
      message: `${path.basename(input.repoPath)} has no .riptide/ folder`,
      next_action: "Run `riptide init` in this workspace to scaffold adapters and scenarios."
    });
  }
  return {
    id: input.id,
    label: input.label,
    source: input.source,
    path: input.repoPath,
    riptide_path: riptidePath,
    has_riptide: hasRiptide,
    warnings
  };
}

async function safeStat(target: string) {
  try {
    return await stat(target);
  } catch {
    return null;
  }
}

function workspaceLabel(cwd: string): string {
  const base = path.basename(cwd);
  return base.length > 0 ? base : cwd;
}

function primaryFirst(a: StudioWorkspace, b: StudioWorkspace): number {
  if (a.source === b.source) return 0;
  if (a.source === "current") return -1;
  if (b.source === "current") return 1;
  return 0;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
