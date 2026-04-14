// `riptide scenarios --validate` — one-tick boot harness.
//
// This is the sibling of `riptide adapt`. The Claude Code
// `riptide-scenarios` skill is the sole proposer of experiments: the
// in-session agent reads the adapter + IDL, classifies plausible
// failure modes, writes a `run-config.json` + `policies.json` +
// `manifest.json` triple into
// `fixtures/scenarios/<adapter-stem>/<slug>/`, then shells out to
// this command to verify that each generated triple boots cleanly
// for one tick against the local engine.
//
// Scope (intentionally minimal, mirrors `adapt/smoke.ts`):
//   1. Resolve `<scenario>` to a directory containing the three files.
//   2. Load and Zod-validate `run-config.json`.
//   3. Load and Zod-validate `policies.json`.
//   4. Load and shape-check `manifest.json`, resolve adapter path.
//   5. Patch run-config to ticks = 1 so we boot-test, not full-run.
//   6. Invoke the engine with `--config / --policies / --adapter /
//      --output`. Walk the output JSON to confirm the engine
//      produced *something* — a timeseries of length >= 1 or a
//      summary object. This is a boot test, not a smoke test: we
//      are not asserting a state delta, only that one tick
//      completed.
//
// Exit codes (returned; the command wrapper calls process.exit):
//   0 — engine booted one tick cleanly
//   1 — engine failed to boot (crashed mid-tick or exited non-zero)
//   2 — file missing / JSON parse error / schema mismatch / manifest
//       missing / referenced adapter missing on disk

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import TOML from "toml";
import { z } from "zod";

import {
  PolicySchema,
  RunConfigSchema,
  type Policy,
  type RunConfig
} from "../compiler/schema.js";

export type ValidateExitCode = 0 | 1 | 2;

export interface ValidateScenarioOptions {
  scenarioPath: string;
  engineBinary: string;
  monorepoRoot: string;
}

export interface ValidateScenarioResult {
  exit: ValidateExitCode;
  reason: string;
  engineStderr?: string;
}

const ManifestSchema = z.object({
  adapter: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/),
  failure_mode: z.enum([
    "whale_concentration",
    "shock_cascades",
    "utilization_stress",
    "persona_mix_instability",
    "oracle_lag"
  ]),
  rationale: z.string().min(1)
});

export type Manifest = z.infer<typeof ManifestSchema>;

