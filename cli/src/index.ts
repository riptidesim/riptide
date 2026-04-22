#!/usr/bin/env node

import { Command } from "commander";

import { createAdaptCommand } from "./commands/adapt.js";
import { createInitCommand } from "./commands/init.js";
import { createLineageCommand } from "./commands/lineage.js";
import { createLintCommand } from "./commands/lint.js";
import { createListCommand } from "./commands/list.js";
import { createReplayCommand } from "./commands/replay.js";
import { createRunCommand } from "./commands/run.js";
import { createScenariosCommand } from "./commands/scenarios.js";
import { createSimulateCommand } from "./commands/simulate.js";
import { renderCliError } from "./errors/render.js";

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
program.addCommand(createInitCommand());
program.addCommand(createLineageCommand());
program.addCommand(createLintCommand());
program.addCommand(createListCommand());

program.parseAsync(process.argv).catch((error: unknown) => {
  // Default: message-first, action-oriented stderr line. The throwing
  // sites already structure their messages with file + field + expected
  // + actual + next-step hints; the renderer just keeps stack-trace
  // dumps off the default surface. RIPTIDE_DEBUG=1 restores the stack.
  process.stderr.write(
    renderCliError(error, {
      env: process.env,
      isTTY: Boolean(process.stderr.isTTY),
    })
  );
  process.exitCode = 1;
});
