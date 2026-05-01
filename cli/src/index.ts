#!/usr/bin/env node

import { Command } from "commander";

import { createAdaptCommand } from "./commands/adapt.js";
import { createDoctorCommand } from "./commands/doctor.js";
import { createExplainCommand } from "./commands/explain.js";
import { createHarnessCommand } from "./commands/harness.js";
import { createInitCommand } from "./commands/init.js";
import { createLineageCommand } from "./commands/lineage.js";
import { createLintCommand } from "./commands/lint.js";
import { createListCommand } from "./commands/list.js";
import { createPackStateCommand } from "./commands/pack-state.js";
import { createReviewCommand } from "./commands/review.js";
import { createReplayCommand } from "./commands/replay.js";
import { createRunCommand } from "./commands/run.js";
import { createScenariosCommand } from "./commands/scenarios.js";
import { createTemplateCommand } from "./commands/template.js";
import { cliPackageVersion } from "./banner.js";
import { renderCliError } from "./errors/render.js";

const program = new Command();

program
  .name("riptide")
  .description(
    "Riptide CLI — wire a Solana program (adapter), define actors (personas), declare a scenario or replay, run deterministically against LiteSVM, inspect evidence."
  )
  .version(cliPackageVersion());

program.addCommand(createRunCommand());
program.addCommand(createReplayCommand());
program.addCommand(createPackStateCommand());
program.addCommand(createTemplateCommand());
program.addCommand(createHarnessCommand());
program.addCommand(createReviewCommand());
program.addCommand(createScenariosCommand());
program.addCommand(createAdaptCommand());
program.addCommand(createInitCommand());
program.addCommand(createExplainCommand());
program.addCommand(createLineageCommand());
program.addCommand(createLintCommand());
program.addCommand(createDoctorCommand());
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
