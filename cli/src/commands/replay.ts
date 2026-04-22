import { readFileSync } from "node:fs";
import path from "node:path";

import chalk from "chalk";
import ora from "ora";
import { Command } from "commander";

import { runReplayOrchestrator } from "../orchestrator/index.js";
import { emitPack } from "../pack/index.js";
import { writeArtifacts } from "../report/artifacts.js";
import { renderSummary, renderColoredTable } from "../report/summary.js";
import { renderTimeline } from "../report/timeline.js";
import { blockUntilSignal, startDashboardServer } from "../serve/index.js";

interface LegacyReplayConfigFile {
  adapter?: string;
  trajectory_dir?: string;
  output_path?: string;
}

interface MultiComponentEntry {
  name?: string;
  adapter?: string;
  trajectory_dir?: string;
}

interface MultiReplayConfigFile {
  components?: unknown;
  bridges?: unknown;
  output_path?: string;
}

type ReplayConfigFile = LegacyReplayConfigFile & MultiReplayConfigFile;

// Mirrors `engine/src/replay/multi.rs::is_safe_multi_identifier`.
// Restrict multi-component component names to ASCII alphanumerics, `_`,
// and `-` — no `.`, no `/` / `\`, no whitespace, no control characters.
// Keeps the CLI and engine contracts byte-identical on this surface
// so an author cannot slip a name past one validator and have the
// other process it.
const MULTI_IDENT_RE = /^[A-Za-z0-9_-]+$/;
const MULTI_IDENT_MAX_LEN = 128;

