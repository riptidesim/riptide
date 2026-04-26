// Run-loop orchestration for `riptide run`.
//
// Discovery → filter → sequential engine invocations → last-run.json.
// Emits a typed event stream the command-layer formatter subscribes
// to. Pure module: no process.exit, no stderr writes, no argv
// parsing; the command wrapper in `cli/src/commands/run.ts` owns I/O
// and exit codes.
//
// Sequential-only this sprint (R3.6). Parallel execution is Sprint 9+.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import TOML from "toml";

import { buildSimulateOptions, toRunConfig, type SimulateOptions } from "../config.js";
import type { RunConfig } from "../compiler/schema.js";
import {
  discoverScenarios,
  type DiscoveredScenario,
  type DiscoveryResult
} from "../discovery/index.js";
import { runOrchestrator } from "../orchestrator/index.js";
import { emitPack } from "../pack/index.js";
import { writeArtifacts } from "../report/artifacts.js";
import { validateAdapter } from "../schemas/adapter.js";
import type { SimulationResult } from "../compiler/schema.js";

import {
  createAdapterResolver,
  type AdapterResolverDeps,
  type ScenarioAdapterResolution
} from "./adapter.js";
import { filterScenariosByPattern } from "./glob.js";
import {
  failingNames,
  readLastRun,
  writeLastRun,
  type InvariantFire,
  type LastRun,
  type ScenarioRecord
} from "./last-run.js";
import { writeRunCollection } from "./collection.js";
import { interpretScenarioResult, type ArtifactReadability } from "./interpretation.js";

export type RunEvent =
  | { type: "run_start"; total: number; cwd: string }
  | { type: "warning"; message: string }
  | { type: "scenario_start"; index: number; total: number; scenario: DiscoveredScenario }
  | {
      type: "scenario_end";
      index: number;
      total: number;
      scenario: DiscoveredScenario;
      record: ScenarioRecord;
    }
  | { type: "run_end"; summary: RunSummary };

export interface RunSummary {
  pass: number;
  fail: number;
  /** Setup / engine-crash errors — scenarios that never produced a trustworthy result. */
  error: number;
  /** SIGINT-skipped scenarios that never started. */
  skipped: number;
  total: number;
  signalAborted: boolean;
  partialAbort: boolean;
  /** Absolute path to the last-run.json just written. */
  lastRunPath: string;
  /** Absolute path to the latest run collection JSON just written. */
  runCollectionPath: string;
  /** Artifacts dir of the last scenario that produced one. */
  lastArtifactsDir?: string;
  /** Per-scenario records (same shape as last-run.json). */
  scenarios: ScenarioRecord[];
}

export interface RunLoopOptions {
  cwd: string;
  adapterPath?: string;
  onEvent?: (event: RunEvent) => void;
}

/**
 * Resolve the scenarios to run from the positional arg + flags.
 *
 * Returns either:
 * - { kind: "ok", scenarios, sourcePath? } — list to run; sourcePath set
 *   for single-file invocations (backward-compat), absent for discovery.
 * - { kind: "setup_error", message } — discovery missing, file not
 *   found, no match for filter, etc. Caller exits 2.
 *
 * Disambiguation rule (R3.3 + T03 done-when #4): if the arg exists as
 * a `.json` file on disk, it ALWAYS wins over treating it as a glob.
 */
export type ResolveResult =
  | { kind: "ok"; scenarios: ResolvedScenario[]; sourcePath?: string; warnings: string[] }
  | { kind: "setup_error"; message: string };

export interface ResolvedScenario {
  name: string;
  runConfigPath: string;
}

export interface ResolveInput {
  cwd: string;
  positional?: string;
  onlyFailing?: boolean;
  /** Injection hook for tests. Defaults to the real discoverScenarios. */
  discover?: (cwd: string) => Promise<DiscoveryResult>;
  /** Injection hook for tests. Defaults to fs.existsSync against absolute path. */
  fileExists?: (absPath: string) => boolean;
}

