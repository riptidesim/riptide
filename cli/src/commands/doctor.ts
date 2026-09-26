// `riptide doctor` — top-level health-check command.
//
// Static diagnostic only. NO build, NO network, NO simulation. Reports
// on toolchain presence, engine binary resolution, and per-adapter
// load + lint status in one compact summary table.
//
// Exit codes:
//   0 — all checks passed
//   1 — at least one warn, no fails
//   2 — at least one fail
//
// `--json` writes one command envelope to stdout (src/contract): a
// success envelope carrying the report for PASS and WARN, and the error
// shape — with the report attached as `data` — for FAIL or when the
// report cannot be assembled. Exit codes are the same in both modes.
//
// Output style mirrors the existing `riptide lint` voice: bold header,
// per-section blocks, a verdict line. Color decisions defer to chalk's
// own TTY / NO_COLOR / FORCE_COLOR detection unless tests force a
// specific mode.

import chalk, { Chalk } from "chalk";
import { Command } from "commander";
import path from "node:path";

import {
  buildDoctorReport,
  type DoctorAdapter,
  type DoctorCheck,
  type DoctorReport,
  type DoctorStatus,
} from "../doctor/index.js";
import {
  errorEnvelope,
  renderEnvelope,
  resolveCommandIO,
  successEnvelope,
  type CommandError,
  type CommandIO,
} from "../contract/index.js";

export interface DoctorCommandDeps extends CommandIO {
  /** Test seam — force color on/off. Defaults to chalk's own detection. */
  color?: boolean;
  /** Test seam — override report builder (used to inject toolchain probe stubs). */
  buildReport?: typeof buildDoctorReport;
  /** Test seam — override env. */
  env?: NodeJS.ProcessEnv;
}

export interface DoctorOptions {
  json?: boolean;
}

export function createDoctorCommand(deps: DoctorCommandDeps = {}): Command {
  const command = new Command("doctor")
    .description(
      "Static health check — toolchain presence and adapter load + lint status. No build, no network, no simulation."
    )
    .option("--json", "Emit the report as a command envelope", false);

  return command.action(async (options: DoctorOptions) => {
    const code = await runDoctor(options, deps);
    process.exit(code);
  });
}

/** Returns the exit code instead of calling `process.exit`. Test seam. */
export async function runDoctor(
  options: DoctorOptions,
  deps: DoctorCommandDeps = {}
): Promise<number> {
  const { stdout, stderr, cwd } = resolveCommandIO(deps);
  const env = deps.env ?? process.env;
  const builder = deps.buildReport ?? buildDoctorReport;

  let report: DoctorReport;
  try {
    report = await builder({ cwd, env });
  } catch (err) {
    const message = `failed to assemble report: ${(err as Error).message ?? String(err)}`;
    if (options.json) {
      stdout(
        renderEnvelope(
          errorEnvelope("doctor", {
            code: "doctor_report_failed",
            message,
            next: "check that the working directory and its .riptide/adapters/ are readable, then rerun `riptide doctor --json`",
          })
        )
      );
    } else {
      stderr(`riptide doctor: ${message}\n`);
    }
    return 2;
  }

  if (options.json) {
    const data = doctorReportJson(report);
    stdout(
      renderEnvelope(
        report.exitCode === 2
          ? errorEnvelope("doctor", doctorFailure(report), data)
          : successEnvelope("doctor", data)
      )
    );
  } else {
    stdout(renderDoctorReport(report, { color: deps.color }));
  }
  return report.exitCode;
}

export interface DoctorReportJson {
  verdict: DoctorStatus;
  exit_code: 0 | 1 | 2;
  counts: AggregateCounts;
  cwd: string;
  environment: DoctorCheck[];
  adapters: DoctorAdapter[];
}

function doctorReportJson(report: DoctorReport): DoctorReportJson {
  return {
    verdict: report.exitCode === 0 ? "pass" : report.exitCode === 1 ? "warn" : "fail",
    exit_code: report.exitCode,
    counts: aggregateCounts(report),
    cwd: report.cwd,
    environment: report.environment,
    adapters: report.adapters,
  };
}

function doctorFailure(report: DoctorReport): CommandError {
  const failed = [
    ...report.environment
      .filter((c) => c.status === "fail")
      .map((c) => ({ subject: c.label, hint: c.hint })),
    ...report.adapters
      .filter((a) => effectiveAdapterStatus(a) === "fail")
      .map((a) => ({ subject: `adapter ${a.name}`, hint: a.hint })),
  ];
  const first = failed.find((f) => f.hint) ?? failed[0];
  return {
    code: "doctor_checks_failed",
    message: `${failed.length} doctor check${failed.length === 1 ? "" : "s"} failed: ${failed
      .map((f) => f.subject)
      .join(", ")}`,
    next: first?.hint
      ? `${first.subject}: ${first.hint}`
      : "fix the failing checks listed in data, then rerun `riptide doctor --json`",
  };
}

export interface RenderOptions {
  color?: boolean;
}

