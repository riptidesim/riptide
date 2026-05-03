import type { SemanticClass } from "../schemas/adapter.js";

export const READINESS_SCHEMA_VERSION = "readiness.v1" as const;

export const SUPPORT_LEVEL_IDS = [
  "L0",
  "L1",
  "L2",
  "L3",
  "L4",
  "L5",
  "L6",
  "L7",
] as const;
export type SupportLevelId = (typeof SUPPORT_LEVEL_IDS)[number];

export const SUPPORT_EVIDENCE_KEYS = [
  "candidate_record",
  "local_repo",
  "build_or_program_artifacts",
  "riptide_workspace",
  "generic_e2e_run",
  "semantic_e2e_run",
  "risk_slice_e2e_run",
  "campaign_ready_inputs",
] as const;
export type SupportEvidenceKey = (typeof SUPPORT_EVIDENCE_KEYS)[number];

export type SupportScope = "candidate" | "repo" | "workspace" | "slice" | "campaign";
export type E2eSupportKind = "none" | "generic" | "semantic" | "risk-slice";

export interface SupportLevelDefinition {
  id: SupportLevelId;
  rank: number;
  name: string;
  summary: string;
  scope: SupportScope;
  e2eKind: E2eSupportKind;
  requiredEvidence: readonly SupportEvidenceKey[];
}

export const SUPPORT_LEVELS = [
  {
    id: "L0",
    rank: 0,
    name: "known candidate",
    summary: "A protocol candidate is known, but no local repository has been discovered.",
    scope: "candidate",
    e2eKind: "none",
    requiredEvidence: ["candidate_record"],
  },
  {
    id: "L1",
    rank: 1,
    name: "local repo discovered",
    summary: "A local repository exists and can be addressed by readiness tooling.",
    scope: "repo",
    e2eKind: "none",
    requiredEvidence: ["candidate_record", "local_repo"],
  },
  {
    id: "L2",
    rank: 2,
    name: "build artifacts discovered",
    summary: "Build, IDL, or program artifacts are present enough for adapter work to begin.",
    scope: "repo",
    e2eKind: "none",
    requiredEvidence: ["candidate_record", "local_repo", "build_or_program_artifacts"],
  },
  {
    id: "L3",
    rank: 3,
    name: "Riptide workspace initialized",
    summary: "A .riptide workspace exists with local support artifacts.",
    scope: "workspace",
    e2eKind: "none",
    requiredEvidence: [
      "candidate_record",
      "local_repo",
      "build_or_program_artifacts",
      "riptide_workspace",
    ],
  },
  {
    id: "L4",
    rank: 4,
    name: "generic E2E observed",
    summary: "A smoke or generic E2E Riptide run has been observed.",
    scope: "workspace",
    e2eKind: "generic",
    requiredEvidence: [
      "candidate_record",
      "local_repo",
      "build_or_program_artifacts",
      "riptide_workspace",
      "generic_e2e_run",
    ],
  },
  {
    id: "L5",
    rank: 5,
    name: "semantic E2E observed",
    summary: "A run with a supported economic semantic class has been observed.",
    scope: "workspace",
    e2eKind: "semantic",
    requiredEvidence: [
      "candidate_record",
      "local_repo",
      "build_or_program_artifacts",
      "riptide_workspace",
      "generic_e2e_run",
      "semantic_e2e_run",
    ],
  },
  {
    id: "L6",
    rank: 6,
    name: "risk-slice E2E observed",
    summary: "A declared risk slice has E2E run evidence for its covered economic path.",
    scope: "slice",
    e2eKind: "risk-slice",
    requiredEvidence: [
      "candidate_record",
      "local_repo",
      "build_or_program_artifacts",
      "riptide_workspace",
      "generic_e2e_run",
      "semantic_e2e_run",
      "risk_slice_e2e_run",
    ],
  },
  {
    id: "L7",
    rank: 7,
    name: "campaign-ready inputs present",
    summary: "Campaign-ready inputs are present; this is an input check, not campaign execution.",
    scope: "campaign",
    e2eKind: "risk-slice",
    requiredEvidence: [
      "candidate_record",
      "local_repo",
      "build_or_program_artifacts",
      "riptide_workspace",
      "generic_e2e_run",
      "semantic_e2e_run",
      "risk_slice_e2e_run",
      "campaign_ready_inputs",
    ],
  },
] as const satisfies readonly SupportLevelDefinition[];

export type SupportEvidenceSnapshot = Partial<Record<SupportEvidenceKey, boolean>>;

