// `riptide init` — scaffold a `.riptide/` directory in the user's repo.
//
// Scaffolding only. No compile, no smoke test, no LLM. Writes the
// `.riptide/` adapter workspace with inline personas, scenario battery,
// and run-state .gitignore entries. Exits 2 if `.riptide/` already
// exists and --force was not passed; exits 0 on successful scaffold.
//
// On a TTY the command opens a short wizard (program name, protocol,
// setup harness, inline personas, scenarios, invariants, agents,
// ticks, seeds). Under --yes, --quiet, or a non-TTY stdout the wizard is skipped and catalog
// defaults apply.

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
import {
  scenarioChoicesFor,
  type InitScenarioConfig,
  type ScenarioCatalogEntry
} from "../init/scenarios-catalog.js";
import {
  invariantChoicesFor,
  invariantConfigFromCatalog,
  type InitInvariantConfig
} from "../init/invariants-catalog.js";
import { resolveSeedCount, seedForSeedCount } from "../init/options.js";
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
  yes?: boolean;
}

// Injection seam for tests: real wizard talks to a TTY, so callers can
// supply a fake that returns canned answers without spawning prompts.
export interface InitDeps {
  promptWizard?: (defaults: WizardDefaults) => Promise<WizardAnswers>;
  isTTY?: boolean;
}

