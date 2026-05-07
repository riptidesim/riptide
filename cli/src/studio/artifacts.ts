// Studio artifact indexer.
//
// Walks a workspace's `.riptide/` tree and produces a deterministic
// list of artifact entries Studio can render: run collections,
// individual scenario runs, replay packs, campaign roots, retained
// cases, guided-sim manifests/artifacts, readiness reports, and Markdown
// summaries.
//
// The indexer is intentionally a thin schema-agnostic walker. Where a
// JSON file is small and structured (e.g. `last-run.json`,
// `run-collection.json`), it parses to surface verdict/status/coverage
// hints. Larger artifacts are reported as path entries with
// modification time so the UI can fetch detail on demand. Missing or
// malformed artifacts produce warnings with next-action hints rather
// than a blank UI.
//
// Heavy / generated trees are skipped: `.git`, `target`, `node_modules`,
// `dist`, plus per-run `outputs/` subtrees that contain compiled BPF
// caches. The walk stops at a bounded depth.

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import toml from "toml";

export type StudioArtifactKind =
  | "run-collection"
  | "last-run"
  | "run"
  | "campaign-root"
  | "retained-case"
  | "campaign-input"
  | "pack"
  | "guided-sim"
  | "readiness-report"
  | "markdown-summary"
  | "scenario"
  | "adapter";

export interface StudioArtifactWarning {
  message: string;
  next_action: string;
}

export interface StudioArtifactEntry {
  /** Stable id within a workspace; sorted lexicographically. */
  id: string;
  /** Artifact kind enum. */
  kind: StudioArtifactKind;
  /** Display label (file or folder name + qualifier). */
  label: string;
  /** Workspace-relative path. */
  relative_path: string;
  /** Absolute path on disk. */
  path: string;
  /** Last modification time as ISO 8601, or null if unknown. */
  updated_at: string | null;
  /** Optional verdict label sourced from the artifact when readable. */
  verdict?: string;
  /** Optional coverage label sourced from the artifact when readable. */
  coverage?: string;
  /** Optional confidence label sourced from interpretation output when readable. */
  confidence?: string;
  /** Optional status label sourced from the artifact when readable. */
  status?: string;
  /** Optional canonical hash where the artifact pins one. */
  canonical_hash?: string;
  /** Number of invariant fires when known. */
  invariant_fire_count?: number;
  /** Optional aggregate status totals from collection-style artifacts. */
  totals_by_status?: Record<string, number>;
  /** Optional aggregate verdict totals from collection-style artifacts. */
  totals_by_verdict?: Record<string, number>;
  /** Optional aggregate coverage totals from collection-style artifacts. */
  totals_by_coverage?: Record<string, number>;
  /** Free-form per-artifact metadata (small and stable). */
  meta?: Record<string, string | number | boolean | null>;
  /** Warnings about missing/malformed sub-artifacts, with next actions. */
  warnings: StudioArtifactWarning[];
}

export interface StudioArtifactIndex {
  workspace_id: string;
  workspace_path: string;
  has_riptide: boolean;
  artifacts: StudioArtifactEntry[];
  warnings: StudioArtifactWarning[];
}

export interface IndexArtifactsOptions {
  workspaceId: string;
  workspacePath: string;
}

const SKIP_DIR_NAMES = new Set([
  ".git",
  "target",
  "node_modules",
  "dist",
  "build",
  "outputs", // per-run BPF caches
  ".cargo",
  ".idea",
  ".vscode"
]);

const MAX_DEPTH = 6;

