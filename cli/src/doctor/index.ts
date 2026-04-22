// Doctor — fast static health diagnosis surface.
//
// `riptide doctor` answers a small, sharp question: is this machine in
// a state where Riptide can run? It reports on three surfaces:
//
//   1. Toolchain — node, npm, rustc, cargo, solana, cargo-build-sbf
//   2. Engine binary resolution
//   3. Discovered adapter health (load + lint, when machine-checkable)
//
// Honesty rules baked in:
// - No build, no network, no simulation. Doctor is a static diagnostic.
// - Toolchain version checks are presence-first; missing-but-required
//   is FAIL, present-but-wrong-band is WARN.
// - Adapter discovery walks `<repo>/.riptide/adapters/*.toml` AND
//   `<repo>/fixtures/adapters/*.toml` so a downstream user repo and
//   the monorepo both work.
// - Lint runs in-process (no spawn) and uses the same code path as
//   `riptide lint`. JSON-IDL adapters get machine validation; non-JSON
//   lineage is honest WARN; missing-lineage is honest SKIP.
//
// Exit codes:
//   0 — all checks passed
//   1 — at least one warn, no fails
//   2 — at least one fail

import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import {
  resolveEngineBinary,
  monorepoRootFromModule,
} from "../orchestrator/index.js";
import { loadAdapter } from "../adapter/resolve.js";
import { lintAdapter } from "../lint/index.js";
import { deriveRepoRoot } from "../commands/lint.js";
import type { Adapter } from "../schemas/adapter.js";

const execFileAsync = promisify(execFile);

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  /** Stable id used in tests. */
  id: string;
  status: DoctorStatus;
  /** Human-readable label shown in the toolchain table. */
  label: string;
  /** Documented expected value (e.g. `>= 20.x`), when one exists. */
  expected?: string;
  /** Observed value (e.g. detected version, resolved path). */
  actual?: string;
  /** One-line next-step suggestion. */
  hint?: string;
}

export interface DoctorAdapter {
  /** Adapter short name (basename without `.toml`). */
  name: string;
  /** Absolute path to the adapter TOML. */
  path: string;
  /** Where this adapter was discovered (`fixtures/adapters` vs `.riptide/adapters`). */
  source: AdapterDiscoverySource;
  /** Loaded successfully? */
  load: DoctorStatus;
  /** Lint outcome — `pass` | `warn` | `fail` once load succeeded; `fail` mirrors load if loading failed. */
  lint: DoctorStatus;
  /** One-line note explaining the lint result (machine-validation availability + counts). */
  note?: string;
  /** One-line next-step hint when not pass. */
  hint?: string;
}

export type AdapterDiscoverySource = "monorepo-fixtures" | "user-repo-riptide-dir";

export interface DoctorReport {
  /** Repo root the report was assembled against (cwd-derived). */
  cwd: string;
  /** Toolchain + engine-binary checks, in display order. */
  environment: DoctorCheck[];
  /** Per-adapter health rows, in discovery order. */
  adapters: DoctorAdapter[];
  /** Aggregate exit code. */
  exitCode: 0 | 1 | 2;
}

// Documented version bands from TOOLCHAIN.md. Drift outside the band
// is WARN, not FAIL — Doctor is a hint, not a gate.
//
// Off-chain band:
//   - rust 1.91.1, cargo 1.91.1, node 24.11.1, npm 11.6.2
// On-chain band:
//   - solana 3.0.13, cargo-build-sbf 3.0.13
//
// Practical compatibility window kept loose so users on 1.91.x / 24.x
// stay PASS without TOOLCHAIN.md edits whenever a patch lands.
interface ToolSpec {
  id: string;
  bin: string;
  versionArgs: string[];
  /** What we expect the user to see, mirrored from TOOLCHAIN.md. */
  expected: string;
  /** Returns true when the detected version is in-band. */
  inBand?: (raw: string) => boolean;
  /** One-line next-step when missing. */
  missingHint: string;
  /** One-line next-step when out of band. */
  driftHint?: string;
}

