import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { ReadinessInspection } from "./inspector.js";
import type { ReadinessReason, ReadinessReport } from "./model.js";

export const READINESS_CORPUS_SCHEMA_VERSION = "case-study-readiness.v1" as const;
export const DETERMINISTIC_GENERATED_AT = "1970-01-01T00:00:00.000Z" as const;

export const READINESS_GATE_IDS = [
  "inventory-only",
  "static-health",
  "adapter-lint",
  "direct-baseline-run",
  "guided-sim-run-review",
  "campaign-validate-plan-run",
  "fresh-clone-eligibility",
] as const;
export type ReadinessGateId = (typeof READINESS_GATE_IDS)[number];

export const READINESS_VERDICTS = ["pass", "warn", "fail", "skipped", "blocked"] as const;
export type ReadinessVerdict = (typeof READINESS_VERDICTS)[number];

export const LAUNCH_CLAIM_LEVELS = [
  "demo-ready",
  "beta-ready",
  "readiness-only",
  "blocked",
] as const;
export type LaunchClaimLevel = (typeof LAUNCH_CLAIM_LEVELS)[number];

export interface ReadinessCaseStudyTarget {
  slug: string;
  path: string;
  riptide_path: string;
}

export interface ReadinessGateDefinition {
  id: ReadinessGateId;
  title: string;
  description: string;
  command_template: string;
  executed_by_default: boolean;
}

export interface ReadinessVerdictDefinition {
  verdict: ReadinessVerdict;
  meaning: string;
}

export interface LaunchClaimDefinition {
  claim_level: LaunchClaimLevel;
  meaning: string;
}

export interface ReadinessObservedSurfaces {
  adapters: string[];
  scenarios: string[];
  guided_sim_manifests: string[];
  campaigns: string[];
  run_collections: string[];
  last_run: string | null;
  harnesses: string[];
  packs: string[];
  reports: string[];
  runs: string[];
}

export interface ReadinessCorpusCommandResult {
  gate: ReadinessGateId;
  command: string;
  executed: boolean;
  verdict: ReadinessVerdict;
  exit_code: number | null;
  artifacts: string[];
  blocker: string | null;
  next_action: string;
}

export interface ReadinessCorpusRow {
  slug: string;
  path: string;
  observed_surfaces: ReadinessObservedSurfaces;
  missing_surfaces: string[];
  command_results: ReadinessCorpusCommandResult[];
  verdict: ReadinessVerdict;
  claim_level: LaunchClaimLevel;
  support_level: string;
  support_status: string;
  artifacts: string[];
  blocker: string | null;
  next_action: string;
  warnings: string[];
}

export interface ReadinessCorpusReport {
  schema_version: typeof READINESS_CORPUS_SCHEMA_VERSION;
  generated_at: string;
  case_studies_root: string;
  gates: ReadinessGateDefinition[];
  verdicts: ReadinessVerdictDefinition[];
  launch_claim_levels: LaunchClaimDefinition[];
  rows: ReadinessCorpusRow[];
}

export interface CreateReadinessCorpusRowInput {
  caseStudiesRoot: string;
  inspection: ReadinessInspection;
  report: ReadinessReport;
}

export interface CreateReadinessCorpusReportInput {
  caseStudiesRoot: string;
  rows: CreateReadinessCorpusRowInput[];
}

export const READINESS_GATE_DEFINITIONS: readonly ReadinessGateDefinition[] = [
  {
    id: "inventory-only",
    title: "Inventory only",
    description:
      "Discover immediate child repositories under the case-study root that contain a .riptide workspace.",
    command_template: "find <case-studies-root> -maxdepth 2 -type d -name .riptide | sort",
    executed_by_default: true,
  },
  {
    id: "static-health",
    title: "Static health",
    description:
      "Run readiness inspection without building, fetching, or executing simulations.",
    command_template: "riptide readiness <repo> --json",
    executed_by_default: true,
  },
  {
    id: "adapter-lint",
    title: "Adapter readiness",
    description:
      "Run the per-adapter static report against the repo-local adapter TOML and its declared lineage.",
    command_template: "riptide doctor",
    executed_by_default: false,
  },
  {
    id: "direct-baseline-run",
    title: "Guided-sim baseline run",
    description:
      "Generate and run a repo-local guided simulation to produce baseline evidence from the repo-local adapter.",
    command_template: "riptide sim generate --adapter <adapter>; riptide sim run .riptide/sim --flows <n>",
    executed_by_default: false,
  },
  {
    id: "guided-sim-run-review",
    title: "Guided-sim run and review",
    description:
      "Run a repo-local guided simulation manifest and review the produced guided artifact.",
    command_template: "riptide sim run <manifest> --out <artifact-dir>; riptide sim review <artifact-dir>",
    executed_by_default: false,
  },
  {
    id: "campaign-validate-plan-run",
    title: "Cartography and assessment",
    description:
      "Build cartography artifacts from a guided-sim sweep and generate an assessment without inferring readiness from static files alone.",
    command_template:
      "riptide sim surface <run-path> --sim .riptide/sim; riptide assess <guided-sim-root>",
    executed_by_default: false,
  },
  {
    id: "fresh-clone-eligibility",
    title: "Fresh-clone eligibility",
    description:
      "Confirm the public install and smoke path from a clean clone before making launch claims.",
    command_template:
      "git clone <repo> /tmp/riptide-fresh-clone; ./install.sh; riptide --help; riptide readiness <case-study>",
    executed_by_default: false,
  },
];

