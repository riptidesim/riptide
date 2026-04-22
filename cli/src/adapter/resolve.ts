// Shared adapter name/path resolution for commands that accept either
// a short adapter name (`solend-fork`) resolved under the fixtures root
// or an explicit path to an adapter TOML.
//
// Used by `riptide lineage`, `riptide lint`, and any downstream health
// surface that needs to load an adapter without imposing a per-command
// copy of the resolution rules.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import TOML from "toml";

import { monorepoRootFromModule } from "../orchestrator/index.js";
import { validateAdapter, type Adapter } from "../schemas/adapter.js";

export interface ResolvedAdapter {
  /** Absolute path to the adapter TOML. */
  path: string;
  /** Short name used in headings — the adapter name when resolvable, else the basename without `.toml`. */
  displayName: string;
}

export function resolveAdapterArg(
  adapterArg: string,
  fixturesRootOverride?: string
): ResolvedAdapter | null {
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

  const fixturesRoot = fixturesRootOverride ?? defaultFixturesRoot();
  const candidate = path.join(fixturesRoot, "adapters", `${adapterArg}.toml`);
  if (existsSync(candidate)) {
    return { path: candidate, displayName: adapterArg };
  }
  return null;
}

export interface LoadedAdapter {
  resolved: ResolvedAdapter;
  adapter: Adapter;
  /** Raw TOML text for downstream analyzers that need the original bytes. */
  raw: string;
}

export type AdapterLoadError =
  | { kind: "not-found"; arg: string }
  | { kind: "read-failed"; path: string; message: string }
  | { kind: "validation-failed"; path: string; message: string };

/**
 * Resolve, read, parse, and Zod-validate an adapter. Returns a tagged
 * error on failure so callers can render their own prefix while sharing
 * the underlying resolution path.
 */
export async function loadAdapter(
  adapterArg: string,
  fixturesRootOverride?: string
): Promise<{ ok: true; value: LoadedAdapter } | { ok: false; error: AdapterLoadError }> {
  const resolved = resolveAdapterArg(adapterArg, fixturesRootOverride);
  if (resolved === null) {
    return { ok: false, error: { kind: "not-found", arg: adapterArg } };
  }

  let raw: string;
  try {
    raw = await readFile(resolved.path, "utf8");
  } catch (err) {
    return {
      ok: false,
      error: { kind: "read-failed", path: resolved.path, message: errMessage(err) },
    };
  }

  try {
    const parsed = TOML.parse(raw);
    const adapter = validateAdapter(parsed, resolved.path);
    return { ok: true, value: { resolved, adapter, raw } };
  } catch (err) {
    return {
      ok: false,
      error: { kind: "validation-failed", path: resolved.path, message: errMessage(err) },
    };
  }
}

export function defaultFixturesRoot(): string {
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

function deriveDisplayName(absPath: string): string {
  const base = path.basename(absPath);
  if (base.endsWith(".toml")) {
    return base.slice(0, base.length - ".toml".length);
  }
  return base;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