/**
 * Parse a `major.minor` pair out of a version line. Returns `null` if
 * the line has no recognizable shape so callers can opt out of drift
 * assertions rather than false-warn on unfamiliar formats.
 */
function parseMajorMinor(raw: string): { major: number; minor: number } | null {
  const m = raw.match(/(\d+)\.(\d+)\./);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  return { major, minor };
}

const TOOL_SPECS: ToolSpec[] = [
  {
    id: "node",
    bin: "node",
    versionArgs: ["--version"],
    expected: ">= 20 (TOOLCHAIN.md pin: 24.11.1)",
    inBand: (raw) => {
      const parsed = parseMajorMinor(raw);
      if (!parsed) return true;
      return parsed.major >= 20;
    },
    missingHint:
      "install Node.js 20+ from https://nodejs.org/ or via nvm — TOOLCHAIN.md pins 24.11.1",
    driftHint:
      "Riptide CLI requires Node 20+; 24.11.1 is the documented pin",
  },
  {
    id: "npm",
    bin: "npm",
    versionArgs: ["--version"],
    expected: "TOOLCHAIN.md pin: 11.6.2",
    inBand: (raw) => {
      // `npm --version` emits `11.6.2` on its own line. Require
      // major >= 10 as the practical floor (Node 20+ ships npm 10+).
      const parsed = parseMajorMinor(raw);
      if (!parsed) return true;
      return parsed.major >= 10;
    },
    missingHint:
      "npm ships with Node — reinstall Node.js if `npm` is missing",
    driftHint:
      "TOOLCHAIN.md pins npm 11.6.2; npm < 10 is likely paired with an unsupported Node version",
  },
  {
    id: "rustc",
    bin: "rustc",
    versionArgs: ["--version"],
    expected: "TOOLCHAIN.md pin: 1.91.1",
    inBand: (raw) => {
      const parsed = parseMajorMinor(raw);
      if (!parsed) return true; // unknown shape — don't false-fail
      // Off-chain workspace builds on rustc 1.91.x; warn outside [1.85, 1.99].
      return parsed.major === 1 && parsed.minor >= 85 && parsed.minor <= 99;
    },
    missingHint:
      "install Rust via https://rustup.rs/ — TOOLCHAIN.md pins 1.91.1",
    driftHint:
      "off-chain workspace expects rustc ~1.91; older toolchains may fail to build the engine",
  },
  {
    id: "cargo",
    bin: "cargo",
    versionArgs: ["--version"],
    expected: "TOOLCHAIN.md pin: 1.91.1",
    inBand: (raw) => {
      const parsed = parseMajorMinor(raw);
      if (!parsed) return true;
      // Cargo tracks rustc — accept the same 1.85..=1.99 window.
      return parsed.major === 1 && parsed.minor >= 85 && parsed.minor <= 99;
    },
    missingHint:
      "cargo ships with Rust — reinstall Rust via rustup if `cargo` is missing",
    driftHint:
      "TOOLCHAIN.md pins cargo 1.91.1; cargo tracks rustc, so drift here usually means rustc drift too",
  },
  {
    id: "solana",
    bin: "solana",
    versionArgs: ["--version"],
    expected: "TOOLCHAIN.md pin: 3.0.13",
    inBand: (raw) => {
      const parsed = parseMajorMinor(raw);
      if (!parsed) return true;
      // Loose: accept anything >= 1.x, since some users still run 1.18 / 2.x.
      return parsed.major >= 1;
    },
    missingHint:
      "install Solana CLI via https://docs.anza.xyz/cli/install — TOOLCHAIN.md pins 3.0.13",
    driftHint:
      "TOOLCHAIN.md pins solana 3.0.13; older releases may produce different SBF artifacts",
  },
  {
    id: "cargo-build-sbf",
    bin: "cargo-build-sbf",
    versionArgs: ["--version"],
    expected: "TOOLCHAIN.md pin: 3.0.13",
    inBand: (raw) => {
      // `solana-cargo-build-sbf --version` emits `solana-cargo-build-sbf 3.0.13`.
      const parsed = parseMajorMinor(raw);
      if (!parsed) return true;
      // Matches the Solana CLI band — anything below major 1 is almost
      // certainly wrong (and `0.0.1` is the canonical false-positive
      // case from the findings report).
      return parsed.major >= 1;
    },
    missingHint:
      "cargo-build-sbf ships with the Solana CLI — install or repair the Solana CLI",
    driftHint:
      "TOOLCHAIN.md pins cargo-build-sbf 3.0.13; this build tool must track the Solana CLI installed band",
  },
];

