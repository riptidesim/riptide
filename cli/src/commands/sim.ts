// `riptide sim` — the guided-sim subcommands the Skill drives.
//
// Every subcommand takes `--json`: it then writes one command envelope to
// stdout (src/contract), and a build failure, a lint failure or a missing
// setup piece comes back as the error shape with a `next` action naming
// the repair. Without `--json` the human output is unchanged.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import chalk from "chalk";
import { Command } from "commander";

import { runReview, type ReviewOptions } from "./review.js";
import {
  errorEnvelope,
  oneLineMessage,
  renderEnvelope,
  resolveCommandIO,
  successEnvelope,
  type CommandError,
  type CommandIO,
  type ResolvedCommandIO
} from "../contract/index.js";
import {
  generateSim,
  SimGenerateError,
  type SimGenerateOptions,
  type SimGenerateResult
} from "../sim/generate.js";
import {
  lintSimManifest,
  renderSimManifestLintReport,
  type SimManifestFinding,
  type SimManifestLintReport
} from "../sim/manifest.js";
import type { SetupGapsReport } from "../sim/setup-gaps.js";
import {
  readSweepConfig,
  readCartographyConfig,
  formatSweepFlags,
  sweepAxes,
  buildCartographyArtifacts,
  emitCartographyRoot,
  type GuidedSimRunDocument,
  type SweepConfig
} from "../sim/cartography.js";
import {
  evaluateLifecycle,
  evaluatePositiveControl,
  readLifecycleConfig,
  readPositiveControlConfig,
  type GateResult
} from "../sim/honesty-gates.js";

const dim = (value: string) => chalk.hex("#A8A8A8")(value);

/** Lines of runner or compiler output an error envelope carries for the repair. */
const LOG_TAIL_LINES = 40;
const DIAGNOSTIC_LINES = 200;

export type SimCommandDeps = CommandIO;

export interface JsonOption {
  json?: boolean;
}

export function createSimCommand(deps: SimCommandDeps = {}): Command {
  const command = new Command("sim").description(
    "Generate, refresh, and run guided Rust simulations"
  );

  command
    .command("generate")
    .description("Generate a project-owned Rust simulation crate")
    .requiredOption("--adapter <path-or-name>", "Adapter TOML to generate against")
    .option("--dir <path>", "Simulation crate directory", ".riptide/sim")
    .option(
      "--force-generated",
      "Overwrite user-owned flows.rs, invariants.rs, and services/* files too",
      false
    )
    .option("--json", "Emit the result as a command envelope", false)
    .action(async (options: SimGenerateOptions & JsonOption) => {
      process.exitCode = await runSimGenerate(options, deps);
    });

  command
    .command("refresh")
    .description("Regenerate typed IDL builders and account storage skeletons")
    .requiredOption("--adapter <path-or-name>", "Adapter TOML to refresh against")
    .option("--dir <path>", "Simulation crate directory", ".riptide/sim")
    .option("--json", "Emit the result as a command envelope", false)
    .action(async (options: SimGenerateOptions & JsonOption) => {
      process.exitCode = await runSimRefresh(options, deps);
    });

  command
    .command("run")
    .description("Run a generated guided simulation crate")
    .argument("[path]", "Simulation crate path", ".riptide/sim")
    .option("--iterations <n>", "Iterations to run")
    .option("--flows <n>", "Flow calls per iteration")
    .option("--seed <hex>", "Deterministic seed as hex")
    .option("--out <dir>", "Write guided-sim JSON artifacts to a directory")
    .option("--json", "Emit the result as a command envelope", false)
    .action(async (simPath: string, options: RunOptions) => {
      process.exitCode = await runSimRun(simPath, options, deps);
    });

  command
    .command("surface")
    .description(
      "Build cartography artifacts (campaign-summary + risk-surface + retention-manifest) from a guided-sim sweep so `riptide assess` renders a heatmap"
    )
    .argument(
      "[run-path]",
      "Guided-sim artifact directory or guided-sim-run.json",
      ".riptide/sim/artifacts/smoke"
    )
    .option("--sim <path>", "Simulation crate directory holding Riptide.toml", ".riptide/sim")
    .option("--out <dir>", "Directory to write the cartography artifacts (default: the assess root that contains the run)")
    .option("--json", "Emit the result as a command envelope", false)
    .action(async (runPath: string, options: SurfaceOptions) => {
      process.exitCode = await runSimSurface(runPath, options, deps);
    });

  command
    .command("fork")
    .description("Fetch or reuse a guided-sim account snapshot cache")
    .requiredOption("--address <pubkey>", "Account address to snapshot")
    .option("--cluster <cluster-or-rpc>", "Cluster alias or custom RPC URL", "mainnet")
    .requiredOption("--out <path>", "Snapshot JSON output path")
    .option("--overwrite", "Refresh an existing snapshot instead of reusing it", false)
    .option("--json", "Emit the result as a command envelope", false)
    .action(async (options: ForkOptions) => {
      process.exitCode = await runSimFork(options, deps);
    });

  command
    .command("lint")
    .description("Validate a guided simulation Riptide.toml manifest")
    .argument("[path]", "Simulation crate directory or Riptide.toml path", ".riptide/sim")
    .option("--json", "Emit the result as a command envelope", false)
    .action(async (simPath: string, options: JsonOption) => {
      process.exitCode = await runSimLint(simPath, options, deps);
    });

  command
    .command("review")
    .description("Review a guided-sim artifact directory or guided-sim-run.json")
    .argument("[path]", "Guided-sim artifact directory or guided-sim-run.json", ".riptide/sim/artifacts")
    .option("--out <md-path>", "Write reviewer markdown to a file instead of stdout")
    .option("--json", "Emit a structured JSON review payload", false)
    .action(async (artifactPath: string, options: ReviewOptions) => {
      process.exitCode = await runReview(artifactPath, options, deps, "sim review");
    });

  command
    .command("debug")
    .description("Run one seed with verbose labelled transaction logging")
    .argument("[path]", "Simulation crate path", ".riptide/sim")
    .requiredOption("--seed <hex>", "Deterministic seed as hex")
    .option("--json", "Emit the result as a command envelope", false)
    .action(async (simPath: string, options: SimDebugOptions) => {
      process.exitCode = await runSimDebug(simPath, options, deps);
    });

  return command;
}

