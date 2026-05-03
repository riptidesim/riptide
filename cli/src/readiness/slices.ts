import { readFile } from "node:fs/promises";
import path from "node:path";

import TOML from "toml";

import {
  isSupportedSemanticClass,
  type SemanticClass,
} from "../schemas/adapter.js";
import {
  compareSupportLevels,
  isSupportLevelId,
  type ReadinessSemanticHygieneFinding,
  type SupportLevelId,
} from "./model.js";
import {
  classifySemanticConcept,
  hasProtocolSpecificSemanticBloat,
  isCoreSemanticObservation,
} from "./semantic-hygiene.js";

export const SLICE_SCHEMA_VERSION = "slice.v1" as const;

export const CUSTOM_OBSERVATION_TYPES = ["int", "uint", "bool", "pubkey", "map"] as const;
export type CustomObservationType = (typeof CUSTOM_OBSERVATION_TYPES)[number];

export interface SliceCustomObservation {
  name: string;
  type: CustomObservationType;
  description: string;
  source?: string;
}

export interface SliceExtensionCandidate {
  name: string;
  description: string;
  reason: string;
  reuseEvidence: string[];
}

export interface SliceManifest {
  schemaVersion: typeof SLICE_SCHEMA_VERSION;
  filePath: string;
  name: string;
  class: SemanticClass;
  objective: string;
  description: string;
  supportLevelTarget: SupportLevelId;
  actions: string[];
  accounts: string[];
  observations: string[];
  invariants: string[];
  scenarios: string[];
  runEvidence: string[];
  knownBoundaries: string[];
  customObservations: SliceCustomObservation[];
  extensionCandidates: SliceExtensionCandidate[];
  semanticHygiene: {
    findings: ReadinessSemanticHygieneFinding[];
  };
}

export interface SliceManifestDiagnostic {
  path: string;
  message: string;
}

export class SliceManifestValidationError extends Error {
  readonly diagnostics: SliceManifestDiagnostic[];
  readonly filePath: string;

  constructor(filePath: string, diagnostics: SliceManifestDiagnostic[]) {
    super(renderSliceDiagnostics(filePath, diagnostics));
    this.name = "SliceManifestValidationError";
    this.filePath = filePath;
    this.diagnostics = diagnostics;
  }
}

export async function readSliceManifestTomlFile(filePath: string): Promise<SliceManifest> {
  const absolutePath = path.resolve(filePath);
  let raw: string;
  try {
    raw = await readFile(absolutePath, "utf8");
  } catch (err) {
    throw new Error(`slice manifest TOML not found at ${absolutePath}: ${errMessage(err)}`);
  }
  return parseSliceManifestToml(raw, absolutePath);
}

export function parseSliceManifestToml(
  raw: string,
  filePath = ".riptide/slices/slice.toml"
): SliceManifest {
  const absolutePath = path.resolve(filePath);
  let parsed: unknown;
  try {
    parsed = TOML.parse(raw);
  } catch (err) {
    throw new SliceManifestValidationError(absolutePath, [
      {
        path: "slice",
        message: `TOML parse failed: ${errMessage(err)}`,
      },
    ]);
  }
  return validateSliceManifestObject(parsed, absolutePath);
}

