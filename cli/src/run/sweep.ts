import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildSimulateOptions, toRunConfig } from "../config.js";
import type { SimulationResult } from "../compiler/schema.js";
import { renderSweepNarrative } from "../report/sweep-narrative.js";

import type { InvariantFire } from "./last-run.js";
import type { ResolvedScenario, RunEvent, RunOneContext, RunOneResult } from "./loop.js";
import {
  writeSweepSummary,
  type SweepCellSummary,
  type SweepSummary
} from "./sweep-summary.js";

export const DEFAULT_SWEEP_SIZE = 50;
const SWEEP_PROGRESS_INTERVAL_MS = 30_000;

export interface RunSweepOptions {
  scenario: ResolvedScenario;
  cwd: string;
  adapterPath?: string;
  adapterSource?: string;
  silent?: boolean;
  /** Scenario-level output directory: `<output>/<scenario-name>/`. */
  scenarioOutputDir: string;
  /** Optional state pack override for every sweep cell. */
  statePackPath?: string;
  /** Optional Rust harness crate or Cargo.toml for every sweep cell. */
  harnessPath?: string;
  sweepSize: number;
  seedRoot: number;
  full: boolean;
  runOne: (ctx: RunOneContext) => Promise<RunOneResult>;
  /** Allows the outer run loop's SIGINT handler to stop this sweep. */
  shouldAbort?: () => boolean;
  /** Test hook. Defaults to os.availableParallelism(). */
  parallelism?: number;
  /** Human-output event bridge owned by the run loop formatter. JSON mode passes a noop. */
  onEvent?: (event: RunEvent) => void;
}

interface RawRunConfigFile {
  agents?: number;
  ticks?: number;
  scenario?: string;
  seed?: number;
  personas?: string[];
  output_path?: string;
  validator_url?: string;
  state_pack?: string;
}

interface CellOutcome {
  cell: SweepCellSummary;
  result: RunOneResult | null;
}