/** A failure a `sim` subcommand reports with a stable code; its message is the human message. */
class SimCommandError extends Error {
  readonly code: string;
  readonly next: string;
  constructor(message: string, code: string, next: string) {
    super(message);
    this.name = "SimCommandError";
    this.code = code;
    this.next = next;
  }
}

function commandFailure(err: unknown, fallback: Omit<CommandError, "message">): CommandError {
  if (err instanceof SimCommandError || err instanceof SimGenerateError) {
    return { code: err.code, message: oneLineMessage(err.message), next: err.next };
  }
  return { ...fallback, message: oneLineMessage(errMessage(err)) };
}

export async function runSimGenerate(
  options: SimGenerateOptions & JsonOption,
  deps: SimCommandDeps = {}
): Promise<number> {
  const { stdout, stderr, cwd } = resolveCommandIO(deps);
  const { json, ...generateOptions } = options;
  try {
    const result = await generateSim(cwd, {
      ...generateOptions,
      writeSummary: json ? () => {} : stderr
    });
    if (json) {
      const data = generateResultJson(result);
      const gaps = result.setupGaps;
      if (gaps?.genesis === "gaps" && gaps.flows_rs === "generated") {
        stdout(renderEnvelope(errorEnvelope("sim generate", setupGapsFailure(gaps, result, cwd), data)));
        return 2;
      }
      stdout(renderEnvelope(successEnvelope("sim generate", data)));
      return 0;
    }
    stderr(chalk.bold(`riptide sim: generated guided Rust simulation at ${chalk.cyan(result.dir)}\n`));
    stderr(dim(`  adapter ${result.adapterPath}\n`));
    stderr(dim(`  idl ${result.idlPath}\n`));
    stderr(dim(`  manifest ${result.manifestPath}\n`));
    stderr(dim(`  bootstrap ${result.bootstrapManifestPath}\n`));
    return 0;
  } catch (err) {
    if (json) {
      stdout(renderEnvelope(errorEnvelope("sim generate", generateFailure(err, "sim_generate_failed"))));
      return 2;
    }
    stderr(chalk.red(`riptide sim: ${errMessage(err)}\n`));
    return 2;
  }
}

export async function runSimRefresh(
  options: SimGenerateOptions & JsonOption,
  deps: SimCommandDeps = {}
): Promise<number> {
  const { stdout, stderr, cwd } = resolveCommandIO(deps);
  const { json, ...generateOptions } = options;
  try {
    const result = await generateSim(cwd, {
      ...generateOptions,
      regenTypesOnly: true,
      writeSummary: json ? () => {} : stderr
    });
    if (json) {
      stdout(
        renderEnvelope(
          successEnvelope("sim refresh", {
            dir: result.dir,
            adapter: result.adapterPath,
            idl: result.idlPath
          })
        )
      );
      return 0;
    }
    stderr(chalk.bold(`riptide sim: refreshed generated Rust files in ${chalk.cyan(result.dir)}\n`));
    return 0;
  } catch (err) {
    if (json) {
      stdout(renderEnvelope(errorEnvelope("sim refresh", generateFailure(err, "sim_refresh_failed"))));
      return 2;
    }
    stderr(chalk.red(`riptide sim: ${errMessage(err)}\n`));
    return 2;
  }
}

