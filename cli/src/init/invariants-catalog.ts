// Invariant catalog for the `riptide init` wizard.
//
// Files ship under cli/assets/init-invariants/<bucket>/<slug>.toml and
// describe starter adapter-level invariants or semantic invariants that
// the scaffold writer can inline into the generated adapter.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import TOML from "toml";

import type { InvariantOp, SemanticInvariantSeverity } from "../schemas/adapter.js";
import type { Protocol } from "./personas-catalog.js";

export type InvariantForm = "flat" | "semantic";

export interface InvariantCatalogEntry {
  name: string;
  label: string;
  description: string;
  form: InvariantForm;
  field?: string;
  op?: InvariantOp;
  value?: number;
  expr?: string;
  severity: SemanticInvariantSeverity;
  recommended: boolean;
  required: boolean;
  commented: boolean;
  requiresSemantics: boolean;
  source: string;
}

export interface InitInvariantConfig {
  name: string;
  label: string;
  description: string;
  form: InvariantForm;
  severity: SemanticInvariantSeverity;
  commented: boolean;
  requiresSemantics: boolean;
  /** Rendered TOML for adapter-level invariants; commented when `commented` is true. */
  toml: string;
  field?: string;
  op?: InvariantOp;
  value?: number;
  expr?: string;
}

// Probe candidate asset roots, mirroring cli/src/init/scenarios-catalog.ts.
// Layouts: built package assets, dist-copied assets, and source-tree assets.
export function invariantAssetCandidates(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(here, "..", "..", "..", "assets", "init-invariants"),
    path.resolve(here, "..", "..", "assets", "init-invariants"),
    path.resolve(here, "..", "assets", "init-invariants")
  ];
}

// Lookup precedence: protocol-specific bucket first, then the generic
// `custom/` bucket. Path probing exposes the fallback for every protocol;
// wizard choices suppress the fallback for lending because its catalog is
// fully engine-backed and should not show generic templates.
export function invariantPathCandidates(protocol: Protocol, slug: string): string[] {
  const roots = invariantAssetCandidates();
  const buckets = protocol === "custom" ? ["custom"] : [protocol, "custom"];
  const out: string[] = [];
  for (const root of roots) {
    for (const bucket of buckets) {
      out.push(path.join(root, bucket, `${slug}.toml`));
    }
  }
  return out;
}

export function invariantChoicesFor(protocol: Protocol): InvariantCatalogEntry[] {
  const buckets = invariantChoiceBuckets(protocol);
  const seen = new Set<string>();
  const out: InvariantCatalogEntry[] = [];

  for (const bucket of buckets) {
    for (const entry of invariantEntriesForBucket(bucket)) {
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      out.push(entry);
    }
  }

  return out;
}

function invariantChoiceBuckets(protocol: Protocol): string[] {
  if (protocol === "custom") return ["custom"];
  if (protocol === "lending") return ["lending"];
  return [protocol, "custom"];
}

export function invariantConfigFromCatalog(entry: InvariantCatalogEntry): InitInvariantConfig {
  return {
    name: entry.name,
    label: entry.label,
    description: entry.description,
    form: entry.form,
    field: entry.field,
    op: entry.op,
    value: entry.value,
    expr: entry.expr,
    severity: entry.severity,
    commented: entry.commented,
    requiresSemantics: entry.requiresSemantics,
    toml: renderFlatInvariantToml(entry)
  };
}

function invariantEntriesForBucket(bucket: string): InvariantCatalogEntry[] {
  for (const root of invariantAssetCandidates()) {
    const dir = path.join(root, bucket);
    if (!existsSync(dir)) continue;

    const files = readdirSync(dir)
      .filter((entry) => entry.endsWith(".toml"))
      .sort((a, b) => a.localeCompare(b, "en-US", { sensitivity: "variant" }));

    if (files.length === 0) continue;

    return stableInvariantOrder(files.map((file) => parseInvariantFile(path.join(dir, file))));
  }

  return [];
}

function stableInvariantOrder(entries: InvariantCatalogEntry[]): InvariantCatalogEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const priorityDelta = invariantPriority(b.entry) - invariantPriority(a.entry);
      return priorityDelta === 0 ? a.index - b.index : priorityDelta;
    })
    .map(({ entry }) => entry);
}

function invariantPriority(entry: InvariantCatalogEntry): number {
  if (entry.required) return 2;
  if (entry.recommended) return 1;
  return 0;
}

