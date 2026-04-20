// `riptide run` — jest-style multi-scenario runner.
//
// Behavior matrix (Sprint 8 spec R3.1–R3.6):
//   $ riptide run                → discover all, run all
//   $ riptide run <pattern>      → discover all, filter by glob
//   $ riptide run <path.json>    → run a single run-config file (backward-compat)
//   $ riptide run --only-failing → rerun only scenarios that failed last time
//   $ riptide run --serve        → after the sweep, serve artifacts of the last scenario
//
// Disambiguation rule: if the positional arg ends in `.json` AND
// exists on disk, it is treated as a file path. Otherwise it is a
// glob pattern. Documented in the spec + resolveScenarios() docs.
//
// Exit codes per `cli/src/run/exit-codes.ts`:
//   0 all-pass · 1 invariant-fire · 2 setup-error · 3 partial-abort · 130 SIGINT

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import chalk from "chalk";
import { Command } from "commander";

import { monorepoRootFromModule } from "../orchestrator/index.js";
import { resolveScenarios, runScenarios } from "../run/loop.js";
import { createJestFormatter } from "../run/output.js";
import { EXIT_CODES, exitCodeFromSummary } from "../run/exit-codes.js";
import { blockUntilSignal, startDashboardServer } from "../serve/index.js";

const DEFAULT_FIXTURES_ADAPTER_REL = path.join("fixtures", "adapters", "solend-fork.toml");

export type AdapterResolution =
  | { kind: "ok"; path: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "none" };

/**
 * Default-adapter resolution order:
 *   1. `--adapter <path>` (handled by the caller, not here)
 *   2. single `.toml` under `<cwd>/.riptide/adapters/` — the scaffolded
 *      adapter from `riptide init`. More than one → ambiguous result
 *      so the caller can ask for `--adapter` explicitly.
 *   3. Monorepo fallback, derived from the CLI module's on-disk
 *      location (NOT from cwd). This keeps `cd cli && riptide run ...`,
 *      `cd subdir && riptide run ...`, and repo-root invocations all
 *      resolving to the same shipping fixture. Cwd-based resolution
 *      was the Phase 2 review's Finding 1 — module-root fixes that.
 *   4. Cwd-local `fixtures/adapters/solend-fork.toml` — legacy catch
 *      for users with a custom fixtures layout rooted at cwd.
 *
 * `moduleRoot` override makes the module-root branch testable.
 * Pass `null` to skip it explicitly; default queries
 * `monorepoRootFromModule()`.
 */