export function validateSliceManifestObject(
  raw: unknown,
  filePath = ".riptide/slices/slice.toml"
): SliceManifest {
  const absolutePath = path.resolve(filePath);
  const diagnostics: SliceManifestDiagnostic[] = [];
  const root = asRecord(raw);
  if (!root) {
    throw new SliceManifestValidationError(absolutePath, [
      { path: "slice", message: "expected a TOML document with a [slice] table" },
    ]);
  }
  checkKnownKeys(root, new Set(["slice"]), "", diagnostics);

  const slice = readRecord(root, "slice", "slice", diagnostics);
  if (!slice) throw new SliceManifestValidationError(absolutePath, diagnostics);
  checkKnownKeys(
    slice,
    new Set([
      "name",
      "class",
      "objective",
      "description",
      "support_level_target",
      "actions",
      "accounts",
      "observations",
      "invariants",
      "scenarios",
      "run_evidence",
      "known_boundaries",
      "custom_observations",
      "extension_candidates",
    ]),
    "slice",
    diagnostics
  );

  const name = readString(slice, "name", "slice.name", diagnostics);
  const semanticClassRaw = readString(slice, "class", "slice.class", diagnostics);
  const objective = readString(slice, "objective", "slice.objective", diagnostics);
  const description = readString(slice, "description", "slice.description", diagnostics);
  const targetRaw = readString(
    slice,
    "support_level_target",
    "slice.support_level_target",
    diagnostics
  );
  const supportLevelTarget = validateSupportLevelTarget(targetRaw, diagnostics);
  const actions = readRequiredStringArray(slice, "actions", "slice.actions", diagnostics);
  const accounts = readRequiredStringArray(slice, "accounts", "slice.accounts", diagnostics);
  const observations = readRequiredStringArray(
    slice,
    "observations",
    "slice.observations",
    diagnostics
  );
  const invariants = readRequiredStringArray(
    slice,
    "invariants",
    "slice.invariants",
    diagnostics
  );
  const scenarios = readRequiredStringArray(slice, "scenarios", "slice.scenarios", diagnostics);
  const runEvidence = readRunEvidence(slice, supportLevelTarget, diagnostics);
  const knownBoundaries = readRequiredStringArray(
    slice,
    "known_boundaries",
    "slice.known_boundaries",
    diagnostics
  );

  validateSliceName(name, absolutePath, diagnostics);
  const semanticClass = validateSemanticClass(semanticClassRaw, diagnostics);

  for (const [field, values] of [
    ["actions", actions],
    ["accounts", accounts],
    ["observations", observations],
    ["invariants", invariants],
    ["scenarios", scenarios],
    ["run_evidence", runEvidence],
    ["known_boundaries", knownBoundaries],
  ] as const) {
    validateUniqueStrings(values, `slice.${field}`, diagnostics);
  }

  const customObservations = parseCustomObservations(
    readOptionalArray(slice, "custom_observations", "slice.custom_observations", diagnostics),
    diagnostics
  );
  const extensionCandidates = parseExtensionCandidates(
    readOptionalArray(slice, "extension_candidates", "slice.extension_candidates", diagnostics),
    diagnostics
  );

  if (semanticClass !== undefined && observations !== undefined) {
    validateCoreObservations(semanticClass, observations, diagnostics);
  }
  validateExtensionCandidates(extensionCandidates, diagnostics);

  if (diagnostics.length > 0) {
    throw new SliceManifestValidationError(absolutePath, diagnostics);
  }

  return {
    schemaVersion: SLICE_SCHEMA_VERSION,
    filePath: absolutePath,
    name: name!,
    class: semanticClass!,
    objective: objective!,
    description: description!,
    supportLevelTarget: supportLevelTarget!,
    actions: actions!,
    accounts: accounts!,
    observations: observations!,
    invariants: invariants!,
    scenarios: scenarios!,
    runEvidence: runEvidence!,
    knownBoundaries: knownBoundaries!,
    customObservations,
    extensionCandidates,
    semanticHygiene: {
      findings: semanticHygieneFindings(semanticClass!, observations!, customObservations, extensionCandidates),
    },
  };
}

export function renderSliceDiagnostics(
  filePath: string,
  diagnostics: SliceManifestDiagnostic[]
): string {
  if (diagnostics.length === 0) return `slice manifest validation failed: ${filePath}`;
  const lines = [`slice manifest validation failed: ${filePath}`];
  for (const diagnostic of diagnostics) {
    lines.push(`  ${diagnostic.path}: ${diagnostic.message}`);
  }
  return lines.join("\n");
}

function parseCustomObservations(
  raw: unknown[] | undefined,
  diagnostics: SliceManifestDiagnostic[]
): SliceCustomObservation[] {
  const observations: SliceCustomObservation[] = [];
  for (const [index, value] of (raw ?? []).entries()) {
    const keyPath = `slice.custom_observations[${index}]`;
    const table = asRecord(value);
    if (!table) {
      diagnostics.push({ path: keyPath, message: "expected a table" });
      continue;
    }
    checkKnownKeys(table, new Set(["name", "type", "description", "source"]), keyPath, diagnostics);
    const name = readString(table, "name", `${keyPath}.name`, diagnostics);
    const type = readString(table, "type", `${keyPath}.type`, diagnostics);
    const description = readString(table, "description", `${keyPath}.description`, diagnostics);
    const source = readOptionalString(table, "source", `${keyPath}.source`, diagnostics);
    if (name !== undefined) validateStableName(name, `${keyPath}.name`, diagnostics);
    if (type !== undefined && !(CUSTOM_OBSERVATION_TYPES as readonly string[]).includes(type)) {
      diagnostics.push({
        path: `${keyPath}.type`,
        message: `unsupported custom observation type ${JSON.stringify(type)}`,
      });
      continue;
    }
    if (name !== undefined && type !== undefined && description !== undefined) {
      observations.push({
        name,
        type: type as CustomObservationType,
        description,
        ...(source !== undefined ? { source } : {}),
      });
    }
  }
  validateUniqueStrings(
    observations.map((observation) => observation.name),
    "slice.custom_observations.name",
    diagnostics
  );
  return observations;
}