export async function indexWorkspaceArtifacts(
  options: IndexArtifactsOptions
): Promise<StudioArtifactIndex> {
  const root = path.resolve(options.workspacePath);
  const riptidePath = path.join(root, ".riptide");
  const riptideStat = await safeStat(riptidePath);
  const warnings: StudioArtifactWarning[] = [];

  if (!riptideStat || !riptideStat.isDirectory()) {
    warnings.push({
      message: ".riptide/ folder not found in workspace",
      next_action: "Run `riptide init` to scaffold adapters, scenarios, and runs."
    });
    return {
      workspace_id: options.workspaceId,
      workspace_path: root,
      has_riptide: false,
      artifacts: [],
      warnings
    };
  }

  const artifacts: StudioArtifactEntry[] = [];
  const runInterpretations = await loadRunCollectionInterpretations(root);

  // 1) Run collection (top-level summary of last sweep).
  await collectRunCollection(root, artifacts);
  // 2) last-run.json (per-run summary the engine wrote).
  await collectLastRun(root, artifacts);
  // 3) Per-scenario runs under `.riptide/runs/`.
  await collectScenarioRuns(root, artifacts, runInterpretations);
  // 4) Campaign roots and retained cases under `.riptide/campaigns/`.
  await collectCampaignRoots(root, artifacts);
  // 5) Pack manifests under `.riptide/pack/`.
  await collectPacks(root, artifacts);
  // 6) Guided-sim manifests/artifacts under `.riptide/sim/` and legacy `.riptide/sims/`.
  await collectGuidedSims(root, artifacts);
  // 7) Readiness reports under `.riptide/readiness/` and Sprint 30 report roots.
  await collectReadinessReports(root, options.workspaceId, artifacts);
  // 8) Markdown summaries at top-level `.riptide/`.
  await collectTopLevelMarkdown(root, artifacts);
  // 9) Scenario presets and adapters (browseable, not run history).
  await collectScenarios(root, artifacts);
  await collectAdapters(root, artifacts);

  artifacts.sort((a, b) => compareStrings(a.id, b.id));

  return {
    workspace_id: options.workspaceId,
    workspace_path: root,
    has_riptide: true,
    artifacts,
    warnings
  };
}

// ---- collectors ----

async function collectRunCollection(
  root: string,
  artifacts: StudioArtifactEntry[]
): Promise<void> {
  const file = path.join(root, ".riptide", "run-collection.json");
  const fileStat = await safeStat(file);
  if (!fileStat) return;
  const entry = await readJsonArtifact<{
    schema_version?: number;
    total_scenarios?: number;
    totals_by_status?: Record<string, number>;
    totals_by_verdict?: Record<string, number>;
    totals_by_coverage?: Record<string, number>;
    scenarios?: Array<{
      status?: string;
      interpretation?: {
        verdict?: string;
        confidence?: string;
        coverage?: string;
      };
    }>;
  }>(file);
  const meta: Record<string, string | number | boolean | null> = {};
  const warnings: StudioArtifactWarning[] = [];
  let status: string | undefined;
  let verdict: string | undefined;
  let coverage: string | undefined;
  let confidence: string | undefined;

  if (entry.parsed) {
    if (typeof entry.parsed.schema_version === "number") {
      meta.schema_version = entry.parsed.schema_version;
    }
    if (typeof entry.parsed.total_scenarios === "number") {
      meta.total_scenarios = entry.parsed.total_scenarios;
    }
    status = dominantKey(entry.parsed.totals_by_status);
    verdict = dominantKey(entry.parsed.totals_by_verdict);
    coverage = dominantKey(entry.parsed.totals_by_coverage);
    confidence = dominantString(
      entry.parsed.scenarios?.map((row) => row.interpretation?.confidence)
    );
  } else if (entry.parseError) {
    warnings.push({
      message: `run-collection.json is unreadable: ${entry.parseError}`,
      next_action: "Re-run `riptide run` to regenerate the collection."
    });
  }

  artifacts.push({
    id: "run-collection",
    kind: "run-collection",
    label: "run-collection.json",
    relative_path: relTo(root, file),
    path: file,
    updated_at: fileStat.mtime.toISOString(),
    status,
    verdict,
    coverage,
    confidence,
    totals_by_status: entry.parsed?.totals_by_status,
    totals_by_verdict: entry.parsed?.totals_by_verdict,
    totals_by_coverage: entry.parsed?.totals_by_coverage,
    meta,
    warnings
  });
}

async function collectLastRun(root: string, artifacts: StudioArtifactEntry[]): Promise<void> {
  const file = path.join(root, ".riptide", "last-run.json");
  const fileStat = await safeStat(file);
  if (!fileStat) return;
  const entry = await readJsonArtifact<{
    schema_version?: number;
    scenarios?: Array<{ name?: string; status?: string }>;
  }>(file);
  const meta: Record<string, string | number | boolean | null> = {};
  const warnings: StudioArtifactWarning[] = [];

  if (entry.parsed) {
    if (typeof entry.parsed.schema_version === "number") {
      meta.schema_version = entry.parsed.schema_version;
    }
    if (Array.isArray(entry.parsed.scenarios)) {
      meta.total_scenarios = entry.parsed.scenarios.length;
    }
  } else if (entry.parseError) {
    warnings.push({
      message: `last-run.json is unreadable: ${entry.parseError}`,
      next_action: "Re-run `riptide run` to regenerate last-run.json."
    });
  }

  artifacts.push({
    id: "last-run",
    kind: "last-run",
    label: "last-run.json",
    relative_path: relTo(root, file),
    path: file,
    updated_at: fileStat.mtime.toISOString(),
    meta,
    warnings
  });
}

