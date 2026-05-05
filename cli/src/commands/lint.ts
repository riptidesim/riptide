// `riptide lint <adapter>` — static adapter validator.
//
// Reads an adapter TOML, resolves the `[lineage].idl_source`, and —
// when the source is a JSON IDL — cross-checks the adapter's mapped
// instructions / args / accounts / dotted field references against the
// IDL.
//
// Honesty rules:
// - JSON IDL is the only machine-checkable source kind.
// - Rust-source `idl_source` (e.g. `programs/lending_pool/src/state.rs`)
//   is warn-only. No fake parser.
// - Missing `[lineage]` block is a SKIP, not a PASS.
// - Positive mismatches are failures.
//
// Exit codes:
//   0 — no failures, no warnings (or pure SKIP)
//   1 — warnings only (non-JSON lineage, uncovered surfaces, …)
//   2 — at least one concrete failure (missing instruction / arg /
//       account / field; unreadable or unparseable IDL; adapter load
//       failure)

import chalk, { Chalk } from "chalk";
import { Command } from "commander";
import { readFileSync } from "node:fs";
import path from "node:path";

import { loadAdapter, defaultFixturesRoot } from "../adapter/resolve.js";
import { monorepoRootFromModule } from "../orchestrator/index.js";
import {
  lintAdapter,
  type LintReport,
  type LintFinding,
  type LintLevel,
} from "../lint/index.js";
import { printBanner } from "../banner.js";

export interface LintCommandDeps {
  fixturesRoot?: string;
  repoRoot?: string;
  stdoutWrite?: (chunk: string) => void;
  stderrWrite?: (chunk: string) => void;
  /** Force color on/off for tests; defaults to chalk's own TTY/NO_COLOR detection. */
  color?: boolean;
}

export interface LintOptions {
  // Reserved for future flags (e.g. `--json` for machine-readable output).
  quiet?: boolean;
}

export function createLintCommand(deps: LintCommandDeps = {}): Command {
  const command = new Command("lint")
    .description(
      "Static validation of an adapter TOML against its [lineage] IDL source (JSON IDL only — non-JSON sources are warn-only)"
    )
    .argument(
      "<adapter>",
      "Adapter name (e.g. amm) resolved under fixtures/adapters/, or an explicit path to an adapter TOML"
    )
    .option("--quiet", "Suppress interactive banner", false);

  return command.action(async (adapter: string, options: LintOptions) => {
    printBanner({ flags: { quiet: Boolean(options.quiet) } });
    const exitCode = await runLint(adapter, options, deps);
    process.exit(exitCode);
  });
}

/**
 * Run the lint pipeline for one adapter. Returns the exit code rather
 * than calling `process.exit`, matching the `runLineage` / `runAdapt`
 * testability pattern.
 */
export async function runLint(
  adapterArg: string,
  _options: LintOptions,
  deps: LintCommandDeps = {}
): Promise<number> {
  const stdout = deps.stdoutWrite ?? ((chunk: string) => process.stdout.write(chunk));
  const stderr = deps.stderrWrite ?? ((chunk: string) => process.stderr.write(chunk));
  const useColor = deps.color ?? undefined;

  const loaded = await loadAdapter(adapterArg, deps.fixturesRoot);
  if (!loaded.ok) {
    switch (loaded.error.kind) {
      case "not-found":
        stderr(
          `riptide lint: adapter not found for \`${loaded.error.arg}\`. Pass an explicit path, or check that .riptide/adapters/${loaded.error.arg}.toml exists in the current repo, or that fixtures/adapters/${loaded.error.arg}.toml exists in the Riptide monorepo.\n`
        );
        return 2;
      case "read-failed":
        stderr(
          `riptide lint: could not read adapter at ${loaded.error.path}: ${loaded.error.message}\n`
        );
        return 2;
      case "validation-failed":
        stderr(renderValidationFailed(loaded.error, adapterArg));
        return 2;
    }
  }

  const repoRoot = deps.repoRoot ?? deriveRepoRoot(loaded.value.resolved.path, deps.fixturesRoot);

  const report = await lintAdapter({
    adapter: loaded.value.adapter,
    adapterPath: loaded.value.resolved.path,
    adapterName: loaded.value.resolved.displayName,
    repoRoot,
  });

  stdout(renderLintReport(report, { color: useColor }));
  return report.exitCode;
}

function renderValidationFailed(
  error: { path: string; message: string },
  adapterArg: string
): string {
  const stubHint = initStubValidationHint(error.path, error.message, adapterArg);
  if (stubHint) return stubHint;
  return (
    `riptide lint: adapter failed validation: ${error.message}\n` +
    `next step: fix the adapter TOML schema error above, then rerun \`riptide lint ${adapterArg}\`.\n`
  );
}

