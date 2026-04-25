// Shared adapter name/path resolution for commands that accept either
// a short adapter name (`lending`) resolved under the fixtures root
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

export interface ResolveAdapterArgOptions {
  /** Override the fixtures root used for the monorepo / shipping-fixture layer. */
  fixturesRoot?: string;
  /** Override cwd used for the downstream `.riptide/adapters/` layer (test seam). */
  cwd?: string;
}

export function resolveAdapterArg(
  adapterArg: string,
  fixturesRootOrOptions?: string | ResolveAdapterArgOptions
): ResolvedAdapter | null {
  const opts: ResolveAdapterArgOptions =
    typeof fixturesRootOrOptions === "string"
      ? { fixturesRoot: fixturesRootOrOptions }
      : (fixturesRootOrOptions ?? {});

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

  // Bare-name layering, mirroring `discoverAdapters` in
  // `cli/src/doctor/index.ts`:
  //   1. `<cwd>/.riptide/adapters/<name>.toml`  (downstream user repo)
  //   2. `<cwd>/fixtures/adapters/<name>.toml`  (in-tree monorepo checkout)
  //   3. `<fixturesRoot>/adapters/<name>.toml`  (explicit override / module-derived fallback)
  //
  // The downstream user-repo layer wins first so a fresh `riptide init`
  // scaffold is lintable by bare name, matching the install-first path
  // documented in `README.md` and `docs/install.md`.
  const cwd = opts.cwd ?? process.cwd();
  const bareCandidates: string[] = [
    path.resolve(cwd, ".riptide", "adapters", `${adapterArg}.toml`),
    path.resolve(cwd, "fixtures", "adapters", `${adapterArg}.toml`),
  ];
  const fixturesRoot = opts.fixturesRoot ?? defaultFixturesRoot();
  bareCandidates.push(path.join(fixturesRoot, "adapters", `${adapterArg}.toml`));

  const seen = new Set<string>();
  for (const candidate of bareCandidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (existsSync(candidate)) {
      return { path: candidate, displayName: adapterArg };
    }
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
  fixturesRootOrOptions?: string | ResolveAdapterArgOptions
): Promise<{ ok: true; value: LoadedAdapter } | { ok: false; error: AdapterLoadError }> {
  const resolved = resolveAdapterArg(adapterArg, fixturesRootOrOptions);
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