export async function validateScenario(
  options: ValidateScenarioOptions,
  // Injectable for tests: default spawns the real engine.
  spawnEngineImpl: SpawnEngine = spawnEngine
): Promise<ValidateScenarioResult> {
  // --- 1. Resolve the scenario directory ---
  const scenarioDir = await resolveScenarioDir(options.scenarioPath);
  if (!scenarioDir.ok) {
    return { exit: 2, reason: scenarioDir.reason };
  }

  const runConfigPath = path.join(scenarioDir.dir, "run-config.json");
  const policiesPath = path.join(scenarioDir.dir, "policies.json");
  const manifestPath = path.join(scenarioDir.dir, "manifest.json");

  // --- 2. Load + validate run-config ---
  const runConfigResult = await loadJsonAndValidate(
    runConfigPath,
    RunConfigSchema,
    "run-config.json"
  );
  if (!runConfigResult.ok) {
    return { exit: 2, reason: runConfigResult.reason };
  }
  const runConfig: RunConfig = runConfigResult.value;

  // --- 3. Load + validate policies ---
  // Two shapes are legal (matches what the engine actually ships):
  //   - Lending runs: policies.json is a non-empty array of Policy
  //     objects. The engine uses that as the persona catalog.
  //   - Generic runs: policies.json is `[]` and the persona catalog
  //     comes from the adapter TOML's `[personas.*]` tables
  //     (see `fixtures/generic-demo.policies.json` — empty — paired
  //     with `fixtures/adapters/resource-grinder.toml`).
  // Either shape is fine here. We only cross-check persona ids
  // against `policies.json` when the file is non-empty, because
  // that's the only case where we *can* check without reparsing
  // the adapter TOML.
  const policiesResult = await loadJsonAndValidate(
    policiesPath,
    z.array(PolicySchema),
    "policies.json"
  );
  if (!policiesResult.ok) {
    return { exit: 2, reason: policiesResult.reason };
  }
  const policies: Policy[] = policiesResult.value;

  // Cross-check persona ids. Two cases:
  //   - Lending (policies.json non-empty): persona catalog comes from
  //     policies.json. Every run-config.persona must appear there.
  //   - Generic (policies.json is []): persona catalog comes from the
  //     adapter TOML's `[personas.*]` tables. We parse the adapter and
  //     check against those keys. Without this, a typo like
  //     `personas: ["ghost"]` would leak through to the engine and
  //     crash mid-tick — returning exit 1 with a confusing stderr
  //     instead of exit 2 with the actual schema error.
  //
  // Adapter path resolution needs the manifest, so we compute that
  // first and reuse `adapterPath` in step 4 below.
  const manifestResult = await loadJsonAndValidate(
    manifestPath,
    ManifestSchema,
    "manifest.json"
  );
  if (!manifestResult.ok) {
    return { exit: 2, reason: manifestResult.reason };
  }
  const manifest: Manifest = manifestResult.value;
  // Security: manifest.adapter must stay inside monorepoRoot.
  //
  // Without this check, a hostile scenario directory could ship a
  // manifest with `adapter: "/etc/hosts"` (or `"../../../../etc/
  // hosts"`) and the validator would happily read that file during
  // the generic persona-id cross-check AND pass it as `--adapter`
  // to the engine. That turns `riptide scenarios --validate` into
  // an arbitrary-local-file read primitive and leaks path info into
  // the engine spawn.
  //
  // The containment check has two layers:
  //   1. Lexical: after `path.resolve` against monorepoRoot, the
  //      result must be inside monorepoRoot. This catches raw
  //      absolute paths and `..` escapes.
  //   2. Canonical: `realpath` both sides and re-check. This
  //      catches a path that *looks* inside the repo but walks out
  //      through a symlink mid-component. Example: `target/
  //      evil.toml` where `target/evil.toml` is a symlink to
  //      `/etc/hosts`. A purely lexical check would let that read
  //      `/etc/hosts`, defeating the whole guarantee.
  //
  // The canonical check requires the file (and every directory on
  // the path) to exist. If it doesn't, `realpath` throws ENOENT and
  // we fall through to the "missing file" branch with the raw
  // resolved path, which still gives the user a clear error
  // without widening the attack surface.
  const resolvedAdapter = path.resolve(options.monorepoRoot, manifest.adapter);
  if (!isInside(options.monorepoRoot, resolvedAdapter)) {
    return {
      exit: 2,
      reason: `manifest.adapter must resolve to a path inside the monorepo root (${options.monorepoRoot}), got: "${manifest.adapter}" → ${resolvedAdapter}`
    };
  }
  if (!existsSync(resolvedAdapter)) {
    return {
      exit: 2,
      reason: `manifest.adapter points at missing file: ${resolvedAdapter} (resolved from "${manifest.adapter}" under ${options.monorepoRoot})`
    };
  }
  let canonicalAdapter: string;
  let canonicalRoot: string;
  try {
    canonicalAdapter = await realpath(resolvedAdapter);
    canonicalRoot = await realpath(options.monorepoRoot);
  } catch (err) {
    return {
      exit: 2,
      reason: `manifest.adapter could not be canonicalized: ${errMessage(err)}`
    };
  }
  if (!isInside(canonicalRoot, canonicalAdapter)) {
    return {
      exit: 2,
      reason: `manifest.adapter resolves inside the monorepo root lexically but canonicalizes outside it — refusing to follow a symlink escape. raw: "${manifest.adapter}" → lexical: ${resolvedAdapter} → canonical: ${canonicalAdapter} (root canonical: ${canonicalRoot})`
    };
  }
  // Use the canonical path for downstream reads + the engine spawn,
  // so the engine sees the same bytes the validator checked.
  const adapterPath = canonicalAdapter;

  const declaredIds: Set<string> = new Set();
  if (policies.length > 0) {
    for (const p of policies) {
      declaredIds.add(p.persona_id);
    }
  } else {
    // Generic path: read adapter TOML and enumerate [personas.*].
    const adapterPersonas = await readAdapterPersonaIds(adapterPath);
    if (!adapterPersonas.ok) {
      return { exit: 2, reason: adapterPersonas.reason };
    }
    for (const id of adapterPersonas.ids) {
      declaredIds.add(id);
    }
  }

  const missing = runConfig.personas.filter((id) => !declaredIds.has(id));
  if (missing.length > 0) {
    const source =
      policies.length > 0
        ? "policies.json"
        : `adapter TOML [personas.*] at ${path.relative(options.monorepoRoot, adapterPath)}`;
    return {
      exit: 2,
      reason: `run-config.personas references persona ids not declared in ${source}: ${[
        ...new Set(missing)
      ].join(", ")}`
    };
  }

  // (manifest + adapterPath already resolved in step 3 above — we need
  //  them for the generic persona cross-check against the adapter TOML.)

  // --- 5. Patch run-config to one tick (boot test, not full run) ---
  const bootConfig: RunConfig = { ...runConfig, ticks: 1 };

  // --- 6. Invoke the engine ---
  if (!existsSync(options.engineBinary)) {
    return {
      exit: 1,
      reason: `engine binary not found at ${options.engineBinary} — build it with \`cargo build --release -p riptide-engine\``
    };
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "riptide-scenarios-"));
  const configFile = path.join(tempDir, "run-config.json");
  const policiesFile = path.join(tempDir, "policies.json");
  const outputFile = path.join(tempDir, "boot-output.json");

  await writeFile(configFile, JSON.stringify(bootConfig, null, 2), "utf8");
  await writeFile(policiesFile, JSON.stringify(policies, null, 2), "utf8");

  const spawnResult = await spawnEngineImpl({
    engineBinary: options.engineBinary,
    configPath: configFile,
    policiesPath: policiesFile,
    outputPath: outputFile,
    adapterPath
  });

  if (spawnResult.code !== 0) {
    return {
      exit: 1,
      reason: `engine exited with code ${spawnResult.code} booting ${path.relative(
        options.monorepoRoot,
        scenarioDir.dir
      )} (tick 1 of 1)`,
      engineStderr: spawnResult.stderr
    };
  }

  // The engine exited 0 — confirm it actually produced an output
  // file with a timeseries entry. "Exited 0 with no output" would
  // be a silent false pass.
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(outputFile, "utf8"));
  } catch (err) {
    return {
      exit: 1,
      reason: `engine exited 0 but output at ${outputFile} could not be read/parsed: ${errMessage(err)}`,
      engineStderr: spawnResult.stderr
    };
  }
  if (!hasAtLeastOneTick(parsed)) {
    return {
      exit: 1,
      reason: "engine exited 0 but produced no timeseries entries — one-tick boot did not run",
      engineStderr: spawnResult.stderr
    };
  }

  return {
    exit: 0,
    reason: `boot ok — engine ran one tick against ${path.relative(options.monorepoRoot, adapterPath)}`
  };
}

