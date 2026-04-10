import chalk from "chalk";
import { Command } from "commander";

import { buildSimulateOptions, registerRunConfigOptions, toRunConfig } from "../config.js";
import { runOrchestrator } from "../orchestrator/index.js";
import { writeArtifacts } from "../report/artifacts.js";
import { renderSummary } from "../report/summary.js";
import { renderTimeline } from "../report/timeline.js";

export function createSimulateCommand(): Command {
  const command = new Command("simulate").description("Compile personas and run a Riptide simulation");

  registerRunConfigOptions(command);

  return command.action(async (options) => {
    const { config, generatedSeed } = buildSimulateOptions(options as Record<string, unknown>);
    if (generatedSeed) {
      process.stderr.write(chalk.yellow(`Generated seed: ${config.seed}\n`));
    }
    const runConfig = toRunConfig(config);

    process.stderr.write(
      chalk.bold(
        `riptide simulate: agents=${runConfig.agents} ticks=${runConfig.ticks} scenario=${runConfig.scenario} seed=${runConfig.seed} personas=[${runConfig.personas.join(",")}]\n`
      )
    );

    const result = await runOrchestrator(runConfig, { llmUrl: config.llm_url });

    process.stdout.write(`${renderSummary(result)}\n\n`);
    process.stdout.write(`${renderTimeline(result)}\n`);

    const artifactPath = await writeArtifacts(result, runConfig.output_path);
    process.stderr.write(chalk.green(`Wrote artifact: ${artifactPath}\n`));
  });
}
