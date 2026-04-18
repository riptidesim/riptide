import { readFileSync } from "node:fs";
import path from "node:path";

import chalk from "chalk";
import ora from "ora";
import { Command } from "commander";

import { buildSimulateOptions, toRunConfig } from "../config.js";
import { runOrchestrator } from "../orchestrator/index.js";
import { writeArtifacts } from "../report/artifacts.js";
import { renderSummary, renderColoredTable } from "../report/summary.js";
import { renderTimeline } from "../report/timeline.js";
import { blockUntilSignal, startDashboardServer } from "../serve/index.js";

/**
 * `riptide run <config.json>` — thin wrapper that reads a JSON run
 * config (the same shape as `demo/configs/safe.json`), optionally
 * applies an `--adapter` override (default: the shipped solend-fork
 * lending adapter), and dispatches through the existing simulate
 * pipeline. Satisfies the Sprint 5 R1.4 install-flow contract which
 * specifies the literal command `riptide run demo/configs/safe.json`.
 */
export function createRunCommand(): Command {
  return new Command("run")
    .description("Run a simulation from a JSON run-config file")
    .argument("<config>", "Path to a run-config JSON file (e.g. demo/configs/safe.json)")
    .option(
      "--adapter <path>",
      "Adapter TOML path (defaults to fixtures/adapters/solend-fork.toml if omitted)"
    )
    .option("--format <format>", "Output format: human (default) or json", "human")
    .option(
      "--allow-invariant-violations",
      "Exit 0 even if declared invariants fire during the run (default: exit 1 on any firing)",
      false
    )
    .option(
      "--serve",
      "After the run completes, start the Riptide web dashboard (default port 4173) serving the artifacts. Blocks on Ctrl-C.",
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
            ? `not found`
            : `unreadable (${(err as Error).message ?? String(err)})`;
        throw new Error(
          `riptide run: run-config ${reason} at ${absConfig}\n` +
            `Expected a JSON file with the fields { agents, ticks, scenario, seed, personas }.\n` +
            `Try one of the shipped examples: demo/configs/safe.json or demo/configs/stressed.json.`
        );
      }
      let parsed: {
        agents?: number;
        ticks?: number;
        scenario?: string;
        seed?: number;
        personas?: string[];
        output_path?: string;
      };
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        throw new Error(
          `riptide run: failed to parse JSON at ${absConfig}: ${(err as Error).message}\n` +
            `Check the run-config for a trailing comma or missing quote.`
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
          `riptide run: run-config at ${absConfig} is missing one of the required fields ` +
            `{ agents, ticks, scenario, seed, personas }.\n` +
            `Reference shape: demo/configs/safe.json.`
        );
      }
      const repoRoot = path.resolve(process.cwd());
      const defaultAdapter = path.resolve(repoRoot, "fixtures/adapters/solend-fork.toml");
      const adapter =
        typeof cliOpts.adapter === "string" && (cliOpts.adapter as string).length > 0
          ? cliOpts.adapter as string
          : defaultAdapter;
      const outputPath =
        typeof parsed.output_path === "string" && parsed.output_path.length > 0
          ? parsed.output_path
          : path.join("demo/outputs", path.basename(absConfig, path.extname(absConfig)));

      const { config } = buildSimulateOptions({
        agents: parsed.agents,
        ticks: parsed.ticks,
        scenario: parsed.scenario,
        seed: parsed.seed,
        personas: parsed.personas.join(","),
        adapter,
        output: outputPath
      });
      const runConfig = toRunConfig(config);

      if (!formatJson) {
        process.stderr.write(
          chalk.bold(
            `riptide run: agents=${runConfig.agents} ticks=${runConfig.ticks} scenario=${runConfig.scenario} seed=${runConfig.seed} personas=[${runConfig.personas.join(",")}]\n`
          )
        );
      }

      const spinner = isTTY ? ora({ text: "Running simulation...", stream: process.stderr }).start() : null;
      const startTime = Date.now();

      let result;
      try {
        result = await runOrchestrator(runConfig, {
          llmUrl: config.llm_url,
          adapterPath: config.adapter_path,
          allowInvariantViolations: Boolean(cliOpts.allowInvariantViolations)
        });
      } catch (err) {
        if (spinner) spinner.fail(chalk.red("Simulation failed"));
        if (formatJson) {
          process.stdout.write(JSON.stringify({ error: (err as Error).message }, null, 2));
        } else {
          process.stderr.write(chalk.red(`\n✗ Run failed: ${(err as Error).message}\n`));
        }
        process.exitCode = 1;
        return;
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (spinner) {
        spinner.succeed(chalk.green(`Simulation complete (${elapsed}s, ${result.total_ticks} ticks)`));
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

      const reproCommand = `riptide run ${configArg}${config.adapter_path ? ` --adapter ${config.adapter_path}` : ""}`;

      const artifactPath = await writeArtifacts(result, runConfig.output_path, {
        narrativeConfig: {
          adapterPath: config.adapter_path ?? defaultAdapter,
          reproCommand
        }
      });

      if (!formatJson) {
        process.stderr.write(chalk.green(`Wrote artifact: ${artifactPath}\n`));
        const reportNote = path.join(path.dirname(artifactPath), "report.md");
        process.stderr.write(chalk.green(`Wrote report:   ${reportNote}\n`));
      }

      if (cliOpts.serve) {
        const handle = await startDashboardServer(path.dirname(artifactPath));
        process.stderr.write(chalk.cyan(`Dashboard: ${handle.url}\n`));
        process.stderr.write(chalk.gray(`  (Ctrl-C to stop)\n`));
        await blockUntilSignal(handle);
      }
    });
}