export function createInitCommand(deps: InitDeps = {}): Command {
  const command = new Command("init").description(
    "Scaffold a .riptide/ directory in a Solana program repo (adapter with inline personas, scenarios, getting-started guide)"
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
    .option("--yes", "Skip the interactive wizard and accept defaults", false)
    .option("--quiet", "Suppress interactive banner (also skips the wizard)", false);

  return command.action(async (options: InitOptions) => {
    printInitBanner({ flags: { quiet: Boolean(options.quiet) } });
    const exitCode = await runInit(options, deps);
    process.exit(exitCode);
  });
}

export async function runInit(options: InitOptions, deps: InitDeps = {}): Promise<number> {
  const cwd = path.resolve(options.dir);

  try {
    const optionProtocol = normalizeProtocolOption(options.protocol);
    const detected = preflightScaffold({
      cwd,
      force: options.force,
      blank: Boolean(options.blank)
    });
    const wizardAnswers = await maybeRunWizard(cwd, options, deps, detected, optionProtocol);
    const protocol = wizardAnswers?.protocol ?? optionProtocol ?? "custom";
    const harnessMode = wizardAnswers?.harnessMode;
    const seeds = wizardAnswers?.seeds;
    const personas = wizardAnswers?.personas ?? [];
    const agents = wizardAnswers?.agents;
    const ticks = wizardAnswers?.ticks;
    const scenarios =
      wizardAnswers?.scenarios ??
      defaultScenariosFor(protocol, {
        agents: agents ?? 100,
        ticks: ticks ?? 30,
        personas,
        baselineUsesDefaults: Boolean(wizardAnswers),
        seeds
      });
    const invariants = wizardAnswers?.invariants ?? defaultInvariantsFor(protocol);
    const result = await scaffold({
      cwd,
      force: options.force,
      blank: Boolean(options.blank),
      programName: wizardAnswers?.programName ?? options.name,
      protocol,
      personas,
      agents,
      ticks,
      scenarios,
      invariants,
      harnessMode,
      seeds
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
    // Echo the install-first sequence with the same first smoke the
    // generated docs recommend: lint, set up harness when needed, then run
    // one deterministic seed before the larger scenario battery. `adapt` is
    // still useful for adapter-only repos, but it is not the main next step
    // once account setup requires a harness.
    const adapterRel = `.riptide/adapters/${result.programName}.toml`;
    const harnessRel = ".riptide/harness";
    const oneSeedRun = `riptide run --adapter ${adapterRel}${result.harnessCreated ? ` --harness ${harnessRel}` : ""} --seeds 1 --seed-root 1337`;
    process.stderr.write(
      `\nNext: edit ${chalk.cyan(adapterRel)} to match your program (TODO comments name every block; the untouched stub is not lint-clean), then:\n`
    );
    process.stderr.write(
      `  1. ${chalk.cyan(`riptide lint ${result.programName}`)}  ${dim("# static validation against the JSON IDL named in [lineage].idl_source")}\n`
    );
    if (result.harnessCreated) {
      process.stderr.write(
        `  2. ${chalk.cyan(`${harnessRel}/src/main.rs`)}  ${dim("# fill in account/program setup before tick 0")}\n`
      );
    } else {
      process.stderr.write(
        `  2. ${chalk.cyan(`riptide harness generate --adapter ${adapterRel}`)}  ${dim("# optional Rust setup for custom accounts/CPIs")}\n`
      );
    }
    process.stderr.write(
      `  3. ${chalk.cyan(oneSeedRun)}  ${dim(result.harnessCreated ? "# first harnessed smoke" : "# first one-seed smoke; add --harness .riptide/harness when setup is needed")}\n`
    );
    process.stderr.write(
      `  4. ${chalk.cyan(`riptide run --adapter ${adapterRel}${result.harnessCreated ? ` --harness ${harnessRel}` : ""}`)}  ${dim("# full scenario battery after the smoke passes")}\n`
    );
    process.stderr.write(
      dim(`Optional adapter-only smoke for repos that do not need setup: ${chalk.cyan(`riptide adapt --adapter ${adapterRel}`)}\n`)
    );
    process.stderr.write(
      dim(result.seeds === 1
        ? "Seed count: generated run-configs pin one seed. Pass --seeds <N> for a larger sweep.\n"
        : `Seed count: generated run-configs request ${result.seeds} seeds. Pass --seeds <N> to override.\n`)
    );
    process.stderr.write(
      dim(`Run ${chalk.cyan("riptide doctor")} any time to recheck toolchain + adapter health. See .riptide/GETTING-STARTED.md for the full walkthrough.\n`)
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
  const wantInteractive =
    !options.yes && !options.quiet && (deps.isTTY ?? Boolean(process.stdout.isTTY));
  if (!wantInteractive) {
    return undefined;
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

function defaultScenariosFor(
  protocol: Protocol,
  defaults: {
    agents: number;
    ticks: number;
    personas: string[];
    baselineUsesDefaults: boolean;
    seeds?: number;
  }
): InitScenarioConfig[] {
  const seeds = resolveSeedCount(defaults.seeds);
  const entries = scenarioChoicesFor(protocol).filter(
    (entry) => entry.required || entry.recommended
  );
  if (entries.length === 0) {
    return [
      {
        name: "baseline",
        scenario: "baseline",
        agents: defaults.agents,
        ticks: defaults.ticks,
        seed: seedForSeedCount(seeds),
        seeds: seedForSeedCount(seeds) === undefined ? seeds : undefined,
        personas: defaults.personas
      }
    ];
  }
  return entries.map((entry) => scenarioFromCatalog(entry, defaults));
}

function scenarioFromCatalog(
  entry: ScenarioCatalogEntry,
  defaults: {
    agents: number;
    ticks: number;
    personas: string[];
    baselineUsesDefaults: boolean;
    seeds?: number;
  }
): InitScenarioConfig {
  const seeds = resolveSeedCount(defaults.seeds);
  const seed = seedForSeedCount(seeds);
  const isBaseline = entry.name === "baseline" || entry.scenario === "baseline";
  const useDefaultSizing = isBaseline && defaults.baselineUsesDefaults;
  return {
    name: entry.name,
    scenario: entry.scenario,
    agents: useDefaultSizing ? defaults.agents : (entry.agents ?? defaults.agents),
    ticks: useDefaultSizing ? defaults.ticks : (entry.ticks ?? defaults.ticks),
    seed,
    seeds: seed === undefined ? seeds : undefined,
    personas: entry.defaultPersonas ?? defaults.personas
  };
}

function defaultInvariantsFor(protocol: Protocol): InitInvariantConfig[] {
  return invariantChoicesFor(protocol)
    // Commented templates are selected by default so non-interactive
    // scaffolds still show the user what to wire, without creating
    // active invariants against undeclared observations.
    .filter((entry) => entry.required || entry.recommended || entry.commented)
    .map((entry) => invariantConfigFromCatalog(entry));
}

function normalizeProtocolOption(value: Protocol | undefined): Protocol | undefined {
  if (value === undefined) return undefined;
  const known = new Set(PROTOCOL_CHOICES.map((choice) => choice.value));
  if (known.has(value)) return value;
  throw new ProgramDetectionError(
    `invalid protocol ${JSON.stringify(value)}. Expected one of: ${[...known].join(", ")}.`
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