export async function resolveScenarios(input: ResolveInput): Promise<ResolveResult> {
  const discover = input.discover ?? ((cwd) => discoverScenarios({ cwd }));
  const fileExists =
    input.fileExists ??
    ((p: string) => {
      try {
        readFileSync(p);
        return true;
      } catch {
        return false;
      }
    });

  // Backward-compat path: a positional that looks like an existing
  // `.json` file runs that file as a single scenario. This MUST win
  // over glob interpretation so existing scripts never break. Name is
  // derived from the file's parent directory (e.g., `…/baseline/run-
  // config.json` → `baseline`) so per-scenario output/records still
  // read naturally. For run-config files NOT under `.riptide/scenarios/`
  // we fall back to the file's parent dir name.
  if (typeof input.positional === "string" && input.positional.endsWith(".json")) {
    const abs = path.resolve(input.cwd, input.positional);
    if (fileExists(abs)) {
      return {
        kind: "ok",
        scenarios: [
          {
            name: deriveSingleFileName(abs, input.cwd),
            runConfigPath: abs
          }
        ],
        sourcePath: abs,
        warnings: []
      };
    }
  }

  const discovered = await discover(input.cwd);
  if (discovered.kind === "missing") {
    // If the user passed a `.json` positional that didn't exist, name
    // that specifically — more actionable than a generic "no .riptide/"
    // message. Otherwise surface the discovery diagnostic directly.
    if (typeof input.positional === "string" && input.positional.endsWith(".json")) {
      return {
        kind: "setup_error",
        message: `riptide run: run-config not found at ${path.resolve(input.cwd, input.positional)}`
      };
    }
    return { kind: "setup_error", message: `riptide run: ${discovered.message}` };
  }

  let scenarios: ResolvedScenario[] = discovered.scenarios.map((s) => ({
    name: s.name,
    runConfigPath: s.runConfigPath
  }));

  if (input.positional && input.positional.length > 0) {
    scenarios = filterScenariosByPattern(scenarios, input.positional);
    if (scenarios.length === 0) {
      return {
        kind: "setup_error",
        message:
          `riptide run: pattern ${JSON.stringify(input.positional)} did not match any ` +
          `discovered scenario under .riptide/scenarios/.\n` +
          `Run 'riptide list' to see discovered scenarios.`
      };
    }
  }

  if (input.onlyFailing) {
    const last = await readLastRun(input.cwd);
    if (last === null) {
      return {
        kind: "setup_error",
        message:
          "riptide run --only-failing: no .riptide/last-run.json found — run 'riptide run' once first."
      };
    }
    const failing = failingNames(last);
    scenarios = scenarios.filter((s) => failing.has(s.name));
    if (scenarios.length === 0) {
      return {
        kind: "setup_error",
        message:
          "riptide run --only-failing: no failing scenarios from the most recent run — everything passed."
      };
    }
  }

  return { kind: "ok", scenarios, warnings: discovered.warnings };
}

function deriveSingleFileName(abs: string, cwd: string): string {
  // Prefer `.riptide/scenarios/<name>/run-config.json` → `<name>` for
  // consistency with discovery. For anything else, fall back to the
  // parent directory basename.
  const scenariosRoot = path.join(cwd, ".riptide", "scenarios");
  const parent = path.dirname(abs);
  if (parent.startsWith(scenariosRoot + path.sep) || parent === scenariosRoot) {
    const rel = path.relative(scenariosRoot, parent);
    if (rel && !rel.startsWith("..")) {
      return rel.split(path.sep).join("/");
    }
  }
  return path.basename(parent);
}

