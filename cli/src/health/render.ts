// Rendering for the health check that `riptide readiness` reports: the
// `health` block of the --json envelope, the error shape for a failing
// check, and the text section that follows the readiness markdown.

import chalk, { Chalk } from "chalk";
import path from "node:path";

import type { CommandError } from "../contract/index.js";
import type { HealthAdapter, HealthCheck, HealthReport, HealthStatus } from "./index.js";

export interface HealthReportJson {
  verdict: HealthStatus;
  counts: AggregateCounts;
  cwd: string;
  environment: HealthCheck[];
  adapters: HealthAdapter[];
}

export function healthReportJson(report: HealthReport): HealthReportJson {
  return {
    verdict: report.exitCode === 0 ? "pass" : report.exitCode === 1 ? "warn" : "fail",
    counts: aggregateCounts(report),
    cwd: report.cwd,
    environment: report.environment,
    adapters: report.adapters,
  };
}

export function healthFailure(report: HealthReport): CommandError {
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
    code: "health_checks_failed",
    message: `${failed.length} health check${failed.length === 1 ? "" : "s"} failed: ${failed
      .map((f) => f.subject)
      .join(", ")}`,
    next: first?.hint
      ? `${first.subject}: ${first.hint}`
      : "fix the failing checks listed in data, then rerun `riptide readiness <path> --json`",
  };
}

export interface RenderOptions {
  color?: boolean;
}

export function renderHealthReport(report: HealthReport, opts: RenderOptions = {}): string {
  const colorize = createColorizer(opts.color);
  const lines: string[] = [];

  lines.push(colorize.bold("Health — toolchain and adapters"));
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
  lines.push(`  Verdict: ${verdict}`);
  lines.push("");

  lines.push(
    colorize.dim(
      "Static diagnostic only — no build, no network, no simulation."
    )
  );
  lines.push("");

  return lines.join("\n");
}

function formatCheckLine(c: HealthCheck, colorize: Colorizer): string {
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

function formatAdapterLine(a: HealthAdapter, colorize: Colorizer, cwd: string): string {
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

function effectiveAdapterStatus(a: HealthAdapter): HealthStatus {
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

function aggregateCounts(report: HealthReport): AggregateCounts {
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

function formatStatus(status: HealthStatus, colorize: Colorizer): string {
  switch (status) {
    case "pass":
      return colorize.bgGreen(" PASS ");
    case "warn":
      return colorize.bgYellow(" WARN ");
    case "fail":
      return colorize.bgRed(" FAIL ");
  }
}

function plainStatus(status: HealthStatus, colorize: Colorizer): string {
  switch (status) {
    case "pass":
      return colorize.green("pass");
    case "warn":
      return colorize.yellow("warn");
    case "fail":
      return colorize.red("fail");
  }
}
