#!/usr/bin/env node

import { Command } from "commander";

import { createAdaptCommand } from "./commands/adapt.js";
import { createReplayCommand } from "./commands/replay.js";
import { createRunCommand } from "./commands/run.js";
import { createScenariosCommand } from "./commands/scenarios.js";
import { createSimulateCommand } from "./commands/simulate.js";

const program = new Command();

program
  .name("riptide")
  .description("Riptide CLI")
  .version("0.1.0");

program.addCommand(createSimulateCommand());
program.addCommand(createRunCommand());
program.addCommand(createReplayCommand());
program.addCommand(createScenariosCommand());
program.addCommand(createAdaptCommand());

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
