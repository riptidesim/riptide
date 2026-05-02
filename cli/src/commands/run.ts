// `riptide run` — jest-style multi-scenario runner.
//
// Behavior matrix (R3.1–R3.6):
//   $ riptide run                → discover all, run all (per-scenario adapter)
//   $ riptide run <pattern>      → discover all, filter by glob
//   $ riptide run <path.json>    → run a single run-config file (backward-compat)
//   $ riptide run --only-failing → rerun only scenarios that failed last time
//   $ riptide run --serve        → after the sweep, serve the run collection dashboard
//   $ riptide run --adapter <t>  → pin every scenario to one adapter (override)
//
// Disambiguation rule: if the positional arg ends in `.json` AND
// exists on disk, it is treated as a file path. Otherwise it is a
// glob pattern. Documented in the spec + resolveScenarios() docs.
//
// Adapter resolution: NOT done globally at startup. Each scenario
// picks its own adapter via `cli/src/run/adapter.ts` per R9.1.
//
// Exit codes per `cli/src/run/exit-codes.ts`:
//   0 all-pass · 1 invariant-fire · 2 setup-error · 3 partial-abort · 130 SIGINT

import { readFileSync } from "node:fs";
import path from "node:path";

import chalk from "chalk";
import { Command } from "commander";

import { monorepoRootFromModule, runOrchestrator } from "../orchestrator/index.js";
import {
  buildScenarioRun,
  extractInvariantFires,
  resolveScenarios,
  runScenarios
} from "../run/loop.js";
import { createJestFormatter } from "../run/output.js";
import { EXIT_CODES, exitCodeFromSummary } from "../run/exit-codes.js";
import { blockUntilSignal, startDashboardServer } from "../serve/index.js";
import { printBanner } from "../banner.js";
import { resolveAdapterForScenario } from "../run/adapter.js";
import { writeArtifacts } from "../report/artifacts.js";
import { canonicalSimulationResultHash } from "../review/hash.js";