export interface SupportLevelEvaluation {
  current: SupportLevelId;
  currentRank: number;
  currentName: string;
  currentScope: SupportScope;
  e2eKind: E2eSupportKind;
  next: SupportLevelId | null;
  missingEvidenceForNextLevel: SupportEvidenceKey[];
}

export type ReadinessStatus = "ready" | "partial" | "blocked";
export type ReadinessLayer =
  | "repo"
  | "build"
  | "idl"
  | "program"
  | "adapter"
  | "harness"
  | "scenario"
  | "semantics"
  | "invariants"
  | "run-evidence"
  | "slice"
  | "campaign"
  | "documentation";

export interface ReadinessReason {
  code: string;
  layer: ReadinessLayer;
  message: string;
  evidence?: string[];
}

export interface ReadinessEvidence {
  key: SupportEvidenceKey | `custom:${string}`;
  present: boolean;
  label: string;
  paths: string[];
  notes: string[];
}

export interface ReadinessNextAction {
  layer: ReadinessLayer;
  action: string;
}

export interface ReadinessBoundary {
  scope: "repo" | "slice" | "semantic" | "campaign";
  description: string;
}

export interface ReadinessRepoRef {
  candidate?: string;
  path?: string;
  remoteUrl?: string;
  branch?: string;
  commit?: string;
  dirty?: boolean;
}

export interface ReadinessSliceRef {
  name: string;
  class: SemanticClass;
  supportLevelTarget: SupportLevelId;
  currentLevel: SupportLevelId;
  evidence: ReadinessEvidence[];
  boundaries: string[];
}

export interface ReadinessSemanticHygieneFinding {
  concept: string;
  classification: "core" | "adapter" | "custom_observation" | "slice_manifest" | "extension_candidate";
  severity: "info" | "warn" | "error";
  message: string;
  recommendedLocation: "core_semantics" | "adapter" | "custom_observations" | "slice_manifest" | "extension_candidates";
}

export interface ReadinessReport {
  schemaVersion: typeof READINESS_SCHEMA_VERSION;
  repo: ReadinessRepoRef;
  support: SupportLevelEvaluation & {
    target: SupportLevelId | null;
    status: ReadinessStatus;
    partialReasons: ReadinessReason[];
    blockedReasons: ReadinessReason[];
  };
  evidence: ReadinessEvidence[];
  blockers: ReadinessReason[];
  nextActions: ReadinessNextAction[];
  warnings: string[];
  boundaries: ReadinessBoundary[];
  slices: ReadinessSliceRef[];
  semanticHygiene: {
    findings: ReadinessSemanticHygieneFinding[];
  };
}

export interface CreateReadinessReportInput {
  repo: ReadinessRepoRef;
  evidenceSnapshot: SupportEvidenceSnapshot;
  targetLevel?: SupportLevelId | null;
  evidence?: ReadinessEvidence[];
  partialReasons?: ReadinessReason[];
  blockedReasons?: ReadinessReason[];
  blockers?: ReadinessReason[];
  nextActions?: ReadinessNextAction[];
  warnings?: string[];
  boundaries?: ReadinessBoundary[];
  slices?: ReadinessSliceRef[];
  semanticHygieneFindings?: ReadinessSemanticHygieneFinding[];
}

export function supportLevelDefinition(level: SupportLevelId): SupportLevelDefinition {
  const definition = SUPPORT_LEVELS.find((candidate) => candidate.id === level);
  if (!definition) {
    throw new Error(`unknown support level ${JSON.stringify(level)}`);
  }
  return definition;
}

export function compareSupportLevels(left: SupportLevelId, right: SupportLevelId): number {
  return supportLevelDefinition(left).rank - supportLevelDefinition(right).rank;
}

export function isSupportLevelId(value: string): value is SupportLevelId {
  return (SUPPORT_LEVEL_IDS as readonly string[]).includes(value);
}

export function evaluateSupportLevel(evidence: SupportEvidenceSnapshot): SupportLevelEvaluation {
  let current: SupportLevelDefinition = SUPPORT_LEVELS[0]!;
  for (const level of SUPPORT_LEVELS) {
    if (hasRequiredEvidence(level, evidence)) {
      current = level;
      continue;
    }
    break;
  }

  const next = SUPPORT_LEVELS.find((level) => level.rank === current.rank + 1) ?? null;
  return {
    current: current.id,
    currentRank: current.rank,
    currentName: current.name,
    currentScope: current.scope,
    e2eKind: current.e2eKind,
    next: next?.id ?? null,
    missingEvidenceForNextLevel: next
      ? next.requiredEvidence.filter((key) => evidence[key] !== true)
      : [],
  };
}