export async function runSweep(options: RunSweepOptions): Promise<RunOneResult> {
  if (!Number.isInteger(options.sweepSize) || options.sweepSize <= 1) {
    throw new Error(`runSweep requires sweepSize > 1, got ${options.sweepSize}`);
  }
  if (!Number.isInteger(options.seedRoot) || options.seedRoot < 0) {
    throw new Error(`runSweep requires a nonnegative integer seedRoot, got ${options.seedRoot}`);
  }

  const raw = readRunConfigFile(options.scenario.runConfigPath);
  assertSweepableConfig(raw, options.scenario.runConfigPath);

  const sweepStarted = Date.now();
  const runsDir = path.join(options.scenarioOutputDir, "runs");
  await mkdir(runsDir, { recursive: true });

  const seeds = Array.from({ length: options.sweepSize }, (_, idx) => options.seedRoot + idx);
  const eventsPerCell = raw.agents! * raw.ticks!;
  const totalEvents = eventsPerCell * options.sweepSize;
  const limit = Math.max(
    1,
    Math.min(
      options.sweepSize,
      options.parallelism ?? availableParallelism()
    )
  );
  const policiesPath = adjacentPoliciesPath(options.scenario.runConfigPath);
  const outcomes: CellOutcome[] = [];
  const controllers = new Set<AbortController>();
  const stats = {
    started: 0,
    active: 0,
    passed: 0,
    fired: 0,
    engineErrors: 0,
    killed: 0,
    completedWallS: 0
  };
  const activeSince = new Map<number, number>();
  let next = 0;
  let cancelRequested = false;
  let cancelReason: "fired" | "engine_error" | "signal" | null = null;
  let firstFireSeed: number | undefined;
  let firstFireCellDir: string | undefined;

  options.onEvent?.({
    type: "sweep_start",
    scenario: options.scenario,
    sweepSize: options.sweepSize,
    seedRoot: options.seedRoot,
    parallelism: limit,
    failFast: !options.full,
    agents: raw.agents!,
    ticks: raw.ticks!,
    eventsPerCell,
    totalEvents
  });

  let heartbeat: NodeJS.Timeout | undefined;
  let heartbeatClosed = false;

  const armHeartbeat = () => {
    if (!options.onEvent || heartbeatClosed) return;
    if (heartbeat) clearTimeout(heartbeat);
    heartbeat = setTimeout(() => {
      heartbeat = undefined;
      emitProgress();
    }, SWEEP_PROGRESS_INTERVAL_MS);
    heartbeat.unref();
  };

  const emitProgress = () => {
    const completed = stats.passed + stats.fired + stats.engineErrors;
    const elapsedS = roundSec((Date.now() - sweepStarted) / 1000);
    const averageCellS =
      completed > 0 ? roundSec(stats.completedWallS / completed) : undefined;
    const etaS =
      averageCellS !== undefined
        ? estimateRemainingSeconds({
            sweepSize: options.sweepSize,
            completed,
            averageCellS,
            activeSince,
            parallelism: limit
          })
        : undefined;
    options.onEvent?.({
      type: "sweep_progress",
      scenario: options.scenario,
      sweepSize: options.sweepSize,
      seedRoot: options.seedRoot,
      parallelism: limit,
      started: stats.started,
      active: stats.active,
      completed,
      passed: stats.passed,
      fired: stats.fired,
      engineErrors: stats.engineErrors,
      killed: stats.killed,
      elapsedS,
      oldestActiveS: oldestActiveSeconds(activeSince),
      eventsPerCell,
      totalEvents,
      ...(averageCellS !== undefined ? { averageCellS } : {}),
      ...(etaS !== undefined ? { etaS } : {})
    });
    armHeartbeat();
  };

  const requestCancel = (reason: "fired" | "engine_error" | "signal") => {
    if (cancelRequested) return;
    cancelRequested = true;
    cancelReason = reason;
    for (const controller of controllers) {
      controller.abort();
    }
  };

  const worker = async () => {
    while (true) {
      if (options.shouldAbort?.()) {
        requestCancel("signal");
      }
      if (cancelRequested) return;
      const seed = seeds[next];
      if (seed === undefined) return;
      next += 1;

      const controller = new AbortController();
      controllers.add(controller);
      stats.started += 1;
      stats.active += 1;
      activeSince.set(seed, Date.now());
      try {
        const outcome = await runCell({
          options,
          raw,
          seed,
          policiesPath,
          signal: controller.signal,
          isCancellationRequested: () => cancelRequested
        });
        stats.active = Math.max(0, stats.active - 1);
        recordCellStatus(stats, outcome.cell);
        outcomes.push(outcome);
        if (outcome.cell.status !== "killed") {
          emitProgress();
        }
        if (outcome.cell.status === "fired" && firstFireSeed === undefined) {
          firstFireSeed = outcome.cell.seed;
          firstFireCellDir = outcome.cell.cell_dir;
        }
        if (!options.full) {
          if (outcome.cell.status === "fired") {
            requestCancel("fired");
          } else if (outcome.cell.status === "engine_error") {
            requestCancel(isInterruptReason(outcome.cell.error) ? "signal" : "engine_error");
          }
        }
      } finally {
        controllers.delete(controller);
        activeSince.delete(seed);
      }
    }
  };

  try {
    const workers = Array.from({ length: limit }, () => worker());
    emitProgress();
    await Promise.all(workers);
  } finally {
    heartbeatClosed = true;
    if (heartbeat) clearTimeout(heartbeat);
  }

  const cells = outcomes
    .map((outcome) => outcome.cell)
    .sort((a, b) => a.seed - b.seed);
  const completed = cells.filter((cell) => cell.status !== "killed").length;
  const fired = cells.filter((cell) => cell.status === "fired").length;
  const engineErrors = cells.filter((cell) => cell.status === "engine_error").length;
  const firstFire = cells.find((cell) => cell.seed === firstFireSeed);
  const firstError = cells.find((cell) => cell.status === "engine_error");

  const status =
    cancelReason === "signal"
      ? "interrupted"
      : engineErrors > 0
        ? "engine_error"
        : fired > 0
          ? "fired"
          : "all_pass";

  const summary: SweepSummary = {
    scenario: options.scenario.name,
    seed_root: options.seedRoot,
    sweep_size: options.sweepSize,
    completed,
    fired,
    engine_errors: engineErrors,
    status,
    fail_fast: !options.full,
    ...(firstFireCellDir ? { first_fire_cell: firstFireCellDir } : {}),
    wall_clock_s: roundSec((Date.now() - sweepStarted) / 1000),
    invariant_fire_frequency: invariantFireFrequency(cells, options.sweepSize),
    cells
  };

  options.onEvent?.({
    type: "sweep_end",
    scenario: options.scenario,
    sweepSize: options.sweepSize,
    seedRoot: options.seedRoot,
    completed,
    fired,
    engineErrors,
    status: summary.status,
    wallClockS: summary.wall_clock_s
  });

  const summaryPath = await writeSweepSummary(options.scenarioOutputDir, summary);
  const reportPath = path.join(options.scenarioOutputDir, "sweep-report.md");
  await writeFile(reportPath, renderSweepNarrative(summary), "utf8");

  const sweep = {
    size: options.sweepSize,
    seed_root: options.seedRoot,
    fired_count: fired,
    engine_error_count: engineErrors,
    summary_path: summaryPath,
    report_path: reportPath,
    ...(firstFireCellDir ? { first_fire_cell: firstFireCellDir } : {}),
    fail_fast: !options.full,
    status: summary.status
  };

  if (summary.status === "engine_error" || summary.status === "interrupted") {
    return {
      kind: "error",
      wallClockS: summary.wall_clock_s,
      error:
        firstError?.error ??
        (cancelReason === "signal"
          ? "sweep aborted: SIGINT received"
          : "sweep aborted: engine error"),
      sweep
    };
  }

  if (summary.status === "fired") {
    const firedOutcome = outcomes.find((outcome) => outcome.cell.seed === firstFireSeed);
    const failed = firedOutcome?.result?.kind === "fail" ? firedOutcome.result : null;
    return {
      kind: "fail",
      wallClockS: summary.wall_clock_s,
      artifactsDir: firstFire?.cell_dir ?? options.scenarioOutputDir,
      result: failed?.result ?? firstRepresentative(outcomes),
      fires: failed?.fires ?? firesFromCell(firstFire),
      engineStderr: failed?.engineStderr,
      sweep
    };
  }

  return {
    kind: "pass",
    wallClockS: summary.wall_clock_s,
    artifactsDir: cells.find((cell) => cell.status === "pass")?.cell_dir ?? options.scenarioOutputDir,
    result: firstRepresentative(outcomes),
    sweep
  };
}

