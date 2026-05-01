// Scenario catalog for the `riptide init` wizard.
//
// Files ship under cli/assets/init-scenarios/<bucket>/<slug>.toml and
// describe only engine-dispatched scenario values that do real work today.
// The wizard resolves these catalog entries into scaffold-ready
// run-config.json files.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import TOML from "toml";

import type { Protocol } from "./personas-catalog.js";

export interface ScenarioCatalogEntry {
  name: string;
  label: string;
  description: string;
  scenario: string;
  agents?: number;
  ticks?: number;
  defaultPersonas?: string[];
  recommended: boolean;
  required: boolean;
  source: string;
}

export interface InitScenarioConfig {
  /** Scaffolded directory name under .riptide/scenarios/. */
  name: string;
  /** Engine-side scenario dispatch value. */
  scenario: string;
  agents: number;
  ticks: number;
  /** Optional explicit seed. Present quick-smoke configs run one deterministic cell. */
  seed?: number;
  /** Optional sweep size. Used when seed is absent. */
  seeds?: number;
  /** Persona slugs written into this scenario's run-config.json. */
  personas: string[];
}

// Probe candidate asset roots, mirroring cli/src/init/personas-catalog.ts.
// Layouts: built package assets, dist-copied assets, and source-tree assets.
export function scenarioAssetCandidates(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(here, "..", "..", "..", "assets", "init-scenarios"),
    path.resolve(here, "..", "..", "assets", "init-scenarios"),
    path.resolve(here, "..", "assets", "init-scenarios")
  ];
}

// Lookup precedence: protocol-specific bucket first, then the generic
// `custom/` bucket. This lets future generic scenarios appear under every
// protocol without duplicating TOML files.
export function scenarioPathCandidates(protocol: Protocol, slug: string): string[] {
  const roots = scenarioAssetCandidates();
  const buckets = protocol === "custom" ? ["custom"] : [protocol, "custom"];
  const out: string[] = [];
  for (const root of roots) {
    for (const bucket of buckets) {
      out.push(path.join(root, bucket, `${slug}.toml`));
    }
  }
  return out;
}

export function scenarioChoicesFor(protocol: Protocol): ScenarioCatalogEntry[] {
  const buckets = protocol === "custom" ? ["custom"] : [protocol, "custom"];
  const seen = new Set<string>();
  const out: ScenarioCatalogEntry[] = [];

  for (const bucket of buckets) {
    for (const entry of scenarioEntriesForBucket(bucket)) {
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      out.push(entry);
    }
  }

  return out;
}

function scenarioEntriesForBucket(bucket: string): ScenarioCatalogEntry[] {
  for (const root of scenarioAssetCandidates()) {
    const dir = path.join(root, bucket);
    if (!existsSync(dir)) continue;

    const files = readdirSync(dir)
      .filter((entry) => entry.endsWith(".toml"))
      .sort((a, b) => a.localeCompare(b, "en-US", { sensitivity: "variant" }));

    if (files.length === 0) continue;

    return stableScenarioOrder(files.map((file) => parseScenarioFile(path.join(dir, file))));
  }

  return [];
}

function stableScenarioOrder(entries: ScenarioCatalogEntry[]): ScenarioCatalogEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const priorityDelta = scenarioPriority(b.entry) - scenarioPriority(a.entry);
      return priorityDelta === 0 ? a.index - b.index : priorityDelta;
    })
    .map(({ entry }) => entry);
}

function scenarioPriority(entry: ScenarioCatalogEntry): number {
  if (entry.required) return 2;
  if (entry.recommended) return 1;
  return 0;
}

function parseScenarioFile(filePath: string): ScenarioCatalogEntry {
  const raw = readFileSync(filePath, "utf8");
  const parsed = TOML.parse(raw) as Record<string, unknown>;
  return {
    name: requiredString(parsed, "name", filePath),
    label: requiredString(parsed, "label", filePath),
    description: requiredString(parsed, "description", filePath),
    scenario: requiredString(parsed, "scenario", filePath),
    agents: optionalPositiveInteger(parsed, "agents", filePath),
    ticks: optionalPositiveInteger(parsed, "ticks", filePath),
    defaultPersonas: optionalStringArray(parsed, "default_personas", filePath),
    recommended: optionalBoolean(parsed, "recommended", false, filePath),
    required: optionalBoolean(parsed, "required", false, filePath),
    source: filePath
  };
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

function optionalPositiveInteger(
  parsed: Record<string, unknown>,
  key: string,
  filePath: string
): number | undefined {
  const value = parsed[key];
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  throw new Error(`${filePath}: expected positive integer field ${JSON.stringify(key)}`);
}

function optionalStringArray(
  parsed: Record<string, unknown>,
  key: string,
  filePath: string
): string[] | undefined {
  const value = parsed[key];
  if (value === undefined) return undefined;
  if (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.trim().length > 0)
  ) {
    return [...value];
  }
  throw new Error(`${filePath}: expected string array field ${JSON.stringify(key)}`);
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
