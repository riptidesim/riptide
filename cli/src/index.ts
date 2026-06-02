#!/usr/bin/env node

import { Command } from "commander";

import { createAdaptCommand } from "./commands/adapt.js";
import { createAssessCommand } from "./commands/assess.js";
import { createCampaignCommand } from "./commands/campaign.js";
import { createDoctorCommand } from "./commands/doctor.js";
import { createExplainCommand } from "./commands/explain.js";
import { createHarnessCommand } from "./commands/harness.js";
import { createInitCommand } from "./commands/init.js";
import { createLineageCommand } from "./commands/lineage.js";
import { createLintCommand } from "./commands/lint.js";
import { createListCommand } from "./commands/list.js";
import { createPackStateCommand } from "./commands/pack-state.js";
import { createReadinessCommand } from "./commands/readiness.js";
import { createReviewCommand } from "./commands/review.js";
import { createReplayCommand } from "./commands/replay.js";
import { createRunCommand } from "./commands/run.js";
import { createScenariosCommand } from "./commands/scenarios.js";
import { createSimCommand } from "./commands/sim.js";
import { createStudioCommand } from "./commands/studio.js";
import { createTemplateCommand } from "./commands/template.js";
import { cliPackageVersion } from "./banner.js";
import { renderCliError } from "./errors/render.js";

const program = new Command();

program
  .name("riptide")
  .description(
    "Deterministic Solana simulations, campaigns, and reviewer-ready evidence."
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

addRootCommand(createInitCommand(), "Scaffold .riptide/ in the current repo", "Start here:");
addRootCommand(createReadinessCommand(), "Inspect local protocol evidence readiness", "Start here:");
addRootCommand(createCampaignCommand(), "Validate, plan, and run campaign sweeps", "Start here:");
addRootCommand(createRunCommand(), "Run scenarios or a single run-config", "Start here:");
addRootCommand(createReviewCommand(), "Review an evidence pack or campaign root", "Start here:");
addRootCommand(createAssessCommand(), "Generate a protocol assessment from a campaign root", "Start here:");
addRootCommand(createStudioCommand(), "Open Riptide Studio (local visual control plane)", "Start here:");
addRootCommand(createDoctorCommand(), "Check toolchain, engine, and adapters", "Start here:");

addRootCommand(createReplayCommand(), "Replay a declared trajectory", "Advanced/support:");
addRootCommand(createHarnessCommand(), "Generate Rust setup harnesses", "Advanced/support:");
addRootCommand(createSimCommand(), "Generate, refresh, and run guided Rust simulations", "Advanced/support:");
addRootCommand(createLintCommand(), "Lint an adapter against its lineage IDL", "Advanced/support:");
addRootCommand(createExplainCommand(), "Inspect a parsed adapter", "Advanced/support:");
addRootCommand(createLineageCommand(), "Show adapter lineage and assumptions", "Advanced/support:");
addRootCommand(createScenariosCommand(), "List or validate scenario presets", "Advanced/support:");
addRootCommand(createListCommand(), "List discovered local scenarios", "Advanced/support:");
addRootCommand(createAdaptCommand(), "Smoke-test an adapter against the engine", "Advanced/support:");
addRootCommand(createTemplateCommand(), "Create transaction-template actions", "Advanced/support:");
addRootCommand(createPackStateCommand(), "Capture current-state account packs", "Advanced/support:");

program.addHelpText(
  "after",
  [
    "",
    "Examples:",
    "  # First assessment: use the riptide-assess agent skill from your protocol repo",
    "  riptide init",
    "  riptide readiness .",
    "  riptide doctor",
    "  riptide list",
    "  riptide run --adapter .riptide/adapters/<program-name>.toml --seeds 1 --seed-root 1337",
    "  riptide campaign validate .riptide/campaigns/<risk>.campaign.toml",
    "  riptide campaign plan .riptide/campaigns/<risk>.campaign.toml",
    "  riptide campaign run .riptide/campaigns/<risk>.campaign.toml",
    "  riptide review <campaign-root>",
    "  riptide assess <campaign-root>",
    "  riptide studio --no-open",
    "",
    "Run `riptide <command> --help` for command-specific options.",
    ""
  ].join("\n")
);

function addRootCommand(command: Command, summary: string, group: string): void {
  program.addCommand(command.summary(summary).helpGroup(group));
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
