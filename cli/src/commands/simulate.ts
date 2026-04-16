import path from "node:path";

import chalk from "chalk";
import ora from "ora";
import { Command } from "commander";

import { buildSimulateOptions, registerRunConfigOptions, toRunConfig } from "../config.js";
import { runOrchestrator } from "../orchestrator/index.js";
import { writeArtifacts } from "../report/artifacts.js";
import { renderSummary, renderColoredTable } from "../report/summary.js";
import { renderTimeline } from "../report/timeline.js";

export function createSimulateCommand(): Command {
  const command = new Command("simulate").description("Compile personas and run a Riptide simulation");

  registerRunConfigOptions(command);
  command.option("--format <format>", "Output format: human (default) or json", "human");

  return command.action(async (options) => {
    const formatJson = (options as Record<string, unknown>).format === "json";
    const isTTY = process.stdout.isTTY && !formatJson;

    const { config, generatedSeed } = buildSimulateOptions(options as Record<string, unknown>);
    if (generatedSeed && !formatJson) {
      process.stderr.write(chalk.yellow(`Generated seed: ${config.seed}\n`));
    }
    const runConfig = toRunConfig(config);

    if (!formatJson) {
      process.stderr.write(
        chalk.bold(
          `riptide simulate: agents=${runConfig.agents} ticks=${runConfig.ticks} scenario=${runConfig.scenario} seed=${runConfig.seed} personas=[${runConfig.personas.join(",")}]\n`
        )
      );
    }

    const spinner = isTTY ? ora({ text: "Running simulation...", stream: process.stderr }).start() : null;
    const startTime = Date.now();

    let result;
    try {
      result = await runOrchestrator(runConfig, {
        llmUrl: config.llm_url,
        adapterPath: config.adapter_path
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

    const reproCommand = `riptide simulate --agents ${runConfig.agents} --ticks ${result.total_ticks} --scenario ${runConfig.scenario} --seed ${result.seed} --personas ${runConfig.personas.join(",")}${config.adapter_path ? ` --adapter ${config.adapter_path}` : ""}`;

    const artifactPath = await writeArtifacts(result, runConfig.output_path, {
      narrativeConfig: {
        adapterPath: config.adapter_path ?? "fixtures/adapters/solend-fork.toml",
        reproCommand
      }
    });

    if (!formatJson) {
      process.stderr.write(chalk.green(`Wrote artifact: ${artifactPath}\n`));
      const reportNote = path.join(path.dirname(artifactPath), "report.md");
      process.stderr.write(chalk.green(`Wrote report:   ${reportNote}\n`));
    }
  });
}