async function collectScenarioRuns(
  root: string,
  artifacts: StudioArtifactEntry[],
  runInterpretations: Map<string, RunCollectionInterpretation>
): Promise<void> {
  const runsRoot = path.join(root, ".riptide", "runs");
  const entries = await readdirSafe(runsRoot);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(runsRoot, entry.name);
    const dirStat = await safeStat(dir);
    if (!dirStat) continue;
    const resultPath = path.join(dir, "simulation-result.json");
    const reportPath = path.join(dir, "report.md");
    const resultStat = await safeStat(resultPath);
    const reportStat = await safeStat(reportPath);
    const warnings: StudioArtifactWarning[] = [];
    const meta: Record<string, string | number | boolean | null> = {
      has_simulation_result: Boolean(resultStat),
      has_report: Boolean(reportStat)
    };
    let status: string | undefined;
    let verdict: string | undefined;
    let coverage: string | undefined;
    let confidence: string | undefined;
    let invariantFireCount: number | undefined;

    if (resultStat) {
      const parsed = await readJsonArtifact<{
        seed?: number;
        total_ticks?: number;
        events?: Array<{ action?: string }>;
        summary?: { invariants_fired?: Array<{ firings?: number }> };
      }>(resultPath);
      if (parsed.parsed) {
        if (typeof parsed.parsed.total_ticks === "number") {
          meta.total_ticks = parsed.parsed.total_ticks;
        }
        if (typeof parsed.parsed.seed === "number") {
          meta.seed = parsed.parsed.seed;
        }
        invariantFireCount = countInvariantFires(parsed.parsed);
        status = invariantFireCount > 0 ? "fail" : "pass";
      } else if (parsed.parseError) {
        warnings.push({
          message: `simulation-result.json is unreadable: ${parsed.parseError}`,
          next_action: `Re-run scenario ${entry.name} or inspect the JSON.`
        });
      }
    } else {
      warnings.push({
        message: `simulation-result.json missing for scenario ${entry.name}`,
        next_action: `Re-run \`riptide run ${entry.name}\` to regenerate the artifact.`
      });
    }

    if (!reportStat) {
      warnings.push({
        message: `report.md missing for scenario ${entry.name}`,
        next_action: `Re-run \`riptide run ${entry.name}\` so the report is regenerated.`
      });
    }

    const interpretation = runInterpretations.get(entry.name);
    if (interpretation) {
      status = interpretation.status ?? status;
      verdict = interpretation.verdict;
      coverage = interpretation.coverage;
      confidence = interpretation.confidence;
    }

    artifacts.push({
      id: `run:${entry.name}`,
      kind: "run",
      label: entry.name,
      relative_path: relTo(root, dir),
      path: dir,
      updated_at: dirStat.mtime.toISOString(),
      status,
      verdict,
      coverage,
      confidence,
      invariant_fire_count: invariantFireCount,
      meta,
      warnings
    });
  }
}