function parseInvariantFile(filePath: string): InvariantCatalogEntry {
  const raw = readFileSync(filePath, "utf8");
  const parsed = TOML.parse(raw) as Record<string, unknown>;
  const form = requiredForm(parsed, filePath);
  const severity = optionalSeverity(parsed, "severity", "error", filePath);
  const requiresSemantics =
    form === "semantic" || optionalBoolean(parsed, "requires_semantics", false, filePath);

  const entry: InvariantCatalogEntry = {
    name: requiredString(parsed, "name", filePath),
    label: requiredString(parsed, "label", filePath),
    description: requiredString(parsed, "description", filePath),
    form,
    field: optionalString(parsed, "field", filePath),
    op: optionalOp(parsed, "op", filePath),
    value: optionalFiniteNumber(parsed, "value", filePath),
    expr: optionalString(parsed, "expr", filePath),
    severity,
    recommended: optionalBoolean(parsed, "recommended", false, filePath),
    required: optionalBoolean(parsed, "required", false, filePath),
    commented: optionalBoolean(parsed, "commented", false, filePath),
    requiresSemantics,
    source: filePath
  };

  if (entry.form === "flat") {
    if (entry.field === undefined) {
      throw new Error(`${filePath}: expected non-empty string field "field" for form = "flat"`);
    }
    if (entry.op === undefined) {
      throw new Error(`${filePath}: expected invariant op field "op" for form = "flat"`);
    }
    if (entry.value === undefined) {
      throw new Error(`${filePath}: expected finite number field "value" for form = "flat"`);
    }
  } else if (entry.expr === undefined) {
    throw new Error(`${filePath}: expected non-empty string field "expr" for form = "semantic"`);
  }

  return entry;
}

function requiredForm(parsed: Record<string, unknown>, filePath: string): InvariantForm {
  const value = requiredString(parsed, "form", filePath);
  if (value === "flat" || value === "semantic") return value;
  throw new Error(`${filePath}: expected field "form" to be "flat" or "semantic"`);
}

function requiredString(
  parsed: Record<string, unknown>,
  key: string,
  filePath: string
): string {
  const value = parsed[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  throw new Error(`${filePath}: expected non-empty string field ${JSON.stringify(key)}`);
}

function optionalString(
  parsed: Record<string, unknown>,
  key: string,
  filePath: string
): string | undefined {
  const value = parsed[key];
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  throw new Error(`${filePath}: expected non-empty string field ${JSON.stringify(key)}`);
}

function optionalOp(
  parsed: Record<string, unknown>,
  key: string,
  filePath: string
): InvariantOp | undefined {
  const value = parsed[key];
  if (value === undefined) return undefined;
  if (
    value === "==" ||
    value === "!=" ||
    value === ">=" ||
    value === "<=" ||
    value === ">" ||
    value === "<"
  ) {
    return value;
  }
  throw new Error(`${filePath}: expected invariant op field ${JSON.stringify(key)}`);
}

function optionalFiniteNumber(
  parsed: Record<string, unknown>,
  key: string,
  filePath: string
): number | undefined {
  const value = parsed[key];
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw new Error(`${filePath}: expected finite number field ${JSON.stringify(key)}`);
}

function optionalSeverity(
  parsed: Record<string, unknown>,
  key: string,
  fallback: SemanticInvariantSeverity,
  filePath: string
): SemanticInvariantSeverity {
  const value = parsed[key];
  if (value === undefined) return fallback;
  if (value === "error" || value === "warn") return value;
  throw new Error(`${filePath}: expected field ${JSON.stringify(key)} to be "error" or "warn"`);
}

function optionalBoolean(
  parsed: Record<string, unknown>,
  key: string,
  fallback: boolean,
  filePath: string
): boolean {
  const value = parsed[key];
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  throw new Error(`${filePath}: expected boolean field ${JSON.stringify(key)}`);
}

function renderFlatInvariantToml(entry: InvariantCatalogEntry): string {
  if (entry.form !== "flat") return "";
  const lines = [
    `# ${entry.label}`,
    `# ${entry.description}`,
    "[[invariants]]",
    `name = ${tomlString(entry.name)}`,
    `field = ${tomlString(entry.field ?? "")}`,
    `op = ${tomlString(entry.op ?? "==")}`,
    `value = ${formatTomlNumber(entry.value ?? 0)}`,
    `# severity = ${tomlString(entry.severity)} (wizard metadata; flat invariant firings are engine failures today)`
  ];
  const body = lines.join("\n");
  if (!entry.commented) return body;
  return [
    "# TEMPLATE - uncomment after wiring [observations].field.",
    ...body.split("\n").map((line) => `# ${line}`)
  ].join("\n");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function formatTomlNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(value);
}
