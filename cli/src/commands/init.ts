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
  preflightScaffoldPrograms,
  scaffold,
  type ScaffoldedAdapter
} from "../init/index.js";
import { runWizard, type WizardAnswers, type WizardDefaults } from "../init/wizard.js";
import { PROTOCOL_CHOICES, type Protocol } from "../init/personas-catalog.js";
import { printInitBanner } from "../banner.js";
import { resolveCommandIO, type CommandIO } from "../contract/index.js";

const SECONDARY_TEXT = "#A8A8A8";
const dim = (value: string) => chalk.hex(SECONDARY_TEXT)(value);

export interface InitOptions {
  force: boolean;
  dir: string;
  quiet?: boolean;
  blank?: boolean;
  name?: string;
  /** Restrict a multi-program workspace to one program. */
  program?: string;
  protocol?: Protocol;
  profile?: Protocol;
  yes?: boolean;
  wizard?: boolean;
  /** Set by --no-skills; commander stores --no-X as `skills: false`. */
  skills?: boolean;
}

// Injection seam for tests: real wizard talks to a TTY, so callers can
// supply a fake that returns canned answers without spawning prompts.
export interface InitDeps extends Omit<CommandIO, "cwd"> {
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
      "--program <program-name>",
      "Scaffold only this program (default: every program detected in the workspace)"
    )
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
  const { stderr } = resolveCommandIO(deps);

  try {
    const optionProtocol = normalizeProfileOptions(options.protocol, options.profile);
    const wantsWizard = Boolean(options.wizard) && !options.yes && !options.quiet;
    // The wizard scaffolds exactly one adapter, so it preflights a single
    // program; the default path preflights every program it will write.
    const detected = wantsWizard
      ? preflightScaffold({ cwd, force: options.force, blank: Boolean(options.blank) })
      : preflightScaffoldPrograms({
          cwd,
          force: options.force,
          blank: Boolean(options.blank),
          program: options.program
        })?.[0];
    const wizardAnswers = await maybeRunWizard(cwd, options, deps, detected, optionProtocol);
    const protocol = wizardAnswers?.protocol ?? optionProtocol ?? "custom";
    const useWizardScaffold = wizardAnswers !== undefined;
    const result = await scaffold({
      cwd,
      force: options.force,
      blank: Boolean(options.blank),
      programName: wizardAnswers?.programName ?? options.name,
      program: options.program,
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

    const programs = result.programNames.map((name) => chalk.cyan(name)).join(", ");
    stderr(
      chalk.bold(
        `riptide init: scaffolded .riptide/ for ${result.programNames.length} ${
          result.programNames.length === 1 ? "program" : "programs"
        } (${programs})\n`
      )
    );
    const summaryByPath = new Map(result.adapters.map((adapter) => [adapter.path, adapter]));
    for (const rel of result.created) {
      stderr(dim(`  created ${rel}\n`));
      const adapter = summaryByPath.get(rel);
      if (adapter?.kind === "defaults") {
        stderr(dim(`    ${describeDefaults(adapter)}\n`));
      }
    }
    for (const warning of result.warnings) {
      stderr(chalk.yellow(`  warning: ${warning}\n`));
    }

    const defaulted = result.adapters.filter((adapter) => adapter.kind === "defaults");
    stderr("\nNext steps:\n\n");
    if (defaulted.length > 0) {
      printDefaultsNextSteps(defaulted, stderr);
    } else {
      printScaffoldNextSteps(`.riptide/adapters/${result.programName}.toml`, useWizardScaffold, stderr);
    }
    stderr(
      dim(`More detail: ${chalk.cyan(".riptide/GETTING-STARTED.md")}\n`)
    );
    return 0;
  } catch (err) {
    if (err instanceof RiptideDirExistsError) {
      stderr(chalk.red(`riptide init: ${err.message}\n`));
      return 2;
    }
    if (err instanceof ProgramDetectionError) {
      stderr(chalk.red(`riptide init: ${err.message}\n`));
      return 2;
    }
    stderr(
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

/**
 * Next steps when init wrote IDL-derived adapters: the pipeline leads
 * because the adapters already run, and `/riptide-config` becomes the
 * sharpening step rather than a prerequisite.
 */
function printDefaultsNextSteps(
  defaulted: ScaffoldedAdapter[],
  stderr: (chunk: string) => void
): void {
  // `sim generate` writes to .riptide/sim by default, so a second
  // program would clobber the first — give each its own crate directory.
  const perProgram = defaulted.length > 1;
  const first = defaulted[0]!;
  const simDir = perProgram ? `.riptide/sim/${first.programName}` : ".riptide/sim";

  stderr(
    `  1. Generate and run a simulation${perProgram ? " (one crate per program)" : ""}:\n`
  );
  stderr(
    `     ${chalk.cyan(
      `riptide sim generate --adapter ${first.path}${perProgram ? ` --dir ${simDir}` : ""}`
    )}\n`
  );
  stderr(`     ${chalk.cyan(`riptide sim run ${simDir} --flows 8`)}\n`);
  stderr(
    `     ${chalk.cyan(`riptide sim surface ${simDir}/artifacts/<dir> --sim ${simDir}`)}\n\n`
  );
  for (const adapter of defaulted.slice(1)) {
    stderr(
      dim(
        `     Then the same for ${adapter.programName}: --adapter ${adapter.path} --dir .riptide/sim/${adapter.programName}\n`
      )
    );
  }
  if (perProgram) stderr("\n");

  stderr(
    `  2. Get the assessment:\n     ${chalk.cyan("riptide assess <guided-sim-root>")}\n\n`
  );

  const gaps = defaulted.reduce((total, adapter) => total + adapter.gaps, 0);
  stderr("  3. Sharpen what init could not derive — personas, invariants,\n");
  stderr(
    `     protocol semantics${
      gaps > 0 ? `, and the ${count(gaps, "gap")} recorded under [lineage]` : ""
    }:\n`
  );
  stderr(`     invoke ${chalk.cyan("/riptide-config")} in your coding agent.\n\n`);

  stderr(
    dim(
      "A run over these adapters produces simulation evidence over the inputs they declare — a bounded result, not a safety proof.\n\n"
    )
  );
  stderr(
    dim(
      `Advanced: run ${chalk.cyan("riptide init --wizard --force")} only if you want to replace these IDL-derived adapters with questionnaire-selected starter files.\n\n`
    )
  );
}

/** Next steps for a thin or wizard scaffold, which still needs authoring. */
function printScaffoldNextSteps(
  adapterRel: string,
  useWizardScaffold: boolean,
  stderr: (chunk: string) => void
): void {
  stderr(`  1. Invoke ${chalk.cyan("/riptide-config")} in your coding agent.\n`);
  stderr("     It finishes the adapter and authors the guided simulation.\n\n");
  stderr("  2. Generate and run the guided sim:\n");
  stderr(`     ${chalk.cyan(`riptide sim generate --adapter ${adapterRel}`)}\n`);
  stderr(`     ${chalk.cyan("riptide sim run .riptide/sim --flows 8")}\n`);
  stderr(
    `     ${chalk.cyan("riptide sim surface .riptide/sim/artifacts/<dir> --sim .riptide/sim")}\n\n`
  );
  stderr(
    `  3. Get the assessment:\n     ${chalk.cyan("riptide assess <guided-sim-root>")}\n\n`
  );
  if (!useWizardScaffold) {
    stderr(
      dim(
        `Advanced: run ${chalk.cyan("riptide init --wizard --force")} only if you want to replace this thin scaffold with questionnaire-selected starter files. Otherwise follow .riptide/GETTING-STARTED.md.\n\n`
      )
    );
  }
}

function describeDefaults(adapter: ScaffoldedAdapter): string {
  const parts = [
    `${count(adapter.declaredAccounts.length, "account")} and ${count(
      adapter.mappedInstructions.length,
      "instruction"
    )} derived from the IDL`
  ];
  if (adapter.gaps > 0) {
    parts.push(`${count(adapter.gaps, "gap")} recorded under [lineage]`);
  }
  return parts.join(", ");
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