export const READINESS_VERDICT_DEFINITIONS: readonly ReadinessVerdictDefinition[] = [
  {
    verdict: "pass",
    meaning: "The gate executed and met the contract with no blocker.",
  },
  {
    verdict: "warn",
    meaning: "The gate executed and produced useful evidence, but a bounded caveat remains.",
  },
  {
    verdict: "fail",
    meaning: "The gate executed and found a concrete validation failure.",
  },
  {
    verdict: "skipped",
    meaning: "The gate was not executed in this report, or the surface is not applicable to this repo.",
  },
  {
    verdict: "blocked",
    meaning: "The gate could not run honestly until a prerequisite or local artifact is supplied.",
  },
];

export const LAUNCH_CLAIM_DEFINITIONS: readonly LaunchClaimDefinition[] = [
  {
    claim_level: "demo-ready",
    meaning:
      "Fresh static checks plus rerunnable direct or guided evidence support a live demo boundary.",
  },
  {
    claim_level: "beta-ready",
    meaning:
      "Static checks and at least one executed validation gate support cautious external testing, but not a launch demo claim.",
  },
  {
    claim_level: "readiness-only",
    meaning:
      "The repo is inventory/readiness evidence only until adapter lint or execution gates are run.",
  },
  {
    claim_level: "blocked",
    meaning:
      "The repo lacks a required local prerequisite or has a blocker that prevents honest readiness evidence.",
  },
];

export async function discoverCaseStudyTargets(
  root: string
): Promise<ReadinessCaseStudyTarget[]> {
  const rootStats = await safeStat(root);
  if (!rootStats) {
    throw new Error(`riptide readiness: case-study root not found: ${root}`);
  }
  if (!rootStats.isDirectory()) {
    throw new Error(`riptide readiness: case-study root is not a directory: ${root}`);
  }

  const entries = await readdir(root, { withFileTypes: true });
  const targets: ReadinessCaseStudyTarget[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const repoPath = path.join(root, entry.name);
    const riptidePath = path.join(repoPath, ".riptide");
    const riptideStats = await safeStat(riptidePath);
    if (!riptideStats?.isDirectory()) continue;
    targets.push({
      slug: entry.name,
      path: repoPath,
      riptide_path: riptidePath,
    });
  }
  return targets.sort((left, right) => compareStrings(left.slug, right.slug));
}

export function createReadinessCorpusReport(
  input: CreateReadinessCorpusReportInput
): ReadinessCorpusReport {
  return {
    schema_version: READINESS_CORPUS_SCHEMA_VERSION,
    generated_at: DETERMINISTIC_GENERATED_AT,
    case_studies_root: input.caseStudiesRoot,
    gates: [...READINESS_GATE_DEFINITIONS],
    verdicts: [...READINESS_VERDICT_DEFINITIONS],
    launch_claim_levels: [...LAUNCH_CLAIM_DEFINITIONS],
    rows: input.rows
      .map((row) => createReadinessCorpusRow(row))
      .sort((left, right) => compareStrings(left.slug, right.slug)),
  };
}

export function createReadinessCorpusRow(
  input: CreateReadinessCorpusRowInput
): ReadinessCorpusRow {
  const slug = path.basename(input.inspection.rootPath);
  const observed = observedSurfaces(input.inspection);
  const missing = missingSurfaces(observed);
  const artifacts = corpusArtifacts(observed);
  const commandResults = commandResultsFor({
    caseStudiesRoot: input.caseStudiesRoot,
    slug,
    repoPath: input.inspection.rootPath,
    observed,
    report: input.report,
  });
  const staticResult = commandResults.find((entry) => entry.gate === "static-health");
  const verdict = staticResult?.verdict ?? "blocked";
  const blocker = verdict === "blocked" || verdict === "fail" ? staticResult?.blocker ?? null : null;
  const nextAction = topLevelNextAction(input.report, verdict);

  return {
    slug,
    path: input.inspection.rootPath,
    observed_surfaces: observed,
    missing_surfaces: missing,
    command_results: commandResults,
    verdict,
    claim_level: deriveLaunchClaimLevel(verdict, commandResults),
    support_level: input.report.support.current,
    support_status: input.report.support.status,
    artifacts,
    blocker,
    next_action: nextAction,
    warnings: [...input.report.warnings].sort(compareStrings),
  };
}