export function createReadinessReport(input: CreateReadinessReportInput): ReadinessReport {
  const evaluation = evaluateSupportLevel(input.evidenceSnapshot);
  const partialReasons = sortReasons(input.partialReasons ?? []);
  const blockedReasons = sortReasons(input.blockedReasons ?? []);
  const status: ReadinessStatus =
    blockedReasons.length > 0 ? "blocked" : partialReasons.length > 0 ? "partial" : "ready";

  return {
    schemaVersion: READINESS_SCHEMA_VERSION,
    repo: sortRepoRef(input.repo),
    support: {
      ...evaluation,
      target: input.targetLevel ?? null,
      status,
      partialReasons,
      blockedReasons,
    },
    evidence: sortEvidence(input.evidence ?? evidenceFromSnapshot(input.evidenceSnapshot)),
    blockers: sortReasons(input.blockers ?? blockedReasons),
    nextActions: sortNextActions(input.nextActions ?? []),
    warnings: [...(input.warnings ?? [])].sort(),
    boundaries: sortBoundaries(input.boundaries ?? []),
    slices: sortSlices(input.slices ?? []),
    semanticHygiene: {
      findings: sortHygieneFindings(input.semanticHygieneFindings ?? []),
    },
  };
}

export function readinessReportToJson(report: ReadinessReport): string {
  return stableJsonStringify(report);
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value), null, 2);
}

function hasRequiredEvidence(
  level: SupportLevelDefinition,
  evidence: SupportEvidenceSnapshot
): boolean {
  return level.requiredEvidence.every((key) => evidence[key] === true);
}

function evidenceFromSnapshot(snapshot: SupportEvidenceSnapshot): ReadinessEvidence[] {
  return SUPPORT_EVIDENCE_KEYS.map((key) => ({
    key,
    present: snapshot[key] === true,
    label: key,
    paths: [],
    notes: [],
  }));
}

function sortRepoRef(repo: ReadinessRepoRef): ReadinessRepoRef {
  return sortJsonValue(repo) as ReadinessRepoRef;
}

function sortEvidence(values: ReadinessEvidence[]): ReadinessEvidence[] {
  return values
    .map((entry) => ({
      ...entry,
      paths: [...entry.paths].sort(),
      notes: [...entry.notes].sort(),
    }))
    .sort((left, right) => compareStrings(evidenceSortKey(left), evidenceSortKey(right)));
}

function sortReasons(values: ReadinessReason[]): ReadinessReason[] {
  return values
    .map((entry) => ({
      ...entry,
      evidence: entry.evidence ? [...entry.evidence].sort() : undefined,
    }))
    .sort((left, right) => compareStrings(reasonSortKey(left), reasonSortKey(right)));
}

function sortNextActions(values: ReadinessNextAction[]): ReadinessNextAction[] {
  return [...values].sort((left, right) =>
    compareStrings(`${left.layer}\u0000${left.action}`, `${right.layer}\u0000${right.action}`)
  );
}

function sortBoundaries(values: ReadinessBoundary[]): ReadinessBoundary[] {
  return [...values].sort((left, right) =>
    compareStrings(`${left.scope}\u0000${left.description}`, `${right.scope}\u0000${right.description}`)
  );
}

function sortSlices(values: ReadinessSliceRef[]): ReadinessSliceRef[] {
  return values
    .map((entry) => ({
      ...entry,
      evidence: sortEvidence(entry.evidence),
      boundaries: [...entry.boundaries].sort(),
    }))
    .sort((left, right) => compareStrings(left.name, right.name));
}

function sortHygieneFindings(
  values: ReadinessSemanticHygieneFinding[]
): ReadinessSemanticHygieneFinding[] {
  return [...values].sort((left, right) =>
    compareStrings(
      `${left.severity}\u0000${left.concept}\u0000${left.classification}`,
      `${right.severity}\u0000${right.concept}\u0000${right.classification}`
    )
  );
}

function evidenceSortKey(entry: ReadinessEvidence): string {
  return `${entry.present ? "1" : "0"}\u0000${entry.key}\u0000${entry.label}`;
}

function reasonSortKey(entry: ReadinessReason): string {
  return `${entry.layer}\u0000${entry.code}\u0000${entry.message}`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value === null || typeof value !== "object") return value;

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) {
    const child = input[key];
    if (child !== undefined) output[key] = sortJsonValue(child);
  }
  return output;
}