async function collectCampaignRoots(
  root: string,
  artifacts: StudioArtifactEntry[]
): Promise<void> {
  const campaignsRoot = path.join(root, ".riptide", "campaigns");
  const entries = await readdirSafe(campaignsRoot);
  for (const entry of entries) {
    const full = path.join(campaignsRoot, entry.name);
    if (entry.isDirectory()) {
      const stats = await safeStat(full);
      if (!stats) continue;
      const summaryPath = path.join(full, "campaign-summary.json");
      const summaryStat = await safeStat(summaryPath);
      const meta: Record<string, string | number | boolean | null> = {
        has_summary: Boolean(summaryStat)
      };
      const warnings: StudioArtifactWarning[] = [];
      let verdict: string | undefined;
      let canonicalHash: string | undefined;

      if (summaryStat) {
        const parsed = await readJsonArtifact<{
          total_runs?: number;
          retained_runs?: number;
          dominant_verdict?: string;
          canonical_hash?: string;
          campaign_digest?: string;
          campaign?: {
            class?: string;
            risk_objective?: string;
            requested_runs?: number;
            run_budget?: number;
            campaign_digest?: string;
          };
          totals?: {
            requested_runs?: number;
            completed_runs?: number;
            passed_runs?: number;
            invariant_failed_runs?: number;
            setup_errors?: number;
          };
          retention?: {
            selected?: unknown[];
          };
        }>(summaryPath);
        if (parsed.parsed) {
          const totalRuns =
            typeof parsed.parsed.total_runs === "number"
              ? parsed.parsed.total_runs
              : typeof parsed.parsed.totals?.requested_runs === "number"
                ? parsed.parsed.totals.requested_runs
                : typeof parsed.parsed.campaign?.requested_runs === "number"
                  ? parsed.parsed.campaign.requested_runs
                  : undefined;
          const retainedRuns =
            typeof parsed.parsed.retained_runs === "number"
              ? parsed.parsed.retained_runs
              : Array.isArray(parsed.parsed.retention?.selected)
                ? parsed.parsed.retention.selected.length
                : undefined;
          if (typeof totalRuns === "number") meta.total_runs = totalRuns;
          if (typeof retainedRuns === "number") {
            meta.retained_runs = retainedRuns;
          }
          if (typeof parsed.parsed.dominant_verdict === "string") verdict = parsed.parsed.dominant_verdict;
          if (typeof parsed.parsed.canonical_hash === "string") canonicalHash = parsed.parsed.canonical_hash;
          if (typeof parsed.parsed.campaign?.class === "string") {
            meta.protocol_class = parsed.parsed.campaign.class;
          }
          if (typeof parsed.parsed.campaign?.risk_objective === "string") {
            meta.risk_objective = parsed.parsed.campaign.risk_objective;
          }
          if (typeof parsed.parsed.campaign?.campaign_digest === "string") {
            meta.campaign_digest = parsed.parsed.campaign.campaign_digest;
          } else if (typeof parsed.parsed.campaign_digest === "string") {
            meta.campaign_digest = parsed.parsed.campaign_digest;
          }
          if (!verdict && parsed.parsed.totals) {
            const failed = parsed.parsed.totals.invariant_failed_runs ?? 0;
            const setupErrors = parsed.parsed.totals.setup_errors ?? 0;
            const passed = parsed.parsed.totals.passed_runs ?? 0;
            if (failed > 0) verdict = "failure-observed";
            else if (setupErrors > 0) verdict = "setup-error";
            else if (passed > 0) verdict = "no-failure-observed";
          }
        } else if (parsed.parseError) {
          warnings.push({
            message: `campaign-summary.json is unreadable: ${parsed.parseError}`,
            next_action: `Re-run \`riptide campaign run ${entry.name}\` to regenerate the summary.`
          });
        }
      } else {
        warnings.push({
          message: `campaign root ${entry.name} has no campaign-summary.json`,
          next_action: "Run `riptide campaign run` to populate the summary."
        });
      }

      artifacts.push({
        id: `campaign:${entry.name}`,
        kind: "campaign-root",
        label: entry.name,
        relative_path: relTo(root, full),
        path: full,
        updated_at: stats.mtime.toISOString(),
        verdict,
        canonical_hash: canonicalHash,
        meta,
        warnings
      });

      // Retained cases inside this campaign root.
      const retainedDir = path.join(full, "retained");
      const retainedEntries = await readdirSafe(retainedDir);
      for (const retained of retainedEntries) {
        if (!retained.isDirectory()) continue;
        const retainedPath = path.join(retainedDir, retained.name);
        const retainedStat = await safeStat(retainedPath);
        if (!retainedStat) continue;
        artifacts.push({
          id: `retained:${entry.name}/${retained.name}`,
          kind: "retained-case",
          label: `${entry.name}/${retained.name}`,
          relative_path: relTo(root, retainedPath),
          path: retainedPath,
          updated_at: retainedStat.mtime.toISOString(),
          meta: { campaign: entry.name },
          warnings: []
        });
      }
    } else if (entry.isFile() && entry.name.endsWith(".campaign.toml")) {
      const stats = await safeStat(full);
      if (!stats) continue;
      artifacts.push({
        id: `campaign-input:${entry.name}`,
        kind: "campaign-input",
        label: entry.name,
        relative_path: relTo(root, full),
        path: full,
        updated_at: stats.mtime.toISOString(),
        meta: {},
        warnings: []
      });
    }
  }
}

