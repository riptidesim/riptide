// `riptide adapt` — LLM adapter generator v0 (Sprint 3 · T07).
//
// Three-step workflow:
//   1. Classify  — ask the configured OpenAI-compatible endpoint
//                  whether the target program is `lending` or `generic`.
//   2. Generate  — ask again with the primitive-specific generation
//                  prompt; parse the raw output through the strict
//                  Zod adapter schema. One retry with a stricter
//                  prompt on validation failure.
//   3. Smoke-test — invoke the engine binary with the generated
//                  adapter against a shrunk sample fixture, assert at
//                  least one observation delta shows up in the output.
//
// Exit codes (as contracted in the task spec):
//   0 — smoke test passed
//   1 — smoke test failed after retry (adapter file still written)
//   2 — missing network / missing endpoint config / missing required flag

import chalk from "chalk";
import { Command } from "commander";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import TOML from "toml";

import { validateAdapter, type Adapter } from "../schemas/adapter.js";
import {
  LlmNetworkError,
  OpenAiCompatClient,
  stripCodeFence,
  type ChatMessage,
  type LlmClient
} from "../llm/openai-compat.js";
import { buildRetrySuffix, loadPrompts, type PromptBundle } from "../llm/prompts.js";
import { runSmokeTest, type SmokeTestResult } from "../llm/smoke-test.js";

export interface AdaptCommandDeps {
  // Injectable for tests. Defaults wire to a real OpenAI-compat client.
  createClient?: (opts: {
    endpoint: string;
    model: string;
    apiKey: string;
  }) => LlmClient;
  // Injectable so tests can avoid spawning the engine binary.
  runSmokeTestImpl?: typeof runSmokeTest;
  // Overrides for test fixtures.
  fixturesRoot?: string;
  engineBinary?: string;
  prompts?: PromptBundle;
}

const DEFAULT_ENDPOINT = "http://localhost:1234/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_API_KEY_ENV = "OPENAI_API_KEY";

export function createAdaptCommand(deps: AdaptCommandDeps = {}): Command {
  const command = new Command("adapt").description(
    "Generate a Riptide adapter TOML from a program IDL using an OpenAI-compatible LLM endpoint"
  );

  command
    .requiredOption("--idl <path>", "Path to the program IDL JSON")
    .option("--program <path>", "Path to the compiled program .so (optional)")
    .option("--source <path>", "Path to the program source tree (optional)")
    .option("--describe <text>", "Short human hint about the protocol (optional)")
    .option("--out <path>", "Where to write the generated adapter TOML", "generated-adapter.toml")
    .option("--endpoint <url>", `OpenAI-compatible endpoint base URL (env: RIPTIDE_LLM_ENDPOINT)`)
    .option("--model <name>", `Model name (env: RIPTIDE_LLM_MODEL)`)
    .option(
      "--api-key-env <var>",
      `Env var that carries the API key (default: ${DEFAULT_API_KEY_ENV})`,
      DEFAULT_API_KEY_ENV
    )
    .option("--skip-smoke", "Skip the smoke test (write the adapter and exit 0)", false);

  return command.action(async (options: AdaptOptions) => {
    const exitCode = await runAdapt(options, deps);
    process.exit(exitCode);
  });
}

interface AdaptOptions {
  idl: string;
  program?: string;
  source?: string;
  describe?: string;
  out: string;
  endpoint?: string;
  model?: string;
  apiKeyEnv: string;
  skipSmoke: boolean;
}