function isInterruptReason(reason: string | undefined): boolean {
  return typeof reason === "string" && (/\bSIGINT\b/i.test(reason) || /interrupt/i.test(reason));
}

function recordCellStatus(
  stats: {
    passed: number;
    fired: number;
    engineErrors: number;
    killed: number;
    completedWallS: number;
  },
  cell: SweepCellSummary
): void {
  const status = cell.status;
  if (status === "pass") stats.passed += 1;
  else if (status === "fired") stats.fired += 1;
  else if (status === "engine_error") stats.engineErrors += 1;
  else if (status === "killed") stats.killed += 1;
  if (status !== "killed") {
    stats.completedWallS += cell.wall_s;
  }
}

function oldestActiveSeconds(activeSince: Map<number, number>): number {
  if (activeSince.size === 0) return 0;
  return roundSec((Date.now() - Math.min(...activeSince.values())) / 1000);
}

function estimateRemainingSeconds(input: {
  sweepSize: number;
  completed: number;
  averageCellS: number;
  activeSince: Map<number, number>;
  parallelism: number;
}): number {
  const remainingCells = Math.max(0, input.sweepSize - input.completed);
  const activeProgressS = activeProgressCreditSeconds(input.activeSince, input.averageCellS);
  const remainingWorkS = Math.max(0, remainingCells * input.averageCellS - activeProgressS);
  const estimate = roundSec(remainingWorkS / Math.max(1, input.parallelism));
  if (remainingCells > 0 && input.activeSince.size > 0 && estimate < 1) {
    return 1;
  }
  return estimate;
}

function activeProgressCreditSeconds(activeSince: Map<number, number>, averageCellS: number): number {
  const now = Date.now();
  let total = 0;
  for (const startedAt of activeSince.values()) {
    total += Math.min(averageCellS, Math.max(0, (now - startedAt) / 1000));
  }
  return total;
}

function readRunConfigFile(runConfigPath: string): RawRunConfigFile {
  const raw = readFileSync(runConfigPath, "utf8");
  try {
    return JSON.parse(raw) as RawRunConfigFile;
  } catch (err) {
    throw new Error(
      `run-config at ${runConfigPath}: JSON parse failed: ${(err as Error).message}`
    );
  }
}

function assertSweepableConfig(raw: RawRunConfigFile, runConfigPath: string): void {
  if (
    typeof raw.agents !== "number" ||
    typeof raw.ticks !== "number" ||
    typeof raw.scenario !== "string" ||
    !Array.isArray(raw.personas)
  ) {
    throw new Error(
      `run-config at ${runConfigPath} missing one of: agents, ticks, scenario, personas`
    );
  }
}