export function resolveDefaultAdapter(
  cwd: string,
  moduleRoot?: string | null
): AdapterResolution {
  const scaffoldedDir = path.join(cwd, ".riptide", "adapters");
  if (existsSync(scaffoldedDir)) {
    const tomls = readdirSync(scaffoldedDir)
      .filter((e) => e.endsWith(".toml"))
      .sort();
    if (tomls.length === 1) {
      return { kind: "ok", path: path.join(scaffoldedDir, tomls[0]!) };
    }
    if (tomls.length > 1) {
      return {
        kind: "ambiguous",
        candidates: tomls.map((t) => path.join(scaffoldedDir, t))
      };
    }
  }

  const resolvedModuleRoot =
    moduleRoot === undefined ? monorepoRootFromModule() ?? null : moduleRoot;
  if (resolvedModuleRoot) {
    const candidate = path.join(resolvedModuleRoot, DEFAULT_FIXTURES_ADAPTER_REL);
    if (existsSync(candidate)) {
      return { kind: "ok", path: candidate };
    }
  }

  const cwdCandidate = path.resolve(cwd, DEFAULT_FIXTURES_ADAPTER_REL);
  if (existsSync(cwdCandidate)) {
    return { kind: "ok", path: cwdCandidate };
  }
  return { kind: "none" };
}

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
      "Adapter TOML path. Defaults: single .toml under .riptide/adapters/ (scaffolded by 'riptide init'), else fixtures/adapters/solend-fork.toml for in-monorepo runs."
    )
    .option(
      "--only-failing",
      "Run only scenarios that failed or aborted in the most recent run (reads .riptide/last-run.json)",
      false
    )
    .option(
      "--serve",
      "After the sweep, start the Riptide web dashboard (default port 4173) serving the last scenario's artifacts. Blocks on Ctrl-C.",
      false
    )
    .option(
      "--format <format>",
      "Output format: human (default, jest-style) or json (RunSummary for multi-scenario, SimulationResult for single-scenario)",
      "human"
    )
    .option(
      "--allow-invariant-violations",
      "Exit 0 even if declared invariants fire during any scenario (default: exit 1 on any firing). Mirrors engine flag; setup errors + SIGINT + engine crashes still return non-zero.",
      false
    )
    .action(async (positional: string | undefined, cliOpts: Record<string, unknown>) => {
      const cwd = process.cwd();
      const formatJson = cliOpts.format === "json";
      const allowInvariantViolations = Boolean(cliOpts.allowInvariantViolations);

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

      // Adapter resolution: explicit flag > scaffolded .riptide/
      // adapters/<one>.toml > monorepo fixture > error. Emit a
      // setup_error if we can't resolve anything so the user gets a
      // clear next step instead of an engine-layer ENOENT.
      let adapterPath: string | undefined;
      if (typeof cliOpts.adapter === "string" && (cliOpts.adapter as string).length > 0) {
        adapterPath = path.resolve(cliOpts.adapter as string);
      } else {
        const def = resolveDefaultAdapter(cwd);
        if (def.kind === "ok") {
          adapterPath = def.path;
        } else if (def.kind === "ambiguous") {
          const msg =
            `riptide run: multiple adapters found under .riptide/adapters/; pass --adapter to disambiguate.\n` +
            `Candidates:\n  ${def.candidates.join("\n  ")}`;
          if (formatJson) {
            process.stdout.write(JSON.stringify({ error: msg }) + "\n");
          } else {
            process.stderr.write(chalk.red(`${msg}\n`));
          }
          process.exit(EXIT_CODES.SETUP_ERROR);
        } else {
          const msg =
            `riptide run: no adapter found. Expected one of:\n` +
            `  - explicit --adapter <path>\n` +
            `  - a single .toml under .riptide/adapters/ (run 'riptide init' to scaffold)\n` +
            `  - fixtures/adapters/solend-fork.toml (for in-monorepo runs)`;
          if (formatJson) {
            process.stdout.write(JSON.stringify({ error: msg }) + "\n");
          } else {
            process.stderr.write(chalk.red(`${msg}\n`));
          }
          process.exit(EXIT_CODES.SETUP_ERROR);
        }
      }

      // Human formatter is only wired in human mode. JSON mode stays
      // silent on stdout during the run loop and emits a single JSON
      // blob at the end so consumers can parse without stripping.
      const formatter = formatJson
        ? { handle: () => {} }
        : createJestFormatter({ stdout: process.stdout, stderr: process.stderr });

      if (!formatJson) {
        process.stderr.write(
          chalk.bold(
            `riptide run: ${resolved.scenarios.length} scenario${resolved.scenarios.length === 1 ? "" : "s"}\n`
          )
        );
      }

      const summary = await runScenarios({
        scenarios: resolved.scenarios,
        cwd,
        adapterPath,
        onEvent: formatter.handle
      });

      if (formatJson) {
        emitJsonOutput(summary, resolved.scenarios.length === 1);
      }

      // `--serve` MVP (R3.4): show the LAST scenario's artifacts only
      // with a note about multi-scenario aggregation being Sprint 9+.
      // Only starts a server if we actually produced artifacts (i.e.
      // at least one pass or fail — aborted runs leave no dir).
      if (cliOpts.serve && summary.lastArtifactsDir) {
        if (summary.total > 1) {
          process.stderr.write(
            chalk.gray(
              `note: --serve is showing the last scenario (${summary.scenarios.at(-1)?.name ?? "?"}). ` +
                `Multi-scenario aggregation is Sprint 9+.\n`
            )
          );
        }
        const handle = await startDashboardServer(summary.lastArtifactsDir);
        process.stderr.write(chalk.cyan(`Dashboard: ${handle.url}\n`));
        process.stderr.write(chalk.gray(`  (Ctrl-C to stop)\n`));
        await blockUntilSignal(handle);
      }

      const code = exitCodeFromSummary(summary);
      // `--allow-invariant-violations` restores exit 0 when the ONLY
      // reason for non-zero is invariant fires. Setup errors, SIGINT,
      // and internal partial-aborts still surface their codes — this
      // flag's contract is narrow per engine parity.
      if (allowInvariantViolations && code === EXIT_CODES.INVARIANT_FIRE) {
        process.exit(EXIT_CODES.SUCCESS);
      }
      process.exit(code);
    });
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
        pass: summary.pass,
        fail: summary.fail,
        aborted: summary.aborted,
        skipped: summary.skipped,
        total: summary.total,
        signal_aborted: summary.signalAborted,
        partial_abort: summary.partialAbort,
        last_run_path: summary.lastRunPath,
        scenarios: summary.scenarios
      },
      null,
      2
    ) + "\n"
  );
}