export interface RunScenariosInput {
  scenarios: ResolvedScenario[];
  cwd: string;
  /**
   * Global adapter override passed via `--adapter <path>`. When set,
   * it wins for every scenario; when unset, the per-scenario resolver
   * in `cli/src/run/adapter.ts` picks an adapter per scenario using
   * the scenario's run-config field, the monorepo bundle fallback, or
   * the scaffolded `.riptide/adapters/<one>.toml` convention.
   */
  adapterOverride?: string;
  /** Module-root hint for the monorepo bundle fallback. Tests pass `null` to disable. */
  monorepoRoot?: string | null;
  /**
   * When true, suppress live engine-stderr pass-through during each
   * scenario run. Captured stderr is attached to scenario records so
   * the formatter can surface it in the per-failure block. Default
   * true for `riptide run` (quiet-by-default per R10.1); the CLI sets
   * it false under `--verbose`.
   */
  silent?: boolean;
  /** Override artifact root for run-produced `simulation-result.json`. Defaults to `<cwd>/.riptide/runs`. */
  outputDir?: string;
  /** Original positional pattern/path, when the command selected by user input. */
  selectedPattern?: string;
  /** Single-file source path, when resolution selected one explicit run-config. */
  selectedSourcePath?: string;
  /** Mirrors the CLI flag for reviewer-facing collection metadata only. */
  allowInvariantViolations?: boolean;
  onEvent?: (event: RunEvent) => void;
  /** Injection hook for tests — substitute the orchestrator invocation. */
  runOne?: (ctx: RunOneContext) => Promise<RunOneResult>;
  /**
   * If set, treat a SIGINT as "abort after the current scenario finishes."
   * Default: true. Tests disable this so they can inject aborts explicitly.
   */
  handleSignals?: boolean;
}

export interface RunOneContext {
  scenario: ResolvedScenario;
  cwd: string;
  adapterPath?: string;
  /** Source label for debugging + verbose output ("override" | "run-config" | "bundle" | "scaffold"). */
  adapterSource?: string;
  /** True → orchestrator runs in silent mode, stderr captured not streamed. */
  silent?: boolean;
  /** Artifact root directory override (T11). */
  outputDir?: string;
}

export type RunOneResult =
  | {
      kind: "pass";
      wallClockS: number;
      artifactsDir: string;
      result: SimulationResult;
      /** Captured engine stderr when silent mode was on (informational). */
      engineStderr?: string;
    }
  | {
      kind: "fail";
      wallClockS: number;
      artifactsDir: string;
      result: SimulationResult;
      fires: InvariantFire[];
      engineStderr?: string;
    }
  | {
      kind: "error";
      wallClockS: number;
      error: string;
      /** Captured engine stderr when available — used to surface real engine diagnostics. */
      engineStderr?: string;
    };

/**
 * Execute the resolved scenarios sequentially and return the final
 * summary. Writes `.riptide/last-run.json` at the end of the invocation
 * (including on SIGINT — the partial record still lands on disk so
 * `--only-failing` works on the next invocation).
 */