function initStubValidationHint(
  adapterPath: string,
  validationMessage: string,
  adapterArg: string
): string | null {
  let raw: string;
  try {
    raw = readFileSync(adapterPath, "utf8");
  } catch {
    return null;
  }

  const looksLikeInitScaffold =
    raw.includes("This is a stub") ||
    raw.includes("thin default bootstrap") ||
    raw.includes("wizard scaffold");
  if (!looksLikeInitScaffold || !raw.includes("TODO:")) {
    return null;
  }

  const rel = path.relative(process.cwd(), adapterPath);
  const displayPath =
    rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel)
      ? rel
      : adapterPath;

  return (
    `riptide lint: adapter is still an incomplete \`riptide init\` stub: ${adapterPath}\n` +
    `schema check stopped at: ${validationMessage}\n` +
    `next step: invoke \`/riptide-config\` to finish the adapter, harness, scenarios, and campaign. ` +
    `Manual / advanced path: open ${displayPath} and fill the TODO blocks for accounts, instructions, state_mapping, actions, observations, and personas. ` +
    `Then rerun \`riptide lint ${adapterArg}\`.\n`
  );
}

export interface RenderOptions {
  color?: boolean;
}

/**
 * Render a lint report for human consumption. Tests pin key lines; a
 * separate JSON output path can be added behind `--json` later without
 * reshaping this renderer.
 */
export function renderLintReport(report: LintReport, opts: RenderOptions = {}): string {
  const colorize = createColorizer(opts.color);
  const lines: string[] = [];
  lines.push(colorize.bold(`Lint — ${report.adapterName}`));
  lines.push("");

  switch (report.sourceKind) {
    case "missing-lineage":
      lines.push(`Source kind: ${colorize.dim("(no [lineage] block)")}`);
      break;
    case "non-json":
      lines.push(
        `Source kind: ${colorize.yellow("non-JSON")} — ${report.resolvedSourcePath ?? "(unresolved)"}`
      );
      break;
    case "json-idl":
      lines.push(
        `Source kind: ${colorize.cyan("JSON IDL")} — ${report.resolvedSourcePath ?? "(unresolved)"}`
      );
      break;
  }
  lines.push("");

  if (report.coverage) {
    const c = report.coverage;
    lines.push(colorize.bold("Coverage"));
    lines.push(`  Mapped instructions         : ${c.mappedInstructions.length}`);
    lines.push(`  Recognized unsupported (ix) : ${c.recognizedUnsupportedInstructions.length}`);
    lines.push(`  Uncovered instructions      : ${c.uncoveredInstructions.length}`);
    lines.push(`  Mapped accounts             : ${c.mappedAccounts.length}`);
    lines.push(`  Mapped account.field refs   : ${c.mappedFields.length}`);
    lines.push(`  Uncovered account.field     : ${c.uncoveredFields.length}`);
    lines.push("");
  }

  lines.push(colorize.bold("Findings"));
  if (report.findings.length === 0) {
    lines.push("  (none)");
  } else {
    for (const f of report.findings) {
      lines.push(`  ${formatLevel(f.level, colorize)} [${f.code}] ${f.subject}`);
      lines.push(`      ${f.message}`);
      if (f.hint) {
        lines.push(`      ${colorize.dim("hint:")} ${f.hint}`);
      }
    }
  }
  lines.push("");

  const counts = countByLevel(report.findings);
  lines.push(colorize.bold("Summary"));
  lines.push(
    `  ${formatLevel("pass", colorize)}:${counts.pass}  ${formatLevel("warn", colorize)}:${counts.warn}  ${formatLevel("fail", colorize)}:${counts.fail}  ${formatLevel("skip", colorize)}:${counts.skip}`
  );

  const verdict =
    report.exitCode === 0
      ? colorize.green("PASS")
      : report.exitCode === 1
        ? colorize.yellow("WARN")
        : colorize.red("FAIL");
  lines.push(`  Verdict: ${verdict} (exit ${report.exitCode})`);
  lines.push("");

  lines.push(
    colorize.dim(
      "Static validation only — no IDL fetch, no program build, no simulation. JSON IDL sources are machine-checked; non-JSON sources are inspection-only."
    )
  );
  lines.push("");

  return lines.join("\n");
}

// ---------- rendering helpers ----------

