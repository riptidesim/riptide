import { Command } from "commander";

import { createTransactionTemplate } from "../template/index.js";

const DEFAULT_MAINNET_RPC = "https://api.mainnet-beta.solana.com";

export function createTemplateCommand(): Command {
  const root = new Command("template").description("Create and manage transaction-template actions");

  root
    .command("create")
    .description("Create a transaction-template action skeleton from an existing transaction")
    .requiredOption("--tx <signature>", "Transaction signature to use as the skeleton source")
    .requiredOption("--name <action>", "Template action name")
    .option(
      "--rpc-url <url>",
      "Solana RPC URL. Defaults to $RIPTIDE_RPC_URL or mainnet-beta.",
      process.env.RIPTIDE_RPC_URL ?? DEFAULT_MAINNET_RPC
    )
    .option("--output-dir <path>", "Override template output directory", undefined)
    .option("--json", "Print machine-readable result", false)
    .action(async (opts: Record<string, unknown>) => {
      const result = await createTransactionTemplate({
        name: stringOpt(opts.name, "--name"),
        tx: stringOpt(opts.tx, "--tx"),
        cwd: process.cwd(),
        rpcUrl: stringOpt(opts.rpcUrl, "--rpc-url"),
        outputDir: typeof opts.outputDir === "string" ? opts.outputDir : undefined
      });
      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        process.stdout.write(`template: ${result.templatePath}\n`);
        process.stdout.write(`instructions: ${result.instructionCount}\n`);
      }
    });

  return root;
}

function stringOpt(value: unknown, flag: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`${flag} is required`);
}