export interface BuildReportInput {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam — override the toolchain probe to avoid spawning subprocesses. */
  probeTool?: (spec: ToolSpec) => Promise<ToolProbeResult>;
  /** Test seam — override engine resolution. */
  resolveEngine?: () => Promise<string>;
  /** Test seam — override the adapter discovery directories. */
  discoverAdapters?: (cwd: string) => DiscoveredAdapter[];
}

export interface ToolProbeResult {
  /** Detected version line (raw stdout, trimmed). */
  version?: string;
  /** Resolved binary path on $PATH, when known. */
  resolved?: string;
}

export interface DiscoveredAdapter {
  name: string;
  path: string;
  source: AdapterDiscoverySource;
}

export async function buildDoctorReport(input: BuildReportInput): Promise<DoctorReport> {
  const env = input.env ?? process.env;
  const probe = input.probeTool ?? defaultProbeTool;

  const environment: DoctorCheck[] = [];

  // ---- toolchain ----
  for (const spec of TOOL_SPECS) {
    let probed: ToolProbeResult;
    try {
      probed = await probe(spec);
    } catch {
      probed = {};
    }
    if (!probed.version) {
      environment.push({
        id: spec.id,
        status: "fail",
        label: spec.bin,
        expected: spec.expected,
        actual: "(not found on PATH)",
        hint: spec.missingHint,
      });
      continue;
    }
    const inBand = spec.inBand ? spec.inBand(probed.version) : true;
    environment.push({
      id: spec.id,
      status: inBand ? "pass" : "warn",
      label: spec.bin,
      expected: spec.expected,
      actual: probed.version + (probed.resolved ? ` (${probed.resolved})` : ""),
      hint: inBand ? undefined : spec.driftHint,
    });
  }

  // ---- engine binary resolution ----
  try {
    const enginePath = input.resolveEngine
      ? await input.resolveEngine()
      : await resolveEngineBinary(env, input.cwd);
    environment.push({
      id: "riptide-engine",
      status: "pass",
      label: "riptide-engine",
      expected: "<repo>/target/release/riptide-engine or $RIPTIDE_ENGINE_BIN",
      actual: enginePath,
    });
  } catch (err) {
    environment.push({
      id: "riptide-engine",
      status: "fail",
      label: "riptide-engine",
      expected: "<repo>/target/release/riptide-engine or $RIPTIDE_ENGINE_BIN",
      actual: "(not found)",
      hint:
        "build it from this repo with `cargo build --release -p riptide-engine`, or set $RIPTIDE_ENGINE_BIN to an existing binary. Original message: " +
        ((err as Error).message ?? String(err)).split("\n")[0],
    });
  }

  // ---- adapters ----
  const discovered = input.discoverAdapters
    ? input.discoverAdapters(input.cwd)
    : discoverAdapters(input.cwd);

  const adapters: DoctorAdapter[] = [];
  for (const adapter of discovered) {
    const row = await checkAdapter(adapter);
    adapters.push(row);
  }

  if (adapters.length === 0) {
    environment.push({
      id: "adapters-discovered",
      status: "warn",
      label: "adapters",
      actual: "(none found)",
      expected: "fixtures/adapters/*.toml or .riptide/adapters/*.toml",
      hint:
        "run `riptide init` to scaffold .riptide/adapters/, or invoke doctor from inside the Riptide monorepo where shipping fixtures live",
    });
  }

  const exitCode = aggregateExitCode(environment, adapters);
  return { cwd: input.cwd, environment, adapters, exitCode };
}

// ---------- adapter health ----------

