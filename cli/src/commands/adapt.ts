// `riptide adapt` — smoke-test harness.
//
// This is NOT a generator. The Claude Code `riptide-adapt` skill is the
// sole adapter-generation surface: the in-session agent reads the IDL,
// emits a TOML adapter using its own model, writes it to disk, and then
// invokes this command to verify the generated adapter round-trips
// cleanly against the engine.
//
// Scope (intentionally minimal):
// 1. Load the adapter TOML from disk.
// 2. Validate it against the Zod schema (`validateAdapter`).
// 3. Resolve the `riptide-engine` binary via the shared orchestrator path.
// 4. Pick a shrunk run-config + policies for the adapter's primitive
// class (lending vs generic) — same logic the shipped smoke runner
// already used.
// 5. Invoke the engine with `--config / --policies / --output / --adapter`.
// 6. Parse the engine output; assert at least one observation delta
// via `findObservationDelta`.
//
// Exit codes:
// 0 — smoke test passed (observed state delta)
// 1 — smoke test failed (engine non-zero OR no delta)
// 2 — adapter file missing / unreadable / Zod validation failed
//
// No HTTP client. No API keys. No endpoint config. No prompts. No retry.
// This command does exactly one thing: verify a TOML adapter works
// end-to-end against the local LiteSVM engine.

import chalk from "chalk";
import ora from "ora";
import { Command } from "commander";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import TOML from "toml";

import { validateAdapter, type Adapter } from "../schemas/adapter.js";
import { resolveEngineBinary, monorepoRootFromModule } from "../orchestrator/index.js";
import { runSmokeTest, type SmokeTestResult } from "../adapt/smoke.js";
import {
  classifyLineageSourceKind,
  lintAdapter,
  type LintReport,
} from "../lint/index.js";
import { deriveRepoRoot } from "./lint.js";

export interface AdaptCommandDeps {
  // Injectable so tests can stub out the engine spawn.
  runSmokeTestImpl?: typeof runSmokeTest;
  fixturesRoot?: string;
  engineBinary?: string;
  /** Repo root for resolving the adapter's `[lineage].idl_source`. Defaults to the fixtures-root parent. */
  repoRoot?: string;
  /** Test seam for the lint preflight — defaults to the real analyzer. */
  runLintImpl?: typeof lintAdapter;
}

export function createAdaptCommand(deps: AdaptCommandDeps = {}): Command {
  const command = new Command("adapt").description(
    "Smoke-test a Riptide adapter TOML against the local engine (used by the riptide-adapt Claude Code skill to verify its generated output)"
  );

  command.requiredOption(
    "--adapter <path>",
    "Path to the adapter TOML to smoke-test"
  );

  return command.action(async (options: AdaptOptions) => {
    const exitCode = await runAdapt(options, deps);
    process.exit(exitCode);
  });
}

export interface AdaptOptions {
  adapter: string;
}