export function renderDoctorReport(report: DoctorReport, opts: RenderOptions = {}): string {
  const colorize = createColorizer(opts.color);
  const lines: string[] = [];

  lines.push(colorize.bold("Doctor — Riptide health check"));
  lines.push(colorize.dim(`cwd: ${report.cwd}`));
  lines.push("");

  // ---- Environment ----
  lines.push(colorize.bold("Environment"));
  if (report.environment.length === 0) {
    lines.push("  (no checks)");
  } else {
    for (const c of report.environment) {
      lines.push(formatCheckLine(c, colorize));
    }
  }
  lines.push("");

  // ---- Adapters ----
  lines.push(colorize.bold("Adapters"));
  if (report.adapters.length === 0) {
    lines.push("  (none discovered)");
    lines.push(
      colorize.dim(
        "  hint: `riptide init` to scaffold .riptide/adapters/, or run from inside the Riptide monorepo"
      )
    );
  } else {
    for (const a of report.adapters) {
      lines.push(formatAdapterLine(a, colorize, report.cwd));
    }
  }
  lines.push("");

  // ---- Verdict ----
  const counts = aggregateCounts(report);
  lines.push(colorize.bold("Summary"));
  lines.push(
    `  ${formatStatus("pass", colorize)}:${counts.pass}  ${formatStatus("warn", colorize)}:${counts.warn}  ${formatStatus("fail", colorize)}:${counts.fail}`
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
      "Static diagnostic only — no build, no network, no simulation. This is the per-adapter report; use `riptide readiness .` to inspect protocol evidence readiness."
    )
  );
  lines.push("");

  return lines.join("\n");
}

function formatCheckLine(c: DoctorCheck, colorize: Colorizer): string {
  const head = `  ${formatStatus(c.status, colorize)} ${c.label}`;
  const detailParts: string[] = [];
  if (c.actual) detailParts.push(c.actual);
  if (c.expected) detailParts.push(colorize.dim(`expected ${c.expected}`));
  const detail = detailParts.length > 0 ? `  ${detailParts.join(" — ")}` : "";
  const lines = [`${head}${detail}`];
  if (c.hint) {
    lines.push(`      ${colorize.dim("hint:")} ${c.hint}`);
  }
  return lines.join("\n");
}

function formatAdapterLine(a: DoctorAdapter, colorize: Colorizer, cwd: string): string {
  const status = effectiveAdapterStatus(a);
  const rel = relativizeIfInside(a.path, cwd);
  const sourceTag =
    a.source === "user-repo-riptide-dir"
      ? colorize.dim("(.riptide)")
      : colorize.dim("(fixtures)");
  const lines = [
    `  ${formatStatus(status, colorize)} ${a.name} ${sourceTag}  ${colorize.dim(rel)}`,
  ];
  const noteParts: string[] = [];
  noteParts.push(`load=${plainStatus(a.load, colorize)}`);
  noteParts.push(`lint=${plainStatus(a.lint, colorize)}`);
  if (a.note) noteParts.push(a.note);
  lines.push(`      ${noteParts.join("  ·  ")}`);
  if (a.hint) {
    lines.push(`      ${colorize.dim("hint:")} ${a.hint}`);
  }
  return lines.join("\n");
}

function effectiveAdapterStatus(a: DoctorAdapter): DoctorStatus {
  if (a.load === "fail" || a.lint === "fail") return "fail";
  if (a.load === "warn" || a.lint === "warn") return "warn";
  return "pass";
}

function relativizeIfInside(p: string, cwd: string): string {
  const rel = path.relative(cwd, p);
  if (!rel || rel.startsWith("..")) return p;
  return rel;
}

interface AggregateCounts {
  pass: number;
  warn: number;
  fail: number;
}

function aggregateCounts(report: DoctorReport): AggregateCounts {
  const counts: AggregateCounts = { pass: 0, warn: 0, fail: 0 };
  for (const c of report.environment) counts[c.status] += 1;
  for (const a of report.adapters) counts[effectiveAdapterStatus(a)] += 1;
  return counts;
}

// ---------- color helpers ----------

interface Colorizer {
  bold: (s: string) => string;
  dim: (s: string) => string;
  red: (s: string) => string;
  yellow: (s: string) => string;
  green: (s: string) => string;
  cyan: (s: string) => string;
  bgGreen: (s: string) => string;
  bgYellow: (s: string) => string;
  bgRed: (s: string) => string;
}

function createColorizer(force: boolean | undefined): Colorizer {
  if (force === false) {
    const id = (s: string) => s;
    return {
      bold: id,
      dim: id,
      red: id,
      yellow: id,
      green: id,
      cyan: id,
      bgGreen: id,
      bgYellow: id,
      bgRed: id,
    };
  }
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
  };
}

function formatStatus(status: DoctorStatus, colorize: Colorizer): string {
  switch (status) {
    case "pass":
      return colorize.bgGreen(" PASS ");
    case "warn":
      return colorize.bgYellow(" WARN ");
    case "fail":
      return colorize.bgRed(" FAIL ");
  }
}

function plainStatus(status: DoctorStatus, colorize: Colorizer): string {
  switch (status) {
    case "pass":
      return colorize.green("pass");
    case "warn":
      return colorize.yellow("warn");
    case "fail":
      return colorize.red("fail");
  }
}
