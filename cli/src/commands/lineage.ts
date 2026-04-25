// `riptide lineage <adapter>` — reviewer-readable inspection of an
// adapter's `[lineage]` block.
//
// Inspection-only in Sprint 12: this command does NOT fetch IDLs at
// run-time, does NOT validate the adapter against the IDL, and does
// NOT generate lineage automatically. It reads the TOML, locates the
// optional `[lineage]` block, and prints it in a reviewer-readable
// format. Sprint 13's adapter linter will consume the same metadata
// to validate IDL-vs-adapter coverage.
//
// Exit codes:
//   0 — adapter loaded and lineage rendered (including the "no lineage
//       recorded" line for adapters that pre-date the lineage surface)
//   1 — unexpected render / IO error after the adapter parsed
//   2 — adapter not found, unreadable, or failed validation
//
// Adapter resolution:
// 1. If the argument exists as a filesystem path (after `path.resolve`),
//    that file is loaded directly.
// 2. Otherwise the argument is treated as an adapter NAME and resolved
//    against `<monorepo>/fixtures/adapters/<name>.toml` (override via
//    $RIPTIDE_FIXTURES_ROOT). This is the `riptide lineage lending`
//    shorthand the reviewer-readable flow assumes.

import { Command } from "commander";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import TOML from "toml";

import { validateAdapter, type Adapter, type AdapterLineage } from "../schemas/adapter.js";
import { monorepoRootFromModule } from "../orchestrator/index.js";

export interface LineageCommandDeps {
  /** Override the fixtures root used for adapter-name resolution. */
  fixturesRoot?: string;
  /** Stdout sink (defaults to `process.stdout.write`). Tests inject a buffer. */
  stdoutWrite?: (chunk: string) => void;
  /** Stderr sink (defaults to `process.stderr.write`). Tests inject a buffer. */
  stderrWrite?: (chunk: string) => void;
}

export interface LineageOptions {
  // No options in Sprint 12 — a single positional adapter argument is
  // the full surface. Reserved for Sprint 13 flags (e.g. `--json`).
}

export function createLineageCommand(deps: LineageCommandDeps = {}): Command {
  const command = new Command("lineage")
    .description(
      "Print an adapter's [lineage] block in reviewer-readable form (inspection-only — no IDL fetch, no validation against IDL)"
    )
    .argument(
      "<adapter>",
      "Adapter name (e.g. lending) resolved under fixtures/adapters/, or an explicit path to an adapter TOML"
    );

  return command.action(async (adapter: string, options: LineageOptions) => {
    const exitCode = await runLineage(adapter, options, deps);
    process.exit(exitCode);
  });
}

export async function runLineage(
  adapterArg: string,
  _options: LineageOptions,
  deps: LineageCommandDeps = {}
): Promise<number> {
  const stdout = deps.stdoutWrite ?? ((chunk: string) => process.stdout.write(chunk));
  const stderr = deps.stderrWrite ?? ((chunk: string) => process.stderr.write(chunk));

  const resolved = resolveAdapterPath(adapterArg, deps.fixturesRoot);
  if (resolved === null) {
    stderr(
      `riptide lineage: adapter not found for \`${adapterArg}\`. Pass an explicit path, or check that .riptide/adapters/${adapterArg}.toml exists in the current repo, or that fixtures/adapters/${adapterArg}.toml exists in the Riptide monorepo.\n`
    );
    return 2;
  }

  let raw: string;
  try {
    raw = await readFile(resolved.path, "utf8");
  } catch (err) {
    stderr(
      `riptide lineage: could not read adapter at ${resolved.path}: ${errMessage(err)}\n`
    );
    return 2;
  }

  let adapter: Adapter;
  try {
    const parsed = TOML.parse(raw);
    adapter = validateAdapter(parsed, resolved.path);
  } catch (err) {
    stderr(
      `riptide lineage: adapter failed validation: ${errMessage(err)}\n`
    );
    return 2;
  }

  const rendered = renderLineage(resolved.displayName, adapter.lineage);
  stdout(rendered);
  return 0;
}

