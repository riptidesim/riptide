// Reviewer-ready evidence pack — CLI-side emitter.
//
// After `riptide run` / `riptide replay` lands its SimulationResult on
// disk, the CLI hands the canonical inputs + outputs off to the engine
// binary's `pack` subcommand, which writes the pack under
// `<cwd>/.riptide/pack/<run-id>/`. Keeping emission engine-side means
// the Rust pack module is the single source of truth for pack shape
// and byte-stability — the CLI only ferries paths.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { SimulationResult } from "../compiler/schema.js";
import { monorepoRootFromModule, resolveEngineBinary } from "../orchestrator/index.js";

export interface EmitPackInput {
  /** Absolute path to the simulation-result.json produced by the run. */
  simulationResultPath: string;
  /** Working directory the pack anchors repo-relative paths against. */
  cwd: string;
  /** Absolute path to the run-config / replay-config the user invoked with. */
  configPath?: string;
  /** Absolute path to the adapter TOML. Single-component runs only. */
  adapterPath?: string;
  /** Absolute path to the policies.json. Only set when a pre-compiled bundle was used. */
  policiesPath?: string;
  /** Per-component adapter TOML paths, keyed by component name. */
  componentAdapters?: Record<string, string>;
  /** Per-component trajectory dir paths, keyed by component name. */
  trajectoryDirs?: Record<string, string>;
  /** Absolute path to .riptide/last-run.json if the run wrote one. */
  lastRunPath?: string;
  /** Human-reviewable rerun command. POSIX sh only. */
  commandHint?: string;
  /** Optional friendly adapter name for the pack manifest. */
  adapterDisplay?: string;
  /** Optional stable pack id. Defaults to a slug derived from run_config.scenario. */
  packRunId?: string;
  /** Silent mode suppresses stderr pass-through (used by jest-style run loop). */
  silent?: boolean;
}

export interface EmitPackResult {
  /** Pack directory written — relative or absolute, matches what engine emitted. */
  packDir: string;
  /** Canonical SHA256 of the SimulationResult (matches `manifest.json`). */
  canonicalHash: string;
  /** Run-id slug the engine derived from the scenario. */
  runId: string;
}

/**
 * Emit a reviewer-ready evidence pack for a just-completed run /
 * replay. The function reads the simulation-result.json to derive the
 * pack `run-id` slug, builds the pack dir (`.riptide/pack/<run-id>`),
 * and invokes the engine binary's `pack` subcommand with the canonical
 * input / output paths. Safe to call even when the engine exited with
 * an invariant-firing (exit code 1) — the SimulationResult is still on
 * disk, and that's what the pack indexes into.
 */
export async function emitPack(input: EmitPackInput): Promise<EmitPackResult> {
  const env = process.env;
  const enginePath = await resolveEngineBinary(
    env,
    input.cwd,
    monorepoRootFromModule() ?? null
  );

  const result = JSON.parse(await readFile(input.simulationResultPath, "utf8")) as SimulationResult;
  const scenario = result.run_config?.scenario ?? "run";
  const runId = deriveRunId(input.packRunId ?? scenario);
  const packDir = path.join(input.cwd, ".riptide", "pack", runId);

  const args: string[] = [
    "pack",
    "--result",
    input.simulationResultPath,
    "--pack-dir",
    packDir,
    "--repo-root",
    input.cwd,
    "--simulation-result",
    input.simulationResultPath
  ];
  if (input.configPath) args.push("--config", input.configPath);
  if (input.adapterPath) args.push("--adapter", input.adapterPath);
  if (input.policiesPath) args.push("--policies", input.policiesPath);
  if (input.lastRunPath) args.push("--last-run", input.lastRunPath);
  if (input.commandHint) args.push("--command-hint", input.commandHint);
  if (input.adapterDisplay) args.push("--adapter-display", input.adapterDisplay);
  for (const [name, value] of Object.entries(input.componentAdapters ?? {})) {
    args.push("--component-adapter", `${name}=${value}`);
  }
  for (const [name, value] of Object.entries(input.trajectoryDirs ?? {})) {
    args.push("--trajectory-dir", `${name}=${value}`);
  }

  const { code, stderrTail } = await spawnEnginePack(enginePath, args, input.silent === true);
  if (code !== 0) {
    throw new Error(
      `riptide-engine pack exited with code ${code}.\n--- engine stderr (tail) ---\n${stderrTail.trim()}`
    );
  }

  const canonicalHash = typeof (result.summary as Record<string, unknown>)["canonical_hash"] ===
    "string"
    ? ((result.summary as Record<string, string>)["canonical_hash"])
    : "";

  return { packDir, canonicalHash, runId };
}

/**
 * Slugify a scenario string into a filesystem-safe run-id. Mirrors
 * `riptide_engine::pack::derive_run_id` in Rust — both sides must
 * agree so the CLI-computed pack dir matches the engine's manifest
 * entry.
 */
export function deriveRunId(scenario: string): string {
  let out = "";
  let lastWasDash = false;
  for (const ch of scenario) {
    if (/[a-zA-Z0-9]/.test(ch)) {
      out += ch.toLowerCase();
      lastWasDash = false;
    } else if (!lastWasDash) {
      out += "-";
      lastWasDash = true;
    }
  }
  const trimmed = out.replace(/^-+|-+$/g, "");
  return trimmed.length > 0 ? trimmed : "run";
}

function spawnEnginePack(
  bin: string,
  args: string[],
  silent: boolean
): Promise<{ code: number; stderrTail: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    const chunks: string[] = [];
    let bytes = 0;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (!silent) process.stderr.write(chunk);
      chunks.push(chunk);
      bytes += chunk.length;
      while (bytes > 4096 && chunks.length > 1) {
        bytes -= chunks[0]!.length;
        chunks.shift();
      }
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code: code ?? 1, stderrTail: chunks.join("") });
    });
  });
}