type Colorizer = {
  bold: (s: string) => string;
  dim: (s: string) => string;
  red: (s: string) => string;
  yellow: (s: string) => string;
  green: (s: string) => string;
  cyan: (s: string) => string;
  bgGreen: (s: string) => string;
  bgYellow: (s: string) => string;
  bgRed: (s: string) => string;
  bgGray: (s: string) => string;
};

function createColorizer(force: boolean | undefined): Colorizer {
  if (force === false) {
    const identity = (s: string) => s;
    return {
      bold: identity,
      dim: identity,
      red: identity,
      yellow: identity,
      green: identity,
      cyan: identity,
      bgGreen: identity,
      bgYellow: identity,
      bgRed: identity,
      bgGray: identity,
    };
  }
  // When force === true, bypass chalk's own detection; when
  // force === undefined, let chalk decide based on TTY / NO_COLOR /
  // FORCE_COLOR semantics.
  if (force === true) {
    const active = new Chalk({ level: 1 });
    return {
      bold: (s) => active.bold(s),
      dim: (s) => active.dim(s),
      red: (s) => active.red(s),
      yellow: (s) => active.yellow(s),
      green: (s) => active.green(s),
      cyan: (s) => active.cyan(s),
      bgGreen: (s) => active.bgGreen.black(s),
      bgYellow: (s) => active.bgYellow.black(s),
      bgRed: (s) => active.bgRed.white(s),
      bgGray: (s) => active.bgGray.black(s),
    };
  }
  return {
    bold: (s) => chalk.bold(s),
    dim: (s) => chalk.dim(s),
    red: (s) => chalk.red(s),
    yellow: (s) => chalk.yellow(s),
    green: (s) => chalk.green(s),
    cyan: (s) => chalk.cyan(s),
    bgGreen: (s) => chalk.bgGreen.black(s),
    bgYellow: (s) => chalk.bgYellow.black(s),
    bgRed: (s) => chalk.bgRed.white(s),
    bgGray: (s) => chalk.bgGray.black(s),
  };
}

function formatLevel(level: LintLevel, colorize: Colorizer): string {
  switch (level) {
    case "pass":
      return colorize.bgGreen(" PASS ");
    case "warn":
      return colorize.bgYellow(" WARN ");
    case "fail":
      return colorize.bgRed(" FAIL ");
    case "skip":
      return colorize.bgGray(" SKIP ");
  }
}

function countByLevel(
  findings: LintFinding[]
): { pass: number; warn: number; fail: number; skip: number } {
  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const f of findings) counts[f.level] += 1;
  return counts;
}

/**
 * Derive the repo root used to resolve a relative `[lineage].idl_source`.
 *
 * Priority order:
 *   1. Adapter-path-derived root — if the adapter sits at
 *      `<root>/fixtures/adapters/<name>.toml` (shipping convention),
 *      `<root>` is used. This is the critical path for external
 *      adapters: the user ran `riptide lint /tmp/my-repo/fixtures/
 *      adapters/foo.toml` and expects the IDL at
 *      `/tmp/my-repo/fixtures/idls/foo.json`, not in the Riptide
 *      monorepo.
 *   2. Explicit `fixturesRoot` override's parent — used when the caller
 *      (tests, downstream tooling) supplied a `fixturesRoot` without an
 *      explicit `repoRoot`.
 *   3. Module-derived monorepo root, then cwd.
 *
 * The adapter-directory itself is always a correct fallback, so
 * `lint/index.ts::resolveLineageSource` also tries adapter-relative
 * resolution if the repo-rooted candidate does not exist.
 */
export function deriveRepoRoot(
  adapterPath: string,
  fixturesRootOverride: string | undefined
): string {
  const derived = deriveRepoRootFromAdapterPath(adapterPath);
  if (derived) return derived;
  if (fixturesRootOverride) return path.resolve(fixturesRootOverride, "..");
  const moduleRoot = monorepoRootFromModule();
  if (moduleRoot) return moduleRoot;
  const fixtures = defaultFixturesRoot();
  return path.resolve(fixtures, "..");
}

function deriveRepoRootFromAdapterPath(adapterPath: string): string | null {
  // Shipping convention: `<root>/fixtures/adapters/<name>.toml`.
  const adapterDir = path.dirname(adapterPath);
  const adapterDirParent = path.dirname(adapterDir);
  if (
    path.basename(adapterDir) === "adapters" &&
    path.basename(adapterDirParent) === "fixtures"
  ) {
    return path.dirname(adapterDirParent);
  }
  // Downstream repo convention: `<root>/.riptide/adapters/<name>.toml`.
  if (
    path.basename(adapterDir) === "adapters" &&
    path.basename(adapterDirParent) === ".riptide"
  ) {
    return path.dirname(adapterDirParent);
  }
  return null;
}
