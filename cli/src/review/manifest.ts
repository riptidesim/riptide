import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

export type ValidationStatus = "pass" | "warn" | "fail";

export interface ValidationResult {
  step: string;
  status: ValidationStatus;
  message: string;
  path?: string;
}

export interface ReviewManifest {
  schema_version?: number;
  kind?: string;
  run_id?: string;
  scenario?: string;
  adapter?: string;
  canonical_hash?: string;
  invariant_firings?: ManifestInvariantFire[];
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  proof_level?: number | { level?: number; label?: string };
  proof_level_label?: string;
  proof?: { level?: number; label?: string };
  what_this_proof_does_not_claim?: string | string[];
  does_not_claim?: string | string[];
  scope_of_claim_bullets?: string[];
  [key: string]: unknown;
}

export interface ManifestInvariantFire {
  name?: string;
  firings?: number;
  first_tick?: number;
  field?: string;
  op?: string;
  value?: number | null;
}

export interface PackPathEntry {
  key: string;
  raw: string;
  resolved: string;
  base: "pack_root" | "repo_root";
}

export interface LoadedPackManifest {
  packRoot: string;
  manifestPath: string;
  manifest: ReviewManifest;
  manifestRaw: string;
  inputsPath: string;
  outputsPath: string;
  inputIndex: Record<string, unknown>;
  outputIndex: Record<string, unknown>;
  resolvedPaths: PackPathEntry[];
  simulationResultPath: string;
  validationResults: ValidationResult[];
}

export class ReviewValidationError extends Error {
  readonly exitCode = 2 as const;

  constructor(message: string) {
    super(message);
    this.name = "ReviewValidationError";
  }
}

export async function loadPackManifest(packPath: string): Promise<LoadedPackManifest> {
  const packRoot = path.resolve(packPath);
  const repoRoot = findRepoRoot(packRoot);
  const validationResults: ValidationResult[] = [];
  const manifestPath = path.join(packRoot, "manifest.json");

  if (!existsSync(manifestPath)) {
    throw new ReviewValidationError(
      `review manifest not found\n  expected: ${manifestPath}\n  next: pass a Riptide evidence pack directory containing manifest.json`
    );
  }

  let manifestRaw: string;
  try {
    manifestRaw = await readFile(manifestPath, "utf8");
  } catch (error) {
    throw new ReviewValidationError(
      `could not read review manifest\n  path: ${manifestPath}\n  reason: ${errorMessage(error)}`
    );
  }

  let manifest: ReviewManifest;
  try {
    manifest = JSON.parse(manifestRaw) as ReviewManifest;
  } catch (error) {
    throw new ReviewValidationError(
      `malformed manifest.json\n  path: ${manifestPath}\n  parse error: ${errorMessage(error)}\n  next: fix manifest.json before reviewing this pack`
    );
  }

  if (!manifest || typeof manifest !== "object") {
    throw new ReviewValidationError(
      `malformed manifest.json\n  path: ${manifestPath}\n  expected: a JSON object\n  next: regenerate the pack or restore manifest.json from source control`
    );
  }
  if (typeof manifest.canonical_hash !== "string" || manifest.canonical_hash.length === 0) {
    throw new ReviewValidationError(
      `malformed manifest.json\n  path: ${manifestPath}\n  expected: non-empty canonical_hash\n  next: regenerate the pack so reviewers can verify the canonical output hash`
    );
  }

  validationResults.push({
    step: "manifest",
    status: "pass",
    message: "manifest.json exists and parses",
    path: manifestPath,
  });

  const inputsPath = path.join(packRoot, "inputs", "paths.json");
  const outputsPath = path.join(packRoot, "outputs", "paths.json");
  const inputIndex = await readPathIndex(inputsPath, "inputs/paths.json");
  const outputIndex = await readPathIndex(outputsPath, "outputs/paths.json");

  const resolvedPaths: PackPathEntry[] = [];
  for (const [key, raw] of flattenPathIndex("inputs", inputIndex)) {
    resolvedPaths.push(resolveIndexedPath(packRoot, repoRoot, key, raw));
  }
  for (const [key, raw] of flattenPathIndex("outputs", outputIndex)) {
    resolvedPaths.push(resolveIndexedPath(packRoot, repoRoot, key, raw));
  }

  validationResults.push({
    step: "path-index",
    status: "pass",
    message: `${resolvedPaths.length} indexed path${resolvedPaths.length === 1 ? "" : "s"} resolved`,
  });

  const simulationResultRaw = firstString(
    outputIndex,
    ["simulation_result", "simulation-result", "simulationResult"],
    manifest.outputs,
  );
  const simulationResultPath = resolveIndexedPath(
    packRoot,
    repoRoot,
    "outputs.simulation_result",
    simulationResultRaw ?? "outputs/simulation-result.json",
  ).resolved;

  return {
    packRoot,
    manifestPath,
    manifest,
    manifestRaw,
    inputsPath,
    outputsPath,
    inputIndex,
    outputIndex,
    resolvedPaths,
    simulationResultPath,
    validationResults,
  };
}