async function checkAdapter(d: DiscoveredAdapter): Promise<DoctorAdapter> {
  const loaded = await loadAdapter(d.path);
  if (!loaded.ok) {
    const message = loaded.error.kind === "validation-failed"
      ? `validation failed: ${loaded.error.message}`
      : loaded.error.kind === "read-failed"
        ? `unreadable: ${loaded.error.message}`
        : `not found: ${d.path}`;
    return {
      name: d.name,
      path: d.path,
      source: d.source,
      load: "fail",
      lint: "fail",
      note: message,
      hint: "fix the adapter file before re-running doctor",
    };
  }

  // Post-schema runtime-path existence check (generic adapters).
  //
  // The CLI schema only asserts `program_so` / `idl_path` are non-empty
  // strings. The engine's loader additionally rejects adapters whose
  // resolved runtime artifacts are missing on disk (see
  // `engine/src/adapter/loader.rs::validate_resolved_paths`). Doctor
  // must mirror that check statically so an adapter that would fail
  // the first engine spawn doesn't surface as `load=pass` here.
  //
  // Lending adapters have a separate `.so` discovery path in the
  // engine harness and intentionally do not carry `program_so` in
  // TOML — skip for them.
  const runtimeCheck = checkGenericRuntimePaths(
    loaded.value.adapter,
    loaded.value.resolved.path
  );
  if (runtimeCheck !== null) {
    return {
      name: d.name,
      path: d.path,
      source: d.source,
      load: "fail",
      lint: "fail",
      note: runtimeCheck.note,
      hint: runtimeCheck.hint,
    };
  }

  // Run the same in-process linter `riptide lint` uses. No spawn,
  // no engine, no network — pure static check.
  const repoRoot = deriveRepoRoot(loaded.value.resolved.path, undefined);
  let lintReport;
  try {
    lintReport = await lintAdapter({
      adapter: loaded.value.adapter,
      adapterPath: loaded.value.resolved.path,
      adapterName: d.name,
      repoRoot,
    });
  } catch (err) {
    return {
      name: d.name,
      path: d.path,
      source: d.source,
      load: "pass",
      lint: "fail",
      note: `lint crashed: ${(err as Error).message ?? String(err)}`,
      hint: "rerun `riptide lint <adapter>` for the full diagnostic",
    };
  }

  const failCount = lintReport.findings.filter((f) => f.level === "fail").length;
  const warnCount = lintReport.findings.filter((f) => f.level === "warn").length;
  const passCount = lintReport.findings.filter((f) => f.level === "pass").length;
  const skipCount = lintReport.findings.filter((f) => f.level === "skip").length;

  let lintStatus: DoctorStatus;
  let note: string;
  let hint: string | undefined;

  if (failCount > 0) {
    lintStatus = "fail";
    note = `${lintReport.sourceKind}: ${failCount} fail / ${warnCount} warn`;
    hint = `run \`riptide lint ${d.name}\` for the full diagnostic`;
  } else if (warnCount > 0) {
    lintStatus = "warn";
    if (lintReport.sourceKind === "non-json") {
      note = "non-JSON lineage source — machine validation unavailable (inspection-only)";
      hint = `run \`riptide lineage ${d.name}\` for the reviewer-readable inspection surface`;
    } else {
      note = `${lintReport.sourceKind}: ${warnCount} warn (uncovered surface)`;
      hint = `run \`riptide lint ${d.name}\` to see uncovered fields`;
    }
  } else if (skipCount > 0 && passCount === 0) {
    // Pure SKIP — no [lineage] block at all. Spec R3.6 lands skipped
    // machine validation on the WARN surface, not PASS: a doctor run
    // that exits 0 must mean every discovered adapter is actually
    // machine-checked clean, not merely "nothing to check". Keep the
    // note + hint actionable so the operator knows how to upgrade.
    lintStatus = "warn";
    note = "no [lineage] block — machine validation skipped";
    hint = `add a [lineage] block + idl_source to ${d.name} to unlock static validation`;
  } else {
    lintStatus = "pass";
    note = `${lintReport.sourceKind}: clean (${passCount} pass)`;
  }

  return {
    name: d.name,
    path: d.path,
    source: d.source,
    load: "pass",
    lint: lintStatus,
    note,
    hint,
  };
}

