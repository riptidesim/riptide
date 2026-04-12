import chalk from "chalk";
import { Command } from "commander";

const SCENARIOS = [
  { id: "baseline", summary: "Stable price path with light seeded noise" },
  { id: "price-shock", summary: "Stable path with a configured sharp drop" },
];

export function createScenariosCommand(): Command {
  return new Command("scenarios")
    .description("List the built-in scenario presets")
    .action(() => {
      for (const scenario of SCENARIOS) {
        console.log(chalk.cyan(`${scenario.id}`), "-", scenario.summary);
      }
    });
}