async function runCell(input: {
  options: RunSweepOptions;
  raw: RawRunConfigFile;
  seed: number;
  policiesPath?: string;
  signal: AbortSignal;
  isCancellationRequested: () => boolean;
}): Promise<CellOutcome> {
  const { options, raw, seed } = input;
  const cellDir = path.join(options.scenarioOutputDir, "runs", String(seed));
  await mkdir(cellDir, { recursive: true });
  const runConfigPath = path.join(cellDir, "run-config.json");
  await writeCellRunConfig({
    raw,
    seed,
    cellDir,
    runConfigPath,
    adapterPath: options.adapterPath,
    statePackPath: resolveSweepStatePackPath(
      options.statePackPath,
      raw.state_pack,
      options.scenario.runConfigPath,
      options.cwd
    )
  });

  const started = Date.now();
  let result: RunOneResult;
  try {
    result = await options.runOne({
      scenario: {
        name: options.scenario.name,
        runConfigPath
      },
      cwd: options.cwd,
      adapterPath: options.adapterPath,
      adapterSource: options.adapterSource,
      silent: options.silent,
      artifactDirOverride: cellDir,
      policiesPathOverride: input.policiesPath,
      reproCommandOverride: `riptide run --replay ${path.relative(options.cwd, cellDir) || cellDir}`,
      statePackPath: options.statePackPath,
      harnessPath: options.harnessPath,
      abortSignal: input.signal
    });
  } catch (err) {
    result = {
      kind: "error",
      wallClockS: (Date.now() - started) / 1000,
      error: err instanceof Error ? err.message : String(err)
    };
  }

  const wallS = roundSec((Date.now() - started) / 1000);
  if (input.signal.aborted && input.isCancellationRequested()) {
    return {
      cell: {
        seed,
        status: "killed",
        wall_s: wallS,
        invariant_fires: [],
        cell_dir: cellDir
      },
      result: null
    };
  }

  if (result.kind === "pass") {
    return {
      cell: {
        seed,
        status: "pass",
        wall_s: roundSec(result.wallClockS),
        invariant_fires: [],
        cell_dir: result.artifactsDir
      },
      result
    };
  }
  if (result.kind === "fail") {
    return {
      cell: {
        seed,
        status: "fired",
        wall_s: roundSec(result.wallClockS),
        invariant_fires: uniqueFireNames(result.fires),
        cell_dir: result.artifactsDir
      },
      result
    };
  }
  return {
    cell: {
      seed,
      status: "engine_error",
      wall_s: roundSec(result.wallClockS),
      invariant_fires: [],
      cell_dir: cellDir,
      error: result.error
    },
    result
  };
}

async function writeCellRunConfig(input: {
  raw: RawRunConfigFile;
  seed: number;
  cellDir: string;
  runConfigPath: string;
  adapterPath?: string;
  statePackPath?: string;
}): Promise<void> {
  const parsed = buildSimulateOptions({
    agents: input.raw.agents,
    ticks: input.raw.ticks,
    scenario: input.raw.scenario,
    seed: input.seed,
    personas: input.raw.personas?.join(","),
    validatorUrl: input.raw.validator_url,
    adapter: input.adapterPath,
    output: input.cellDir,
    statePack: input.statePackPath
  });
  const runConfig = toRunConfig(parsed.config);
  const payload: Record<string, unknown> = {
    ...runConfig
  };
  if (input.adapterPath) {
    payload.adapter = input.adapterPath;
  }
  await writeFile(input.runConfigPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

function resolveSweepStatePackPath(
  override: string | undefined,
  rawStatePack: string | undefined,
  sourceRunConfigPath: string,
  cwd: string
): string | undefined {
  const value = override ?? rawStatePack;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  if (path.isAbsolute(value)) return value;
  return path.resolve(override ? cwd : path.dirname(sourceRunConfigPath), value);
}

function adjacentPoliciesPath(runConfigPath: string): string | undefined {
  const candidate = path.join(path.dirname(runConfigPath), "policies.json");
  return existsSync(candidate) ? candidate : undefined;
}

function invariantFireFrequency(
  cells: SweepCellSummary[],
  sweepSize: number
): SweepSummary["invariant_fire_frequency"] {
  const counts = new Map<string, number>();
  for (const cell of cells) {
    if (cell.status !== "fired") continue;
    for (const name of new Set(cell.invariant_fires)) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  const out: SweepSummary["invariant_fire_frequency"] = {};
  for (const [name, count] of [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    out[name] = {
      count,
      rate: sweepSize > 0 ? count / sweepSize : 0
    };
  }
  return out;
}

function uniqueFireNames(fires: InvariantFire[]): string[] {
  return [...new Set(fires.map((fire) => fire.name))].sort();
}

function firesFromCell(cell: SweepCellSummary | undefined): InvariantFire[] {
  if (!cell) return [];
  return cell.invariant_fires.map((name) => ({ name, tick: 0 }));
}

function firstRepresentative(outcomes: CellOutcome[]): SimulationResult {
  for (const outcome of outcomes) {
    if (outcome.result?.kind === "pass" || outcome.result?.kind === "fail") {
      return outcome.result.result;
    }
  }
  throw new Error("sweep produced no completed simulation result");
}

function availableParallelism(): number {
  const fn = os.availableParallelism;
  if (typeof fn === "function") {
    return fn.call(os);
  }
  return Math.max(1, os.cpus().length);
}

function roundSec(s: number): number {
  return Math.round(s * 1000) / 1000;
}
