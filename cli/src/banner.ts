import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import chalk from "chalk";

export interface BannerFlags {
  json?: boolean;
  quiet?: boolean;
  format?: unknown;
}

export interface BannerDecisionInput {
  env: NodeJS.ProcessEnv;
  flags?: BannerFlags;
  isTTY: boolean;
}

export interface BannerDecision {
  print: boolean;
  color: boolean;
}

export interface PrintBannerOptions {
  env?: NodeJS.ProcessEnv;
  flags?: BannerFlags;
  isTTY?: boolean;
  stdoutWrite?: (chunk: string) => void;
  version?: string;
}

const PRIMARY_ACCENT = "#53d5d1";
const SECONDARY_TEXT = "#A8A8A8";

const RIPTIDE_INIT_LOGO_LINES = [
  ".......   ...   ......    .......  ...   .......   .......",
  "..   ..   ...   ..   ..     ..     ...   ..   ...  ...    ",
  ".......   ...   ..  ...     ..     ...   ..   ...  .......",
  "..  ..    ...   ..          ..     ...   ..   ...  ...    ",
  "..   ..   ...   ..          ..     ...   .......   ......."
];

export function bannerDecision(input: BannerDecisionInput): BannerDecision {
  const flags = input.flags ?? {};
  if (!input.isTTY) return { print: false, color: false };
  if (Boolean(flags.json) || flags.format === "json") return { print: false, color: false };
  if (Boolean(flags.quiet)) return { print: false, color: false };
  if (truthyEnv(input.env.CI)) return { print: false, color: false };
  if (truthyEnv(input.env.RIPTIDE_NO_BANNER)) return { print: false, color: false };
  return { print: true, color: !Object.prototype.hasOwnProperty.call(input.env, "NO_COLOR") };
}

export function shouldPrintBanner(input: BannerDecisionInput): boolean {
  return bannerDecision(input).print;
}

export function renderBanner(version: string, color = true): string {
  const accent = color ? (value: string) => chalk.hex(PRIMARY_ACCENT).bold(value) : (value: string) => value;
  return [
    accent("RIPTIDE"),
    accent(`Riptide v${version}`),
    "Deterministic Solana simulation evidence.",
    "",
    ""
  ].join("\n");
}

export function printBanner(options: PrintBannerOptions = {}): void {
  const env = options.env ?? process.env;
  const isTTY = options.isTTY ?? Boolean(process.stdout.isTTY);
  const decision = bannerDecision({ env, flags: options.flags, isTTY });
  if (!decision.print) return;
  const write = options.stdoutWrite ?? ((chunk: string) => process.stdout.write(chunk));
  write(renderBanner(options.version ?? cliPackageVersion(), decision.color));
}

export function renderInitBanner(version: string, color = true): string {
  const accent = color ? (value: string) => chalk.hex(PRIMARY_ACCENT).bold(value) : (value: string) => value;
  const dim = color ? (value: string) => chalk.hex(SECONDARY_TEXT)(value) : (value: string) => value;
  const tagline = `Riptide v${version} · Deterministic Solana simulation evidence.`;
  return [
    "",
    ...RIPTIDE_INIT_LOGO_LINES.map((line) => accent(line)),
    "",
    dim(tagline),
    "",
    ""
  ].join("\n");
}

export function printInitBanner(options: PrintBannerOptions = {}): void {
  const env = options.env ?? process.env;
  const isTTY = options.isTTY ?? Boolean(process.stdout.isTTY);
  const decision = bannerDecision({ env, flags: options.flags, isTTY });
  if (!decision.print) return;
  const write = options.stdoutWrite ?? ((chunk: string) => process.stdout.write(chunk));
  write(renderInitBanner(options.version ?? cliPackageVersion(), decision.color));
}

export function cliPackageVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "..", "..", "package.json"),
    path.resolve(here, "..", "package.json")
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.length > 0) {
        return parsed.version;
      }
    } catch {
      // Try the next source/build layout.
    }
  }
  return "unknown";
}

function truthyEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}
