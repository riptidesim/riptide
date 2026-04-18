import { readFileSync } from "node:fs";
import path from "node:path";

import chalk from "chalk";
import ora from "ora";
import { Command } from "commander";

import { runReplayOrchestrator } from "../orchestrator/index.js";
import { writeArtifacts } from "../report/artifacts.js";
import { renderSummary, renderColoredTable } from "../report/summary.js";
import { renderTimeline } from "../report/timeline.js";

interface ReplayConfigFile {
  adapter?: string;
  trajectory_dir?: string;
  output_path?: string;
}

export function createReplayCommand(): Command {
  return new Command("replay")
    .description("Run a historical replay from a JSON config file")
    .argument("<config>", "Path to a replay-config JSON file")
    .option("--format <format>", "Output format: human (default) or json", "human")
    .option(
      "--allow-invariant-violations",
      "Exit 0 even if declared invariants fire during the replay (default: exit 1 on any firing)",
      false
    )
    .action(async (configArg: string, cliOpts: Record<string, unknown>) => {
      const formatJson = cliOpts.format === "json";
      const isTTY = process.stdout.isTTY && !formatJson;

      const absConfig = path.resolve(configArg);
      let raw: string;
      try {
        raw = readFileSync(absConfig, "utf8");
      } catch (err) {
        const reason =
          err && typeof err === "object" && "code" in err && err.code === "ENOENT"
            ? "not found"
            : `unreadable (${(err as Error).message ?? String(err)})`;
        throw new Error(
          `riptide replay: replay-config ${reason} at ${absConfig}\n` +
            `Expected a JSON file with { adapter, trajectory_dir, output_path? }.`
        );
      }

      let parsed: ReplayConfigFile;
      try {
        parsed = JSON.parse(raw) as ReplayConfigFile;
      } catch (err) {
        throw new Error(
          `riptide replay: failed to parse JSON at ${absConfig}: ${(err as Error).message}\n` +
            `Check the replay-config for a trailing comma or missing quote.`
        );
      }

      if (typeof parsed.adapter !== "string" || typeof parsed.trajectory_dir !== "string") {
        throw new Error(
          `riptide replay: replay-config at ${absConfig} is missing one of the required fields ` +
            `{ adapter, trajectory_dir }.`
        );
      }

      const configDir = path.dirname(absConfig);
      const adapterPath = path.resolve(configDir, parsed.adapter);
      const trajectoryDir = path.resolve(configDir, parsed.trajectory_dir);
      const outputPath =
        typeof parsed.output_path === "string" && parsed.output_path.length > 0
          ? path.resolve(configDir, parsed.output_path)
          : path.join(
              "riptide-output",
              "replays",
              path.basename(trajectoryDir)
            );

      if (!formatJson) {
        process.stderr.write(
          chalk.bold(
            `riptide replay: adapter=${adapterPath} trajectory=${trajectoryDir}\n`
          )
        );
      }

      const spinner = isTTY
        ? ora({ text: "Running replay...", stream: process.stderr }).start()
        : null;
      const startTime = Date.now();

      let result;
      let invariantFiring = false;
      try {
        result = await runReplayOrchestrator(
          {
            adapterPath,
            trajectoryDir,
            outputPath
          },
          {
            allowInvariantViolations: Boolean(cliOpts.allowInvariantViolations)
          }
        );
      } catch (err) {
        // Sprint 6 Phase 3 re-review fix: the orchestrator attaches
        // the parsed SimulationResult to the error when the engine
        // exits 1 due to an invariant firing (the canonical "replay
        // reproduces the cascade" case). Surface that result to the
        // user instead of discarding it — the default exit code
        // stays 1 so scripts/CI still notice the firing, but the
        // report, table, and artifact all get produced. `--allow-
        // invariant-violations` keeps the exit-0 shape from the
        // happy path.
        const e = err as Error & {
          simulationResult?: typeof result;
          exitCode?: number;
        };
        if (e.simulationResult) {
          invariantFiring = true;
          result = e.simulationResult;
          if (spinner) {
            spinner.warn(
              chalk.yellow(
                `Replay completed with ${e.exitCode ?? 1} invariant violation(s)`
              )
            );
          }
        } else {
          if (spinner) spinner.fail(chalk.red("Replay failed"));
          if (formatJson) {
            process.stdout.write(JSON.stringify({ error: e.message }, null, 2));
          } else {
            process.stderr.write(chalk.red(`\n✗ Replay failed: ${e.message}\n`));
          }
          process.exitCode = 1;
          return;
        }
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (spinner && !invariantFiring) {
        spinner.succeed(chalk.green(`Replay complete (${elapsed}s, ${result.total_ticks} ticks)`));
      }

      if (formatJson) {
        process.stdout.write(JSON.stringify(result, null, 2));
      } else {
        if (isTTY) {
          process.stdout.write(`\n${renderColoredTable(result)}\n\n`);
        } else {
          process.stdout.write(`${renderSummary(result)}\n\n`);
        }
        process.stdout.write(`${renderTimeline(result)}\n`);
      }

      const reproCommand = `riptide replay ${configArg}`;
      const artifactPath = await writeArtifacts(result, outputPath, {
        narrativeConfig: {
          adapterPath,
          reproCommand
        }
      });

      if (!formatJson) {
        process.stderr.write(chalk.green(`Wrote artifact: ${artifactPath}\n`));
        const reportNote = path.join(path.dirname(artifactPath), "report.md");
        process.stderr.write(chalk.green(`Wrote report:   ${reportNote}\n`));
        if (invariantFiring) {
          process.stderr.write(
            chalk.yellow(
              "Note: one or more declared invariants fired. Exit code 1. " +
                "Pass --allow-invariant-violations to restore exit 0.\n"
            )
          );
        }
      }

      if (invariantFiring) {
        process.exitCode = 1;
      }
    });
}
