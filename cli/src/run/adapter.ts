// Per-scenario adapter resolution for `riptide run`.
//
// Resolution order (R9.1, applied per scenario):
//   1. Global override — passed via `--adapter <path>` on the command
//      line, applies to every scenario in the sweep. The escape valve
//      for users who want to point every discovered scenario at one
//      adapter regardless of declared metadata.
//   2. Scenario's own `run-config.json` `adapter` field, if present.
//      Path is resolved relative to the run-config's directory so a
//      scenario can ship a colocated adapter without leaking absolute
//      paths into the JSON.
//   3. Monorepo bundle fallback — derive from the first path segment
//      of the scenario name. `resource-grinder/...` maps to
//      `<monorepo>/fixtures/adapters/resource-grinder.toml`,
//      `lending/...` to `lending.toml`, etc. This is the
//      mechanism that makes `riptide run` work from the monorepo root
//      across mixed bundles.
//   4. Scaffolded user-repo path — single `.toml` under
//      `<cwd>/.riptide/adapters/`. Same heuristic the global resolver
//      used pre-T09; preserved here as the per-scenario fallback for
//      drop-in users.
//   5. Error — clear message about which step failed so the user
//      knows what to add.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import type { ResolvedScenario } from "./loop.js";

export interface AdapterResolverDeps {
  cwd: string;
  monorepoRoot?: string | null;
  /** Global `--adapter <path>` override applied uniformly to every scenario. */
  globalOverride?: string;
}

export type ScenarioAdapterResolution =
  | { kind: "ok"; path: string; source: AdapterResolutionSource }
  | { kind: "error"; message: string };

export type AdapterResolutionSource =
  | "override"
  | "run-config"
  | "bundle"
  | "scaffold";

interface RunConfigAdapterField {
  adapter?: unknown;
}

export function createAdapterResolver(deps: AdapterResolverDeps) {
  const cache = new Map<string, ScenarioAdapterResolution>();
  return function resolve(scenario: ResolvedScenario): ScenarioAdapterResolution {
    const cached = cache.get(scenario.runConfigPath);
    if (cached) return cached;
    const resolution = resolveAdapterForScenario(scenario, deps);
    cache.set(scenario.runConfigPath, resolution);
    return resolution;
  };
}

export function resolveAdapterForScenario(
  scenario: ResolvedScenario,
  deps: AdapterResolverDeps
): ScenarioAdapterResolution {
  if (deps.globalOverride && deps.globalOverride.length > 0) {
    return { kind: "ok", path: path.resolve(deps.globalOverride), source: "override" };
  }

  // (2) scenario's own declared adapter field
  const declared = readDeclaredAdapter(scenario.runConfigPath);
  if (declared) {
    const resolved = path.resolve(path.dirname(scenario.runConfigPath), declared);
    if (!existsSync(resolved)) {
      return {
        kind: "error",
        message:
          `riptide run: scenario ${scenario.name} declares adapter ${JSON.stringify(declared)} ` +
          `in ${scenario.runConfigPath}, but the file was not found at ${resolved}.`
      };
    }
    return { kind: "ok", path: resolved, source: "run-config" };
  }

  // (3) monorepo fallback — derive from first segment of scenario name
  const firstSegment = scenario.name.split("/").filter((s) => s.length > 0)[0];
  if (firstSegment && deps.monorepoRoot) {
    const candidate = path.join(
      deps.monorepoRoot,
      "fixtures",
      "adapters",
      `${firstSegment}.toml`
    );
    if (existsSync(candidate)) {
      return { kind: "ok", path: candidate, source: "bundle" };
    }
  }

  // (4) scaffolded user-repo: single .toml under .riptide/adapters/
  const scaffoldDir = path.join(deps.cwd, ".riptide", "adapters");
  if (existsSync(scaffoldDir)) {
    const tomls = readdirSync(scaffoldDir)
      .filter((e) => e.endsWith(".toml"))
      .sort();
    if (tomls.length === 1) {
      return {
        kind: "ok",
        path: path.join(scaffoldDir, tomls[0]!),
        source: "scaffold"
      };
    }
    if (tomls.length > 1) {
      return {
        kind: "error",
        message:
          `riptide run: scenario ${scenario.name} has no declared adapter and ` +
          `.riptide/adapters/ contains multiple TOMLs (${tomls.join(", ")}). ` +
          `Pass --adapter <path> to disambiguate, or add an "adapter" field to ` +
          `${scenario.runConfigPath}.`
      };
    }
  }

  return {
    kind: "error",
    message:
      `riptide run: could not resolve an adapter for scenario ${scenario.name}.\n` +
      `Tried in order:\n` +
      `  1. --adapter <path> (not set)\n` +
      `  2. "adapter" field in ${scenario.runConfigPath} (not set)\n` +
      (firstSegment
        ? `  3. monorepo bundle fixtures/adapters/${firstSegment}.toml (not found)\n`
        : `  3. monorepo bundle fallback (skipped — empty scenario name)\n`) +
      `  4. single .toml under .riptide/adapters/ (not present)\n` +
      `Add an "adapter" field to the scenario's run-config.json or pass --adapter explicitly.`
  };
}

function readDeclaredAdapter(runConfigPath: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(runConfigPath, "utf8");
  } catch {
    return null;
  }
  let parsed: RunConfigAdapterField;
  try {
    parsed = JSON.parse(raw) as RunConfigAdapterField;
  } catch {
    return null;
  }
  if (typeof parsed.adapter === "string" && parsed.adapter.length > 0) {
    return parsed.adapter;
  }
  return null;
}
