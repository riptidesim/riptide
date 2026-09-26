#!/usr/bin/env node

import { Command } from "commander";

import { createAssessCommand } from "./commands/assess.js";
import { createDeltaCommand } from "./commands/delta.js";
import { createInitCommand } from "./commands/init.js";
import { createReadinessCommand } from "./commands/readiness.js";
import { createReviewCommand } from "./commands/review.js";
import { createSimCommand } from "./commands/sim.js";
import { createValidateCommand } from "./commands/validate.js";
import { cliPackageVersion } from "./version.js";
import { renderCliError } from "./errors/render.js";

const program = new Command();

program
  .name("riptide")
  .description(
    "The Riptide Engine: deterministic guided simulation of a Solana program's compiled binary. " +
      "An agent API driven by the /riptide-assess Skill."
  )
  .version(cliPackageVersion())
  .addHelpCommand(false);

addRootCommand(createInitCommand(), "Scaffold .riptide/ in the current repo");
addRootCommand(createReadinessCommand(), "Inspect protocol evidence readiness and toolchain health");
addRootCommand(createSimCommand(), "Generate, refresh, and run guided Rust simulations");
addRootCommand(createReviewCommand(), "Review a campaign root, retained case, or guided-sim artifact");
addRootCommand(createAssessCommand(), "Generate a protocol assessment from a guided-sim root");
addRootCommand(createDeltaCommand(), "Compare an Assessment with the previous one over the same region");
addRootCommand(createValidateCommand(), "Check an Assessment's Engine Output, Assessment Context and composed report");

program.addHelpText(
  "after",
  [
    "",
    "Pass --json to every command: it writes one riptide-command.v1 envelope to stdout.",
    "On failure, error.code names the problem and error.next the repair. No command reads stdin.",
    ""
  ].join("\n")
);

function addRootCommand(command: Command, summary: string): void {
  program.addCommand(command.summary(summary));
}

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
