// `riptide init` — minimally bootstrap a `.riptide/` directory.
//
// Plain init is intentionally thin: no compile, smoke test, LLM,
// questionnaire, personas, scenarios, invariants, seed counts, agent
// counts, or tick counts. It writes the adapter placeholder,
// GETTING-STARTED.md, and run-state .gitignore entries. The old rich
// questionnaire path remains available only behind --wizard.

import chalk from "chalk";
import { Command } from "commander";
import path from "node:path";

import {
  type ProgramDetection,
  ProgramDetectionError,
  RiptideDirExistsError,
  inferProgramName,
  preflightScaffold,
  scaffold
} from "../init/index.js";
import { runWizard, type WizardAnswers, type WizardDefaults } from "../init/wizard.js";
import { PROTOCOL_CHOICES, type Protocol } from "../init/personas-catalog.js";
import { printInitBanner } from "../banner.js";

const SECONDARY_TEXT = "#A8A8A8";
const dim = (value: string) => chalk.hex(SECONDARY_TEXT)(value);

export interface InitOptions {
  force: boolean;
  dir: string;
  quiet?: boolean;
  blank?: boolean;
  name?: string;
  protocol?: Protocol;
  profile?: Protocol;
  yes?: boolean;
  wizard?: boolean;
  /** Set by --no-skills; commander stores --no-X as `skills: false`. */
  skills?: boolean;
}

// Injection seam for tests: real wizard talks to a TTY, so callers can
// supply a fake that returns canned answers without spawning prompts.
export interface InitDeps {
  promptWizard?: (defaults: WizardDefaults) => Promise<WizardAnswers>;
  isTTY?: boolean;
}

export function createInitCommand(deps: InitDeps = {}): Command {
  const command = new Command("init").description(
    "Bootstrap a thin .riptide/ workspace; use /riptide-config to finish simulations"
  );

  command
    .option("--force", "Overwrite an existing .riptide/ directory without prompting", false)
    .option("--dir <path>", "Directory to scaffold under (defaults to cwd)", process.cwd())
    .option("--blank", "Allow scaffolding even when no Solana program is detected", false)
    .option("--name <program-name>", "Program name to use for a blank/manual scaffold")
    .option(
      "--protocol <protocol>",
      "Adapter protocol to scaffold (amm, lending, perpetuals, liquid-staking, stablecoin, custom)"
    )
    .option(
      "--profile <profile>",
      "Alias for --protocol; records a protocol hint in the adapter placeholder"
    )
    .option("--wizard", "Run the advanced interactive questionnaire scaffold", false)
    .option("--yes", "Non-interactive minimal init (kept for scripts)", false)
    .option("--quiet", "Suppress interactive banner and use non-interactive minimal init", false)
    .option(
      "--no-skills",
      "Skip installing bundled Claude Code skills under .claude/skills/"
    );

  return command.action(async (options: InitOptions) => {
    printInitBanner({ flags: { quiet: Boolean(options.quiet) } });
    const exitCode = await runInit(options, deps);
    process.exit(exitCode);
  });
}

