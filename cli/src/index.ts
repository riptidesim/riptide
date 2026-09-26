#!/usr/bin/env node

import { Command } from "commander";

import { createAssessCommand } from "./commands/assess.js";
import { createDoctorCommand } from "./commands/doctor.js";
import { createInitCommand } from "./commands/init.js";
import { createReadinessCommand } from "./commands/readiness.js";
import { createReviewCommand } from "./commands/review.js";
import { createSimCommand } from "./commands/sim.js";
import { cliPackageVersion } from "./version.js";
import { renderCliError } from "./errors/render.js";

const program = new Command();

program
  .name("riptide")
  .description(
    "Deterministic Solana guided simulations and reviewer-ready evidence."
  )
  .version(cliPackageVersion())
  .addHelpCommand(false);

program.addHelpText(
  "before",
  [
    "First assessment:",
    "  Open your Solana program repo in an agent and invoke `riptide-assess`.",
    "  The skill runs this CLI underneath and returns assessment.md, assessment.json, evidence, and rerun commands.",
    "  Reports are simulation evidence over declared inputs, not audit signoff.",
    ""
  ].join("\n")
);

addRootCommand(createInitCommand(), "Scaffold .riptide/ in the current repo");
addRootCommand(createReadinessCommand(), "Inspect local protocol evidence readiness");
addRootCommand(createSimCommand(), "Generate, refresh, and run guided Rust simulations");
addRootCommand(createReviewCommand(), "Review a guided-sim evidence root");
addRootCommand(createAssessCommand(), "Generate a protocol assessment from a guided-sim root");
addRootCommand(createDoctorCommand(), "Check the local toolchain");

program.addHelpText(
  "after",
  [
    "",
    "Examples:",
    "  # First assessment: use the riptide-assess agent skill from your protocol repo",
    "  riptide init",
    "  riptide readiness .",
    "  riptide doctor",
    "  riptide sim generate --adapter .riptide/adapters/<program-name>.toml",
    "  riptide sim run .riptide/sim --flows 8",
    "  riptide sim surface .riptide/sim/artifacts/<dir> --sim .riptide/sim",
    "  riptide review <guided-sim-root>",
    "  riptide assess <guided-sim-root>",
    "",
    "Run `riptide <command> --help` for command-specific options.",
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