function parseExtensionCandidates(
  raw: unknown[] | undefined,
  diagnostics: SliceManifestDiagnostic[]
): SliceExtensionCandidate[] {
  const candidates: SliceExtensionCandidate[] = [];
  for (const [index, value] of (raw ?? []).entries()) {
    const keyPath = `slice.extension_candidates[${index}]`;
    const table = asRecord(value);
    if (!table) {
      diagnostics.push({ path: keyPath, message: "expected a table" });
      continue;
    }
    checkKnownKeys(
      table,
      new Set(["name", "description", "reason", "reuse_evidence"]),
      keyPath,
      diagnostics
    );
    const name = readString(table, "name", `${keyPath}.name`, diagnostics);
    const description = readString(table, "description", `${keyPath}.description`, diagnostics);
    const reason = readString(table, "reason", `${keyPath}.reason`, diagnostics);
    const reuseEvidence = readRequiredStringArray(
      table,
      "reuse_evidence",
      `${keyPath}.reuse_evidence`,
      diagnostics
    );
    if (name !== undefined) validateStableName(name, `${keyPath}.name`, diagnostics);
    if (
      name !== undefined &&
      description !== undefined &&
      reason !== undefined &&
      reuseEvidence !== undefined
    ) {
      candidates.push({ name, description, reason, reuseEvidence });
    }
  }
  validateUniqueStrings(
    candidates.map((candidate) => candidate.name),
    "slice.extension_candidates.name",
    diagnostics
  );
  return candidates;
}

function validateCoreObservations(
  semanticClass: SemanticClass,
  observations: string[],
  diagnostics: SliceManifestDiagnostic[]
): void {
  for (const [index, observation] of observations.entries()) {
    const keyPath = `slice.observations[${index}]`;
    if (hasProtocolSpecificSemanticBloat(observation)) {
      diagnostics.push({
        path: keyPath,
        message:
          `${JSON.stringify(observation)} looks protocol-specific; put it in ` +
          "`[[slice.custom_observations]]` instead of the core semantic observation list",
      });
      continue;
    }
    if (!isCoreSemanticObservation(semanticClass, observation)) {
      diagnostics.push({
        path: keyPath,
        message:
          `${JSON.stringify(observation)} is not a core ${semanticClass} observation; ` +
          "use a supported generic derived observation, [[slice.custom_observations]], or an extension candidate",
      });
    }
  }
}

function validateExtensionCandidates(
  candidates: SliceExtensionCandidate[],
  diagnostics: SliceManifestDiagnostic[]
): void {
  for (const [index, candidate] of candidates.entries()) {
    const finding = classifySemanticConcept({
      name: candidate.name,
      description: `${candidate.description} ${candidate.reason}`,
      requestedLocation: "extension_candidates",
      reuseEvidence: candidate.reuseEvidence,
    });
    if (finding.protocolSpecific) {
      diagnostics.push({
        path: `slice.extension_candidates[${index}].name`,
        message:
          `${JSON.stringify(candidate.name)} looks protocol-specific; keep it in the adapter, ` +
          "custom observations, or this slice's boundaries instead of recommending a reusable semantic extension",
      });
      continue;
    }
    if (finding.classification !== "extension_candidate") {
      diagnostics.push({
        path: `slice.extension_candidates[${index}].reuse_evidence`,
        message:
          "extension candidates must describe a structural concept repeated across at least two protocol families",
      });
    }
  }
}

function semanticHygieneFindings(
  semanticClass: SemanticClass,
  observations: string[],
  customObservations: SliceCustomObservation[],
  extensionCandidates: SliceExtensionCandidate[]
): ReadinessSemanticHygieneFinding[] {
  return [
    ...observations.map((name) =>
      classifySemanticConcept({ name, semanticClass, requestedLocation: "core_semantics" })
    ),
    ...customObservations.map((observation) =>
      classifySemanticConcept({
        name: observation.name,
        description: observation.description,
        semanticClass,
        requestedLocation: "custom_observations",
      })
    ),
    ...extensionCandidates.map((candidate) =>
      classifySemanticConcept({
        name: candidate.name,
        description: `${candidate.description} ${candidate.reason}`,
        semanticClass,
        requestedLocation: "extension_candidates",
        reuseEvidence: candidate.reuseEvidence,
      })
    ),
  ];
}

function validateSliceName(
  value: string | undefined,
  filePath: string,
  diagnostics: SliceManifestDiagnostic[]
): void {
  if (value === undefined) return;
  validateStableName(value, "slice.name", diagnostics);
  const stem = path.basename(filePath, path.extname(filePath));
  if (stem !== "slice" && stem !== value) {
    diagnostics.push({
      path: "slice.name",
      message: `slice name ${JSON.stringify(value)} must match manifest filename ${JSON.stringify(stem)}`,
    });
  }
}