// --- Helpers -------------------------------------------------------

export interface SpawnEngineOptions {
  engineBinary: string;
  configPath: string;
  policiesPath: string;
  outputPath: string;
  adapterPath: string;
}

export type SpawnEngine = (options: SpawnEngineOptions) => Promise<{
  code: number;
  stderr: string;
}>;

const spawnEngine: SpawnEngine = (options) => {
  return new Promise((resolve) => {
    const child = spawn(
      options.engineBinary,
      [
        "--config",
        options.configPath,
        "--policies",
        options.policiesPath,
        "--output",
        options.outputPath,
        "--adapter",
        options.adapterPath
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout.on("data", () => {});
    child.on("error", (err) => {
      resolve({ code: -1, stderr: `${stderr}\nspawn error: ${err.message}` });
    });
    child.on("exit", (code) => {
      resolve({ code: code ?? -1, stderr });
    });
  });
};

interface ResolvedDir {
  ok: true;
  dir: string;
}
interface UnresolvedDir {
  ok: false;
  reason: string;
}

async function resolveScenarioDir(
  scenarioPath: string
): Promise<ResolvedDir | UnresolvedDir> {
  const abs = path.resolve(scenarioPath);
  if (!existsSync(abs)) {
    return { ok: false, reason: `scenario path does not exist: ${abs}` };
  }
  let s;
  try {
    s = await stat(abs);
  } catch (err) {
    return {
      ok: false,
      reason: `could not stat scenario path ${abs}: ${errMessage(err)}`
    };
  }
  if (s.isDirectory()) {
    return { ok: true, dir: abs };
  }
  // User pointed at run-config.json directly — take the containing dir.
  if (path.basename(abs) === "run-config.json") {
    return { ok: true, dir: path.dirname(abs) };
  }
  return {
    ok: false,
    reason: `scenario path must be a directory or point at run-config.json, got: ${abs}`
  };
}

// Parse an adapter TOML and return the set of persona ids declared
// in its `[personas.*]` tables. Used by the validator when
// `policies.json` is empty (generic adapters) so we can give an
// honest schema-level error if `run-config.personas` references a
// persona id that doesn't exist in the adapter.
async function readAdapterPersonaIds(
  adapterPath: string
): Promise<{ ok: true; ids: string[] } | { ok: false; reason: string }> {
  let raw: string;
  try {
    raw = await readFile(adapterPath, "utf8");
  } catch (err) {
    return {
      ok: false,
      reason: `adapter TOML at ${adapterPath} unreadable: ${errMessage(err)}`
    };
  }
  let parsed: unknown;
  try {
    parsed = TOML.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reason: `adapter TOML at ${adapterPath} could not be parsed: ${errMessage(err)}`
    };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: true, ids: [] };
  }
  const personas = (parsed as Record<string, unknown>)["personas"];
  if (!personas || typeof personas !== "object") {
    return { ok: true, ids: [] };
  }
  return { ok: true, ids: Object.keys(personas as Record<string, unknown>) };
}

