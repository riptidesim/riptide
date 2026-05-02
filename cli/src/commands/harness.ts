import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import chalk from "chalk";
import { Command } from "commander";

import { loadAdapter, type AdapterLoadError } from "../adapter/resolve.js";
import { cliPackageVersion } from "../banner.js";
import { monorepoRootFromModule } from "../orchestrator/index.js";
import { resolveAdapterRuntime, type Adapter } from "../schemas/adapter.js";

const dim = (value: string) => chalk.hex("#A8A8A8")(value);

export interface HarnessGenerateOptions {
  adapter?: string;
  dir?: string;
  name?: string;
  force?: boolean;
}

export interface HarnessGenerateResult {
  dir: string;
  manifestPath: string;
  adapterPath: string;
}

export function createHarnessCommand(): Command {
  const command = new Command("harness").description(
    "Generate and manage Rust project harnesses for protocol-specific simulation setup"
  );

  command
    .command("generate")
    .description("Generate a Rust harness crate that owns account/program setup before tick 0")
    .option(
      "--adapter <path-or-name>",
      "Adapter TOML to generate against. Defaults to the single .riptide/adapters/*.toml file.",
      undefined
    )
    .option("--dir <path>", "Harness crate directory", ".riptide/harness")
    .option("--name <crate-name>", "Generated Rust crate name", "riptide-harness")
    .option("--force", "Overwrite an existing generated harness crate", false)
    .action(async (options: HarnessGenerateOptions) => {
      try {
        const result = await generateHarness(process.cwd(), options);
        process.stderr.write(
          chalk.bold(`riptide harness: generated Rust harness at ${chalk.cyan(result.dir)}\n`)
        );
        process.stderr.write(dim(`  adapter ${result.adapterPath}\n`));
        process.stderr.write(dim(`  manifest ${result.manifestPath}\n`));
        process.stderr.write(
          `\nNext: edit ${chalk.cyan(path.join(result.dir, "src", "main.rs"))}, then run:\n`
        );
        process.stderr.write(
          `  ${chalk.cyan(`riptide run --adapter ${result.adapterPath} --harness ${result.dir} --seeds 1 --seed-root 1337`)}\n`
        );
      } catch (err) {
        process.stderr.write(chalk.red(`riptide harness: ${errMessage(err)}\n`));
        process.exitCode = 2;
      }
    });

  return command;
}

export async function generateHarness(
  cwd: string,
  options: HarnessGenerateOptions
): Promise<HarnessGenerateResult> {
  const resolved = await resolveAdapterForHarness(cwd, options.adapter);
  const runtime = resolveAdapterRuntime(resolved.adapter);
  if (runtime !== "generic") {
    throw new Error(
      `Rust harnesses currently target generic SBF/IDL adapters; ${resolved.path} resolves to ${runtime}`
    );
  }

  const outDir = path.resolve(cwd, options.dir ?? ".riptide/harness");
  const srcDir = path.join(outDir, "src");
  const manifestPath = path.join(outDir, "Cargo.toml");
  const mainPath = path.join(srcDir, "main.rs");
  const readmePath = path.join(outDir, "README.md");
  if (existsSync(manifestPath) && !options.force) {
    throw new Error(
      `${manifestPath} already exists. Pass --force to overwrite the generated harness files.`
    );
  }

  await mkdir(srcDir, { recursive: true });
  await writeFile(
    manifestPath,
    renderCargoToml(options.name ?? "riptide-harness"),
    "utf8"
  );
  await writeFile(mainPath, renderHarnessMain(resolved.adapter), "utf8");
  await writeFile(readmePath, renderHarnessReadme(resolved.path), "utf8");
  return { dir: outDir, manifestPath, adapterPath: resolved.path };
}