async function collectPacks(root: string, artifacts: StudioArtifactEntry[]): Promise<void> {
  const packRoot = path.join(root, ".riptide", "pack");
  const entries = await readdirSafe(packRoot);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(packRoot, entry.name);
    const dirStat = await safeStat(dir);
    if (!dirStat) continue;
    const manifestPath = path.join(dir, "manifest.json");
    const manifestStat = await safeStat(manifestPath);
    const warnings: StudioArtifactWarning[] = [];
    const meta: Record<string, string | number | boolean | null> = {
      has_manifest: Boolean(manifestStat)
    };
    let canonicalHash: string | undefined;

    if (manifestStat) {
      const parsed = await readJsonArtifact<{
        canonical_hash?: string;
        scenario?: string;
      }>(manifestPath);
      if (parsed.parsed) {
        if (typeof parsed.parsed.canonical_hash === "string") {
          canonicalHash = parsed.parsed.canonical_hash;
        }
        if (typeof parsed.parsed.scenario === "string") {
          meta.scenario = parsed.parsed.scenario;
        }
      } else if (parsed.parseError) {
        warnings.push({
          message: `pack manifest is unreadable: ${parsed.parseError}`,
          next_action: `Re-run \`riptide run ${entry.name}\` (or \`riptide replay\`) to regenerate the pack.`
        });
      }
    } else {
      warnings.push({
        message: `pack ${entry.name} has no manifest.json`,
        next_action: `Re-run the source scenario for ${entry.name} to regenerate the pack.`
      });
    }

    artifacts.push({
      id: `pack:${entry.name}`,
      kind: "pack",
      label: entry.name,
      relative_path: relTo(root, dir),
      path: dir,
      updated_at: dirStat.mtime.toISOString(),
      canonical_hash: canonicalHash,
      meta,
      warnings
    });
  }
}

async function collectGuidedSims(
  root: string,
  artifacts: StudioArtifactEntry[]
): Promise<void> {
  await collectSingularGuidedSim(root, artifacts);
  await collectGuidedSimRunArtifacts(root, artifacts);
  await collectLegacyGuidedSims(root, artifacts);
}

async function collectSingularGuidedSim(
  root: string,
  artifacts: StudioArtifactEntry[]
): Promise<void> {
  const dir = path.join(root, ".riptide", "sim");
  const dirStat = await safeStat(dir);
  if (!dirStat?.isDirectory()) return;

  const riptideToml = path.join(dir, "Riptide.toml");
  const cargoToml = path.join(dir, "Cargo.toml");
  const artifactsDir = path.join(dir, "artifacts");
  const riptideTomlStat = await safeStat(riptideToml);
  const cargoTomlStat = await safeStat(cargoToml);
  const artifactsDirStat = await safeStat(artifactsDir);
  const warnings: StudioArtifactWarning[] = [];

  if (!riptideTomlStat) {
    warnings.push({
      message: ".riptide/sim exists but Riptide.toml is missing",
      next_action: "Run `riptide sim generate --adapter <adapter>` or restore `.riptide/sim/Riptide.toml`."
    });
  }

  artifacts.push({
    id: "guided-sim:sim",
    kind: "guided-sim",
    label: ".riptide/sim",
    relative_path: relTo(root, dir),
    path: dir,
    updated_at: dirStat.mtime.toISOString(),
    meta: {
      has_riptide_toml: Boolean(riptideTomlStat),
      has_cargo_toml: Boolean(cargoTomlStat),
      has_artifacts: Boolean(artifactsDirStat?.isDirectory())
    },
    warnings
  });
}

async function collectGuidedSimRunArtifacts(
  root: string,
  artifacts: StudioArtifactEntry[]
): Promise<void> {
  const artifactsRoot = path.join(root, ".riptide", "sim", "artifacts");
  await walkGuidedSimArtifacts(root, artifactsRoot, artifacts, 0);
}

async function walkGuidedSimArtifacts(
  root: string,
  dir: string,
  artifacts: StudioArtifactEntry[],
  depth: number
): Promise<void> {
  if (depth > MAX_DEPTH) return;
  const entries = await readdirSafe(dir);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      await walkGuidedSimArtifacts(root, full, artifacts, depth + 1);
      continue;
    }
    if (!entry.isFile() || entry.name !== "guided-sim-run.json") continue;

    const fileStat = await safeStat(full);
    if (!fileStat) continue;
    const container = path.dirname(full);
    const parsed = await readJsonArtifact<{ status?: string; schema_version?: number }>(full);
    const warnings: StudioArtifactWarning[] = [];
    const meta: Record<string, string | number | boolean | null> = {};
    let status: string | undefined;

    if (parsed.parsed) {
      if (typeof parsed.parsed.schema_version === "number") {
        meta.schema_version = parsed.parsed.schema_version;
      }
      if (typeof parsed.parsed.status === "string") {
        status = parsed.parsed.status;
      }
    } else if (parsed.parseError) {
      warnings.push({
        message: `guided-sim-run.json is unreadable: ${parsed.parseError}`,
        next_action: "Re-run `riptide sim run .riptide/sim --out .riptide/sim/artifacts/<run-id>`."
      });
    }

    artifacts.push({
      id: `guided-sim-run:${relTo(root, container)}`,
      kind: "guided-sim",
      label: path.basename(container) || "guided-sim-run.json",
      relative_path: relTo(root, container),
      path: container,
      updated_at: fileStat.mtime.toISOString(),
      status,
      meta,
      warnings
    });
  }
}