async function loadJsonAndValidate<T>(
  filePath: string,
  schema: z.ZodType<T>,
  label: string
): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  if (!existsSync(filePath)) {
    return { ok: false, reason: `${label} missing at ${filePath}` };
  }
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    return {
      ok: false,
      reason: `${label} at ${filePath} unreadable: ${errMessage(err)}`
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reason: `${label} at ${filePath} is not valid JSON: ${errMessage(err)}`
    };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const loc = firstIssue?.path?.length
      ? `field \`${firstIssue.path.join(".")}\`: `
      : "";
    const msg = firstIssue?.message ?? "schema mismatch";
    return {
      ok: false,
      reason: `${label} at ${filePath} failed schema validation — ${loc}${msg}`
    };
  }
  return { ok: true, value: result.data };
}

// Proof-of-boot contract: the engine must have produced at least one
// concrete timeseries entry with a numeric `tick` field. A populated
// `total_ticks` number alone is NOT sufficient — the engine writes
// that counter as part of its run metadata, and a silently-broken run
// can land 0 on disk alongside `total_ticks: 1`. The timeseries
// element is the only signal that proves the tick loop actually
// advanced.
function hasAtLeastOneTick(output: unknown): boolean {
  if (!output || typeof output !== "object") {
    return false;
  }
  const root = output as Record<string, unknown>;
  const ts = root["timeseries"];
  if (!Array.isArray(ts) || ts.length === 0) {
    return false;
  }
  const first = ts[0];
  if (!first || typeof first !== "object") {
    return false;
  }
  const tick = (first as Record<string, unknown>)["tick"];
  return typeof tick === "number" && Number.isFinite(tick) && tick >= 0;
}

// Containment check: returns true iff `child` resolves to the same
// path as `parent` or a descendant of it. Both arguments must
// already be absolute. Uses path.relative rather than a string
// prefix so that `/foo` and `/foo-bar` are correctly distinguished.
function isInside(parent: string, child: string): boolean {
  const absParent = path.resolve(parent);
  const absChild = path.resolve(child);
  const rel = path.relative(absParent, absChild);
  if (rel === "") {
    return true;
  }
  if (rel.startsWith("..")) {
    return false;
  }
  if (path.isAbsolute(rel)) {
    return false;
  }
  return true;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
