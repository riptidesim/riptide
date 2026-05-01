import chalk from "chalk";
import { Command } from "commander";

import {
  createStatePack,
  type CreateStatePackResult
} from "../state-pack/index.js";
import type { AccountGroupName } from "../state-pack/account-groups.js";

const DEFAULT_MAINNET_RPC = "https://api.mainnet-beta.solana.com";
const ACCOUNT_GROUPS = new Set<AccountGroupName>([
  "tick_arrays",
  "vaults",
  "oracle_set",
  "lookup_tables"
]);

export function createPackStateCommand(): Command {
  return new Command("pack-state")
    .description(
      "Capture a current-state account pack. --tx discovers accounts from a transaction, then fetches current RPC state; it is not historical pre-state replay."
    )
    .requiredOption("--name <pack>", "State pack name under .riptide/state-packs/<pack>")
    .option("--tx <signature>", "Transaction signature used for account discovery")
    .option("--account <pubkey>", "Explicit root account to capture. Repeat for multiple accounts.", collect, [])
    .option(
      "--account-group <name>",
      "Account group resolver to materialize in manifest diagnostics: tick_arrays, vaults, oracle_set, lookup_tables. Repeatable.",
      collectGroup,
      []
    )
    .option(
      "--rpc-url <url>",
      "Solana RPC URL. Defaults to $RIPTIDE_RPC_URL or mainnet-beta.",
      process.env.RIPTIDE_RPC_URL ?? DEFAULT_MAINNET_RPC
    )
    .option("--commitment <level>", "RPC commitment for account fetches", "confirmed")
    .option("--output-dir <path>", "Override state-pack root directory", undefined)
    .option("--json", "Print machine-readable result", false)
    .action(async (opts: Record<string, unknown>) => {
      const result = await createStatePack({
        name: stringOpt(opts.name, "--name"),
        cwd: process.cwd(),
        tx: typeof opts.tx === "string" ? opts.tx : undefined,
        accounts: Array.isArray(opts.account) ? (opts.account as string[]) : [],
        accountGroups: Array.isArray(opts.accountGroup)
          ? (opts.accountGroup as AccountGroupName[])
          : [],
        rpcUrl: stringOpt(opts.rpcUrl, "--rpc-url"),
        commitment: stringOpt(opts.commitment, "--commitment"),
        outputDir: typeof opts.outputDir === "string" ? opts.outputDir : undefined
      });
      emitPackStateResult(result, Boolean(opts.json));
    });
}

function emitPackStateResult(result: CreateStatePackResult, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  process.stderr.write(chalk.yellow("warning: --tx is account discovery only; pack bytes are current RPC state\n"));
  process.stdout.write(`state pack: ${result.packDir}\n`);
  process.stdout.write(`accounts: ${result.accountCount}\n`);
  process.stdout.write(`manifest: ${result.manifestPath}\n`);
}

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function collectGroup(value: string, previous: AccountGroupName[]): AccountGroupName[] {
  if (!ACCOUNT_GROUPS.has(value as AccountGroupName)) {
    throw new Error(
      `unknown account group ${JSON.stringify(value)}; expected one of ${[...ACCOUNT_GROUPS].join(", ")}`
    );
  }
  previous.push(value as AccountGroupName);
  return previous;
}

function stringOpt(value: unknown, flag: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`${flag} is required`);
}
