// `riptide list` — print discovered scenarios to stdout.
//
// Behavior:
// - Default scan root: CWD. Override with `--dir <path>` (test injection).
// - One scenario name per line on stdout, in discovery sort order.
// - Warnings (e.g. malformed run-config.json) go to stderr as
//   `warning: <msg>` lines; discovered scenarios still print.
// - Missing `.riptide/` directory → exit 2 with stderr diagnostic.
// - Empty `.riptide/scenarios/` → exit 0, no stdout output.

import { Command } from "commander";

import {
  discoverScenarios,
  type DiscoveryResult
} from "../discovery/index.js";

export interface ListCommandDeps {
  discoverScenariosImpl?: typeof discoverScenarios;
}

export interface ListOptions {
  dir?: string;
}

export function createListCommand(deps: ListCommandDeps = {}): Command {
  const command = new Command("list").description(
    "List scenarios discovered under .riptide/scenarios/ (one per line)"
  );

  command.option(
    "--dir <path>",
    "Directory containing the .riptide/ folder (defaults to CWD)"
  );

  return command.action(async (options: ListOptions) => {
    const exitCode = await runList(options, deps);
    process.exit(exitCode);
  });
}

export async function runList(
  options: ListOptions,
  deps: ListCommandDeps = {}
): Promise<number> {
  const cwd = options.dir ?? process.cwd();
  const discover = deps.discoverScenariosImpl ?? discoverScenarios;

  const result: DiscoveryResult = await discover({ cwd });

  if (result.kind === "missing") {
    process.stderr.write(`riptide list: ${result.message}\n`);
    return 2;
  }

  for (const warning of result.warnings) {
    process.stderr.write(`warning: ${warning}\n`);
  }

  for (const scenario of result.scenarios) {
    process.stdout.write(`${scenario.name}\n`);
  }

  return 0;
}