export interface SimGenerateResultJson {
  dir: string;
  adapter: string;
  idl: string;
  cargo_manifest: string;
  sim_manifest: string;
  setup_gaps_report: string | null;
  setup_gaps: SetupGapsReport | null;
}

function generateResultJson(result: SimGenerateResult): SimGenerateResultJson {
  return {
    dir: result.dir,
    adapter: result.adapterPath,
    idl: result.idlPath,
    cargo_manifest: result.manifestPath,
    sim_manifest: result.bootstrapManifestPath,
    setup_gaps_report: result.setupGapsPath ?? null,
    setup_gaps: result.setupGaps ?? null
  };
}

function setupGapsFailure(
  report: SetupGapsReport,
  result: SimGenerateResult,
  cwd: string
): CommandError {
  const count = report.gaps.length;
  const files = [...new Set(report.gaps.map((gap) => gap.file))];
  const simDir = path.relative(cwd, result.dir) || ".";
  return {
    code: "sim_setup_gaps",
    message: `tick-0 genesis has ${count} unresolved seam${count === 1 ? "" : "s"}: ${report.gaps
      .map((gap) => gap.seam)
      .join(", ")}`,
    next: `author the unresolved seams listed in data.setup_gaps.gaps in ${files
      .map((file) => path.join(simDir, file))
      .join(", ")}, then run \`riptide sim run ${simDir} --json\``
  };
}

function generateFailure(err: unknown, fallbackCode: string): CommandError {
  return commandFailure(err, {
    code: fallbackCode,
    next: "check that the adapter, its IDL and the sim directory are readable and writable, then rerun"
  });
}

export async function runSimRun(
  simPath: string,
  options: RunOptions,
  deps: SimCommandDeps = {}
): Promise<number> {
  return runCargoSim("sim run", simPath, options, resolveCommandIO(deps));
}

export async function runSimDebug(
  simPath: string,
  options: SimDebugOptions,
  deps: SimCommandDeps = {}
): Promise<number> {
  return runCargoSim(
    "sim debug",
    simPath,
    { ...options, iterations: "1", debug: true },
    resolveCommandIO(deps)
  );
}

export async function runSimLint(
  simPath: string,
  options: JsonOption = {},
  deps: SimCommandDeps = {}
): Promise<number> {
  const { stdout, cwd } = resolveCommandIO(deps);
  const report = await lintSimManifest(simPath, cwd);
  if (options.json) {
    const data = lintReportJson(report);
    stdout(
      renderEnvelope(
        report.exitCode === 2
          ? errorEnvelope("sim lint", lintFailure(report, simPath), data)
          : successEnvelope("sim lint", data)
      )
    );
    return report.exitCode;
  }
  stdout(renderSimManifestLintReport(report));
  return report.exitCode;
}

export interface SimLintReportJson {
  manifest_path: string;
  verdict: "pass" | "warn" | "fail";
  exit_code: number;
  findings: SimManifestFinding[];
}

function lintReportJson(report: SimManifestLintReport): SimLintReportJson {
  return {
    manifest_path: report.manifestPath,
    verdict: report.exitCode === 0 ? "pass" : report.exitCode === 1 ? "warn" : "fail",
    exit_code: report.exitCode,
    findings: report.findings
  };
}

function lintFailure(report: SimManifestLintReport, simPath: string): CommandError {
  const failed = report.findings.filter((finding) => finding.level === "fail");
  const message = `${failed.length} sim manifest check${failed.length === 1 ? "" : "s"} failed: ${failed
    .map((finding) => `${finding.code} at ${finding.path}`)
    .join(", ")}`;
  if (failed.some((finding) => finding.code === "manifest-missing")) {
    return {
      code: "sim_lint_manifest_missing",
      message,
      next: `generate the sim crate with \`riptide sim generate --adapter <adapter> --dir ${simPath} --json\`, which writes its Riptide.toml`
    };
  }
  const first = failed.find((finding) => finding.hint) ?? failed[0];
  return {
    code: "sim_lint_failed",
    message,
    next: first?.hint
      ? `${first.path}: ${first.hint}`
      : `fix ${first?.path ?? "Riptide.toml"} (${first?.message ?? "see data.findings"}), then rerun \`riptide sim lint ${simPath} --json\``
  };
}