async function collectLegacyGuidedSims(
  root: string,
  artifacts: StudioArtifactEntry[]
): Promise<void> {
  const simsRoot = path.join(root, ".riptide", "sims");
  const entries = await readdirSafe(simsRoot);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(simsRoot, entry.name);
    const dirStat = await safeStat(dir);
    if (!dirStat) continue;
    const manifestPath = path.join(dir, "manifest.json");
    const manifestStat = await safeStat(manifestPath);
    const warnings: StudioArtifactWarning[] = [];
    const meta: Record<string, string | number | boolean | null> = {
      has_manifest: Boolean(manifestStat)
    };

    if (!manifestStat) {
      warnings.push({
        message: `guided-sim ${entry.name} has no manifest.json`,
        next_action: "Re-run `riptide sim run` for this guided scenario."
      });
    }

    artifacts.push({
      id: `guided-sim:${entry.name}`,
      kind: "guided-sim",
      label: entry.name,
      relative_path: relTo(root, dir),
      path: dir,
      updated_at: dirStat.mtime.toISOString(),
      meta,
      warnings
    });
  }
}

async function collectReadinessReports(
  root: string,
  workspaceId: string,
  artifacts: StudioArtifactEntry[]
): Promise<void> {
  const readinessRoot = path.join(root, ".riptide", "readiness");
  const seen = new Set<string>();
  const workspaceSlug = workspaceId === "current" ? path.basename(root) : workspaceId;
  const entries = await readdirSafe(readinessRoot);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".json") && !entry.name.endsWith(".md")) continue;
    const file = path.join(readinessRoot, entry.name);
    const fileStat = await safeStat(file);
    if (!fileStat) continue;
    const metadata = await readinessMetadata(file, workspaceSlug);
    seen.add(path.resolve(file));
    artifacts.push({
      id: `readiness:${entry.name}`,
      kind: "readiness-report",
      label: entry.name,
      relative_path: relTo(root, file),
      path: file,
      updated_at: fileStat.mtime.toISOString(),
      status: metadata.status,
      verdict: metadata.verdict,
      meta: metadata.meta,
      warnings: []
    });
  }

  const reportRoots = readinessReportRoots(root);
  for (const reportRoot of reportRoots) {
    await collectCaseStudyReadinessReports({
      workspaceRoot: root,
      reportRoot,
      workspaceSlug,
      artifacts,
      seen
    });
  }
}

interface CaseStudyReadinessInput {
  workspaceRoot: string;
  reportRoot: string;
  workspaceSlug: string;
  artifacts: StudioArtifactEntry[];
  seen: Set<string>;
}

async function collectCaseStudyReadinessReports(input: CaseStudyReadinessInput): Promise<void> {
  const rootStat = await safeStat(input.reportRoot);
  if (!rootStat?.isDirectory()) return;
  await walkCaseStudyReadinessReports(input, input.reportRoot, 0);
}

async function walkCaseStudyReadinessReports(
  input: CaseStudyReadinessInput,
  dir: string,
  depth: number
): Promise<void> {
  if (depth > MAX_DEPTH) return;
  const entries = await readdirSafe(dir);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      await walkCaseStudyReadinessReports(input, full, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;

    const relFromReportRoot = relTo(input.reportRoot, full);
    if (!isCaseStudyReadinessReport(relFromReportRoot, input.workspaceSlug)) continue;

    const resolved = path.resolve(full);
    if (input.seen.has(resolved)) continue;
    const fileStat = await safeStat(full);
    if (!fileStat) continue;
    const metadata = await readinessMetadata(full, input.workspaceSlug);
    input.seen.add(resolved);

    const relativePath = path.join("reports", "case-study-readiness", relFromReportRoot);
    input.artifacts.push({
      id: `readiness:${relativePath}`,
      kind: "readiness-report",
      label: relFromReportRoot,
      relative_path: relativePath,
      path: full,
      updated_at: fileStat.mtime.toISOString(),
      status: metadata.status,
      verdict: metadata.verdict,
      meta: { source: "case-study-readiness", ...metadata.meta },
      warnings: []
    });
  }
}