/**
 * Render the lineage block (or the "no lineage recorded" line) for an
 * adapter. Exported so tests can pin byte-for-byte output without
 * invoking the CLI spawn path.
 */
export function renderLineage(
  displayName: string,
  lineage: AdapterLineage | undefined
): string {
  if (lineage === undefined) {
    return `no lineage recorded for \`${displayName}\`; pre-dates the lineage surface\n`;
  }

  const lines: string[] = [];
  lines.push(`Lineage — ${displayName}`);
  lines.push("");

  if (lineage.idl_source !== undefined) {
    lines.push("IDL source:");
    lines.push(`  ${lineage.idl_source}`);
  } else {
    lines.push("IDL source:");
    lines.push("  (not recorded)");
  }
  lines.push("");

  if (lineage.generator !== undefined) {
    lines.push("Generator:");
    lines.push(`  ${lineage.generator}`);
  } else {
    lines.push("Generator:");
    lines.push("  (not recorded)");
  }
  lines.push("");

  lines.push("Inferred assumptions:");
  if (lineage.inferred_assumptions.length === 0) {
    lines.push("  (none recorded)");
  } else {
    for (const entry of lineage.inferred_assumptions) {
      lines.push(`  - ${entry}`);
    }
  }
  lines.push("");

  lines.push("Unsupported fields:");
  if (lineage.unsupported_fields.length === 0) {
    lines.push("  (none recorded)");
  } else {
    for (const entry of lineage.unsupported_fields) {
      lines.push(`  - ${entry}`);
    }
  }
  lines.push("");

  lines.push(
    "Inspection only — no IDL fetch, no validation against IDL. Sprint 13's adapter linter consumes this metadata."
  );
  lines.push("");

  return lines.join("\n");
}

interface ResolvedAdapter {
  path: string;
  /** Display name used in headings — short adapter name when resolvable, else the raw filename. */
  displayName: string;
}

function resolveAdapterPath(
  adapterArg: string,
  fixturesRootOverride: string | undefined
): ResolvedAdapter | null {
  // Branch 1: explicit path (absolute, or relative with a path separator
  // or a `.toml` suffix). Honours absolute/relative paths the reviewer
  // types directly.
  const looksLikePath =
    adapterArg.includes("/") ||
    adapterArg.includes(path.sep) ||
    adapterArg.endsWith(".toml");
  if (looksLikePath) {
    const absolute = path.resolve(adapterArg);
    if (existsSync(absolute)) {
      return { path: absolute, displayName: deriveDisplayName(absolute) };
    }
    return null;
  }

  // Branch 2: short adapter name — layered resolution mirroring the
  // shared `resolveAdapterArg` + the doctor's adapter discovery order:
  //   1. `<cwd>/.riptide/adapters/<name>.toml`  (downstream user repo)
  //   2. `<cwd>/fixtures/adapters/<name>.toml`  (in-tree monorepo checkout)
  //   3. `<fixturesRoot>/adapters/<name>.toml`  (explicit override / module-derived fallback)
  const fixturesRoot = fixturesRootOverride ?? defaultFixturesRoot();
  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, ".riptide", "adapters", `${adapterArg}.toml`),
    path.resolve(cwd, "fixtures", "adapters", `${adapterArg}.toml`),
    path.join(fixturesRoot, "adapters", `${adapterArg}.toml`),
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (existsSync(candidate)) {
      return { path: candidate, displayName: adapterArg };
    }
  }
  return null;
}

function deriveDisplayName(absPath: string): string {
  const base = path.basename(absPath);
  if (base.endsWith(".toml")) {
    return base.slice(0, base.length - ".toml".length);
  }
  return base;
}

function defaultFixturesRoot(): string {
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
    path.resolve(cwd, "riptide", "fixtures"),
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