export interface RunOptions extends JsonOption {
  iterations?: string;
  flows?: string;
  seed?: string;
  debug?: boolean;
  out?: string;
}

export interface SimDebugOptions extends JsonOption {
  seed: string;
}

export interface ForkOptions extends JsonOption {
  address: string;
  cluster: string;
  out: string;
  overwrite?: boolean;
}

export interface SurfaceOptions extends JsonOption {
  sim: string;
  out?: string;
}

export async function runSimSurface(
  runPath: string,
  options: SurfaceOptions,
  deps: SimCommandDeps = {}
): Promise<number> {
  const { stdout, stderr, cwd: baseCwd } = resolveCommandIO(deps);
  try {
    const resolvedRun = path.resolve(baseCwd, runPath);
    const runFile = resolvedRun.endsWith(".json")
      ? resolvedRun
      : path.join(resolvedRun, "guided-sim-run.json");
    const simDir = path.resolve(baseCwd, options.sim);
    const simArg = path.relative(baseCwd, simDir) || ".";
    if (!existsSync(runFile)) {
      throw new SimCommandError(
        `guided-sim run artifact not found at ${runFile}`,
        "sim_surface_run_not_found",
        `run the sweep first: \`riptide sim run ${simArg} --out ${runPath} --json\``
      );
    }
    let runDoc: GuidedSimRunDocument;
    try {
      runDoc = JSON.parse(await readFile(runFile, "utf8")) as GuidedSimRunDocument;
    } catch (err) {
      throw new SimCommandError(
        errMessage(err),
        "sim_surface_run_malformed",
        `rerun the sweep to rewrite ${runFile}: \`riptide sim run ${simArg} --out ${runPath} --json\``
      );
    }

    const manifestPath = path.join(simDir, "Riptide.toml");
    const sweep = await readSweepConfig(manifestPath);
    if (!sweep) {
      throw new SimCommandError(
        `no [sim.sweep] block in ${manifestPath}; declare a parameter sweep to build a risk surface`,
        "sim_surface_sweep_missing",
        `declare a [sim.sweep] block (name, values, seeds_per_value) in ${manifestPath}, rerun \`riptide sim run ${simArg} --out ${runPath} --json\`, then rerun sim surface`
      );
    }
    const cartography =
      (await readCartographyConfig(manifestPath)) ??
      ({ class: "generic", riskObjective: sweep.name } as const);

    const positiveControl = await readPositiveControlConfig(manifestPath, sweep.name);
    const lifecycle = await readLifecycleConfig(manifestPath);

    const artifacts = buildCartographyArtifacts({
      runDoc,
      sweep,
      cartography,
      positiveControl,
      lifecycle
    });
    const outDir = options.out ? path.resolve(baseCwd, options.out) : path.dirname(simDir);
    await emitCartographyRoot(artifacts, outDir);

    const honesty = artifacts.campaignSummary.execution_honesty;
    if (options.json) {
      stdout(
        renderEnvelope(
          successEnvelope("sim surface", {
            out_dir: outDir,
            campaign_id: artifacts.campaignId,
            files: ["campaign-summary.json", "risk-surface.json", "retention-manifest.json"],
            execution_honesty: honesty ?? null
          })
        )
      );
      return 0;
    }

    stderr(
      chalk.bold(`riptide sim surface: wrote cartography artifacts to ${chalk.cyan(outDir)}\n`)
    );
    stderr(dim(`  campaign-summary.json (id ${artifacts.campaignId})\n`));
    stderr(dim(`  risk-surface.json\n`));
    stderr(dim(`  retention-manifest.json\n`));

    // Surface the execution-honesty gate status; a failed gate blocks at
    // `riptide assess` (emit) time, so flag it loudly here too.
    if (honesty) {
      const blocked = honesty.status === "blocked";
      stderr(
        (blocked ? chalk.red : chalk.green)(
          `  execution-honesty gates: ${honesty.status}\n`
        )
      );
      for (const gate of honesty.gates) {
        const mark = gate.status === "fail" ? chalk.red("✗") : dim("✓");
        stderr(`    ${mark} ${gate.id}: ${gate.detail}\n`);
      }
      if (blocked) {
        stderr(
          chalk.red(`  riptide assess will block this surface until the failing gate(s) pass\n`)
        );
      }
    }

    stderr(dim(`  next: riptide assess ${path.relative(baseCwd, outDir) || "."}\n`));
    return 0;
  } catch (err) {
    if (options.json) {
      stdout(
        renderEnvelope(
          errorEnvelope(
            "sim surface",
            commandFailure(err, {
              code: "sim_surface_failed",
              next: "check that the sim crate's Riptide.toml parses and the output directory is writable, then rerun"
            })
          )
        )
      );
      return 2;
    }
    stderr(chalk.red(`riptide sim surface: ${errMessage(err)}\n`));
    return 2;
  }
}