function validateStableName(
  value: string,
  keyPath: string,
  diagnostics: SliceManifestDiagnostic[]
): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) {
    diagnostics.push({
      path: keyPath,
      message: "expected a stable lowercase identifier using letters, numbers, dots, underscores, or dashes",
    });
  }
}

function validateSemanticClass(
  value: string | undefined,
  diagnostics: SliceManifestDiagnostic[]
): SemanticClass | undefined {
  if (value === undefined) return undefined;
  if (!isSupportedSemanticClass(value)) {
    diagnostics.push({
      path: "slice.class",
      message: `unsupported semantic class ${JSON.stringify(value)}`,
    });
    return undefined;
  }
  return value;
}

function validateSupportLevelTarget(
  value: string | undefined,
  diagnostics: SliceManifestDiagnostic[]
): SupportLevelId | undefined {
  if (value === undefined) return undefined;
  if (!isSupportLevelId(value)) {
    diagnostics.push({
      path: "slice.support_level_target",
      message: `unsupported support level target ${JSON.stringify(value)}`,
    });
    return undefined;
  }
  return value;
}

function readRunEvidence(
  record: Record<string, unknown>,
  target: SupportLevelId | undefined,
  diagnostics: SliceManifestDiagnostic[]
): string[] | undefined {
  const required = target !== undefined && compareSupportLevels(target, "L6") >= 0;
  return required
    ? readRequiredStringArray(record, "run_evidence", "slice.run_evidence", diagnostics)
    : readOptionalStringArray(record, "run_evidence", "slice.run_evidence", diagnostics) ?? [];
}

function readRecord(
  record: Record<string, unknown>,
  key: string,
  keyPath: string,
  diagnostics: SliceManifestDiagnostic[]
): Record<string, unknown> | undefined {
  if (!hasKey(record, key)) {
    diagnostics.push({ path: keyPath, message: "missing required table" });
    return undefined;
  }
  const value = asRecord(record[key]);
  if (!value) {
    diagnostics.push({ path: keyPath, message: "expected a table" });
    return undefined;
  }
  return value;
}

function readString(
  record: Record<string, unknown>,
  key: string,
  keyPath: string,
  diagnostics: SliceManifestDiagnostic[]
): string | undefined {
  if (!hasKey(record, key)) {
    diagnostics.push({ path: keyPath, message: "missing required string" });
    return undefined;
  }
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    diagnostics.push({ path: keyPath, message: "expected a non-empty string" });
    return undefined;
  }
  return value;
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  keyPath: string,
  diagnostics: SliceManifestDiagnostic[]
): string | undefined {
  if (!hasKey(record, key)) return undefined;
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    diagnostics.push({ path: keyPath, message: "expected a non-empty string" });
    return undefined;
  }
  return value;
}

function readRequiredStringArray(
  record: Record<string, unknown>,
  key: string,
  keyPath: string,
  diagnostics: SliceManifestDiagnostic[]
): string[] | undefined {
  if (!hasKey(record, key)) {
    diagnostics.push({ path: keyPath, message: "missing required non-empty string array" });
    return undefined;
  }
  const value = record[key];
  if (!Array.isArray(value) || value.length === 0) {
    diagnostics.push({ path: keyPath, message: "expected a non-empty string array" });
    return undefined;
  }
  const values: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      diagnostics.push({ path: `${keyPath}[${index}]`, message: "expected a non-empty string" });
      return;
    }
    values.push(entry);
  });
  return values;
}

function readOptionalStringArray(
  record: Record<string, unknown>,
  key: string,
  keyPath: string,
  diagnostics: SliceManifestDiagnostic[]
): string[] | undefined {
  if (!hasKey(record, key)) return undefined;
  return readRequiredStringArray(record, key, keyPath, diagnostics);
}

function readOptionalArray(
  record: Record<string, unknown>,
  key: string,
  keyPath: string,
  diagnostics: SliceManifestDiagnostic[]
): unknown[] | undefined {
  if (!hasKey(record, key)) return undefined;
  const value = record[key];
  if (!Array.isArray(value)) {
    diagnostics.push({ path: keyPath, message: "expected an array of tables" });
    return undefined;
  }
  return value;
}

function validateUniqueStrings(
  values: string[] | undefined,
  keyPath: string,
  diagnostics: SliceManifestDiagnostic[]
): void {
  if (values === undefined) return;
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      diagnostics.push({ path: `${keyPath}[${index}]`, message: `duplicate value ${JSON.stringify(value)}` });
      continue;
    }
    seen.add(value);
  }
}

function checkKnownKeys(
  record: Record<string, unknown>,
  allowed: Set<string>,
  prefix: string,
  diagnostics: SliceManifestDiagnostic[]
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      diagnostics.push({
        path: prefix ? `${prefix}.${key}` : key,
        message: `unknown key ${JSON.stringify(key)}`,
      });
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function hasKey(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
