import { spawn } from "node:child_process";
import { access, constants, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { compilePersonas } from "../compiler/compile.js";
import {
  SimulationResultSchema,
  type RunConfig,
  type SimulationResult
} from "../compiler/schema.js";

export interface SpawnResult {
  code: number;
  stderrTail: string;
}

export type Spawner = (bin: string, args: string[]) => Promise<SpawnResult>;

export interface OrchestratorOptions {
  spawner?: Spawner;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  llmUrl?: string;
  warn?: (message: string) => void;
}

const ENGINE_REL_PATH = path.join("target", "release", "riptide-engine");
const STDERR_TAIL_BYTES = 8192;

export async function runOrchestrator(
  runConfig: RunConfig,
  options: OrchestratorOptions = {}
): Promise<SimulationResult> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const spawner = options.spawner ?? defaultSpawner;
  const warn = options.warn ?? ((msg: string) => process.stderr.write(`${msg}\n`));

  const enginePath = await resolveEngineBinary(env, cwd);

  const policies = await compilePersonas(runConfig.personas, {
    llmUrl: options.llmUrl,
    warn
  });

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "riptide-run-"));
  try {
    const configPath = path.join(tmpDir, "run-config.json");
    const policiesPath = path.join(tmpDir, "policies.json");
    const outputPath = path.join(tmpDir, "simulation-result.json");

    await writeFile(configPath, JSON.stringify(runConfig, null, 2));
    await writeFile(policiesPath, JSON.stringify(policies, null, 2));

    const args = [
      "--config",
      configPath,
      "--policies",
      policiesPath,
      "--output",
      outputPath
    ];

    const { code, stderrTail } = await spawner(enginePath, args);
    if (code !== 0) {
      const tail = stderrTail.trim();
      const suffix = tail ? `\n--- engine stderr (tail) ---\n${tail}` : "";
      throw new Error(`riptide-engine exited with code ${code}.${suffix}`);
    }

    const raw = await readFile(outputPath, "utf8");
    return SimulationResultSchema.parse(JSON.parse(raw));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function resolveEngineBinary(env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  const attempts: string[] = [];

  const fromEnv = env.RIPTIDE_ENGINE_BIN;
  if (fromEnv) {
    attempts.push(`$RIPTIDE_ENGINE_BIN=${fromEnv}`);
    if (await isExecutable(fromEnv)) {
      return fromEnv;
    }
  } else {
    attempts.push("$RIPTIDE_ENGINE_BIN (unset)");
  }

  // Explicit, trusted candidates only — do NOT walk arbitrary ancestors.
  // Walking up would let a binary planted in /tmp/evil/target/release/
  // riptide-engine hijack the run and inherit the shell environment if
  // the CLI is invoked from any descendant directory.
  //
  // The three supported layouts:
  //   1. cwd is the monorepo root               → cwd/target/release/...
  //   2. cwd is the cli/ subdir of the monorepo → cwd/../target/release/...
  //   3. cwd is the parent of the monorepo      → cwd/riptide-monorepo/target/release/...
  const relativeCandidates = [
    path.resolve(cwd, ENGINE_REL_PATH),
    path.resolve(cwd, "..", ENGINE_REL_PATH),
    path.resolve(cwd, "riptide-monorepo", ENGINE_REL_PATH)
  ];
  for (const candidate of relativeCandidates) {
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  for (const candidate of relativeCandidates) {
    attempts.push(candidate);
  }

  const onPath = await which("riptide-engine", env);
  if (onPath) {
    return onPath;
  }
  attempts.push("$PATH lookup for riptide-engine");

  throw new Error(
    [
      "Could not locate the riptide-engine binary. Attempted:",
      ...attempts.map((a) => `  - ${a}`),
      "",
      "Build it with: cargo build --release -p riptide-engine"
    ].join("\n")
  );
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function which(bin: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const pathVar = env.PATH ?? "";
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

const defaultSpawner: Spawner = (bin, args) => {
  // Pipe stderr so we can both stream it live to the user AND keep a rolling
  // tail buffer for the error message on non-zero exit. Inherit-only would
  // lose the engine's actual error text, which is exactly what the caller
  // needs when the engine fails mid-setup.
  const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
  const chunks: string[] = [];
  let chunksBytes = 0;

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    process.stderr.write(chunk);
    chunks.push(chunk);
    chunksBytes += chunk.length;
    while (chunksBytes > STDERR_TAIL_BYTES && chunks.length > 1) {
      chunksBytes -= chunks[0]!.length;
      chunks.shift();
    }
  });

  return new Promise<SpawnResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === null) {
        reject(new Error(`riptide-engine terminated by signal ${signal ?? "unknown"}`));
        return;
      }
      const tail = chunks.join("").slice(-STDERR_TAIL_BYTES);
      resolve({ code, stderrTail: tail });
    });
  });
};