interface CargoOutcome {
  code: number;
  /** The child's stdout and stderr, captured only in `--json` mode. */
  log: string;
}

/**
 * Build the sim crate, then run it. The build is its own step so a compile
 * error is told apart from a failing run. Injected streams cannot be handed
 * to a child as file descriptors, so the child's output is piped through
 * them; in `--json` mode it is captured instead, keeping stdout for the
 * envelope; otherwise it inherits the terminal.
 */
async function runCargoSim(
  command: "sim run" | "sim debug",
  simPath: string,
  options: RunOptions,
  io: ResolvedCommandIO
): Promise<number> {
  const { stdout, stderr } = io;
  const json = options.json === true;
  const cwd = path.resolve(io.cwd, simPath);
  const fail = (error: CommandError, code: number, data?: unknown): number => {
    stdout(renderEnvelope(errorEnvelope(command, error, data)));
    return code;
  };

  if (!existsSync(path.join(cwd, "Cargo.toml"))) {
    const message = `no sim crate at ${cwd} (Cargo.toml not found)`;
    if (json) {
      return fail(
        {
          code: "sim_crate_not_found",
          message,
          next: `generate the sim crate with \`riptide sim generate --adapter <adapter> --dir ${simPath} --json\``
        },
        2
      );
    }
    stderr(chalk.red(`riptide sim: ${message}\n`));
    return 2;
  }

  const args = ["run", "--release", "--quiet", "--"];
  if (options.iterations) args.push("--iterations", options.iterations);
  if (options.flows) args.push("--flows", options.flows);
  if (options.seed) args.push("--seed", options.seed);
  if (options.debug) args.push("--debug");
  if (options.out) args.push("--out", path.resolve(io.cwd, options.out));

  // Manifest-primary parameter sweep: if Riptide.toml declares [sim.sweep],
  // forward it to the runner. Skipped in --debug (single-seed) mode.
  const sweep = options.debug ? null : await readSweepConfig(path.join(cwd, "Riptide.toml"));
  if (sweep) {
    for (const flag of formatSweepFlags(sweep)) args.push("--sweep", flag);
    args.push("--seeds-per-value", String(sweep.seedsPerValue));
    if (!json) stderr(dim(`  sweep ${describeSweep(sweep)}\n`));
  }

  if (options.out) {
    await writeGuidedSimRerunScript(simPath, options, io.cwd);
  }

  const cargo = (cargoArgs: string[]) => spawnCargo(cargoArgs, cwd, io, json);
  let build: CargoOutcome;
  let run: CargoOutcome;
  try {
    build = await cargo(["build", "--release", "--quiet"]);
    if (build.code !== 0) {
      if (!json) return build.code;
      return fail(
        {
          code: "sim_build_failed",
          message: `the sim crate at ${cwd} failed to build (cargo exit ${build.code})`,
          next: `fix the compiler errors in data.diagnostics (the authored code lives in ${path.join(simPath, "src")}), then rerun \`riptide ${command} ${simPath} --json\``
        },
        build.code,
        { crate: cwd, diagnostics: headLines(build.log, DIAGNOSTIC_LINES) }
      );
    }
    run = await cargo(args);
  } catch (err) {
    const message = `failed to start cargo: ${errMessage(err)}`;
    if (json) {
      return fail(
        {
          code: "sim_cargo_unavailable",
          message,
          next: "install the Rust toolchain so `cargo` is on PATH (see `riptide doctor --json`), then rerun"
        },
        2
      );
    }
    stderr(chalk.red(`riptide sim: ${message}\n`));
    return 2;
  }

  const outDir = options.out ? path.resolve(io.cwd, options.out) : null;
  // Warn (never block) at `sim run`: evaluate the run-only honesty gates
  // (positive control + lifecycle) so authoring iterations get early feedback
  // without being stopped. Emit-time enforcement happens at `riptide assess`.
  const gateWarnings =
    run.code === 0 && sweep && outDir ? await failedRunGates(cwd, outDir, sweep.name) : [];

  if (!json) {
    if (gateWarnings.length > 0) {
      stderr(
        chalk.yellow(
          `  warning: ${gateWarnings.length} execution-honesty gate(s) would block at \`riptide assess\`:\n`
        )
      );
      for (const gate of gateWarnings) {
        stderr(chalk.yellow(`    ✗ ${gate.id}: ${gate.detail}\n`));
      }
    }
    return run.code;
  }

  const failingSeed = /^riptide sim failure iteration=\d+ seed=([0-9a-fA-F]+)$/m.exec(run.log)?.[1];
  if (command === "sim debug") {
    if (run.code === 0 || failingSeed) {
      stdout(
        renderEnvelope(
          successEnvelope("sim debug", {
            crate: cwd,
            seed: options.seed ?? null,
            status: run.code === 0 ? "passed" : "failed",
            failure: run.code === 0 ? null : runnerError(run.log),
            log: lines(run.log)
          })
        )
      );
      return 0;
    }
    return fail(runnerFailure(run, command, simPath), run.code, {
      crate: cwd,
      log_tail: tailLines(run.log, LOG_TAIL_LINES)
    });
  }

  if (run.code !== 0) {
    const data = {
      crate: cwd,
      out: outDir,
      failing_seed: failingSeed ?? null,
      log_tail: tailLines(run.log, LOG_TAIL_LINES)
    };
    if (!failingSeed) return fail(runnerFailure(run, command, simPath), run.code, data);
    return fail(
      {
        code: "sim_run_failed",
        message: `iteration failed at seed ${failingSeed}: ${runnerError(run.log) ?? `sim exited with code ${run.code}`}`,
        next: `replay the failing seed with \`riptide sim debug ${simPath} --seed ${failingSeed} --json\`, then repair the flow or invariant its log names`
      },
      run.code,
      data
    );
  }

  stdout(
    renderEnvelope(
      successEnvelope("sim run", {
        crate: cwd,
        out: outDir,
        sweep: sweep
          ? { axes: sweepAxes(sweep), seeds_per_value: sweep.seedsPerValue }
          : null,
        run: outDir ? await readRunSummary(outDir) : null,
        execution_honesty_warnings: gateWarnings.map(({ id, detail }) => ({ id, detail }))
      })
    )
  );
  return 0;
}