export function deriveLaunchClaimLevel(
  verdict: ReadinessVerdict,
  commandResults: ReadinessCorpusCommandResult[]
): LaunchClaimLevel {
  if (verdict === "blocked" || verdict === "fail") return "blocked";

  const passed = (gate: ReadinessGateId) =>
    commandResults.some(
      (entry) => entry.gate === gate && entry.executed && entry.verdict === "pass"
    );
  const staticReady = passed("inventory-only") && passed("static-health");
  const adapterLint = passed("adapter-lint");
  const directRun = passed("direct-baseline-run");
  const guidedRun = passed("guided-sim-run-review");
  const campaignRun = passed("campaign-validate-plan-run");

  if (staticReady && adapterLint && (directRun || guidedRun) && (campaignRun || directRun)) {
    return "demo-ready";
  }
  if (staticReady && (adapterLint || directRun || guidedRun || campaignRun)) {
    return "beta-ready";
  }
  return "readiness-only";
}

function commandResultsFor(input: {
  caseStudiesRoot: string;
  slug: string;
  repoPath: string;
  observed: ReadinessObservedSurfaces;
  report: ReadinessReport;
}): ReadinessCorpusCommandResult[] {
  const adapter = input.observed.adapters[0] ?? null;
  const baseline = firstBaselineScenario(input.observed.scenarios);
  const guidedManifest = input.observed.guided_sim_manifests[0] ?? null;
  const campaign = input.observed.campaigns[0] ?? null;

  return [
    {
      gate: "inventory-only",
      command: `find ${shellQuote(input.caseStudiesRoot)} -maxdepth 2 -type d -name .riptide | sort`,
      executed: true,
      verdict: "pass",
      exit_code: 0,
      artifacts: [".riptide"],
      blocker: null,
      next_action: "Record the repo in the corpus matrix.",
    },
    staticHealthResult(input.repoPath, input.report),
    skippedGate({
      gate: "adapter-lint",
      command: `cd ${shellQuote(input.repoPath)} && riptide doctor`,
      artifacts: adapter ? [adapter] : [],
      nextAction: adapter
        ? "Run the per-adapter doctor report in the validation lane before upgrading the launch claim."
        : "Add a repo-local adapter TOML before running the per-adapter doctor report.",
    }),
    skippedGate({
      gate: "direct-baseline-run",
      command: adapter
        ? `cd ${shellQuote(input.repoPath)} && riptide sim generate --adapter ${shellQuote(adapter)} && riptide sim run .riptide/sim --flows 8`
        : `cd ${shellQuote(input.repoPath)} && riptide sim generate --adapter .riptide/adapters/<adapter>.toml && riptide sim run .riptide/sim --flows 8`,
      artifacts: [adapter, baseline].filter(isString),
      nextAction: adapter
        ? "Generate and run the guided simulation from a fresh shell before claiming local execution support."
        : "Add a repo-local adapter before generating and running a guided simulation.",
    }),
    skippedGate({
      gate: "guided-sim-run-review",
      command: guidedManifest
        ? `cd ${shellQuote(input.repoPath)} && riptide sim run ${shellQuote(guidedManifest)} --out /tmp/riptide-guided-sim-${input.slug} && riptide sim review /tmp/riptide-guided-sim-${input.slug}`
        : `cd ${shellQuote(input.repoPath)} && riptide sim run .riptide/sim --out /tmp/riptide-guided-sim-${input.slug}`,
      artifacts: guidedManifest ? [guidedManifest] : [],
      nextAction: guidedManifest
        ? "Run and review the guided-sim manifest before using guided evidence in the launch claim."
        : "No guided-sim manifest is present; keep this gate skipped unless guided support is added.",
    }),
    skippedGate({
      gate: "campaign-validate-plan-run",
      command: guidedManifest
        ? `cd ${shellQuote(input.repoPath)} && riptide sim surface .riptide/sim/artifacts/<dir> --sim ${shellQuote(guidedManifest)} && riptide assess .riptide/sim`
        : `cd ${shellQuote(input.repoPath)} && riptide sim surface .riptide/sim/artifacts/<dir> --sim .riptide/sim && riptide assess .riptide/sim`,
      artifacts: [guidedManifest, campaign].filter(isString),
      nextAction: guidedManifest
        ? "Build cartography artifacts and run the assessment before claiming assessment support."
        : "No guided-sim manifest is present; keep this gate skipped unless guided support is added.",
    }),
    skippedGate({
      gate: "fresh-clone-eligibility",
      command:
        "cd /tmp && git clone https://github.com/riptidesim/riptide riptide-fresh-clone && cd riptide-fresh-clone && ./install.sh && riptide --help",
      artifacts: [],
      nextAction:
        "Run the fresh-clone evaluator path before using the corpus report as promotional launch evidence.",
    }),
  ];
}

