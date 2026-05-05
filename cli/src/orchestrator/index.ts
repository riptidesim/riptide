import { spawn } from "node:child_process";
import { access, constants, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import TOML from "toml";

import { compilePersonas } from "../compiler/compile.js";
import {
  SimulationResultSchema,
  type RunConfig,
  type SimulationResult
} from "../compiler/schema.js";
import { resolveAdapterRuntime, validateAdapter } from "../schemas/adapter.js";

/**
 * Symbol-keyed slot on parsed `SimulationResult` objects that carries
 * the engine-emitted JSON bytes byte-for-byte. `writeArtifacts` reads
 * this slot when present and writes the raw bytes verbatim — that
 * preserves Rust's float-vs-integer encoding (`500.0` vs `500`) that
 * `JSON.stringify` would otherwise collapse. The byte preservation
 * is load-bearing for the evidence pack canonical-hash surface:
 * the pack subcommand re-parses `simulation-result.json`, and any
 * serde_json round-trip loss here bubbles up as a hash drift between
 * the in-engine test fixtures and the CLI-emitted pack.
 */
export const RAW_JSON_SLOT = Symbol.for("riptide.orchestrator.rawJson");

function attachRawJson(result: SimulationResult, rawJson: string): SimulationResult {
  Object.defineProperty(result, RAW_JSON_SLOT, {
    value: rawJson,
    enumerable: false,
    writable: false,
    configurable: true
  });
  return result;
}

/** Read the raw JSON bytes stashed on a SimulationResult by the orchestrator, if any. */
export function readRawJsonSlot(result: SimulationResult): string | undefined {
  const value = (result as unknown as Record<symbol, unknown>)[RAW_JSON_SLOT];
  return typeof value === "string" ? value : undefined;
}

/**
 * Swap the `run_config.output_path` string literal inside a
 * Rust-emitted JSON blob without going through JSON.parse →
 * JSON.stringify. That round-trip loses f64-vs-integer fidelity
 * (`500.0` collapses to `500`) and silently drifts the canonical
 * hash. Targeted substring replacement preserves every other byte.
 */
function swapOutputPath(rawJson: string, fromPath: string, toPath: string): string {
  const needle = `"output_path": ${JSON.stringify(fromPath)}`;
  const replacement = `"output_path": ${JSON.stringify(toPath)}`;
  const idx = rawJson.indexOf(needle);
  if (idx < 0) {
    // Fallback: engine's pretty-print may use a single space after
    // the colon but we also tolerate no-space (serde_json compact
    // modes). Try the compact form before giving up.
    const compact = `"output_path":${JSON.stringify(fromPath)}`;
    const compactReplacement = `"output_path":${JSON.stringify(toPath)}`;
    const compactIdx = rawJson.indexOf(compact);
    if (compactIdx < 0) return rawJson;
    return (
      rawJson.slice(0, compactIdx) +
      compactReplacement +
      rawJson.slice(compactIdx + compact.length)
    );
  }
  return rawJson.slice(0, idx) + replacement + rawJson.slice(idx + needle.length);
}

export interface SpawnResult {
  code: number;
  stderrTail: string;
  /** Full captured stderr. Populated when the spawner runs in silent mode. */
  stderrFull?: string;
}

export type Spawner = (bin: string, args: string[], opts?: SpawnerOptions) => Promise<SpawnResult>;

export interface SpawnerOptions {
  /**
   * When true, capture engine stderr without writing it to
   * `process.stderr`. The full captured text surfaces on the
   * SpawnResult.stderrFull field so the caller can inline it in
   * failure blocks under `riptide run`. Default (undefined/false)
   * preserves stderr pass-through for `riptide replay` and the adapt
   * smoke-test — keeps per-command behavior explicit.
   */
  silent?: boolean;
  /** Abort signal used by sweep fail-fast cancellation to terminate the engine process. */
  signal?: AbortSignal;
}

export interface OrchestratorOptions {
  spawner?: Spawner;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  llmUrl?: string;
  /** Absolute path to a pre-validated adapter TOML, or undefined. */
  adapterPath?: string;
  /**
   * Suppress live engine stderr pass-through. Captured stderr still
   * lands on SpawnResult for inclusion in error messages. Default is
   * pass-through (today's behavior) so non-run commands keep their
   * live output.
   */
  silent?: boolean;
  /**
   * forward the `--allow-invariant-violations` flag
   * into the engine. When true, the engine exits 0 even if one or
   * more declared invariants fired during the run. When false
   * (default), an invariant firing exits 1. Setup errors always exit
   * 2 regardless. Match the engine-side flag semantics.
   */
  allowInvariantViolations?: boolean;
  warn?: (message: string) => void;
  /**
   * Override the module-root lookup. Pass `null` to disable it entirely
   * (used by tests that want to exercise the "no engine anywhere" path
   * without the real in-tree binary leaking in). Defaults to the
   * monorepo root derived from this module's on-disk location.
   */
  moduleRoot?: string | null;
  /**
   * Absolute path to a pre-compiled `policies.json` sitting next to a
   * user-authored `run-config.json`. When set, the orchestrator skips
   * `compilePersonas` and hands the file to the engine verbatim. This
   * is the path older shipping bundles rely on — their `policies.json`
   * pairs are part of the determinism contract and the LLM-free persona
   * fallback table only covers five lending archetypes.
   */
  policiesPath?: string;
  /** Abort signal used by sweep fail-fast cancellation to terminate the engine process. */
  abortSignal?: AbortSignal;
  /** Absolute current-state pack path to pass to the engine as an explicit override. */
  statePackPath?: string;
  /** Path to a generated Rust harness crate or its Cargo.toml. */
  harnessPath?: string;
}

export interface ReplayOrchestratorInput {
  /** Single-component replay: adapter TOML path. Mutually exclusive with `configPath`. */
  adapterPath?: string;
  /** Single-component replay: trajectory directory path. Mutually exclusive with `configPath`. */
  trajectoryDir?: string;
  /**
   * Multi-component replay: path to a replay config JSON containing a
   * `components` array (and optional `bridges`). When set, the engine
   * is invoked with `replay --config <path>` and the orchestrator
   * does not need adapter/trajectory separately. Mutually exclusive
   * with `adapterPath` / `trajectoryDir`.
   */
  configPath?: string;
  outputPath: string;
}

const ENGINE_REL_PATH = path.join("target", "release", "riptide-engine");
// npm-published layout: <package-root>/bin/riptide-engine, where
// <package-root> = cli/. The postinstall script in
// cli/scripts/install-binary.js drops the binary here, and the runtime
// resolver checks this path before falling back to the monorepo-root
// target/release layout. This is what lets `npm i -g @riptide/cli`
// users call `riptide` without having built the engine themselves.
const ENGINE_NPM_REL_PATH = path.join("bin", "riptide-engine");
const STDERR_TAIL_BYTES = 8192;
const harnessBuildCache = new Map<string, Promise<string>>();
let defaultPolicyWarningEmitted = false;

// Derive the monorepo root from *this file's* real location on disk. The
// CLI ships as `<monorepo>/cli/dist/src/orchestrator/index.js`, so five
// dirname steps land on the monorepo root regardless of where the user
// invoked `riptide` from. `realpathSync` follows `npm link` symlinks so
// a globally-linked CLI still resolves back into the source tree.
//
// This is the fix for the "any Claude Code session / zero setup" promise:
// previously we only looked at $cwd-relative layouts, which broke the
// moment the user ran the command from anywhere outside the monorepo.
let cachedMonorepoRoot: string | undefined;
export function monorepoRootFromModule(): string | undefined {
  if (cachedMonorepoRoot !== undefined) {
    return cachedMonorepoRoot || undefined;
  }
  try {
    const here = realpathSync(fileURLToPath(import.meta.url));
    // here = <monorepo>/cli/dist/src/orchestrator/index.js
    // ^5^ ^4^ ^3^ ^2^ ^1^
    const root = path.resolve(here, "..", "..", "..", "..", "..");
    cachedMonorepoRoot = root;
    return root;
  } catch {
    cachedMonorepoRoot = "";
    return undefined;
  }
}

// npm-published installations land the compiled CLI at
// <pkg-root>/dist/src/orchestrator/index.js. Four dirname steps up is
// the package root, which is where the postinstall script (scripts/
// install-binary.js) drops the binary at `bin/riptide-engine`.
//
// This is distinct from `monorepoRootFromModule` — in monorepo runs
// the pkg root is `<monorepo>/cli`, but the engine binary lives at
// `<monorepo>/target/release/riptide-engine`. In npm runs the engine
// binary lives at `<pkg-root>/bin/riptide-engine`. Both paths are
// checked.
let cachedPkgRoot: string | undefined;
export function cliPackageRootFromModule(): string | undefined {
  if (cachedPkgRoot !== undefined) {
    return cachedPkgRoot || undefined;
  }
  try {
    const here = realpathSync(fileURLToPath(import.meta.url));
    // here = <pkg-root>/dist/src/orchestrator/index.js
    // ^4^ ^3^ ^2^ ^1^
    const root = path.resolve(here, "..", "..", "..", "..");
    cachedPkgRoot = root;
    return root;
  } catch {
    cachedPkgRoot = "";
    return undefined;
  }
}

export async function runOrchestrator(
  runConfig: RunConfig,
  options: OrchestratorOptions = {}
): Promise<SimulationResult> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const spawner = options.spawner ?? defaultSpawner;
  const rawWarn = options.warn ?? ((msg: string) => process.stderr.write(`${msg}\n`));
  const warn = (msg: string) => {
    if (msg === "LLM unavailable — using default policies") {
      if (defaultPolicyWarningEmitted) return;
      defaultPolicyWarningEmitted = true;
      rawWarn("LLM unavailable — using default policies (shown once per command)");
      return;
    }
    rawWarn(msg);
  };

  const harnessManifest = options.harnessPath
    ? resolveHarnessManifest(options.harnessPath, cwd)
    : undefined;
  const enginePath = harnessManifest
    ? await prepareHarnessExecutable({
        manifestPath: harnessManifest,
        cwd,
        env,
        spawner,
        silent: options.silent,
        signal: options.abortSignal
      })
    : await resolveEngineBinary(
        env,
        cwd,
        options.moduleRoot === undefined ? monorepoRootFromModule() ?? null : options.moduleRoot
      );

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "riptide-run-"));
  try {
    const configPath = path.join(tmpDir, "run-config.json");
    const policiesPath = path.join(tmpDir, "policies.json");
    const outputPath = path.join(tmpDir, "simulation-result.json");

    await writeFile(configPath, JSON.stringify(runConfig, null, 2));

    // Prefer a caller-supplied policies.json (shipping bundle path —
    // policies co-authored with the run-config, byte-stable). Fall
    // through to the LLM-or-fallback compile path only when no
    // adjacent policies file was found.
    if (options.policiesPath) {
      const raw = await readFile(options.policiesPath, "utf8");
      await writeFile(policiesPath, raw);
    } else if (await usesInlineGenericPersonas(options.adapterPath)) {
      await writeFile(policiesPath, "[]\n");
    } else {
      const policies = await compilePersonas(runConfig.personas, {
        llmUrl: options.llmUrl,
        warn
      });
      await writeFile(policiesPath, JSON.stringify(policies, null, 2));
    }

    const engineArgs = [
      "--config",
      configPath,
      "--policies",
      policiesPath,
      "--output",
      outputPath
    ];
    if (options.adapterPath) {
      engineArgs.push("--adapter", options.adapterPath);
    }
    if (harnessManifest && !options.adapterPath) {
      throw new Error("runOrchestrator: harness runs require an adapter path");
    }
    if (options.statePackPath) {
      engineArgs.push("--state-pack", options.statePackPath);
    }
    if (options.allowInvariantViolations) {
      engineArgs.push("--allow-invariant-violations");
    }
    const args = engineArgs;
    const runnerLabel = harnessManifest ? "riptide harness" : "riptide-engine";

    const { code, stderrTail, stderrFull } = await spawner(enginePath, args, {
      silent: options.silent,
      signal: options.abortSignal
    });
    if (code !== 0) {
      const tail = stderrTail.trim();
      const suffix = tail ? `\n--- engine stderr (tail) ---\n${tail}` : "";
      // when the engine exits with the invariant-firing
      // code (1) and the caller has not passed --allow-invariant-violations,
      // still surface the engine's JSON output if it was written. Doing
      // so lets exploratory callers inspect `summary.invariants_fired`
      // after the non-zero exit. Parse failures here fall back to the
      // generic error message so callers get a coherent diagnostic in
      // both "engine died setting up" and "engine ran but fired" paths.
      if (code === 1) {
        try {
          const raw = await readFile(outputPath, "utf8");
          const parsed = SimulationResultSchema.parse(JSON.parse(raw));
          const error = new Error(
            `${runnerLabel} exited with code 1 — invariant violation(s) recorded.${suffix}`
          ) as Error & {
            simulationResult?: SimulationResult;
            exitCode?: number;
            stderrFull?: string;
            isOrchestratorEngineFailure?: true;
          };
          error.simulationResult = parsed;
          error.exitCode = 1;
          error.stderrFull = stderrFull;
          error.isOrchestratorEngineFailure = true;
          throw error;
        } catch (readErr) {
          if ((readErr as { isOrchestratorEngineFailure?: boolean }).isOrchestratorEngineFailure) {
            throw readErr;
          }
          // fall through to the generic error below.
        }
      }
      const err = new Error(`${runnerLabel} exited with code ${code}.${suffix}`) as Error & {
        stderrFull?: string;
        exitCode?: number;
      };
      err.stderrFull = stderrFull;
      err.exitCode = code;
      throw err;
    }

    const raw = await readFile(outputPath, "utf8");
    // Simulate path does NOT attach the raw JSON — byte-stable fixtures pin
    // the historical JSON.stringify output shape, and that shape is what
    // CONTRIBUTING.md's byte-stable-fixture gates `89ca84…`, `1518bcfd…`,
    // and `5de060cd…` are derived from. Replays carry their own in-memory
    // canonical hash, so they opt in to raw-byte preservation below.
    return SimulationResultSchema.parse(JSON.parse(raw));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function usesInlineGenericPersonas(adapterPath: string | undefined): Promise<boolean> {
  if (!adapterPath) return false;
  try {
    const raw = await readFile(adapterPath, "utf8");
    const parsed = TOML.parse(raw);
    return resolveAdapterRuntime(validateAdapter(parsed, adapterPath)) === "generic";
  } catch {
    return false;
  }
}

export async function runReplayOrchestrator(
  replay: ReplayOrchestratorInput,
  options: OrchestratorOptions = {}
): Promise<SimulationResult> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const spawner = options.spawner ?? defaultSpawner;

  const enginePath = await resolveEngineBinary(
    env,
    cwd,
    options.moduleRoot === undefined ? monorepoRootFromModule() ?? null : options.moduleRoot
  );

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "riptide-replay-"));
  try {
    const outputPath = path.join(tmpDir, "simulation-result.json");
    // Accept either (adapterPath + trajectoryDir) for the legacy
    // single-component path OR (configPath) for the multi-component
    // path. The engine binary auto-detects the config shape; the
    // orchestrator only has to shape the argv correctly.
    let args: string[];
    if (replay.configPath) {
      if (replay.adapterPath || replay.trajectoryDir) {
        throw new Error(
          "runReplayOrchestrator: `configPath` is mutually exclusive with `adapterPath`/`trajectoryDir`"
        );
      }
      args = ["replay", "--config", replay.configPath, "--output", outputPath];
    } else {
      if (!replay.adapterPath || !replay.trajectoryDir) {
        throw new Error(
          "runReplayOrchestrator: missing inputs — pass either `configPath` or both `adapterPath` + `trajectoryDir`"
        );
      }
      args = ["replay", replay.adapterPath, replay.trajectoryDir, "--output", outputPath];
    }
    if (options.allowInvariantViolations) {
      args.push("--allow-invariant-violations");
    }

    const { code, stderrTail } = await spawner(enginePath, args, {
      signal: options.abortSignal
    });
    if (code !== 0) {
      const tail = stderrTail.trim();
      const suffix = tail ? `\n--- engine stderr (tail) ---\n${tail}` : "";
      if (code === 1) {
        try {
          const raw = await readFile(outputPath, "utf8");
          const rewritten = swapOutputPath(raw, outputPath, replay.outputPath);
          const parsed = SimulationResultSchema.parse(JSON.parse(rewritten));
          parsed.run_config.output_path = replay.outputPath;
          attachRawJson(parsed, rewritten);
          const error = new Error(
            `riptide-engine replay exited with code 1 — invariant violation(s) recorded.${suffix}`
          ) as Error & {
            simulationResult?: SimulationResult;
            exitCode?: number;
            isOrchestratorEngineFailure?: true;
          };
          error.simulationResult = parsed;
          error.exitCode = 1;
          error.isOrchestratorEngineFailure = true;
          throw error;
        } catch (readErr) {
          if ((readErr as { isOrchestratorEngineFailure?: boolean }).isOrchestratorEngineFailure) {
            throw readErr;
          }
        }
      }
      throw new Error(`riptide-engine replay exited with code ${code}.${suffix}`);
    }

    const raw = await readFile(outputPath, "utf8");
    const rewritten = swapOutputPath(raw, outputPath, replay.outputPath);
    const parsed = SimulationResultSchema.parse(JSON.parse(rewritten));
    parsed.run_config.output_path = replay.outputPath;
    return attachRawJson(parsed, rewritten);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export async function resolveEngineBinary(
  env: NodeJS.ProcessEnv,
  cwd: string,
  moduleRoot: string | null = monorepoRootFromModule() ?? null
): Promise<string> {
  const attempts: string[] = [];

  const fromEnv = env.RIPTIDE_ENGINE_BIN;
  if (fromEnv) {
    attempts.push(`$RIPTIDE_ENGINE_BIN=${fromEnv}`);
    if (await isExecutable(fromEnv)) {
      return fromEnv;
    }
  } else {
    attempts.push("$RIPTIDE_ENGINE_BIN (unset)");
  }

  // Explicit, trusted candidates only — do NOT walk arbitrary ancestors.
  // Walking up would let a binary planted in /tmp/evil/target/release/
  // riptide-engine hijack the run and inherit the shell environment if
  // the CLI is invoked from any descendant directory.
  //
  // Preferred: the monorepo root derived from this module's real disk
  // location. This is what makes `riptide adapt` invokable from any
  // cwd — including `/tmp` inside a Claude Code skill run. Fall back
  // to cwd-relative layouts for historical compatibility (tests and
  // anyone running the raw built CLI from inside the monorepo).
  const relativeCandidates: string[] = [];

  // Monorepo layout first — this is a provenance guarantee for anyone
  // working in a source checkout. If a contributor has `cargo build
  // --release -p riptide-engine` output sitting at
  // `<repo>/target/release/riptide-engine`, we MUST prefer that over an
  // `<cli-pkg-root>/bin/riptide-engine` stub (which a future npm
  // postinstall or a malicious/mistaken drop could plant in `cli/bin/`).
  // Source-checkout testing always resolves to the locally-built engine.
  if (moduleRoot) {
    relativeCandidates.push(path.resolve(moduleRoot, ENGINE_REL_PATH));
  }

  // npm-published layout: the postinstall script drops the prebuilt
  // engine binary at <cli-pkg-root>/bin/riptide-engine. Checked AFTER
  // the monorepo candidate so source checkouts keep their provenance.
  // End-users installing via `npm install -g @riptide/cli` have no
  // monorepo target/release/ to shadow this, so they still resolve
  // correctly.
  const pkgRoot = cliPackageRootFromModule();
  if (pkgRoot) {
    relativeCandidates.push(path.resolve(pkgRoot, ENGINE_NPM_REL_PATH));
  }

  relativeCandidates.push(
    path.resolve(cwd, ENGINE_REL_PATH),
    path.resolve(cwd, "..", ENGINE_REL_PATH),
    path.resolve(cwd, "riptide", ENGINE_REL_PATH)
  );
  for (const candidate of relativeCandidates) {
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  for (const candidate of relativeCandidates) {
    attempts.push(candidate);
  }

  const onPath = await which("riptide-engine", env);
  if (onPath) {
    return onPath;
  }
  attempts.push("$PATH lookup for riptide-engine");

  throw new Error(
    [
      "Could not locate the riptide-engine binary. Attempted:",
      ...attempts.map((a) => `  - ${a}`),
      "",
      "Build it with: cargo build --release -p riptide-engine"
    ].join("\n")
  );
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function which(bin: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const pathVar = env.PATH ?? "";
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function resolveHarnessManifest(harnessPath: string, cwd: string): string {
  const resolved = path.isAbsolute(harnessPath)
    ? harnessPath
    : path.resolve(cwd, harnessPath);
  const manifest = (() => {
    if (existsSync(resolved) && statSync(resolved).isDirectory()) {
      return path.join(resolved, "Cargo.toml");
    }
    return resolved;
  })();
  if (!existsSync(manifest)) {
    throw new Error(
      `Rust harness not found at ${manifest}. Run 'riptide harness generate' or pass --harness <dir-or-Cargo.toml>.`
    );
  }
  if (path.basename(manifest) !== "Cargo.toml") {
    throw new Error(`Rust harness path must be a harness directory or Cargo.toml, got ${manifest}`);
  }
  return manifest;
}

async function prepareHarnessExecutable(input: {
  manifestPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawner: Spawner;
  silent?: boolean;
  signal?: AbortSignal;
}): Promise<string> {
  const key = realpathSync(input.manifestPath);
  const existing = harnessBuildCache.get(key);
  if (existing) return existing;

  const promise = buildHarnessExecutable(input).catch((err) => {
    harnessBuildCache.delete(key);
    throw err;
  });
  harnessBuildCache.set(key, promise);
  return promise;
}

async function buildHarnessExecutable(input: {
  manifestPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawner: Spawner;
  silent?: boolean;
  signal?: AbortSignal;
}): Promise<string> {
  const executable = await harnessExecutablePath(input.manifestPath, input.cwd, input.env);
  const cargoArgs = await harnessCargoBuildArgs(input.manifestPath);
  const { code, stderrTail, stderrFull } = await input.spawner(
    "cargo",
    cargoArgs,
    {
      silent: input.silent,
      signal: input.signal
    }
  );
  if (code !== 0) {
    const tail = stderrTail.trim();
    const suffix = tail ? `\n--- cargo stderr (tail) ---\n${tail}` : "";
    const err = new Error(`riptide harness build exited with code ${code}.${suffix}`) as Error & {
      stderrFull?: string;
      exitCode?: number;
    };
    err.stderrFull = stderrFull;
    err.exitCode = code;
    throw err;
  }
  if (!existsSync(executable)) {
    throw new Error(
      `riptide harness build completed, but the release binary was not found at ${executable}`
    );
  }
  return executable;
}

async function harnessCargoBuildArgs(manifestPath: string): Promise<string[]> {
  const baseArgs = ["build", "--release", "--quiet", "--manifest-path", manifestPath];
  const rustToolchainPath = path.join(path.dirname(manifestPath), "rust-toolchain.toml");
  if (!existsSync(rustToolchainPath)) return baseArgs;

  const raw = await readFile(rustToolchainPath, "utf8");
  const parsed = TOML.parse(raw) as { toolchain?: { channel?: unknown } };
  const channel = parsed.toolchain?.channel;
  if (typeof channel !== "string" || channel.trim().length === 0) return baseArgs;
  return [`+${channel.trim()}`, ...baseArgs];
}

async function harnessExecutablePath(
  manifestPath: string,
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<string> {
  const manifestRaw = await readFile(manifestPath, "utf8");
  const parsed = TOML.parse(manifestRaw) as {
    package?: { name?: unknown };
    bin?: Array<{ name?: unknown }>;
  };
  const name =
    Array.isArray(parsed.bin) && typeof parsed.bin[0]?.name === "string"
      ? parsed.bin[0].name
      : typeof parsed.package?.name === "string"
        ? parsed.package.name
        : undefined;
  if (!name || name.trim().length === 0) {
    throw new Error(`Rust harness manifest at ${manifestPath} is missing [package].name`);
  }

  const targetDir =
    typeof env.CARGO_TARGET_DIR === "string" && env.CARGO_TARGET_DIR.trim().length > 0
      ? path.resolve(cwd, env.CARGO_TARGET_DIR)
      : path.join(path.dirname(manifestPath), "target");
  return path.join(targetDir, "release", process.platform === "win32" ? `${name}.exe` : name);
}

const defaultSpawner: Spawner = (bin, args, opts) => {
  const silent = opts?.silent === true;
  // In non-silent mode we pipe stderr so we can BOTH stream it live
  // to the user AND keep a rolling tail for the error message. In
  // silent mode we capture the full stderr stream for later display
  // (riptide run's failure block) without any live pass-through.
  const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
  const abort = opts?.signal;
  const chunks: string[] = [];
  let chunksBytes = 0;
  const fullBuf: string[] = [];

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (!silent) {
      process.stderr.write(chunk);
    }
    if (silent) {
      fullBuf.push(chunk);
    }
    chunks.push(chunk);
    chunksBytes += chunk.length;
    while (chunksBytes > STDERR_TAIL_BYTES && chunks.length > 1) {
      chunksBytes -= chunks[0]!.length;
      chunks.shift();
    }
  });

  return new Promise<SpawnResult>((resolve, reject) => {
    const onAbort = () => {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    };
    if (abort?.aborted) {
      onAbort();
    } else {
      abort?.addEventListener("abort", onAbort, { once: true });
    }
    child.once("error", (err) => {
      abort?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.once("close", (code, signal) => {
      abort?.removeEventListener("abort", onAbort);
      if (code === null) {
        reject(new Error(`riptide-engine terminated by signal ${signal ?? "unknown"}`));
        return;
      }
      const tail = chunks.join("").slice(-STDERR_TAIL_BYTES);
      resolve({
        code,
        stderrTail: tail,
        stderrFull: silent ? fullBuf.join("") : undefined
      });
    });
  });
};