function describeSweep(sweep: SweepConfig): string {
  const axes = sweepAxes(sweep);
  const coordinates = axes.reduce((acc, axis) => acc * axis.values.length, 1);
  const description =
    axes.length === 1
      ? `${axes[0]!.name} over ${axes[0]!.values.length} value(s)`
      : `${axes.length} axes (${axes.map((axis) => axis.name).join(", ")}) over ${coordinates} coordinate(s)`;
  return `${description} x ${sweep.seedsPerValue} seed(s)`;
}

function spawnCargo(
  args: string[],
  cwd: string,
  io: ResolvedCommandIO,
  capture: boolean
): Promise<CargoOutcome> {
  return new Promise((resolve, reject) => {
    let log = "";
    const record = (chunk: string) => {
      log += chunk;
    };
    const child = spawn("cargo", args, {
      cwd,
      stdio: capture || io.injected ? ["ignore", "pipe", "pipe"] : "inherit",
      env: { ...process.env }
    });
    child.stdout?.setEncoding("utf8").on("data", capture ? record : io.stdout);
    child.stderr?.setEncoding("utf8").on("data", capture ? record : io.stderr);
    child.once("error", reject);
    child.once("close", (closeCode) => resolve({ code: closeCode ?? 1, log }));
  });
}

/** The runner's own error line (`riptide sim: <error>`), if it printed one. */
function runnerError(log: string): string | undefined {
  const matches = [...log.matchAll(/^riptide sim: (.+)$/gm)];
  return matches.at(-1)?.[1];
}

function runnerFailure(run: CargoOutcome, command: string, simPath: string): CommandError {
  return {
    code: "sim_runner_failed",
    message: runnerError(run.log) ?? `the sim exited with code ${run.code} before any iteration failed`,
    next: `fix the runner error shown in data.log_tail (an invalid option, or a setup piece the sim's init needs), then rerun \`riptide ${command} ${simPath} --json\``
  };
}

export interface SimRunSummaryJson {
  artifact: string;
  status: unknown;
  base_seed: unknown;
  retained_failing_seed: unknown;
  totals: unknown;
}

