import chalk from "chalk";
import { Command } from "commander";

export function createSimulateCommand(): Command {
  return new Command("simulate")
    .description("Compile personas and run a Riptide simulation")
    .option("--config <file>", "Path to a run configuration file")
    .option("--policies <file>", "Path to a precompiled policy file")
    .option("--output <file>", "Where to write simulation results")
    .action((options) => {
      const target = options.output ?? "(not provided)";
      console.log(chalk.yellow(`simulate stub: output ${target}`));
    });
}