export async function runScenarios(input: RunScenariosInput): Promise<RunSummary> {
  const onEvent = input.onEvent ?? (() => {});
  const runOne = input.runOne ?? defaultRunOne;
  const handleSignals = input.handleSignals !== false;

  // Per-scenario adapter resolver. Injection-friendly so tests can
  // skip resolution entirely by passing a fake runOne; when runOne is
  // the default engine path we lean on the resolver to pick an
  // adapter per scenario.
  const resolverDeps: AdapterResolverDeps = {
    cwd: input.cwd,
    monorepoRoot: input.monorepoRoot ?? null,
    globalOverride: input.adapterOverride
  };
  const resolveAdapter = createAdapterResolver(resolverDeps);

  const startedAt = new Date().toISOString();

  let signalAborted = false;
  const sigintHandler = () => {
    signalAborted = true;
  };
  if (handleSignals) {
    process.on("SIGINT", sigintHandler);
  }

  const records: ScenarioRecord[] = [];
  let pass = 0;
  let fail = 0;
  let error = 0;
  let skipped = 0;
  let partialAbort = false;
  let lastArtifactsDir: string | undefined;

  onEvent({ type: "run_start", total: input.scenarios.length, cwd: input.cwd });

  for (let i = 0; i < input.scenarios.length; i += 1) {
    const scenario = input.scenarios[i]!;
    const total = input.scenarios.length;

    if (signalAborted) {
      // Remaining scenarios were never started — skipped.
      const record: ScenarioRecord = {
        name: scenario.name,
        run_config_path: scenario.runConfigPath,
        status: "skipped",
        wall_clock_s: 0,
        invariant_fires: [],
        error: "skipped: SIGINT received before scenario could start"
      };
      record.interpretation = interpretScenarioResult({ record, result: null });
      records.push(record);
      skipped += 1;
      continue;
    }

    onEvent({ type: "scenario_start", index: i, total, scenario });

    let adapterResolution: ScenarioAdapterResolution | null = null;
    let adapterPathForInterpretation: string | undefined;
    let runResult: RunOneResult;

    try {
      // Resolve the adapter only when the caller relies on the default
      // runOne. Injected test runOnes provide their own adapter paths
      // (or ignore them entirely) so the resolver's filesystem checks
      // don't leak into unit tests.
      const adapterPath = (() => {
        if (input.runOne) return input.adapterOverride;
        adapterResolution = resolveAdapter(scenario);
        if (adapterResolution.kind === "error") {
          return undefined;
        }
        return adapterResolution.path;
      })();
      adapterPathForInterpretation = adapterPath;

      if (adapterResolution && adapterResolution.kind === "error") {
        runResult = {
          kind: "error",
          wallClockS: 0,
          error: adapterResolution.message
        };
      } else {
        runResult = await runOne({
          scenario,
          cwd: input.cwd,
          adapterPath,
          adapterSource: adapterResolution?.kind === "ok" ? adapterResolution.source : undefined,
          silent: input.silent !== false,
          outputDir: input.outputDir
        });
      }
    } catch (err) {
      runResult = {
        kind: "error",
        wallClockS: 0,
        error: errMessage(err),
        engineStderr:
          err && typeof err === "object" && "stderrFull" in err
            ? ((err as { stderrFull?: string }).stderrFull ?? undefined)
            : undefined
      };
    }

    const declaredInvariants =
      runResult.kind === "pass" || runResult.kind === "fail"
        ? declaredInvariantNames(adapterPathForInterpretation)
        : undefined;
    const record = recordForResult(input.cwd, scenario, runResult, declaredInvariants);
    records.push(record);

    if (record.status === "pass") {
      pass += 1;
      if (runResult.kind === "pass") lastArtifactsDir = runResult.artifactsDir;
    } else if (record.status === "fail") {
      fail += 1;
      if (runResult.kind === "fail") lastArtifactsDir = runResult.artifactsDir;
    } else {
      error += 1;
      partialAbort = true;
    }

    onEvent({ type: "scenario_end", index: i, total, scenario, record });
  }

  if (handleSignals) {
    process.off("SIGINT", sigintHandler);
  }

  const finishedAt = new Date().toISOString();

  const lastRun: LastRun = {
    schema_version: 1,
    started_at: startedAt,
    finished_at: finishedAt,
    signal_aborted: signalAborted,
    partial_abort: partialAbort && !signalAborted,
    scenarios: records
  };
  const lastRunAbsPath = await writeLastRun(input.cwd, lastRun);
  const runCollectionAbsPath = await writeRunCollection({
    cwd: input.cwd,
    startedAt,
    finishedAt,
    scenarios: records,
    selectedPattern: input.selectedPattern,
    selectedSourcePath: input.selectedSourcePath,
    allowInvariantViolations: input.allowInvariantViolations
  });

  const summary: RunSummary = {
    pass,
    fail,
    error,
    skipped,
    total: input.scenarios.length,
    signalAborted,
    partialAbort: partialAbort && !signalAborted,
    lastRunPath: lastRunAbsPath,
    runCollectionPath: runCollectionAbsPath,
    lastArtifactsDir,
    scenarios: records
  };

  onEvent({ type: "run_end", summary });

  return summary;
}

function recordForResult(
  cwd: string,
  scenario: ResolvedScenario,
  result: RunOneResult,
  declaredInvariants: readonly string[] | undefined
): ScenarioRecord {
  if (result.kind === "pass") {
    const record: ScenarioRecord = {
      name: scenario.name,
      run_config_path: scenario.runConfigPath,
      status: "pass",
      wall_clock_s: roundSec(result.wallClockS),
      invariant_fires: [],
      artifacts_dir: result.artifactsDir
    };
    record.interpretation = interpretScenarioResult({
      record,
      result: result.result,
      declaredInvariants,
      artifactReadability: artifactReadability(cwd, record.artifacts_dir)
    });
    return record;
  }
  if (result.kind === "fail") {
    const record: ScenarioRecord = {
      name: scenario.name,
      run_config_path: scenario.runConfigPath,
      status: "fail",
      wall_clock_s: roundSec(result.wallClockS),
      invariant_fires: result.fires,
      artifacts_dir: result.artifactsDir,
      engine_stderr: result.engineStderr
    };
    record.interpretation = interpretScenarioResult({
      record,
      result: result.result,
      declaredInvariants,
      artifactReadability: artifactReadability(cwd, record.artifacts_dir)
    });
    return record;
  }
  const record: ScenarioRecord = {
    name: scenario.name,
    run_config_path: scenario.runConfigPath,
    status: "error",
    wall_clock_s: roundSec(result.wallClockS),
    invariant_fires: [],
    error: result.error,
    engine_stderr: result.engineStderr
  };
  record.interpretation = interpretScenarioResult({ record, result: null });
  return record;
}

