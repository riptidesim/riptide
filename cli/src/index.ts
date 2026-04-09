#!/usr/bin/env node

import { Command } from "commander";

import { createScenariosCommand } from "./commands/scenarios.js";
import { createSimulateCommand } from "./commands/simulate.js";

const program = new Command();

program
  .name("riptide")
  .description("Riptide CLI")
  .version("0.1.0");

program.addCommand(createSimulateCommand());
program.addCommand(createScenariosCommand());

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