async function readPathIndex(filePath: string, label: string): Promise<Record<string, unknown>> {
  if (!existsSync(filePath)) {
    throw new ReviewValidationError(
      `${label} not found\n  expected: ${filePath}\n  next: restore the pack path index before review`
    );
  }
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    throw new ReviewValidationError(
      `could not read ${label}\n  path: ${filePath}\n  reason: ${errorMessage(error)}`
    );
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new ReviewValidationError(
      `malformed ${label}\n  path: ${filePath}\n  parse error: ${errorMessage(error)}`
    );
  }
}

function flattenPathIndex(prefix: string, value: unknown): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  const visit = (key: string, current: unknown) => {
    if (current === null || current === undefined) return;
    if (typeof current === "string") {
      rows.push([key, current]);
      return;
    }
    if (typeof current === "object" && !Array.isArray(current)) {
      for (const [childKey, childValue] of Object.entries(current as Record<string, unknown>)) {
        visit(`${key}.${childKey}`, childValue);
      }
    }
  };
  visit(prefix, value);
  return rows;
}

function resolveIndexedPath(
  packRoot: string,
  repoRoot: string | null,
  key: string,
  raw: string
): PackPathEntry {
  if (path.isAbsolute(raw)) {
    throw new ReviewValidationError(
      `absolute indexed paths are not allowed\n  field: ${key}\n  path: ${raw}\n  next: keep inputs/paths.json and outputs/paths.json entries relative to the pack root`
    );
  }

  const packResolved = path.resolve(packRoot, raw);
  if (!isWithinRoot(packRoot, packResolved)) {
    throw new ReviewValidationError(
      `indexed path escapes pack root\n  field: ${key}\n  path: ${raw}\n  resolved: ${packResolved}\n  pack root: ${packRoot}\n  next: keep pack indexes self-contained and relative to the pack root`
    );
  }

  if (existsSync(packResolved)) {
    return canonicalizeIndexedPath({
      root: packRoot,
      resolved: packResolved,
      key,
      raw,
      base: "pack_root"
    });
  }

  const repoResolved = repoRoot ? path.resolve(repoRoot, raw) : null;
  if (repoRoot && repoResolved && existsSync(repoResolved)) {
    if (!isWithinRoot(repoRoot, repoResolved)) {
      throw new ReviewValidationError(
        `indexed path escapes repo root\n  field: ${key}\n  path: ${raw}\n  resolved: ${repoResolved}\n  repo root: ${repoRoot}\n  next: keep repo-relative pack indexes inside the checkout`
      );
    }
    return canonicalizeIndexedPath({
      root: repoRoot,
      resolved: repoResolved,
      key,
      raw,
      base: "repo_root"
    });
  }

  if (!existsSync(packResolved)) {
    throw new ReviewValidationError(
      `indexed path does not exist\n  field: ${key}\n  expected: ${packResolved}` +
        (repoResolved ? `\n  repo-relative candidate: ${repoResolved}` : "") +
        `\n  next: ${missingIndexedPathNext(packRoot, key)}`
    );
  }
  throw new ReviewValidationError(
    `indexed path could not be resolved\n  field: ${key}\n  path: ${raw}`
  );
}

function canonicalizeIndexedPath(input: {
  root: string;
  resolved: string;
  key: string;
  raw: string;
  base: PackPathEntry["base"];
}): PackPathEntry {
  let canonicalRoot: string;
  let canonicalPath: string;
  try {
    canonicalRoot = realpathSync(input.root);
    canonicalPath = realpathSync(input.resolved);
  } catch (error) {
    throw new ReviewValidationError(
      `indexed path could not be canonicalized\n  field: ${input.key}\n  path: ${input.raw}\n  resolved: ${input.resolved}\n  reason: ${errorMessage(error)}\n  next: restore the pack file as a regular readable path`
    );
  }

  if (!isWithinRoot(canonicalRoot, canonicalPath)) {
    throw new ReviewValidationError(
      `indexed path resolves inside the ${input.base} lexically but canonicalizes outside it — refusing to follow a symlink escape\n  field: ${input.key}\n  path: ${input.raw}\n  lexical: ${input.resolved}\n  canonical: ${canonicalPath}\n  ${input.base}: ${canonicalRoot}\n  next: keep pack indexes inside their declared root`
    );
  }

  return { key: input.key, raw: input.raw, resolved: canonicalPath, base: input.base };
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function findRepoRoot(start: string): string | null {
  let current = path.resolve(start);
  while (true) {
    if (existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function missingIndexedPathNext(packRoot: string, key: string): string {
  const indexPath = key.startsWith("inputs") ? "inputs/paths.json" : "outputs/paths.json";
  if (key.startsWith("outputs") && existsSync(path.join(packRoot, "config.json"))) {
    const rerunHint = existsSync(path.join(packRoot, "rerun.sh"))
      ? " or execute the pack's rerun.sh"
      : "";
    return `this replay pack references generated output that is not present; run \`riptide replay ${path.join(
      packRoot,
      "config.json"
    )} --allow-invariant-violations\`${rerunHint}, then retry review`;
  }
  return `check ${indexPath} and keep pack paths relative to the pack root or repo root`;
}

function firstString(
  primary: Record<string, unknown>,
  keys: string[],
  fallback: unknown
): string | null {
  for (const key of keys) {
    const value = primary[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  if (fallback && typeof fallback === "object" && !Array.isArray(fallback)) {
    for (const key of keys) {
      const value = (fallback as Record<string, unknown>)[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