async function resolveAdapterForHarness(
  cwd: string,
  adapterArg: string | undefined
): Promise<{ path: string; adapter: Adapter }> {
  if (adapterArg && adapterArg.length > 0) {
    const loaded = await loadAdapter(adapterArg, { cwd });
    if (!loaded.ok) {
      throw new Error(renderAdapterLoadError(loaded.error));
    }
    return { path: loaded.value.resolved.path, adapter: loaded.value.adapter };
  }

  const adapterDir = path.join(cwd, ".riptide", "adapters");
  let files: string[];
  try {
    files = (await readdir(adapterDir))
      .filter((file) => file.endsWith(".toml"))
      .sort();
  } catch {
    throw new Error(
      "no adapter supplied and .riptide/adapters/ was not found. Run 'riptide init' or pass --adapter <path>."
    );
  }
  if (files.length !== 1) {
    throw new Error(
      `expected exactly one adapter under .riptide/adapters/ when --adapter is omitted, found ${files.length}. Pass --adapter <path>.`
    );
  }
  const loaded = await loadAdapter(path.join(adapterDir, files[0]!), { cwd });
  if (!loaded.ok) {
    throw new Error(renderAdapterLoadError(loaded.error));
  }
  return { path: loaded.value.resolved.path, adapter: loaded.value.adapter };
}

function renderCargoToml(crateName: string): string {
  const engineDep = engineDependency();
  return `[package]
name = "${sanitizeCrateName(crateName)}"
version = "0.1.0"
edition = "2021"
publish = false

[workspace]

[dependencies]
anyhow = "1.0"
riptide-engine = ${engineDep}
`;
}

function engineDependency(): string {
  const root = monorepoRootFromModule();
  if (root) {
    const engineDir = path.join(root, "engine");
    if (existsSync(path.join(engineDir, "Cargo.toml"))) {
      return `{ path = ${JSON.stringify(engineDir)} }`;
    }
  }
  return JSON.stringify(cliPackageVersion());
}

function renderHarnessMain(adapter: Adapter): string {
  const accountChecks = Object.entries(adapter.accounts)
    .map(([name, def]) => {
      const owner = def.owner?.program_so
        ? `, owner program ${def.owner.program_so}`
        : def.owner?.pubkey
          ? `, owner ${def.owner.pubkey}`
          : "";
      const locator = def.address
        ? `, address ${def.address}`
        : def.pda
          ? `, PDA seeds [${def.pda.seeds.join(", ")}]`
          : "";
      return `        // ${name}: ${def.kind}, space=${def.space}${locator}${owner}
        ctx.require_declared_account(${JSON.stringify(name)})?;`;
    })
    .join("\n");

  return `use riptide_engine::harness::{run_harness_cli, HarnessContext, RiptideHarness};

struct ProjectHarness;

impl RiptideHarness for ProjectHarness {
    fn setup(&self, ctx: &mut HarnessContext<'_>) -> anyhow::Result<()> {
        // Adapter-declared accounts are listed below. Replace zeroed generic
        // bootstrap accounts with the concrete bytes your program expects.
        //
        // Common helpers:
        //   ctx.spl_mint("mint", ctx.admin_pubkey(), 1_000_000_000, 6)?;
        //   ctx.spl_token_account("vault", mint, authority, 500_000)?;
        //   ctx.agent_spl_token_account("user_ata", 0, mint, owner, 100_000)?;
        //   ctx.load_program_from_so("../target/deploy/dependency.so")?;
${accountChecks || "        let _ = ctx;"}

        Ok(())
    }
}

fn main() -> std::process::ExitCode {
    run_harness_cli(ProjectHarness)
}
`;
}

function renderHarnessReadme(adapterPath: string): string {
  return `# Riptide Rust Harness

This crate owns protocol-specific setup for the adapter:

\`${adapterPath}\`

Use it when your program needs real account bytes, sibling programs, SPL mints,
token accounts, PDAs, or other setup that should not become Riptide core code.

Run it through the CLI:

\`\`\`sh
riptide run --adapter ${adapterPath} --harness . --seeds 1 --seed-root 1337
\`\`\`

After the one-seed smoke passes, drop \`--seeds 1 --seed-root 1337\` for the
full scenario sweep.
`;
}

function sanitizeCrateName(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "riptide-harness";
}

function renderAdapterLoadError(error: AdapterLoadError): string {
  switch (error.kind) {
    case "not-found":
      return `adapter not found: ${error.arg}`;
    case "read-failed":
      return `failed to read adapter ${error.path}: ${error.message}`;
    case "validation-failed":
      return `adapter validation failed for ${error.path}: ${error.message}`;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