// Exported for tests: returns the exit code instead of calling process.exit.
export async function runAdapt(
  options: AdaptOptions,
  deps: AdaptCommandDeps
): Promise<number> {
  const endpoint = options.endpoint ?? process.env.RIPTIDE_LLM_ENDPOINT ?? DEFAULT_ENDPOINT;
  const model = options.model ?? process.env.RIPTIDE_LLM_MODEL ?? DEFAULT_MODEL;
  const apiKeyEnv = options.apiKeyEnv || DEFAULT_API_KEY_ENV;
  const apiKey = process.env[apiKeyEnv] ?? "";

  if (!endpoint) {
    printUsageHint(`missing endpoint: pass --endpoint or set RIPTIDE_LLM_ENDPOINT`);
    return 2;
  }
  if (!apiKey) {
    printUsageHint(
      `missing API key: set ${apiKeyEnv}=<key> (or pass --api-key-env <VAR> to read from a different env var)`
    );
    return 2;
  }

  let idlRaw: string;
  try {
    idlRaw = await readFile(options.idl, "utf8");
  } catch (err) {
    printUsageHint(`could not read --idl ${options.idl}: ${errMessage(err)}`);
    return 2;
  }

  const prompts = deps.prompts ?? loadPrompts();

  const client =
    deps.createClient?.({ endpoint, model, apiKey }) ??
    new OpenAiCompatClient({ endpoint, model, apiKey });

  process.stderr.write(chalk.bold(`riptide adapt: endpoint=${endpoint} model=${model}\n`));

  const promptContext: PromptContext = {
    idl: idlRaw,
    describe: options.describe,
    programPath: options.program,
    sourcePath: options.source
  };

  // --- Step 1: classify ---
  let classification: "lending" | "generic";
  try {
    classification = await classify(client, prompts, promptContext);
  } catch (err) {
    if (err instanceof LlmNetworkError) {
      printUsageHint(`LLM network error during classification: ${err.message}`);
      return 2;
    }
    process.stderr.write(chalk.red(`classification failed: ${errMessage(err)}\n`));
    return 1;
  }
  process.stderr.write(chalk.cyan(`classification: ${classification}\n`));

  // --- Step 2: generate (with one retry on validation failure) ---
  const generationPrompt =
    classification === "lending" ? prompts.generateLending : prompts.generateGeneric;

  const firstAttempt = await safeGenerate(client, generationPrompt, promptContext);

  let adapter: Adapter | null = null;
  let adapterToml: string | null = null;
  let firstError: string | null = null;
  let firstRaw: string | null = null;

  if (firstAttempt.kind === "network-error") {
    printUsageHint(`LLM network error during generation: ${firstAttempt.error}`);
    return 2;
  } else if (firstAttempt.kind === "ok") {
    adapter = firstAttempt.adapter;
    adapterToml = firstAttempt.toml;
  } else {
    firstError = firstAttempt.error;
    firstRaw = firstAttempt.raw;
    process.stderr.write(
      chalk.yellow(`generation attempt 1 failed validation: ${firstError}\n`)
    );
    process.stderr.write(chalk.yellow(`retrying once with a stricter prompt...\n`));

    const retryMessages: ChatMessage[] = [
      { role: "system", content: generationPrompt },
      {
        role: "user",
        content: buildUserContent(promptContext)
      },
      { role: "assistant", content: firstRaw },
      {
        role: "user",
        content: buildRetrySuffix(prompts.retrySuffix, firstRaw, firstError)
      }
    ];

    const retryAttempt = await safeGenerateMessages(client, retryMessages);
    if (retryAttempt.kind === "network-error") {
      printUsageHint(`LLM network error on retry: ${retryAttempt.error}`);
      return 2;
    } else if (retryAttempt.kind === "validation-error") {
      const debugPath = await stashDebug({
        firstRaw,
        firstError,
        retryRaw: retryAttempt.raw,
        retryError: retryAttempt.error
      });
      process.stderr.write(
        chalk.red(
          `generation retry also failed validation: ${retryAttempt.error}\n` +
            `raw outputs stashed at: ${debugPath}\n`
        )
      );
      // Still write whatever we got from the retry so the dev can edit
      // by hand — that is the `# TODO:` workflow.
      await writeFile(options.out, retryAttempt.raw, "utf8");
      process.stderr.write(chalk.yellow(`wrote raw adapter draft to ${options.out}\n`));
      return 1;
    } else {
      adapter = retryAttempt.adapter;
      adapterToml = retryAttempt.toml;
    }
  }

  if (!adapter || !adapterToml) {
    process.stderr.write(chalk.red(`internal: adapter unresolved after retry loop\n`));
    return 1;
  }

  await writeFile(options.out, adapterToml, "utf8");
  process.stderr.write(chalk.green(`wrote adapter to ${options.out}\n`));

  if (options.skipSmoke) {
    process.stderr.write(chalk.yellow(`--skip-smoke set; not running smoke test\n`));
    return 0;
  }

  // --- Step 3: smoke test ---
  const engineBinary =
    deps.engineBinary ??
    path.resolve(
      process.cwd(),
      "..",
      "target",
      "release",
      "riptide-engine"
    );
  const fixturesRoot =
    deps.fixturesRoot ?? path.resolve(process.cwd(), "..", "fixtures");

  const smokeFn = deps.runSmokeTestImpl ?? runSmokeTest;
  const result: SmokeTestResult = await smokeFn({
    adapterPath: path.resolve(options.out),
    adapter,
    engineBinary,
    fixturesRoot
  });

  if (result.passed) {
    process.stderr.write(
      chalk.green(`smoke test passed (${result.reason})\n`) +
        chalk.gray(`  engine output: ${result.outputPath}\n`)
    );
    return 0;
  }

  process.stderr.write(
    chalk.red(`smoke test FAILED: ${result.reason}\n`) +
      chalk.yellow(`  adapter file: ${path.resolve(options.out)} (edit the \`# TODO:\` markers and retry)\n`)
  );
  if (result.engineStderr.trim().length > 0) {
    const tail = result.engineStderr.trim().split("\n").slice(-8).join("\n");
    process.stderr.write(chalk.gray(`  engine stderr (tail):\n${tail}\n`));
  }
  return 1;
}