function roundSec(s: number): number {
  return Math.round(s * 1000) / 1000;
}

function artifactReadability(
  cwd: string,
  artifactsDir: string | undefined
): ArtifactReadability | undefined {
  if (!artifactsDir) return undefined;
  const dir = path.resolve(cwd, artifactsDir);
  return {
    simulationResultJson: existsSync(path.join(dir, "simulation-result.json")),
    reportMarkdown: existsSync(path.join(dir, "report.md"))
  };
}

function declaredInvariantNames(adapterPath: string | undefined): string[] | undefined {
  if (!adapterPath) return undefined;
  try {
    const raw = readFileSync(adapterPath, "utf8");
    const parsed = TOML.parse(raw);
    const adapter = validateAdapter(parsed, adapterPath);
    return adapter.invariants.map((inv, idx) => inv.name ?? `inv_${idx}`);
  } catch {
    return undefined;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Shape parsed out of a user-authored run-config.json file. */
interface RawRunConfigFile {
  agents?: number;
  ticks?: number;
  scenario?: string;
  seed?: number;
  personas?: string[];
  output_path?: string;
  validator_url?: string;
}

export interface ScenarioRunInputs {
  scenarioName: string;
  runConfigPath: string;
  cwd: string;
  adapterPath?: string;
  /**
   * Override the run-config's `output_path` field. When set, `riptide
   * run` uses this directory regardless of what the scenario file
   * declared — the T11 shape ("artifacts always inside .riptide/runs/
   * inside the repo, not /tmp/ and not fixtures/"). Leaving this
   * undefined preserves the pre-Phase-4 behavior of honoring the
   * run-config field so `riptide simulate` + script-direct callers
   * aren't affected.
   */
  outputPathOverride?: string;
}

export interface ScenarioRunBuild {
  runConfig: RunConfig;
  simulateOptions: SimulateOptions;
  outputPath: string;
  reproCommand: string;
}

/**
 * Build the orchestrator inputs for one scenario. Pure — no FS side
 * effects beyond reading the run-config file (and whatever
 * `buildSimulateOptions` does for adapter validation when `adapterPath`
 * is supplied). Exported so tests can pin:
 *   - `validator_url` from the scenario file is forwarded to the engine
 *     (not silently replaced by `127.0.0.1:8899`).
 *   - Default `output_path` preserves the full scenario name so that
 *     `amm/baseline` and `perps/baseline` don't collide on `.riptide/
 *     runs/baseline/`.
 */
export function buildScenarioRun(inputs: ScenarioRunInputs): ScenarioRunBuild {
  const raw = readFileSync(inputs.runConfigPath, "utf8");
  let parsed: RawRunConfigFile;
  try {
    parsed = JSON.parse(raw) as RawRunConfigFile;
  } catch (err) {
    throw new Error(
      `run-config at ${inputs.runConfigPath}: JSON parse failed: ${(err as Error).message}`
    );
  }
  if (
    typeof parsed.agents !== "number" ||
    typeof parsed.ticks !== "number" ||
    typeof parsed.scenario !== "string" ||
    typeof parsed.seed !== "number" ||
    !Array.isArray(parsed.personas)
  ) {
    throw new Error(
      `run-config at ${inputs.runConfigPath} missing one of: agents, ticks, scenario, seed, personas`
    );
  }

  const outputPath = inputs.outputPathOverride
    ? inputs.outputPathOverride
    : typeof parsed.output_path === "string" && parsed.output_path.length > 0
      ? parsed.output_path
      : defaultOutputPathForScenario(inputs.scenarioName);

  const { config } = buildSimulateOptions({
    agents: parsed.agents,
    ticks: parsed.ticks,
    scenario: parsed.scenario,
    seed: parsed.seed,
    personas: parsed.personas.join(","),
    // Forward the scenario-declared validator_url verbatim.
    // buildSimulateOptions' fallback chain (argv → $RIPTIDE_RPC_URL →
    // default localhost) still kicks in only when the scenario file
    // omits the field entirely, so contributors relying on the old
    // environment-variable override keep working unchanged.
    validatorUrl: parsed.validator_url,
    adapter: inputs.adapterPath,
    output: outputPath
  });
  const runConfig = toRunConfig(config);

  const reproCommand =
    `riptide run ${path.relative(inputs.cwd, inputs.runConfigPath) || inputs.runConfigPath}` +
    (config.adapter_path ? ` --adapter ${config.adapter_path}` : "");

  return { runConfig, simulateOptions: config, outputPath, reproCommand };
}

/**
 * Default artifact path for a scenario when the run-config doesn't
 * declare `output_path`. Preserves the full discovery name so two
 * scenarios whose leaf directory is `baseline` (e.g., `amm/baseline`
 * vs `perps/baseline`) don't clobber each other's artifacts.
 */
export function defaultOutputPathForScenario(scenarioName: string): string {
  const segments = scenarioName.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) {
    return path.join(".riptide", "runs");
  }
  return path.join(".riptide", "runs", ...segments);
}

/**
 * Default engine invocation used by `riptide run`. Matches the old
 * single-scenario path: same `runOrchestrator` + `writeArtifacts`
 * sequence, plus invariant-fire extraction for the event stream.
 *
 * We pass `allowInvariantViolations: true` internally so the
 * orchestrator does NOT throw on invariant fires — we want to capture
 * the SimulationResult either way and compute pass/fail ourselves
 * from the event stream (where every fire appears with its tick).
 */
async function defaultRunOne(ctx: RunOneContext): Promise<RunOneResult> {
  // Artifact destination: .riptide/runs/<scenario-name>/ (or
  // --output-dir override). This deliberately ignores the run-config's
  // `output_path` field so riptide-run writes land inside the user's
  // repo and outside /tmp/, regardless of what the run-config file
  // declared (shipping fixtures declare fixtures/scenarios/... paths).
  const artifactDir = resolveArtifactsDir(ctx);

  const build = buildScenarioRun({
    scenarioName: ctx.scenario.name,
    runConfigPath: ctx.scenario.runConfigPath,
    cwd: ctx.cwd,
    adapterPath: ctx.adapterPath,
    outputPathOverride: artifactDir
  });

  // Shipping bundles (Sprint 4/5/6 fixtures, scenarios generated by the
  // riptide-scenarios skill) author a `policies.json` next to their
  // `run-config.json`. Forward it to the orchestrator so the engine
  // receives the byte-stable policy set instead of a fresh LLM/fallback
  // compilation. Adjacent means the exact same directory — no
  // recursion.
  const adjacentPolicies = path.join(
    path.dirname(ctx.scenario.runConfigPath),
    "policies.json"
  );
  const policiesPath = existsSync(adjacentPolicies) ? adjacentPolicies : undefined;

  const silent = ctx.silent !== false;

  const started = Date.now();
  let result: SimulationResult;
  try {
    result = await runOrchestrator(build.runConfig, {
      llmUrl: build.simulateOptions.llm_url,
      adapterPath: build.simulateOptions.adapter_path,
      allowInvariantViolations: true,
      policiesPath,
      silent
    });
  } catch (err) {
    const elapsed = (Date.now() - started) / 1000;
    const message = err instanceof Error ? err.message : String(err);
    const captured =
      err && typeof err === "object" && "stderrFull" in err
        ? ((err as { stderrFull?: string }).stderrFull ?? undefined)
        : undefined;
    return { kind: "error", wallClockS: elapsed, error: message, engineStderr: captured };
  }
  const elapsedS = (Date.now() - started) / 1000;

  const fires = extractInvariantFires(result);

  const artifactPath = await writeArtifacts(result, artifactDir, {
    narrativeConfig: {
      adapterPath: build.simulateOptions.adapter_path ?? "",
      reproCommand: build.reproCommand
    }
  });
  const artifactsDir = path.dirname(artifactPath);

  // reviewer-ready evidence pack. The pack is additive on
  // top of simulation-result.json + report.md; failures during
  // emission are logged but never block the run loop, since the
  // SimulationResult itself is the load-bearing artifact and the
  // pack is auxiliary.
  try {
    const packCommand = buildPackRerunHint(ctx, build.simulateOptions.adapter_path);
    await emitPack({
      simulationResultPath: artifactPath,
      cwd: ctx.cwd,
      configPath: ctx.scenario.runConfigPath,
      adapterPath: build.simulateOptions.adapter_path,
      policiesPath,
      commandHint: packCommand,
      silent: silent
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!silent) {
      process.stderr.write(`warn: pack emission failed: ${msg}\n`);
    }
  }

  if (fires.length > 0) {
    return { kind: "fail", wallClockS: elapsedS, artifactsDir, result, fires };
  }
  return { kind: "pass", wallClockS: elapsedS, artifactsDir, result };
}

/**
 * Build a POSIX-shell-safe rerun command reviewers can paste back
 * into a terminal to reproduce the run. Prefers the high-level
 * `riptide run` verb over the lower-level engine invocation.
 */
function buildPackRerunHint(ctx: RunOneContext, adapterPath: string | undefined): string {
  const rel = path.relative(ctx.cwd, ctx.scenario.runConfigPath) || ctx.scenario.runConfigPath;
  const adapterRel = adapterPath
    ? path.relative(ctx.cwd, adapterPath) || adapterPath
    : undefined;
  const parts = ["exec", "riptide", "run", posixQuote(rel)];
  if (adapterRel && !adapterRel.startsWith("..")) {
    parts.push("--adapter", posixQuote(adapterRel));
  }
  return parts.join(" ");
}

/**
 * POSIX-safe single-quote wrap for a shell argument.
 *
 * Double-quoting still runs `$(...)`, backticks, and `$VAR`
 * expansion against the reviewer's environment — a forwarded pack
 * with a filename like `fixtures/$(id).toml` would execute `id` on
 * the reviewer's machine. Single-quote wrapping with the classic
 * `'\''` close/escape/reopen dance turns every byte literal.
 * See F-2026-04-21-S12P1-001.
 */
function posixQuote(value: string): string {
  if (/^[-_./A-Za-z0-9]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Compute the artifact directory for a scenario run. Default:
 * `.riptide/runs/<scenario-name>/` (relative to cwd) with `/` in the
 * name preserved as directory separators. Override:
 * `<outputDir>/<scenario-name>/` when --output-dir is passed (the
 * caller already absolute-resolved outputDir at CLI parse time).
 *
 * The default stays RELATIVE on purpose — the engine writes the
 * configured output_path into the serialized SimulationResult, and
 * that value surfaces in the dashboard meta panel + any downstream
 * consumer. A relative path reads cleanly ("artifacts: .riptide/runs/...")
 * where an absolute one leaks `/home/<dev>/Work/...` into every
 * result file a user might share.
 */
export function resolveArtifactsDir(ctx: RunOneContext): string {
  const segments = ctx.scenario.name.split("/").filter((s) => s.length > 0);
  const root = ctx.outputDir
    ? path.resolve(ctx.outputDir)
    : path.join(".riptide", "runs");
  if (segments.length === 0) {
    return root;
  }
  return path.join(root, ...segments);
}

/**
 * Pull invariant fires out of a SimulationResult. The engine emits
 * one SimEvent per fire with persona_id = "invariant" and action
 * "invariant_violation:<name>" (see engine/src/sim/run.rs :: evaluate_
 * invariants). We project these into `{ name, tick }` records in
 * declaration order (filtered by tick-then-declaration-index).
 */
export function extractInvariantFires(result: SimulationResult): InvariantFire[] {
  const fires: InvariantFire[] = [];
  for (const event of result.events) {
    if (event.persona_id !== "invariant") continue;
    if (!event.action.startsWith("invariant_violation:")) continue;
    const name = event.action.slice("invariant_violation:".length);
    fires.push({ name, tick: event.tick });
  }
  return fires;
}