export function createRunCommand(): Command {
  return new Command("run")
    .description(
      "Run every scenario under .riptide/scenarios/ (jest-style). Passing a pattern filters; passing a .json path runs that single file."
    )
    .argument(
      "[pattern-or-path]",
      "Glob pattern (matches discovered scenario names) OR path to a single run-config .json file"
    )
    .option(
      "--adapter <path>",
      "Adapter TOML path. Overrides per-scenario adapter resolution. Default (no override): each scenario resolves its own adapter from run-config.json, the monorepo bundle fallback, or .riptide/adapters/<one>.toml."
    )
    .option(
      "--only-failing",
      "Run only scenarios that failed or aborted in the most recent run (reads .riptide/last-run.json)",
      false
    )
    .option(
      "--serve",
      "After the sweep, start the Riptide web dashboard (default port 4173) serving the run collection. Blocks on Ctrl-C.",
      false
    )
    .option(
      "--format <format>",
      "Output format: human (default, jest-style) or json (RunSummary for multi-scenario, SimulationResult for single-scenario)",
      "human"
    )
    .option("--json", "Alias for --format json", false)
    .option("--quiet", "Suppress interactive banner", false)
    .option(
      "--allow-invariant-violations",
      "Exit 0 even if declared invariants fire during any scenario (default: exit 1 on any firing). Mirrors engine flag; setup errors + SIGINT + engine crashes still return non-zero.",
      false
    )
    .option(
      "-v, --verbose",
      "Restore pass-through engine stderr during each scenario (today's pre-Phase-4 chatter). Default is quiet — engine output only surfaces in the per-failure summary block.",
      false
    )
    .option(
      "--output-dir <path>",
      "Override the artifact root (default: <cwd>/.riptide/runs). Each scenario lands at <output-dir>/<scenario-name>/simulation-result.json. Use for CI systems writing to mounted volumes.",
      undefined
    )
    .option(
      "--state-pack <path>",
      "Hydrate a current-state pack into LiteSVM before tick 0. Overrides any state_pack field in selected run-config files.",
      undefined
    )
    .option(
      "--harness <path>",
      "Run scenarios through a generated Rust harness crate or Cargo.toml. Harness setup runs before tick 0.",
      undefined
    )
    .option(
      "--seeds <N>",
      "Override stress sweep size. N=1 preserves the single-run path.",
      undefined
    )
    .option(
      "--full",
      "Run every seed cell even after an invariant fires or an engine error is observed.",
      false
    )
    .option(
      "--seed-root <N>",
      "Pin the sweep seed stream. Cells use seed-root, seed-root+1, ...",
      undefined
    )
    .option(
      "--replay <cell-dir>",
      "Re-execute one sweep cell deterministically from <cell-dir>/run-config.json.",
      undefined
    )
    .action(async (positional: string | undefined, cliOpts: Record<string, unknown>) => {
      const cwd = process.cwd();
      const formatJson = Boolean(cliOpts.json) || cliOpts.format === "json";
      printBanner({ flags: { json: formatJson, quiet: Boolean(cliOpts.quiet), format: cliOpts.format } });
      const allowInvariantViolations = Boolean(cliOpts.allowInvariantViolations);
      const verbose = Boolean(cliOpts.verbose);
      const outputDir =
        typeof cliOpts.outputDir === "string" && (cliOpts.outputDir as string).length > 0
          ? path.resolve(cliOpts.outputDir as string)
          : undefined;
      const statePackOverride =
        typeof cliOpts.statePack === "string" && (cliOpts.statePack as string).length > 0
          ? path.resolve(cliOpts.statePack as string)
          : undefined;
      const harnessPath =
        typeof cliOpts.harness === "string" && (cliOpts.harness as string).length > 0
          ? path.resolve(cliOpts.harness as string)
          : undefined;
      const seeds =
        typeof cliOpts.seeds === "string"
          ? parsePositiveIntegerFlag(cliOpts.seeds, "--seeds")
          : undefined;
      const seedRoot =
        typeof cliOpts.seedRoot === "string"
          ? parseNonnegativeIntegerFlag(cliOpts.seedRoot, "--seed-root")
          : undefined;

      if (typeof cliOpts.replay === "string" && cliOpts.replay.length > 0) {
        let replay: RunCellReplayResult;
        try {
          replay = await replayRunCell({
            cwd,
            cellDir: path.resolve(cliOpts.replay),
            adapterOverride:
              typeof cliOpts.adapter === "string" && cliOpts.adapter.length > 0
                ? path.resolve(cliOpts.adapter)
                : undefined,
            monorepoRoot: monorepoRootFromModule() ?? null,
            silent: !verbose,
            allowInvariantViolations
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (formatJson) {
            process.stdout.write(JSON.stringify({ error: message }, null, 2) + "\n");
          } else {
            process.stderr.write(chalk.red(`${message}\n`));
          }
          process.exit(EXIT_CODES.SETUP_ERROR);
        }
        if (formatJson) {
          process.stdout.write(JSON.stringify(replay, null, 2) + "\n");
        } else {
          process.stdout.write(`cell hash: ${replay.hash}\n`);
          process.stdout.write(`cell dir: ${replay.cellDir}\n`);
        }
        process.exit(replay.exitCode);
      }

      const resolved = await resolveScenarios({
        cwd,
        positional,
        onlyFailing: Boolean(cliOpts.onlyFailing)
      });
      if (resolved.kind === "setup_error") {
        if (formatJson) {
          process.stdout.write(JSON.stringify({ error: resolved.message }) + "\n");
        } else {
          process.stderr.write(chalk.red(`${resolved.message}\n`));
        }
        process.exit(EXIT_CODES.SETUP_ERROR);
      }

      for (const warning of resolved.warnings) {
        process.stderr.write(chalk.yellow(`warning: ${warning}\n`));
      }

      // Global adapter override — passed through as a hint to the
      // per-scenario resolver in `cli/src/run/adapter.ts`. When unset,
      // each scenario picks its own adapter per R9.1.
      const adapterOverride =
        typeof cliOpts.adapter === "string" && (cliOpts.adapter as string).length > 0
          ? path.resolve(cliOpts.adapter as string)
          : undefined;

      // Human formatter is only wired in human mode. JSON mode stays
      // silent on stdout during the run loop and emits a single JSON
      // blob at the end so consumers can parse without stripping.
      const formatter = formatJson
        ? { handle: () => {} }
        : createJestFormatter({
            stdout: process.stdout,
            stderr: process.stderr,
            cwd
          });

      if (!formatJson) {
        process.stderr.write(
          `riptide run: ${resolved.scenarios.length} scenario${resolved.scenarios.length === 1 ? "" : "s"}\n`
        );
      }

      const summary = await runScenarios({
        scenarios: resolved.scenarios,
        cwd,
        adapterOverride,
        monorepoRoot: monorepoRootFromModule() ?? null,
        silent: !verbose,
        outputDir,
        statePackOverride,
        harnessPath,
        selectedPattern: positional,
        selectedSourcePath: resolved.sourcePath,
        allowInvariantViolations,
        sweep: {
          seeds,
          full: Boolean(cliOpts.full),
          seedRoot
        },
        onEvent: formatter.handle
      });

      if (formatJson) {
        emitJsonOutput(summary, resolved.scenarios.length === 1);
      }

      if (cliOpts.serve) {
        const handle = await startDashboardServer(summary.runCollectionPath);
        process.stderr.write(chalk.cyan(`Dashboard: ${handle.url}\n`));
        process.stderr.write(chalk.gray(`Run collection: ${summary.runCollectionPath}\n`));
        process.stderr.write(chalk.gray(`  (Ctrl-C to stop)\n`));
        await blockUntilSignal(handle);
      }

      const code = exitCodeFromSummary(summary);
      // `--allow-invariant-violations` restores exit 0 when the ONLY
      // reason for non-zero is invariant fires. Setup errors, SIGINT,
      // and internal partial-aborts still surface their codes — this
      // flag's contract is narrow per engine parity.
      if (
        allowInvariantViolations &&
        code === EXIT_CODES.INVARIANT_FIRE &&
        failedScenariosAreInvariantOnly(summary)
      ) {
        process.exit(EXIT_CODES.SUCCESS);
      }
      process.exit(code);
    });
}

function failedScenariosAreInvariantOnly(summary: import("../run/loop.js").RunSummary): boolean {
  return summary.scenarios
    .filter((scenario) => scenario.status === "fail")
    .every((scenario) => scenario.invariant_fires.length > 0);
}

/**
 * Emit a machine-readable JSON blob on stdout for `--format json`.
 *
 * - Single-scenario mode writes the full SimulationResult read from
 *   the scenario's artifacts dir. This preserves the pre-Sprint-8
 *   single-file CLI shape CI scripts may consume.
 * - Multi-scenario mode writes the RunSummary (the same shape that
 *   landed in `.riptide/last-run.json` plus totals).
 */
function emitJsonOutput(summary: import("../run/loop.js").RunSummary, singleScenario: boolean): void {
  if (singleScenario) {
    const record = summary.scenarios[0];
    const artifactsDir = record?.artifacts_dir;
    if (record && artifactsDir) {
      const resultPath = path.join(artifactsDir, "simulation-result.json");
      try {
        const raw = readFileSync(resultPath, "utf8");
        process.stdout.write(raw.endsWith("\n") ? raw : raw + "\n");
        return;
      } catch {
        // fall through to summary-shape emission
      }
    }
  }
  process.stdout.write(
    JSON.stringify(
      {
        ...runSummaryJson(summary)
      },
      null,
      2
    ) + "\n"
  );
}

export function runSummaryJson(summary: import("../run/loop.js").RunSummary): Record<string, unknown> {
  return {
    pass: summary.pass,
    fail: summary.fail,
    error: summary.error,
    skipped: summary.skipped,
    total: summary.total,
    signal_aborted: summary.signalAborted,
    partial_abort: summary.partialAbort,
    last_run_path: summary.lastRunPath,
    run_collection_path: summary.runCollectionPath,
    scenarios: summary.scenarios
  };
}

interface RunCellReplayInput {
  cwd: string;
  cellDir: string;
  adapterOverride?: string;
  monorepoRoot?: string | null;
  silent?: boolean;
  allowInvariantViolations?: boolean;
}

export interface RunCellReplayResult {
  cellDir: string;
  simulationResultPath: string;
  hash: string;
  exitCode: number;
  invariantFires: string[];
}

export async function replayRunCell(input: RunCellReplayInput): Promise<RunCellReplayResult> {
  const runConfigPath = path.join(input.cellDir, "run-config.json");
  let scenarioName = path.basename(input.cellDir);
  try {
    const raw = JSON.parse(readFileSync(runConfigPath, "utf8")) as { scenario?: unknown };
    if (typeof raw.scenario === "string" && raw.scenario.length > 0) {
      scenarioName = raw.scenario;
    }
  } catch (err) {
    throw new Error(
      `riptide run --replay: could not read cell run-config at ${runConfigPath}: ${(err as Error).message}`
    );
  }

  const adapterResolution = resolveAdapterForScenario(
    { name: scenarioName, runConfigPath },
    {
      cwd: input.cwd,
      monorepoRoot: input.monorepoRoot ?? null,
      globalOverride: input.adapterOverride
    }
  );
  if (adapterResolution.kind === "error") {
    throw new Error(adapterResolution.message);
  }

  const build = buildScenarioRun({
    scenarioName,
    runConfigPath,
    cwd: input.cwd,
    adapterPath: adapterResolution.path,
    outputPathOverride: input.cellDir
  });

  const result = await runOrchestrator(build.runConfig, {
    llmUrl: build.simulateOptions.llm_url,
    adapterPath: build.simulateOptions.adapter_path,
    allowInvariantViolations: true,
    silent: input.silent
  });
  const artifactPath = await writeArtifacts(result, input.cellDir, {
    narrativeConfig: {
      adapterPath: build.simulateOptions.adapter_path ?? "",
      reproCommand: `riptide run --replay ${path.relative(input.cwd, input.cellDir) || input.cellDir}`
    }
  });
  const rawResult = readFileSync(artifactPath, "utf8");
  const invariantFires = extractInvariantFires(result).map((fire) => fire.name);
  const hasFire = invariantFires.length > 0;
  return {
    cellDir: input.cellDir,
    simulationResultPath: artifactPath,
    hash: canonicalSimulationResultHash(rawResult),
    exitCode:
      hasFire && input.allowInvariantViolations !== true
        ? EXIT_CODES.INVARIANT_FIRE
        : EXIT_CODES.SUCCESS,
    invariantFires
  };
}

function parsePositiveIntegerFlag(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function parseNonnegativeIntegerFlag(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a nonnegative integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}