async function collectTopLevelMarkdown(
  root: string,
  artifacts: StudioArtifactEntry[]
): Promise<void> {
  const riptideRoot = path.join(root, ".riptide");
  const entries = await readdirSafe(riptideRoot);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;
    const file = path.join(riptideRoot, entry.name);
    const fileStat = await safeStat(file);
    if (!fileStat) continue;
    artifacts.push({
      id: `summary:${entry.name}`,
      kind: "markdown-summary",
      label: entry.name,
      relative_path: relTo(root, file),
      path: file,
      updated_at: fileStat.mtime.toISOString(),
      meta: {},
      warnings: []
    });
  }
}

async function collectScenarios(
  root: string,
  artifacts: StudioArtifactEntry[]
): Promise<void> {
  const scenariosRoot = path.join(root, ".riptide", "scenarios");
  const entries = await readdirSafe(scenariosRoot);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(scenariosRoot, entry.name);
    const dirStat = await safeStat(dir);
    if (!dirStat) continue;
    artifacts.push({
      id: `scenario:${entry.name}`,
      kind: "scenario",
      label: entry.name,
      relative_path: relTo(root, dir),
      path: dir,
      updated_at: dirStat.mtime.toISOString(),
      meta: {},
      warnings: []
    });
  }
}

async function collectAdapters(
  root: string,
  artifacts: StudioArtifactEntry[]
): Promise<void> {
  const adaptersRoot = path.join(root, ".riptide", "adapters");
  const entries = await readdirSafe(adaptersRoot);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".toml")) continue;
    const file = path.join(adaptersRoot, entry.name);
    const fileStat = await safeStat(file);
    if (!fileStat) continue;
    const parsed = await readTomlArtifact<{
      protocol?: string;
      semantics?: { class?: string };
    }>(file);
    const meta: Record<string, string | number | boolean | null> = {};
    const warnings: StudioArtifactWarning[] = [];
    if (parsed.parsed) {
      if (typeof parsed.parsed.protocol === "string") meta.protocol = parsed.parsed.protocol;
      if (typeof parsed.parsed.semantics?.class === "string") {
        meta.protocol_class = parsed.parsed.semantics.class;
      }
    } else if (parsed.parseError) {
      warnings.push({
        message: `${entry.name} could not be parsed for protocol metadata: ${parsed.parseError}`,
        next_action: "Run `riptide lint` on this adapter and fix the TOML before using Studio filters."
      });
    }
    artifacts.push({
      id: `adapter:${entry.name}`,
      kind: "adapter",
      label: entry.name,
      relative_path: relTo(root, file),
      path: file,
      updated_at: fileStat.mtime.toISOString(),
      meta,
      warnings
    });
  }
}

// ---- helpers ----

interface ParsedJsonArtifact<T> {
  parsed: T | null;
  parseError: string | null;
}

type ParsedTomlArtifact<T> = ParsedJsonArtifact<T>;

interface RunCollectionInterpretation {
  status?: string;
  verdict?: string;
  coverage?: string;
  confidence?: string;
}

async function readJsonArtifact<T>(file: string): Promise<ParsedJsonArtifact<T>> {
  try {
    const raw = await readFile(file, "utf8");
    return { parsed: JSON.parse(raw) as T, parseError: null };
  } catch (err) {
    return {
      parsed: null,
      parseError: (err as Error).message ?? String(err)
    };
  }
}

async function readTomlArtifact<T>(file: string): Promise<ParsedTomlArtifact<T>> {
  try {
    const raw = await readFile(file, "utf8");
    return { parsed: toml.parse(raw) as T, parseError: null };
  } catch (err) {
    return {
      parsed: null,
      parseError: (err as Error).message ?? String(err)
    };
  }
}

async function loadRunCollectionInterpretations(
  root: string
): Promise<Map<string, RunCollectionInterpretation>> {
  const file = path.join(root, ".riptide", "run-collection.json");
  const parsed = await readJsonArtifact<{
    scenarios?: Array<{
      name?: string;
      status?: string;
      interpretation?: {
        verdict?: string;
        coverage?: string;
        confidence?: string;
      };
    }>;
  }>(file);
  const out = new Map<string, RunCollectionInterpretation>();
  if (!parsed.parsed || !Array.isArray(parsed.parsed.scenarios)) return out;
  for (const scenario of parsed.parsed.scenarios) {
    if (typeof scenario.name !== "string") continue;
    out.set(scenario.name, {
      status: typeof scenario.status === "string" ? scenario.status : undefined,
      verdict:
        typeof scenario.interpretation?.verdict === "string"
          ? scenario.interpretation.verdict
          : undefined,
      coverage:
        typeof scenario.interpretation?.coverage === "string"
          ? scenario.interpretation.coverage
          : undefined,
      confidence:
        typeof scenario.interpretation?.confidence === "string"
          ? scenario.interpretation.confidence
          : undefined
    });
  }
  return out;
}