async function readRunSummary(outDir: string): Promise<SimRunSummaryJson | null> {
  const runFile = path.join(outDir, "guided-sim-run.json");
  if (!existsSync(runFile)) return null;
  const doc = JSON.parse(await readFile(runFile, "utf8")) as Record<string, unknown>;
  return {
    artifact: runFile,
    status: doc.status ?? null,
    base_seed: doc.base_seed ?? null,
    retained_failing_seed: doc.retained_failing_seed ?? null,
    totals: doc.totals ?? null
  };
}

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

function headLines(text: string, count: number): string[] {
  return lines(text).slice(0, count);
}

function tailLines(text: string, count: number): string[] {
  return lines(text).slice(-count);
}

/** The run-only honesty gates (positive control + lifecycle) that fail over a freshly written guided-sim-run.json. */
async function failedRunGates(
  cwd: string,
  outDir: string,
  sweepName: string
): Promise<GateResult[]> {
  try {
    const runFile = path.join(outDir, "guided-sim-run.json");
    if (!existsSync(runFile)) return [];
    const runDoc = JSON.parse(await readFile(runFile, "utf8")) as GuidedSimRunDocument;
    const manifestPath = path.join(cwd, "Riptide.toml");
    const positiveControl = await readPositiveControlConfig(manifestPath, sweepName);
    const lifecycle = await readLifecycleConfig(manifestPath);
    const gates = [
      evaluatePositiveControl(runDoc, positiveControl),
      evaluateLifecycle(runDoc, lifecycle)
    ];
    return gates.filter((gate) => gate.status === "fail");
  } catch {
    // Best-effort warning; never fail the run on gate-evaluation trouble.
    return [];
  }
}

async function writeGuidedSimRerunScript(
  simPath: string,
  options: RunOptions,
  baseCwd: string
): Promise<void> {
  if (!options.out) return;
  const outDir = path.resolve(baseCwd, options.out);
  await mkdir(outDir, { recursive: true });
  const parts = [
    "riptide",
    "sim",
    "run",
    shellQuotePath(path.resolve(baseCwd, simPath))
  ];
  if (options.iterations) parts.push("--iterations", shellQuotePath(options.iterations));
  if (options.flows) parts.push("--flows", shellQuotePath(options.flows));
  if (options.seed) parts.push("--seed", shellQuotePath(options.seed));
  parts.push("--out", shellQuotePath(outDir));

  const rerunPath = path.join(outDir, "rerun.sh");
  await writeFile(rerunPath, `#!/bin/sh\nset -eu\n${parts.join(" ")}\n`, "utf8");
  await chmod(rerunPath, 0o755);
}

function shellQuotePath(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export async function runSimFork(options: ForkOptions, deps: SimCommandDeps = {}): Promise<number> {
  const { stdout, stderr, cwd } = resolveCommandIO(deps);
  const outPath = path.resolve(cwd, options.out);
  const succeed = (reused: boolean, human: string): number => {
    if (options.json) {
      stdout(
        renderEnvelope(
          successEnvelope("sim fork", {
            address: options.address,
            cluster: options.cluster,
            out: outPath,
            reused
          })
        )
      );
    } else {
      stdout(human);
    }
    return 0;
  };
  try {
    if (existsSync(outPath) && options.overwrite !== true) {
      try {
        const raw = await readFile(outPath, "utf8");
        validateReusableSnapshot(raw, options.address, outPath);
      } catch (err) {
        throw new SimCommandError(
          errMessage(err),
          "sim_fork_cache_invalid",
          `rerun \`riptide sim fork --address ${options.address} --out ${options.out} --overwrite --json\` to refresh the snapshot`
        );
      }
      return succeed(true, `riptide sim fork: reused cached snapshot ${outPath}\n`);
    }

    const account = await fetchAccountSnapshot(options.address, options.cluster);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(
      outPath,
      JSON.stringify(snapshotJson(options.address, options.cluster, outPath, account), null, 2),
      "utf8"
    );
    return succeed(
      false,
      `riptide sim fork: wrote ${options.address} from ${options.cluster} to ${outPath}\n`
    );
  } catch (err) {
    if (options.json) {
      stdout(
        renderEnvelope(
          errorEnvelope(
            "sim fork",
            commandFailure(err, {
              code: "sim_fork_failed",
              next: `check that ${path.dirname(outPath)} is writable, then rerun`
            })
          )
        )
      );
      return 2;
    }
    stderr(chalk.red(`riptide sim fork: ${errMessage(err)}\n`));
    return 2;
  }
}

function validateReusableSnapshot(raw: string, expectedAddress: string, filename: string): void {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`cached snapshot ${filename} must be a JSON object`);
  }
  const declared = typeof parsed.pubkey === "string" ? parsed.pubkey : undefined;
  const provenanceAddress = isRecord(parsed.provenance) && typeof parsed.provenance.address === "string"
    ? parsed.provenance.address
    : undefined;
  const cachedAddress = declared ?? provenanceAddress;
  if (cachedAddress === undefined) {
    throw new Error(
      `cached snapshot ${filename} is missing pubkey provenance; pass --overwrite to refresh it`
    );
  }
  if (cachedAddress !== expectedAddress) {
    throw new Error(
      `cached snapshot ${filename} pubkey ${cachedAddress} does not match requested address ${expectedAddress}; pass --overwrite to refresh it`
    );
  }

  const account = snapshotAccountValue(parsed);
  if (!isRecord(account)) {
    throw new Error(`cached snapshot ${filename} is missing account data`);
  }
  if (typeof account.owner !== "string") {
    throw new Error(`cached snapshot ${filename} is missing account.owner`);
  }
  if (typeof account.lamports !== "number" || !Number.isSafeInteger(account.lamports) || account.lamports < 0) {
    throw new Error(`cached snapshot ${filename} has invalid account.lamports`);
  }
  validateSnapshotData(account.data, filename);
}

