import { spawn } from "node:child_process";
import path from "node:path";

import chalk from "chalk";
import { Command } from "commander";

import { generateSim, type SimGenerateOptions } from "../sim/generate.js";

const dim = (value: string) => chalk.hex("#A8A8A8")(value);

export function createSimCommand(): Command {
  const command = new Command("sim").description(
    "Generate, refresh, and run guided Rust simulations"
  );

  command
    .command("generate")
    .description("Generate a project-owned Rust simulation crate")
    .requiredOption("--adapter <path-or-name>", "Adapter TOML to generate against")
    .option("--dir <path>", "Simulation crate directory", ".riptide/sim")
    .option(
      "--force-generated",
      "Overwrite user-owned flows.rs, invariants.rs, and services/* files too",
      false
    )
    .action(async (options: SimGenerateOptions) => {
      try {
        const result = await generateSim(process.cwd(), options);
        process.stderr.write(
          chalk.bold(`riptide sim: generated guided Rust simulation at ${chalk.cyan(result.dir)}\n`)
        );
        process.stderr.write(dim(`  adapter ${result.adapterPath}\n`));
        process.stderr.write(dim(`  idl ${result.idlPath}\n`));
        process.stderr.write(dim(`  manifest ${result.manifestPath}\n`));
      } catch (err) {
        process.stderr.write(chalk.red(`riptide sim: ${errMessage(err)}\n`));
        process.exitCode = 2;
      }
    });

  command
    .command("refresh")
    .description("Regenerate typed IDL builders and account storage skeletons")
    .requiredOption("--adapter <path-or-name>", "Adapter TOML to refresh against")
    .option("--dir <path>", "Simulation crate directory", ".riptide/sim")
    .action(async (options: SimGenerateOptions) => {
      try {
        const result = await generateSim(process.cwd(), { ...options, regenTypesOnly: true });
        process.stderr.write(
          chalk.bold(`riptide sim: refreshed generated Rust files in ${chalk.cyan(result.dir)}\n`)
        );
      } catch (err) {
        process.stderr.write(chalk.red(`riptide sim: ${errMessage(err)}\n`));
        process.exitCode = 2;
      }
    });

  command
    .command("run")
    .description("Run a generated guided simulation crate")
    .argument("[path]", "Simulation crate path", ".riptide/sim")
    .option("--iterations <n>", "Iterations to run")
    .option("--flows <n>", "Flow calls per iteration")
    .option("--seed <hex>", "Deterministic seed as hex")
    .action(async (simPath: string, options: RunOptions) => {
      process.exitCode = await runCargoSim(simPath, options);
    });

  command
    .command("debug")
    .description("Run one seed with verbose labelled transaction logging")
    .argument("[path]", "Simulation crate path", ".riptide/sim")
    .requiredOption("--seed <hex>", "Deterministic seed as hex")
    .action(async (simPath: string, options: RunOptions) => {
      process.exitCode = await runCargoSim(simPath, {
        ...options,
        iterations: "1",
        debug: true
      });
    });

  return command;
}

interface RunOptions {
  iterations?: string;
  flows?: string;
  seed?: string;
  debug?: boolean;
}

function runCargoSim(simPath: string, options: RunOptions): Promise<number> {
  const cwd = path.resolve(process.cwd(), simPath);
  const args = ["run", "--release", "--quiet", "--"];
  if (options.iterations) args.push("--iterations", options.iterations);
  if (options.flows) args.push("--flows", options.flows);
  if (options.seed) args.push("--seed", options.seed);
  if (options.debug) args.push("--debug");

  return new Promise((resolve, reject) => {
    const child = spawn("cargo", args, {
      cwd,
      stdio: "inherit",
      env: { ...process.env }
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
