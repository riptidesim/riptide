// Scenario discovery module.
//
// Walks `.riptide/scenarios/**/run-config.json` relative to a caller-supplied
// `cwd`, returning a stable sorted list of scenarios. Pure module: no process
// exits, no stderr writes, no global state — the caller (CLI command) decides
// how to surface the result.
//
// Scenario semantics (part of the public contract — other commands consume
// this shape):
// - Name = directory path relative to `.riptide/scenarios/`, with `/` as
//   separator on every OS (Windows backslashes are normalized).
// - `runConfigPath` is always absolute.
// - Sort is plain lexicographic via `localeCompare(..., "en-US", { sensitivity: "variant" })`.
//   Deliberately NOT natural-numeric — `w100-s20` < `w25-s20`. Simpler,
//   fewer cross-OS surprises. Document if/when users complain.
// - Malformed run-config.json: emit a warning string, skip that scenario,
//   keep walking. Discovery is schema-light here; the downstream runner
//   validates full run-config shape.
// - Missing `.riptide/` at cwd → `{ kind: "missing", ... }` so the caller
//   can exit with a setup-error code. Missing-but-present `.riptide/scenarios/`
//   (or empty) → `{ kind: "ok", scenarios: [], warnings: [] }`.

import { promises as fs } from "node:fs";
import path from "node:path";

export interface DiscoveredScenario {
  name: string;
  runConfigPath: string;
}

export type DiscoveryResult =
  | { kind: "ok"; scenarios: DiscoveredScenario[]; warnings: string[] }
  | { kind: "missing"; message: string };

export interface DiscoverOptions {
  cwd: string;
}

const RIPTIDE_DIR = ".riptide";
const SCENARIOS_DIR = "scenarios";
const RUN_CONFIG_FILE = "run-config.json";

export async function discoverScenarios(
  opts: DiscoverOptions
): Promise<DiscoveryResult> {
  const riptideDir = path.join(opts.cwd, RIPTIDE_DIR);
  const scenariosRoot = path.join(riptideDir, SCENARIOS_DIR);

  if (!(await pathExists(riptideDir))) {
    return {
      kind: "missing",
      message: `No .riptide/ directory found at ${opts.cwd}. Run 'riptide init' to scaffold one.`
    };
  }

  if (!(await pathExists(scenariosRoot))) {
    // `.riptide/` exists but no scenarios subdir — treat as empty, not missing.
    return { kind: "ok", scenarios: [], warnings: [] };
  }

  const scenarios: DiscoveredScenario[] = [];
  const warnings: string[] = [];

  await walk(scenariosRoot, scenariosRoot, scenarios, warnings);

  // Stable sort: plain lexicographic, variant sensitivity. Explicit about
  // locale to keep behavior identical across user machines.
  scenarios.sort((a, b) =>
    a.name.localeCompare(b.name, "en-US", { sensitivity: "variant" })
  );

  return { kind: "ok", scenarios, warnings };
}

async function walk(
  root: string,
  dir: string,
  out: DiscoveredScenario[],
  warnings: string[]
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    warnings.push(`failed to read directory ${dir}: ${errMessage(err)}`);
    return;
  }

  // First check whether this dir itself is a scenario (has run-config.json).
  const hasRunConfig = entries.some(
    (e) => e.isFile() && e.name === RUN_CONFIG_FILE
  );

  if (hasRunConfig) {
    const runConfigPath = path.join(dir, RUN_CONFIG_FILE);
    const parseOk = await isParseableJson(runConfigPath);
    if (parseOk.ok) {
      const name = deriveScenarioName(root, dir);
      out.push({ name, runConfigPath });
    } else {
      warnings.push(
        `skipped ${runConfigPath}: malformed JSON (${parseOk.error})`
      );
    }
    // Don't recurse into a scenario dir: run-config.json marks a leaf.
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      await walk(root, path.join(dir, entry.name), out, warnings);
    }
  }
}

function deriveScenarioName(root: string, dir: string): string {
  const rel = path.relative(root, dir);
  // Normalize to `/` on every OS.
  return rel.split(path.sep).join("/");
}

async function isParseableJson(
  filePath: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    JSON.parse(raw);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