type GenerateResult =
  | { kind: "ok"; adapter: Adapter; toml: string }
  | { kind: "validation-error"; error: string; raw: string }
  | { kind: "network-error"; error: string };

interface PromptContext {
  idl: string;
  describe?: string;
  programPath?: string;
  sourcePath?: string;
}

async function safeGenerate(
  client: LlmClient,
  systemPrompt: string,
  ctx: PromptContext
): Promise<GenerateResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: buildUserContent(ctx) }
  ];
  return safeGenerateMessages(client, messages);
}

async function safeGenerateMessages(
  client: LlmClient,
  messages: ChatMessage[]
): Promise<GenerateResult> {
  let raw: string;
  try {
    raw = await client.complete(messages);
  } catch (err) {
    if (err instanceof LlmNetworkError) {
      return { kind: "network-error", error: err.message };
    }
    return { kind: "network-error", error: errMessage(err) };
  }

  const stripped = stripCodeFence(raw);
  let parsedToml: unknown;
  try {
    parsedToml = TOML.parse(stripped);
  } catch (err) {
    return {
      kind: "validation-error",
      error: `TOML parse error: ${errMessage(err)}`,
      raw: stripped
    };
  }

  try {
    const adapter = validateAdapter(parsedToml, "<generated>");
    return { kind: "ok", adapter, toml: stripped };
  } catch (err) {
    return { kind: "validation-error", error: errMessage(err), raw: stripped };
  }
}

async function classify(
  client: LlmClient,
  prompts: PromptBundle,
  ctx: PromptContext
): Promise<"lending" | "generic"> {
  const messages: ChatMessage[] = [
    { role: "system", content: prompts.classify },
    { role: "user", content: buildUserContent(ctx) }
  ];
  const raw = await client.complete(messages);
  const stripped = stripCodeFence(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    throw new Error(`classifier returned non-JSON output: ${errMessage(err)}`);
  }
  const classification = (parsed as { classification?: string })?.classification;
  if (classification !== "lending" && classification !== "generic") {
    throw new Error(
      `classifier returned unexpected classification: ${JSON.stringify(classification)}`
    );
  }
  return classification;
}

// Build the user-turn JSON payload consumed by every prompt. Every
// CLI flag that gives the model more ground truth about the program
// lands here — the `--program` and `--source` flags are not
// decorative, the generator uses them to fill `program_so` + the
// source-path hint in the generic adapter output.
function buildUserContent(ctx: PromptContext): string {
  const payload: {
    idl: unknown;
    describe?: string;
    program_path?: string;
    source_path?: string;
  } = { idl: safeParseJson(ctx.idl) };
  if (ctx.describe && ctx.describe.length > 0) {
    payload.describe = ctx.describe;
  }
  if (ctx.programPath && ctx.programPath.length > 0) {
    payload.program_path = ctx.programPath;
  }
  if (ctx.sourcePath && ctx.sourcePath.length > 0) {
    payload.source_path = ctx.sourcePath;
  }
  return JSON.stringify(payload, null, 2);
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function printUsageHint(message: string): void {
  process.stderr.write(chalk.red(`riptide adapt: ${message}\n`));
  process.stderr.write(
    chalk.gray(
      `usage:\n` +
        `  riptide adapt --idl <path> [--describe <text>] [--out <path>]\n` +
        `                [--endpoint <url>] [--model <name>] [--api-key-env <VAR>]\n\n` +
        `env:\n` +
        `  RIPTIDE_LLM_ENDPOINT   default endpoint base URL\n` +
        `  RIPTIDE_LLM_MODEL      default model name\n` +
        `  OPENAI_API_KEY         default API key\n`
    )
  );
}

async function stashDebug(bundle: {
  firstRaw: string;
  firstError: string;
  retryRaw: string;
  retryError: string;
}): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "riptide-adapt-debug-"));
  const file = path.join(dir, "generation-failure.json");
  await writeFile(file, JSON.stringify(bundle, null, 2), "utf8");
  return file;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