// ---------- runtime-path existence (mirrors engine/src/adapter/loader.rs) ----------

interface RuntimePathFailure {
  note: string;
  hint: string;
}

/**
 * Static equivalent of `validate_resolved_paths` in the engine loader.
 * For generic adapters, verify that `program_so`, `idl_path`, and
 * every `[accounts.<name>.owner.program_so]` path resolves to an
 * existing file on disk, plus the `<.so>`-sibling keypair the engine
 * needs at bootstrap time.
 *
 * Returns `null` when all checks pass (or the adapter is lending so
 * this contract doesn't apply). Returns the first failure otherwise —
 * doctor only needs one reason to fail, with a concrete next-step hint.
 */
function checkGenericRuntimePaths(adapter: Adapter, adapterPath: string): RuntimePathFailure | null {
  if (adapter.protocol !== "generic") return null;

  const adapterDir = path.dirname(adapterPath);
  const resolveRel = (raw: string): string =>
    path.isAbsolute(raw) ? raw : path.resolve(adapterDir, raw);

  if (adapter.program_so !== undefined) {
    const resolved = resolveRel(adapter.program_so);
    if (!existsSync(resolved)) {
      return {
        note: `program_so not found on disk: ${resolved}`,
        hint:
          "run `cargo build-sbf --manifest-path <program>/Cargo.toml` to produce the .so, or fix `program_so` in the adapter TOML",
      };
    }
  }

  if (adapter.idl_path !== undefined) {
    const resolved = resolveRel(adapter.idl_path);
    if (!existsSync(resolved)) {
      return {
        note: `idl_path not found on disk: ${resolved}`,
        hint:
          "regenerate the IDL (anchor build, or commit the JSON IDL at fixtures/idls/) or fix `idl_path` in the adapter TOML",
      };
    }
  }

  for (const [accountName, def] of Object.entries(adapter.accounts)) {
    const ownerSo = def.owner?.program_so;
    if (ownerSo === undefined) continue;
    const resolved = resolveRel(ownerSo);
    if (!existsSync(resolved)) {
      return {
        note: `[accounts.${accountName}].owner.program_so not found on disk: ${resolved}`,
        hint:
          "build the sibling program with `cargo build-sbf` or fix the owner.program_so path in the adapter TOML",
      };
    }
    // The engine also requires the companion `-keypair.json` next to
    // the `.so`. Mirror that check so doctor catches the same pre-boot
    // failure the engine does.
    const keypair = siblingDeployKeypairPath(resolved);
    if (keypair === null) {
      return {
        note: `[accounts.${accountName}].owner.program_so has an unparseable stem: ${resolved}`,
        hint:
          "rename the sibling `.so` to `<program>.so` so the companion `<program>-keypair.json` can be derived",
      };
    }
    if (!existsSync(keypair)) {
      return {
        note: `[accounts.${accountName}].owner sibling keypair not found: ${keypair}`,
        hint:
          "rebuild the sibling program with `cargo build-sbf` (which generates the keypair) or restore the keypair file",
      };
    }
  }

  return null;
}

/**
 * Derive the `<program>-keypair.json` path that sits alongside a
 * compiled `<program>.so`. Mirrors
 * `engine/src/adapter/loader.rs::sibling_deploy_keypair_path` so the
 * static doctor check and the engine boot path agree on the same
 * convention.
 */
function siblingDeployKeypairPath(programSo: string): string | null {
  const dir = path.dirname(programSo);
  const base = path.basename(programSo);
  const stem = base.endsWith(".so") ? base.slice(0, -".so".length) : null;
  if (!stem || stem.length === 0) return null;
  return path.join(dir, `${stem}-keypair.json`);
}

// ---------- adapter discovery ----------