function snapshotAccountValue(parsed: Record<string, unknown>): unknown {
  if (isRecord(parsed.account)) return parsed.account;
  if (isRecord(parsed.result)) {
    const value = parsed.result.value;
    if (isRecord(value)) return value;
  }
  return parsed;
}

function validateSnapshotData(data: unknown, filename: string): void {
  const encoded = typeof data === "string"
    ? data
    : Array.isArray(data) && typeof data[0] === "string"
      ? data[0]
      : undefined;
  if (encoded === undefined) {
    throw new Error(`cached snapshot ${filename} data must be base64 or [base64, encoding]`);
  }
  const encoding = Array.isArray(data) && typeof data[1] === "string"
    ? data[1].toLowerCase()
    : "base64";
  if (encoding !== "base64") {
    throw new Error(`cached snapshot ${filename} uses unsupported data encoding ${encoding}`);
  }
  if (!isStrictBase64(encoded)) {
    throw new Error(`cached snapshot ${filename} data is not valid standard base64`);
  }
}

function isStrictBase64(value: string): boolean {
  if (value.length === 0) return true;
  if (value.length % 4 !== 0) return false;
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface RpcAccount {
  contextSlot?: number;
  lamports: number;
  data: [string, string];
  owner: string;
  executable: boolean;
  rentEpoch: number;
}

async function fetchAccountSnapshot(address: string, cluster: string): Promise<RpcAccount> {
  const url = clusterUrl(cluster);
  const fetchFailed = (message: string) =>
    new SimCommandError(
      message,
      "sim_fork_fetch_failed",
      "check the --cluster alias or RPC URL and network access, then rerun"
    );
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [address, { encoding: "base64", commitment: "confirmed" }]
      })
    });
  } catch (err) {
    throw fetchFailed(errMessage(err));
  }
  if (!response.ok) {
    throw fetchFailed(`RPC ${url} returned HTTP ${response.status}`);
  }
  const body = await response.json() as {
    error?: unknown;
    result?: { context?: { slot?: number }; value?: Omit<RpcAccount, "contextSlot"> | null };
  };
  if (body.error) throw fetchFailed(`RPC ${url} returned ${JSON.stringify(body.error)}`);
  const value = body.result?.value;
  if (!value) {
    throw new SimCommandError(
      `account ${address} does not exist on ${url}`,
      "sim_fork_account_not_found",
      "check --address and --cluster: the account must exist on that cluster"
    );
  }
  return { ...value, contextSlot: body.result?.context?.slot };
}

function snapshotJson(address: string, cluster: string, filename: string, account: RpcAccount): unknown {
  const data = account.data[0] ?? "";
  return {
    pubkey: address,
    account: {
      lamports: account.lamports,
      data: account.data,
      owner: account.owner,
      executable: account.executable,
      rentEpoch: account.rentEpoch
    },
    provenance: {
      address,
      cluster,
      fetched_slot: account.contextSlot ?? null,
      owner: account.owner,
      executable: account.executable,
      data_hash: createHash("sha256").update(Buffer.from(data, "base64")).digest("hex"),
      filename
    }
  };
}

function clusterUrl(cluster: string): string {
  switch (cluster) {
    case "m":
    case "mainnet":
    case "mainnet-beta":
      return "https://api.mainnet-beta.solana.com";
    case "d":
    case "devnet":
      return "https://api.devnet.solana.com";
    case "t":
    case "testnet":
      return "https://api.testnet.solana.com";
    default:
      return cluster;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