// Exported for tests: returns the exit code instead of calling process.exit.
export async function runAdapt(
  options: AdaptOptions,
  deps: AdaptCommandDeps = {}
): Promise<number> {
  const adapterPath = path.resolve(options.adapter);
  const isTTY = process.stderr.isTTY;
  const adapterBaseName = deriveAdapterName(adapterPath);

  // Banner mirrors the `Lint — <name>` / `Doctor — Riptide health check`
  // headers on the sibling DX commands so the three surfaces read like
  // one CLI. chalk's own TTY/NO_COLOR/FORCE_COLOR detection governs
  // color emission — we deliberately do not second-guess it here.
  process.stderr.write(`${chalk.bold(`Adapt — ${adapterBaseName}`)}\n`);
  process.stderr.write(chalk.dim(`adapter: ${adapterPath}`) + "\n");
  process.stderr.write("\n");

  // --- 1. Load ---
  const loadSpinner = isTTY ? ora({ text: "Loading adapter TOML...", stream: process.stderr }).start() : null;
  let raw: string;
  try {
    raw = await readFile(adapterPath, "utf8");
  } catch (err) {
    if (loadSpinner) loadSpinner.fail("Failed to load adapter");
    process.stderr.write(
      chalk.red(`riptide adapt: could not read adapter at ${adapterPath}: ${errMessage(err)}\n`)
    );
    return 2;
  }

  // --- 2. Validate ---
  let adapter: Adapter;
  try {
    const parsed = TOML.parse(raw);
    adapter = validateAdapter(parsed, adapterPath);
  } catch (err) {
    if (loadSpinner) loadSpinner.fail("Adapter validation failed");
    process.stderr.write(
      chalk.red(`riptide adapt: adapter failed validation: ${errMessage(err)}\n`)
    );
    process.stderr.write(chalk.yellow(`  adapter file: ${adapterPath}\n`));
    return 2;
  }
  if (loadSpinner) loadSpinner.succeed("Adapter loaded and validated");

  // --- 2b. Lint preflight ---
  //
  // When the adapter's `[lineage].idl_source` is a JSON IDL the adapter
  // is machine-checkable — run the static validator BEFORE spawning
  // the engine. Concrete lint failures abort here (exit 2) so a bogus
  // mapping never gets to waste engine time. Missing lineage and
  // non-JSON lineage sources skip / warn through cleanly.
  const lintKind = classifyLineageSourceKind(adapter.lineage);
  // repoRoot resolution priority: explicit dep > path-derived from the
  // adapter location (so external adapters outside the Riptide monorepo
  // resolve their own `[lineage].idl_source` correctly, not against the
  // installed CLI's checkout).
  const repoRoot = deps.repoRoot ?? deriveRepoRoot(adapterPath, deps.fixturesRoot);
  const lintFn = deps.runLintImpl ?? lintAdapter;

  if (lintKind === "json-idl" || adapter.semantics !== undefined) {
    const lintSpinner = isTTY ? ora({ text: "Running adapter lint preflight...", stream: process.stderr }).start() : null;
    let lintReport: LintReport;
    try {
      lintReport = await lintFn({
        adapter,
        adapterPath,
        adapterName: adapterBaseName,
        repoRoot,
      });
    } catch (err) {
      if (lintSpinner) lintSpinner.fail("Lint preflight crashed");
      process.stderr.write(chalk.red(`riptide adapt: lint preflight crashed: ${errMessage(err)}\n`));
      return 2;
    }
    const hasFail = lintReport.findings.some((f) => f.level === "fail");
    if (hasFail) {
      if (lintSpinner) lintSpinner.fail(chalk.red("Lint FAIL — aborting before engine spawn"));
      for (const f of lintReport.findings) {
        if (f.level !== "fail") continue;
        process.stderr.write(chalk.red(`  [${f.code}] ${f.subject}: ${f.message}\n`));
        if (f.hint) process.stderr.write(chalk.yellow(`      hint: ${f.hint}\n`));
      }
      process.stderr.write(chalk.yellow(`  adapter file: ${adapterPath}\n`));
      return 2;
    }
    const warnCount = lintReport.findings.filter((f) => f.level === "warn").length;
    if (warnCount > 0) {
      if (lintSpinner) lintSpinner.warn(chalk.yellow(`Lint PASS with ${warnCount} warning(s) — continuing to smoke`));
    } else if (lintSpinner) {
      lintSpinner.succeed("Lint PASS");
    }
  } else if (lintKind === "non-json") {
    process.stderr.write(
      chalk.gray(
        `  lint: SKIP — non-JSON lineage source (${adapter.lineage?.idl_source ?? ""}) is inspection-only; continuing to smoke\n`
      )
    );
  } else {
    process.stderr.write(
      chalk.gray(`  lint: SKIP — adapter has no [lineage] block to machine-check; continuing to smoke\n`)
    );
  }

  // --- 3. Resolve engine binary ---
  const engineSpinner = isTTY ? ora({ text: "Resolving engine binary...", stream: process.stderr }).start() : null;
  let engineBinary: string;
  try {
    engineBinary =
      deps.engineBinary ?? (await resolveEngineBinary(process.env, process.cwd()));
  } catch (err) {
    if (engineSpinner) engineSpinner.fail("Engine binary not found");
    process.stderr.write(chalk.red(`riptide adapt: ${errMessage(err)}\n`));
    return 1;
  }
  if (engineSpinner) engineSpinner.succeed("Engine binary resolved");

  // --- 4-6. Smoke test ---
  const fixturesRoot = deps.fixturesRoot ?? defaultFixturesRoot();
  const smokeFn = deps.runSmokeTestImpl ?? runSmokeTest;

  const smokeSpinner = isTTY ? ora({ text: "Running smoke test...", stream: process.stderr }).start() : null;
  let result: SmokeTestResult;
  try {
    result = await smokeFn({
      adapterPath,
      adapter,
      engineBinary,
      fixturesRoot
    });
  } catch (err) {
    if (smokeSpinner) smokeSpinner.fail("Smoke test crashed");
    process.stderr.write(chalk.red(`riptide adapt: smoke runner crashed: ${errMessage(err)}\n`));
    process.stderr.write(chalk.yellow(`  adapter file: ${adapterPath}\n`));
    return 1;
  }

  if (result.passed) {
    if (smokeSpinner) smokeSpinner.succeed(chalk.green(`PASS (${result.reason})`));
    else process.stderr.write(chalk.green(`Smoke: PASS (${result.reason})\n`));
    process.stderr.write(chalk.gray(`  engine output: ${result.outputPath}\n`));
    writeAdaptVerdict(0);
    return 0;
  }

  if (smokeSpinner) smokeSpinner.fail(chalk.red(`FAIL — ${result.reason}`));
  else process.stderr.write(chalk.red(`Smoke: FAIL — ${result.reason}\n`));
  process.stderr.write(chalk.yellow(`  adapter file: ${adapterPath}\n`));
  if (result.engineStderr.trim().length > 0) {
    const tail = result.engineStderr.trim().split("\n").slice(-8).join("\n");
    process.stderr.write(chalk.gray(`  engine stderr (tail):\n${tail}\n`));
  }
  writeAdaptVerdict(1);
  return 1;
}

