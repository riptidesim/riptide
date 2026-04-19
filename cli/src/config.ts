import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Command } from "commander";
import TOML from "toml";
import { z } from "zod";

import { RunConfigSchema, type RunConfig } from "./compiler/schema.js";
import { validateAdapter } from "./schemas/adapter.js";

export const SimulateOptionsSchema = RunConfigSchema.extend({
  llm_url: z.string().url().optional(),
  // Absolute path to a pre-validated adapter TOML. Populated by
  // `buildSimulateOptions` after running the raw path through
  // `validateAdapter` — never trust the raw CLI string past that point.
  adapter_path: z.string().min(1).optional()
});

export type SimulateOptions = z.infer<typeof SimulateOptionsSchema>;

export const DEFAULT_PERSONAS = [
  "cautious-yield-farmer",
  "aggressive-arb-bot",
  "panic-whale",
  "steady-lp",
  "degen-borrower"
] as const;
export const DEFAULT_VALIDATOR_URL = "http://127.0.0.1:8899";

export function registerRunConfigOptions(command: Command): Command {
  return command
    .option("--agents <count>", "Number of simulated agents", parseInteger)
    .option("--ticks <count>", "Number of ticks to run", parseInteger)
    .option("--scenario <name>", "Scenario preset", "baseline")
    .option("--seed <seed>", "Random seed", parseInteger)
    .option("--personas <ids>", "Comma-separated persona ids")
    .option("--validator-url <url>", "Solana RPC URL", DEFAULT_VALIDATOR_URL)
    .option("--llm-url <url>", "OpenAI-compatible LLM endpoint override")
    .option("--adapter <path>", "Path to an adapter TOML (selects the primitive at runtime)")
    .option("--output <path>", "Output directory for artifacts");
}

export function buildSimulateOptions(raw: Record<string, unknown>): { config: SimulateOptions; generatedSeed: boolean } {
  const generatedSeed = raw.seed === undefined;

  // Pre-validate the adapter TOML before it ever reaches the engine
  // binary. Fail fast with the full path + key on a schema violation.
  // We resolve to an absolute path so the engine binary can find the
  // file regardless of its own cwd.
  let adapterPath: string | undefined;
  let adapterProtocol: "lending" | "generic" | undefined;
  if (typeof raw.adapter === "string" && raw.adapter.length > 0) {
    adapterPath = path.resolve(raw.adapter);
    let rawToml: string;
    try {
      rawToml = readFileSync(adapterPath, "utf8");
    } catch (err) {
      // Wrap the raw ENOENT / EACCES into a message a cold user can act
      // on: name the file, say what was expected, point at a concrete
      // next step. The CLI's top-level handler prints the.message as-is.
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr && nodeErr.code === "ENOENT") {
        throw new Error(
          `adapter TOML not found at ${adapterPath}\n` +
            `Expected a path to a Riptide adapter file.\n` +
            `Try one of the shipped examples: fixtures/adapters/solend-fork.toml ` +
            `or fixtures/adapters/resource-grinder.toml, or drop --adapter to use the default lending primitive.`
        );
      }
      throw new Error(
        `failed to read adapter TOML at ${adapterPath}: ${nodeErr.message ?? err}`
      );
    }
    let parsedToml: unknown;
    try {
      parsedToml = TOML.parse(rawToml);
    } catch (err) {
      const parseErr = err as Error;
      throw new Error(
        `${adapterPath}: TOML parse failed: ${parseErr.message}\n` +
          `Check for an unclosed bracket, a missing quote, or a stray comma near the reported line/column.`
      );
    }
    // Throws on validation failure. Message includes file + key.
    adapterProtocol = validateAdapter(parsedToml, adapterPath).protocol;
  }

  const parsed = SimulateOptionsSchema.parse({
    agents: raw.agents ?? 15,
    ticks: raw.ticks ?? 50,
    scenario: raw.scenario ?? "price-shock",
    seed: raw.seed ?? generateSeed(),
    personas: parsePersonas(raw.personas, adapterProtocol),
    validator_url: raw.validatorUrl ?? process.env.RIPTIDE_RPC_URL ?? DEFAULT_VALIDATOR_URL,
    output_path: raw.output ?? "riptide-output/default-run",
    llm_url: raw.llmUrl,
    adapter_path: adapterPath
  });

  return { config: parsed, generatedSeed };
}

export function toRunConfig(options: SimulateOptions): RunConfig {
  const { llm_url: _llmUrl, adapter_path: _adapterPath, ...runConfig } = options;
  return runConfig;
}

function parsePersonas(
  value: unknown,
  adapterProtocol?: "lending" | "generic"
): string[] {
  if (typeof value !== "string" || value.trim() === "") {
    if (adapterProtocol === "generic") {
      return [];
    }
    return [...DEFAULT_PERSONAS];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Expected an integer, received "${value}"`);
  }
  return parsed;
}

function generateSeed(): number {
  return crypto.randomInt(1, 2_147_483_647);
}