export function createReplayCommand(): Command {
  return new Command("replay")
    .description("Run a historical replay from a JSON config file")
    .argument("<config>", "Path to a replay-config JSON file")
    .option("--format <format>", "Output format: human (default) or json", "human")
    .option(
      "--allow-invariant-violations",
      "Exit 0 even if declared invariants fire during the replay (default: exit 1 on any firing)",
      false
    )
    .option(
      "--serve",
      "After the replay completes, start the Riptide web dashboard (default port 4173) serving the artifacts. Blocks on Ctrl-C.",
      false
    )
    .action(async (configArg: string, cliOpts: Record<string, unknown>) => {
      const formatJson = cliOpts.format === "json";
      const isTTY = process.stdout.isTTY && !formatJson;

      const absConfig = path.resolve(configArg);
      let raw: string;
      try {
        raw = readFileSync(absConfig, "utf8");
      } catch (err) {
        const reason =
          err && typeof err === "object" && "code" in err && err.code === "ENOENT"
            ? "not found"
            : `unreadable (${(err as Error).message ?? String(err)})`;
        throw new Error(
          `riptide replay: replay-config ${reason} at ${absConfig}\n` +
            `Expected a JSON file shaped either as a legacy single-component replay\n` +
            `  { adapter, trajectory_dir, output_path? }\n` +
            `or a multi-component cross-protocol replay\n` +
            `  { components: [ { name, adapter, trajectory_dir }, ... ], bridges?: [...], output_path? }.`
        );
      }

      let parsed: ReplayConfigFile;
      try {
        parsed = JSON.parse(raw) as ReplayConfigFile;
      } catch (err) {
        throw new Error(
          `riptide replay: failed to parse JSON at ${absConfig}: ${(err as Error).message}\n` +
            `Check the replay-config for a trailing comma or missing quote.`
        );
      }

      // A replay config is either single-component
      // `{ adapter, trajectory_dir, output_path? }` or multi-component
      // `{ components: [...], bridges?: [...], output_path? }`. The
      // CLI auto-detects the shape so every shipping single-program
      // fixture keeps working without migration, and the new
      // cross-protocol contagion proof path lands through the same
      // `riptide replay <config>` entrypoint.
      const isMulti = Array.isArray(parsed.components);
      const isLegacy =
        typeof parsed.adapter === "string" && typeof parsed.trajectory_dir === "string";
      if (!isMulti && !isLegacy) {
        throw new Error(
          `riptide replay: replay-config at ${absConfig} is neither a legacy ` +
            `{ adapter, trajectory_dir } shape nor a multi-component { components: [...] } shape.\n` +
            `See examples/replays/* for both shapes.`
        );
      }

      const configDir = path.dirname(absConfig);
      let adapterPath: string | undefined;
      let trajectoryDir: string | undefined;
      let outputPath: string;
      let displayLine: string;

      if (isMulti) {
        const components = parsed.components as MultiComponentEntry[];
        const componentNames: string[] = [];
        for (const [idx, component] of components.entries()) {
          if (
            !component ||
            typeof component.name !== "string" ||
            typeof component.adapter !== "string" ||
            typeof component.trajectory_dir !== "string"
          ) {
            throw new Error(
              `riptide replay: multi-component config at ${absConfig} has an ` +
                `invalid entry at components[${idx}] — each entry needs ` +
                `{ name, adapter, trajectory_dir }.`
            );
          }
          // Fail-closed identifier check — mirror the engine-side
          // `is_safe_multi_identifier` contract. Component names flow
          // into qualified metric keys, event ids, pack trace rows,
          // and the default output directory below; an unconstrained
          // name could smuggle ANSI escape sequences into operator
          // output, create ambiguous `<component>.<field>` keys, or
          // escape the default `riptide-output/replays/...` subtree
          // via `..` / `/`.
          if (!MULTI_IDENT_RE.test(component.name) || component.name.length > MULTI_IDENT_MAX_LEN) {
            throw new Error(
              `riptide replay: multi-component config at ${absConfig}: ` +
                `components[${idx}].name ${JSON.stringify(component.name)} must match ` +
                `\`[A-Za-z0-9_-]+\` (1..=${MULTI_IDENT_MAX_LEN} chars). The name flows into ` +
                `qualified snapshot keys, event ids, and the default output directory — \`.\`, ` +
                `whitespace, path separators, and control characters are rejected so a config ` +
                `author cannot create ambiguous qualified keys, inject ANSI sequences into ` +
                `operator output, or escape the default artifact subtree.`
            );
          }
          componentNames.push(component.name);
        }
        if (components.length < 2) {
          throw new Error(
            `riptide replay: multi-component config at ${absConfig} declares ` +
              `${components.length} component(s); at least 2 are required.`
          );
        }
        outputPath =
          typeof parsed.output_path === "string" && parsed.output_path.length > 0
            ? path.resolve(configDir, parsed.output_path)
            : path.join(
                "riptide-output",
                "replays",
                `${componentNames.join("-")}-multi`
              );
        displayLine = `riptide replay (multi-component): components=${componentNames.join(", ")}\n`;
      } else {
        adapterPath = path.resolve(configDir, parsed.adapter as string);
        trajectoryDir = path.resolve(configDir, parsed.trajectory_dir as string);
        outputPath =
          typeof parsed.output_path === "string" && parsed.output_path.length > 0
            ? path.resolve(configDir, parsed.output_path)
            : path.join(
                "riptide-output",
                "replays",
                path.basename(trajectoryDir)
              );
        displayLine = `riptide replay: adapter=${adapterPath} trajectory=${trajectoryDir}\n`;
      }

      if (!formatJson) {
        process.stderr.write(chalk.bold(displayLine));
      }

      const spinner = isTTY
        ? ora({ text: "Running replay...", stream: process.stderr }).start()
        : null;
      const startTime = Date.now();

      let result;
      let invariantFiring = false;
      try {
        result = await runReplayOrchestrator(
          isMulti
            ? { configPath: absConfig, outputPath }
            : {
                adapterPath: adapterPath!,
                trajectoryDir: trajectoryDir!,
                outputPath
              },
          {
            allowInvariantViolations: Boolean(cliOpts.allowInvariantViolations)
          }
        );
      } catch (err) {
        // re-review fix: the orchestrator attaches
        // the parsed SimulationResult to the error when the engine
        // exits 1 due to an invariant firing (the canonical "replay
        // reproduces the cascade" case). Surface that result to the
        // user instead of discarding it — the default exit code
        // stays 1 so scripts/CI still notice the firing, but the
        // report, table, and artifact all get produced. `--allow-
        // invariant-violations` keeps the exit-0 shape from the
        // happy path.
        const e = err as Error & {
          simulationResult?: typeof result;
          exitCode?: number;
        };
        if (e.simulationResult) {
          invariantFiring = true;
          result = e.simulationResult;
          if (spinner) {
            spinner.warn(
              chalk.yellow(
                `Replay completed with ${e.exitCode ?? 1} invariant violation(s)`
              )
            );
          }
        } else {
          if (spinner) spinner.fail(chalk.red("Replay failed"));
          if (formatJson) {
            process.stdout.write(JSON.stringify({ error: e.message }, null, 2));
          } else {
            process.stderr.write(chalk.red(`\n✗ Replay failed: ${e.message}\n`));
          }
          process.exitCode = 1;
          return;
        }
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (spinner && !invariantFiring) {
        spinner.succeed(chalk.green(`Replay complete (${elapsed}s, ${result.total_ticks} ticks)`));
      }

      if (formatJson) {
        process.stdout.write(JSON.stringify(result, null, 2));
      } else {
        if (isTTY) {
          process.stdout.write(`\n${renderColoredTable(result)}\n\n`);
        } else {
          process.stdout.write(`${renderSummary(result)}\n\n`);
        }
        process.stdout.write(`${renderTimeline(result)}\n`);
      }

      const reproCommand = `riptide replay ${configArg}`;
      // Multi-component replays do not have a single adapter path;
      // fall back to the config file path for the narrative surface
      // so the rerun hint still points at a concrete file the user
      // can inspect.
      const narrativeAdapterPath = adapterPath ?? absConfig;
      const artifactPath = await writeArtifacts(result, outputPath, {
        narrativeConfig: {
          adapterPath: narrativeAdapterPath,
          reproCommand
        }
      });

      if (!formatJson) {
        process.stderr.write(chalk.green(`Wrote artifact: ${artifactPath}\n`));
        const reportNote = path.join(path.dirname(artifactPath), "report.md");
        process.stderr.write(chalk.green(`Wrote report:   ${reportNote}\n`));
      }

      // Evidence pack — additive emission. Reviewer runs see the
      // pack path immediately after the result artifact line, which
      // is the path they forward to auditors.
      try {
        const componentAdapters: Record<string, string> = {};
        const trajectoryDirs: Record<string, string> = {};
        if (isMulti) {
          const components = parsed.components as MultiComponentEntry[];
          for (const component of components) {
            if (
              typeof component.name === "string" &&
              typeof component.adapter === "string" &&
              typeof component.trajectory_dir === "string"
            ) {
              componentAdapters[component.name] = path.resolve(configDir, component.adapter);
              trajectoryDirs[component.name] = path.resolve(configDir, component.trajectory_dir);
            }
          }
        }
        const cwd = process.cwd();
        const relConfig = path.relative(cwd, absConfig) || absConfig;
        const emission = await emitPack({
          simulationResultPath: artifactPath,
          cwd,
          configPath: absConfig,
          adapterPath: isMulti ? undefined : adapterPath,
          componentAdapters: isMulti ? componentAdapters : undefined,
          trajectoryDirs: isMulti && Object.keys(trajectoryDirs).length > 0 ? trajectoryDirs : undefined,
          commandHint: `exec riptide replay ${posixQuote(relConfig)}`,
          adapterDisplay: isMulti
            ? `multi-component replay (${Object.keys(componentAdapters).join(" × ")})`
            : undefined
        });
        if (!formatJson) {
          process.stderr.write(chalk.green(`Wrote pack:     ${emission.packDir}\n`));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(chalk.yellow(`warn: pack emission failed: ${msg}\n`));
      }

      if (!formatJson && invariantFiring) {
        process.stderr.write(
          chalk.yellow(
            "Note: one or more declared invariants fired. Exit code 1. " +
              "Pass --allow-invariant-violations to restore exit 0.\n"
          )
        );
      }

      if (invariantFiring) {
        process.exitCode = 1;
      }

      if (cliOpts.serve) {
        const handle = await startDashboardServer(path.dirname(artifactPath));
        process.stderr.write(chalk.cyan(`Dashboard: ${handle.url}\n`));
        process.stderr.write(chalk.gray(`  (Ctrl-C to stop)\n`));
        await blockUntilSignal(handle);
      }
    });
}

/**
 * POSIX-safe single-quote wrap for a shell argument.
 *
 * Double-quoting still runs `$(...)`, backticks, and `$VAR`
 * expansion against the reviewer's environment — a forwarded pack
 * with a filename like `fixtures/$(id).toml` would execute `id` on
 * the reviewer's machine. Single-quote wrapping with the classic
 * `'\''` close/escape/reopen dance turns every byte literal.
 * See F-2026-04-21-S12P1-001.
 */
function posixQuote(value: string): string {
  if (/^[-_./A-Za-z0-9]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
