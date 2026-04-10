import chalk from "chalk";
import { Command } from "commander";

import { buildSimulateOptions, registerRunConfigOptions } from "../config.js";

export function createSimulateCommand(): Command {
  const command = new Command("simulate").description("Compile personas and run a Riptide simulation");

  registerRunConfigOptions(command);

  return command.action((options) => {
      // TODO: Replace the stub with compiler -> engine -> report orchestration.
      // `output_path` is already validated here so the eventual pipeline can honor it.
      const { config, generatedSeed } = buildSimulateOptions(options as Record<string, unknown>);
      if (generatedSeed) {
        console.log(chalk.yellow(`Generated seed: ${config.seed}`));
      }
      console.log(chalk.yellow(`simulate stub: output ${config.output_path}`));
    });
}
