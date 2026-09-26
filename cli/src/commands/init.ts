// `riptide init` — non-interactive scaffold of the `.riptide/` Workspace.
//
// Writes one adapter per detected program (IDL-derived where the IDL
// allows, otherwise a thin bootstrap) and the Workspace ignore file.
// It never prompts; the Skill calls it and owns everything it writes.

import chalk from "chalk";
import { Command } from "commander";
import path from "node:path";

import {
  ProgramDetectionError,
  RiptideDirExistsError,
  preflightScaffoldPrograms,
  scaffold,
  type ScaffoldedAdapter
} from "../init/index.js";
import { PROTOCOL_CHOICES, type Protocol } from "../init/personas-catalog.js";
import { resolveCommandIO, type CommandIO } from "../contract/index.js";

const SECONDARY_TEXT = "#A8A8A8";
const dim = (value: string) => chalk.hex(SECONDARY_TEXT)(value);

export interface InitOptions {
  force: boolean;
  dir: string;
  blank?: boolean;
  name?: string;
  /** Restrict a multi-program workspace to one program. */
  program?: string;
  protocol?: Protocol;
  profile?: Protocol;
}

export type InitDeps = Omit<CommandIO, "cwd">;

export function createInitCommand(deps: InitDeps = {}): Command {
  const command = new Command("init").description("Scaffold the .riptide/ Workspace");

  command
    .option("--force", "Overwrite an existing .riptide/ directory", false)
    .option("--dir <path>", "Directory to scaffold under (defaults to cwd)", process.cwd())
    .option("--blank", "Allow scaffolding even when no Solana program is detected", false)
    .option("--name <program-name>", "Program name to use for a blank/manual scaffold")
    .option(
      "--program <program-name>",
      "Scaffold only this program (default: every program detected in the workspace)"
    )
    .option(
      "--protocol <protocol>",
      "Adapter protocol hint (amm, lending, perpetuals, liquid-staking, stablecoin, custom)"
    )
    .option("--profile <profile>", "Alias for --protocol");

  return command.action(async (options: InitOptions) => {
    const exitCode = await runInit(options, deps);
    process.exit(exitCode);
  });
}

export async function runInit(options: InitOptions, deps: InitDeps = {}): Promise<number> {
  const cwd = path.resolve(options.dir);
  const { stderr } = resolveCommandIO(deps);

  try {
    const protocol = normalizeProfileOptions(options.protocol, options.profile) ?? "custom";
    preflightScaffoldPrograms({
      cwd,
      force: options.force,
      blank: Boolean(options.blank),
      program: options.program
    });
    const result = await scaffold({
      cwd,
      force: options.force,
      blank: Boolean(options.blank),
      programName: options.name,
      program: options.program,
      protocol
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

function normalizeProtocolOption(value: Protocol | undefined): Protocol | undefined {
  if (value === undefined) return undefined;
  const known = new Set<string>(PROTOCOL_CHOICES);
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