export async function runInit(options: InitOptions, deps: InitDeps = {}): Promise<number> {
  const cwd = path.resolve(options.dir);

  try {
    const optionProtocol = normalizeProfileOptions(options.protocol, options.profile);
    const detected = preflightScaffold({
      cwd,
      force: options.force,
      blank: Boolean(options.blank)
    });
    const wizardAnswers = await maybeRunWizard(cwd, options, deps, detected, optionProtocol);
    const protocol = wizardAnswers?.protocol ?? optionProtocol ?? "custom";
    const useWizardScaffold = wizardAnswers !== undefined;
    const result = await scaffold({
      cwd,
      force: options.force,
      blank: Boolean(options.blank),
      programName: wizardAnswers?.programName ?? options.name,
      protocol,
      mode: useWizardScaffold ? "wizard" : "minimal",
      personas: wizardAnswers?.personas,
      agents: wizardAnswers?.agents,
      ticks: wizardAnswers?.ticks,
      scenarios: wizardAnswers?.scenarios,
      invariants: wizardAnswers?.invariants,
      seeds: wizardAnswers?.seeds,
      installSkills: options.skills !== false
    });

    process.stderr.write(
      chalk.bold(`riptide init: scaffolded .riptide/ for ${chalk.cyan(result.programName)}\n`)
    );
    for (const rel of result.created) {
      process.stderr.write(dim(`  created ${rel}\n`));
    }
    for (const warning of result.warnings) {
      process.stderr.write(chalk.yellow(`  warning: ${warning}\n`));
    }
    const adapterRel = `.riptide/adapters/${result.programName}.toml`;
    process.stderr.write("\nNext steps:\n\n");
    process.stderr.write(`  1. Invoke ${chalk.cyan("/riptide-config")} in your coding agent.\n`);
    process.stderr.write("     It finishes the adapter and authors the guided simulation.\n\n");
    process.stderr.write("  2. Generate and run the guided sim:\n");
    process.stderr.write(`     ${chalk.cyan(`riptide sim generate --adapter ${adapterRel}`)}\n`);
    process.stderr.write(`     ${chalk.cyan("riptide sim run .riptide/sim --flows 8")}\n`);
    process.stderr.write(`     ${chalk.cyan("riptide sim surface .riptide/sim/artifacts/<dir> --sim .riptide/sim")}\n\n`);
    process.stderr.write(`  3. Get the assessment:\n     ${chalk.cyan("riptide assess <guided-sim-root>")}\n\n`);
    if (!useWizardScaffold) {
      process.stderr.write(
        dim(
          `Advanced: run ${chalk.cyan("riptide init --wizard --force")} only if you want to replace this thin scaffold with questionnaire-selected starter files. Otherwise follow .riptide/GETTING-STARTED.md.\n\n`
        )
      );
    }
    process.stderr.write(
      dim(`More detail: ${chalk.cyan(".riptide/GETTING-STARTED.md")}\n`)
    );
    return 0;
  } catch (err) {
    if (err instanceof RiptideDirExistsError) {
      process.stderr.write(chalk.red(`riptide init: ${err.message}\n`));
      return 2;
    }
    if (err instanceof ProgramDetectionError) {
      process.stderr.write(chalk.red(`riptide init: ${err.message}\n`));
      return 2;
    }
    process.stderr.write(
      chalk.red(`riptide init: scaffold failed: ${errMessage(err)}\n`)
    );
    return 1;
  }
}

async function maybeRunWizard(
  cwd: string,
  options: InitOptions,
  deps: InitDeps,
  detected?: ProgramDetection,
  optionProtocol?: Protocol
): Promise<WizardAnswers | undefined> {
  if (!options.wizard || options.yes || options.quiet) {
    return undefined;
  }
  const isInteractive = deps.isTTY ?? Boolean(process.stdout.isTTY);
  if (!isInteractive) {
    throw new ProgramDetectionError(
      "`riptide init --wizard` requires an interactive TTY. Run plain `riptide init` for the default minimal scaffold."
    );
  }

  // Default the program-name prompt to the preflight result when one was
  // required; blank/manual scaffolds can still fall back to --name or
  // "my-program" because the user opted out of program detection.
  const inferred =
    options.name ?? detected?.programName ?? inferProgramName(cwd) ?? "my-program";
  const defaults: WizardDefaults = {
    programName: inferred,
    protocol: optionProtocol ?? "custom",
    agents: 100,
    ticks: 30
  };
  const prompt = deps.promptWizard ?? runWizard;
  return prompt(defaults);
}

function normalizeProtocolOption(value: Protocol | undefined): Protocol | undefined {
  if (value === undefined) return undefined;
  const known = new Set(PROTOCOL_CHOICES.map((choice) => choice.value));
  if (known.has(value)) return value;
  throw new ProgramDetectionError(
    `invalid protocol ${JSON.stringify(value)}. Expected one of: ${[...known].join(", ")}.`
  );
}

function normalizeProfileOptions(
  protocol: Protocol | undefined,
  profile: Protocol | undefined
): Protocol | undefined {
  const normalizedProtocol = normalizeProtocolOption(protocol);
  const normalizedProfile = normalizeProtocolOption(profile);
  if (
    normalizedProtocol !== undefined &&
    normalizedProfile !== undefined &&
    normalizedProtocol !== normalizedProfile
  ) {
    throw new ProgramDetectionError(
      `conflicting init profile options: --protocol ${JSON.stringify(normalizedProtocol)} and --profile ${JSON.stringify(normalizedProfile)}. Pick one.`
    );
  }
  return normalizedProfile ?? normalizedProtocol;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