async function readinessMetadata(
  file: string,
  workspaceSlug: string
): Promise<{
  status?: string;
  verdict?: string;
  meta: Record<string, string | number | boolean | null>;
}> {
  if (!file.endsWith(".json")) return { meta: {} };
  const parsed = await readJsonArtifact<{
    rows?: Array<{
      slug?: string;
      support_status?: string;
      verdict?: string;
      support_level?: string;
      claim_level?: string;
    }>;
    verdict?: string;
    support_status?: string;
    support_level?: string;
    claim_level?: string;
  }>(file);
  if (!parsed.parsed) return { meta: {} };
  const row = Array.isArray(parsed.parsed.rows)
    ? parsed.parsed.rows.find((candidate) => candidate.slug === workspaceSlug)
    : parsed.parsed;
  const meta: Record<string, string | number | boolean | null> = {};
  if (typeof row?.support_level === "string") meta.support_level = row.support_level;
  if (typeof row?.claim_level === "string") meta.claim_level = row.claim_level;
  if (typeof row?.support_status === "string") meta.support_status = row.support_status;
  return {
    status: typeof row?.support_status === "string" ? row.support_status : undefined,
    verdict: typeof row?.verdict === "string" ? row.verdict : undefined,
    meta
  };
}

async function safeStat(target: string) {
  try {
    return await stat(target);
  } catch {
    return null;
  }
}

async function readdirSafe(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [] as Awaited<ReturnType<typeof readdir>> & Array<never>;
  }
}

function relTo(root: string, file: string): string {
  return path.relative(root, file) || ".";
}

function readinessReportRoots(root: string): string[] {
  const candidates = [
    path.join(root, "reports", "case-study-readiness"),
    // Case-study workspaces live under `<workspace>/case-studies/<slug>`,
    // while Sprint 30 raw readiness reports live in the sibling
    // Riptide repo at `<workspace>/riptide/reports/case-study-readiness`.
    path.resolve(root, "..", "..", "riptide", "reports", "case-study-readiness")
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function isCaseStudyReadinessReport(relPath: string, workspaceSlug: string): boolean {
  const normalized = relPath.split(path.sep).join("/");
  if (
    normalized.endsWith("/corpus-static/readiness.json") ||
    normalized.endsWith("/corpus-static/readiness.md")
  ) {
    return true;
  }
  return (
    normalized === `${workspaceSlug}/summary.md` ||
    normalized === `${workspaceSlug}/README.md` ||
    normalized === `${workspaceSlug}/readiness.json` ||
    normalized === `${workspaceSlug}/readiness.md`
  );
}

function dominantKey(map: Record<string, number> | undefined): string | undefined {
  if (!map) return undefined;
  let best: { key: string; value: number } | null = null;
  for (const [key, value] of Object.entries(map)) {
    if (typeof value !== "number") continue;
    if (!best || value > best.value || (value === best.value && key < best.key)) {
      best = { key, value };
    }
  }
  return best && best.value > 0 ? best.key : undefined;
}

function dominantString(values: Array<string | undefined> | undefined): string | undefined {
  if (!values) return undefined;
  const counts: Record<string, number> = {};
  for (const value of values) {
    if (!value) continue;
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return dominantKey(counts);
}

function countInvariantFires(result: {
  events?: Array<{ action?: string }>;
  summary?: { invariants_fired?: Array<{ firings?: number }> };
}): number {
  let fromEvents = 0;
  if (Array.isArray(result.events)) {
    for (const event of result.events) {
      if (typeof event?.action === "string" && event.action.startsWith("invariant_violation:")) {
        fromEvents += 1;
      }
    }
  }
  if (fromEvents > 0) return fromEvents;
  const rows = Array.isArray(result.summary?.invariants_fired) ? result.summary!.invariants_fired : [];
  let fromSummary = 0;
  for (const row of rows) {
    if (typeof row?.firings === "number" && row.firings > 0) fromSummary += row.firings;
  }
  return fromSummary;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// SKIP_DIR_NAMES is exported for test visibility only.
export { SKIP_DIR_NAMES, MAX_DEPTH };
