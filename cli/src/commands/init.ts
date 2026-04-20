// `riptide init` — scaffold a `.riptide/` directory in the user's repo.
//
// Scaffolding only. No compile, no smoke test, no LLM. Writes only under
// `<cwd>/.riptide/`. Exits 2 if `.riptide/` already exists and --force
// was not passed; exits 0 on successful scaffold.

import chalk from "chalk";
import { Command } from "commander";
import path from "node:path";

import { RiptideDirExistsError, scaffold } from "../init/index.js";

export interface InitCommandDeps {
  personasSourceDir?: string;
}

export interface InitOptions {
  force: boolean;
  dir: string;
}

export function createInitCommand(deps: InitCommandDeps = {}): Command {
  const command = new Command("init").description(
    "Scaffold a .riptide/ directory in the current repo (adapter stub, starter personas, baseline scenario, getting-started guide)"
  );

  command
    .option("--force", "Overwrite an existing .riptide/ directory without prompting", false)
    .option("--dir <path>", "Directory to scaffold under (defaults to cwd)", process.cwd());

  return command.action(async (options: InitOptions) => {
    const exitCode = await runInit(options, deps);
    process.exit(exitCode);
  });
}

export async function runInit(
  options: InitOptions,
  deps: InitCommandDeps = {}
): Promise<number> {
  const cwd = path.resolve(options.dir);

  try {
    const result = await scaffold({
      cwd,
      force: options.force,
      personasSourceDir: deps.personasSourceDir
    });

    process.stderr.write(
      chalk.bold(`riptide init: scaffolded .riptide/ for ${chalk.cyan(result.programName)}\n`)
    );
    for (const rel of result.created) {
      process.stderr.write(chalk.gray(`  created ${rel}\n`));
    }
    const runCmd = `riptide run .riptide/scenarios/baseline/run-config.json --adapter .riptide/adapters/${result.programName}.toml`;
    process.stderr.write(
      `\nNext: edit ${chalk.cyan(`.riptide/adapters/${result.programName}.toml`)} to match your program, then run:\n  ${chalk.cyan(runCmd)}\n`
    );
    process.stderr.write(
      chalk.gray(`See .riptide/GETTING-STARTED.md for the full walkthrough.\n`)
    );
    return 0;
  } catch (err) {
    if (err instanceof RiptideDirExistsError) {
      process.stderr.write(chalk.red(`riptide init: ${err.message}\n`));
      return 2;
    }
    process.stderr.write(
      chalk.red(`riptide init: scaffold failed: ${errMessage(err)}\n`)
    );
    return 1;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