function writeAdaptVerdict(exitCode: number): void {
  // Mirror the final `Verdict: <outcome> (exit N)` line the sibling
  // `riptide lint` and `riptide doctor` commands already print so the
  // three commands share a common closing beat.
  const verdictLabel =
    exitCode === 0 ? chalk.green("PASS") : chalk.red("FAIL");
  process.stderr.write("\n");
  process.stderr.write(chalk.bold("Summary") + "\n");
  process.stderr.write(`  Verdict: ${verdictLabel} (exit ${exitCode})\n`);
  process.stderr.write("\n");
  process.stderr.write(
    chalk.dim(
      "Adapter smoke test only — runs one scenario against the local engine. Use `riptide lint <adapter>` for static validation; `riptide doctor` for toolchain + multi-adapter health.\n"
    )
  );
}

function defaultFixturesRoot(): string {
  // Order of precedence:
  // 1. $RIPTIDE_FIXTURES_ROOT — explicit override for packaged installs
  // 2. Monorepo root derived from *this CLI module's* on-disk location
  // (the fix for "any cwd / any Claude Code session")
  // 3. Historical cwd-relative candidates (tests + running from inside
  // the monorepo without a build)
  const fromEnv = process.env.RIPTIDE_FIXTURES_ROOT;
  if (fromEnv && existsSync(fromEnv)) {
    return fromEnv;
  }

  const moduleRoot = monorepoRootFromModule();
  if (moduleRoot) {
    const moduleFixtures = path.resolve(moduleRoot, "fixtures");
    if (existsSync(moduleFixtures)) {
      return moduleFixtures;
    }
  }

  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, "fixtures"),
    path.resolve(cwd, "..", "fixtures"),
    path.resolve(cwd, "riptide", "fixtures")
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      return c;
    }
  }
  return candidates[0]!;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function deriveAdapterName(absPath: string): string {
  const base = path.basename(absPath);
  return base.endsWith(".toml") ? base.slice(0, -".toml".length) : base;
}