/**
 * Walk the adapter homes for the current repo shape. Spec R3.3:
 *   - `.riptide/adapters/*.toml` when the user repo has one
 *   - `fixtures/adapters/*.toml` **as the monorepo fallback**
 *
 * These are layered, NOT unioned. A downstream user repo that defines
 * `.riptide/adapters/my-program.toml` must not inherit shipping
 * adapters from the monorepo checkout the CLI happens to sit inside.
 * The first layer that yields any adapter wins; later layers do not
 * contribute.
 *
 * Layer order:
 *   1. `<cwd>/.riptide/adapters/*.toml`                 (user repo)
 *   2. `<cwd>/fixtures/adapters/*.toml`                 (in-tree monorepo)
 *   3. `<module-derived-monorepo>/fixtures/adapters/*.toml`
 *       (contributor running `cd cli && riptide doctor` from a source
 *        checkout — the module's own on-disk location resolves back
 *        to the monorepo that contains it, so fixtures are still
 *        findable without trusting any parent of `<cwd>`.)
 *
 * Trust surface is deliberately narrow: directly under `<cwd>`, or
 * directly under the CLI module's on-disk location. An earlier draft
 * included a `<cwd>/../fixtures/adapters` layer that trusted any
 * parent directory, which leaked unrelated adapters from a nested cwd
 * (e.g. running doctor inside `/tmp/.../child` inherited
 * `/tmp/.../fixtures/adapters/parent-hit.toml`). Dropped.
 *
 * **Scope note on packaged installs.** Sprint 13's install-first path
 * is `install.sh` + source checkout; the npm package is dry-run-
 * verified but not published, and `cli/package.json`'s `files` list
 * does not ship `fixtures/`. For a truly packaged CLI running from an
 * arbitrary cwd with nothing under `<cwd>`, all three layers will
 * miss and `discoverAdapters` returns `[]` — doctor then prints the
 * `run riptide init` hint. That is the honest behaviour today.
 */
export function discoverAdapters(cwd: string): DiscoveredAdapter[] {
  const layers: Array<{ dir: string; source: AdapterDiscoverySource }> = [
    { dir: path.join(cwd, ".riptide", "adapters"), source: "user-repo-riptide-dir" },
    { dir: path.join(cwd, "fixtures", "adapters"), source: "monorepo-fixtures" },
  ];
  const moduleRoot = monorepoRootFromModule();
  if (moduleRoot) {
    layers.push({
      dir: path.join(moduleRoot, "fixtures", "adapters"),
      source: "monorepo-fixtures",
    });
  }

  const seen = new Set<string>();
  for (const { dir, source } of layers) {
    const layerResults = readAdapterDir(dir, source, seen);
    if (layerResults.length > 0) {
      return layerResults;
    }
  }
  return [];
}

function readAdapterDir(
  dir: string,
  source: AdapterDiscoverySource,
  seen: Set<string>
): DiscoveredAdapter[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: DiscoveredAdapter[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".toml")) continue;
    const abs = path.resolve(dir, entry);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push({
      name: entry.slice(0, -".toml".length),
      path: abs,
      source,
    });
  }
  return out;
}

// ---------- aggregate ----------

function aggregateExitCode(env: DoctorCheck[], adapters: DoctorAdapter[]): 0 | 1 | 2 {
  const hasFail =
    env.some((c) => c.status === "fail") ||
    adapters.some((a) => a.load === "fail" || a.lint === "fail");
  if (hasFail) return 2;
  const hasWarn =
    env.some((c) => c.status === "warn") ||
    adapters.some((a) => a.lint === "warn");
  if (hasWarn) return 1;
  return 0;
}

// ---------- toolchain probe ----------

async function defaultProbeTool(spec: ToolSpec): Promise<ToolProbeResult> {
  // No PATH lookup here — `execFile` already resolves via $PATH on
  // POSIX; ENOENT bubbles cleanly when missing. We deliberately do
  // NOT spawn shells (preserves quiet, no-injection behavior).
  try {
    const { stdout, stderr } = await execFileAsync(spec.bin, spec.versionArgs, {
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    const out = (stdout || stderr || "").trim().split("\n")[0]?.trim();
    if (!out) return {};
    return { version: out };
  } catch {
    return {};
  }
}