function staticHealthResult(
  repoPath: string,
  report: ReadinessReport
): ReadinessCorpusCommandResult {
  const verdict = readinessStatusVerdict(report.support.status);
  const reason = firstReason([
    ...report.support.blockedReasons,
    ...report.blockers,
    ...report.support.partialReasons,
  ]);
  return {
    gate: "static-health",
    command: `cd ${shellQuote(repoPath)} && riptide readiness . --json`,
    executed: true,
    verdict,
    exit_code: 0,
    artifacts: evidencePaths(report),
    blocker: verdict === "pass" ? null : reason,
    next_action: topLevelNextAction(report, verdict),
  };
}

function skippedGate(input: {
  gate: ReadinessGateId;
  command: string;
  artifacts: string[];
  nextAction: string;
}): ReadinessCorpusCommandResult {
  return {
    gate: input.gate,
    command: input.command,
    executed: false,
    verdict: "skipped",
    exit_code: null,
    artifacts: [...input.artifacts].sort(compareStrings),
    blocker: null,
    next_action: input.nextAction,
  };
}

function observedSurfaces(inspection: ReadinessInspection): ReadinessObservedSurfaces {
  return {
    adapters: artifactPaths(inspection.riptide.adapters),
    scenarios: artifactPaths(inspection.riptide.scenarios),
    guided_sim_manifests: artifactPaths(inspection.riptide.guidedSimManifests),
    campaigns: artifactPaths(inspection.riptide.campaignInputs),
    run_collections: artifactPaths(inspection.riptide.runCollections),
    last_run: inspection.riptide.lastRun?.relativePath ?? null,
    harnesses: inspection.riptide.harnesses
      .map((entry) => entry.relativePath)
      .sort(compareStrings),
    packs: artifactPaths(inspection.riptide.packs),
    reports: artifactPaths(inspection.riptide.reports),
    runs: artifactPaths(inspection.riptide.runs),
  };
}

function missingSurfaces(observed: ReadinessObservedSurfaces): string[] {
  const missing: string[] = [];
  if (observed.adapters.length === 0) missing.push("adapters");
  if (observed.scenarios.length === 0) missing.push("scenarios");
  if (observed.guided_sim_manifests.length === 0) missing.push("guided_sim_manifests");
  if (observed.campaigns.length === 0) missing.push("campaigns");
  if (observed.run_collections.length === 0) missing.push("run_collections");
  if (observed.last_run === null) missing.push("last_run");
  return missing.sort(compareStrings);
}

function corpusArtifacts(observed: ReadinessObservedSurfaces): string[] {
  return uniqueSorted([
    ...observed.run_collections,
    ...(observed.last_run ? [observed.last_run] : []),
    ...observed.packs,
    ...observed.reports,
    ...observed.runs,
  ]);
}

function artifactPaths(values: Array<{ relativePath: string }>): string[] {
  return values.map((entry) => entry.relativePath).sort(compareStrings);
}

function evidencePaths(report: ReadinessReport): string[] {
  return uniqueSorted(report.evidence.flatMap((entry) => entry.paths));
}

function topLevelNextAction(report: ReadinessReport, verdict: ReadinessVerdict): string {
  const next = report.nextActions[0];
  if (next) return next.action;
  if (verdict !== "pass") {
    return "Inspect the blocker and rerun readiness after the missing input is supplied.";
  }
  return "Record the observed support level and evidence paths.";
}

function firstReason(reasons: ReadinessReason[]): string | null {
  const reason = reasons[0];
  return reason ? `${reason.code}: ${reason.message}` : null;
}

function readinessStatusVerdict(status: ReadinessReport["support"]["status"]): ReadinessVerdict {
  switch (status) {
    case "ready":
      return "pass";
    case "partial":
      return "warn";
    case "blocked":
      return "blocked";
  }
}

function firstBaselineScenario(scenarios: string[]): string | null {
  return (
    scenarios.find((entry) => entry === ".riptide/scenarios/baseline/run-config.json") ??
    scenarios.find((entry) => entry.endsWith("/baseline/run-config.json")) ??
    scenarios.find((entry) => entry.endsWith("run-config.json")) ??
    null
  );
}

async function safeStat(filePath: string): Promise<import("node:fs").Stats | null> {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function isString(value: string | null): value is string {
  return value !== null;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
