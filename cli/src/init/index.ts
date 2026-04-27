// Scaffolding module for `riptide init`.
//
// Pure functions only — no CLI I/O, no process.exit. The command layer in
// `cli/src/commands/init.ts` handles argv parsing, user-facing output,
// and exit codes. Everything here is testable in isolation via `scaffold`.

import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { monorepoRootFromModule } from "../orchestrator/index.js";

export interface ScaffoldOptions {
  cwd: string;
  force: boolean;
  /**
   * Override the starter-persona source directory. Defaults to the
   * packaged `cli/assets/init-personas/` bundle that ships with the
   * CLI, with a monorepo `fixtures/personas/` fallback for repo-checkout
   * dev. Tests inject this directly to stay hermetic.
   */
  personasSourceDir?: string;
}

export interface ScaffoldResult {
  created: string[];
  programName: string;
}

// The three starter personas chosen to give a new user concrete,
// non-protocol-specific references. `swapper` + `arbitrageur` + `whale`
// cover the baseline/adversarial/outsized-actor spread without implying
// the user is simulating lending vs AMM vs perps.
const STARTER_PERSONAS = ["swapper", "arbitrageur", "whale"] as const;

const PLACEHOLDER_PROGRAM_NAME = "my-program";

export function inferProgramName(cwd: string): string {
  const anchorPath = path.join(cwd, "Anchor.toml");
  if (!existsSync(anchorPath)) {
    return PLACEHOLDER_PROGRAM_NAME;
  }
  let raw: string;
  try {
    // Sync read keeps the inference function synchronous to match the
    // task contract — the file is tiny (< 1 KiB typical) and we only
    // read it once at init time. Unreadable/malformed files fall
    // through to the placeholder per R1.3.
    raw = readFileSync(anchorPath, "utf8");
  } catch {
    return PLACEHOLDER_PROGRAM_NAME;
  }
  return parseAnchorTomlForProgramName(raw) ?? PLACEHOLDER_PROGRAM_NAME;
}

// Minimal Anchor.toml parser targeting just the two keys we need. We
// avoid a full TOML dependency pull here because Anchor.toml malformed
// shapes are common (hand-edited files, partial workspaces) and the
// full-parse path would throw on the first stray character. Regex-based
// extraction gives us the same "best-effort infer, fall through
// cleanly" behavior the task contract demands.
function parseAnchorTomlForProgramName(raw: string): string | null {
  // Multi-program workspaces are ambiguous: picking the first key would
  // quietly commit a user of a monorepo to the wrong adapter. Fall
  // through to the placeholder so the user edits intentionally.
  const localnetKeys = extractProgramKeys(raw, "programs.localnet");
  if (localnetKeys.length === 1) {
    return localnetKeys[0]!.replace(/_/g, "-");
  }
  if (localnetKeys.length > 1) {
    return null;
  }
  const mainnetKeys = extractProgramKeys(raw, "programs.mainnet");
  if (mainnetKeys.length === 1) {
    return mainnetKeys[0]!.replace(/_/g, "-");
  }
  if (mainnetKeys.length > 1) {
    return null;
  }
  // Fall back to `name = "..."` at the top of the file.
  const nameMatch = raw.match(/^\s*name\s*=\s*"([a-z][a-z0-9_-]*)"\s*$/m);
  if (nameMatch && nameMatch[1]) {
    return nameMatch[1].replace(/_/g, "-");
  }
  return null;
}

function extractProgramKeys(raw: string, tableHeader: string): string[] {
  const escaped = tableHeader.replace(/\./g, "\\.");
  const sectionRe = new RegExp(`\\[${escaped}\\][^\\[]*`);
  const match = raw.match(sectionRe);
  if (!match) {
    return [];
  }
  const body = match[0];
  const keyRe = /^\s*([a-z][a-z0-9_-]*)\s*=/gim;
  const keys: string[] = [];
  let keyMatch: RegExpExecArray | null;
  while ((keyMatch = keyRe.exec(body)) !== null) {
    if (keyMatch[1]) keys.push(keyMatch[1]);
  }
  return keys;
}

export function renderAdapterStub(programName: string): string {
  const soName = programName.replace(/-/g, "_");
  return `# Riptide adapter for ${programName}.
#
# This is a stub — fill in the sections below to wire your program into
# Riptide. Every block has a TODO comment explaining what goes in it.
# When you're done, run \`riptide adapt --adapter .riptide/adapters/${programName}.toml\`
# to smoke-test the adapter round-trips against the engine.

protocol = "generic"
program_so = "target/deploy/${soName}.so"
idl_path = "target/idl/${soName}.json"

# TODO: declare every account type the engine should track.
# - \`kind = "agent"\` for accounts owned by a single simulated user
#   (wallet, position, token account, etc.)
# - \`kind = "shared"\` for global / pool / config accounts
# - \`space\` is the account byte size — match your Rust \`#[account]\` layout
[accounts.player]
kind = "agent"
space = 64

# TODO: map every instruction you want agents to invoke to a Riptide action.
# - \`action\` is the string personas reference in \`action_weights\`
# - \`amount\` names the primary numeric arg the runtime binds per decision
# - add \`args = { ... }\` for any other instruction args (literal or @persona.<key>)
[instructions]
# example = { action = "example", amount = "amount" }

# TODO: map on-chain state fields to observation keys so invariants + the
# dashboard can read them. LHS is \`<account>.<field>\` from your program,
# RHS is the Riptide observation key.
[state_mapping]
# "player.balance" = "player.balance"

# TODO: define each runtime-dispatchable action. \`label\` is the dashboard
# display name; \`takes\` lists the numeric args the runtime provides.
[actions]
# [actions.example]
# label = "Example action"
# takes = ["amount"]

# TODO: declare observations for each state-mapping key. Types:
# "uint" / "int" / "float" / "bool" / "pubkey" / "map".
[observations]
# "player.balance" = "uint"

# TODO: declare at least one persona so \`riptide run\` has an agent shape
# to seed. For generic adapters, personas live inline here and the scenario
# \`run-config.json\` leaves the \`personas\` array empty — the engine reads
# the roster from this block. The \`personas/\` directory next to this file
# holds reference archetypes you can copy fields from.
[personas.example]
label = "Example persona"
action_rate_multiplier = 1.0
# TODO: replace \`action_name\` below with real \`[actions.*]\` keys you declared above.
action_weights = { action_name = 1.0 }
triggers = []
`;
}

export function renderBaselineRunConfig(): object {
  // personas is intentionally empty: generic adapters (the scaffolded
  // primitive) carry their persona roster inline in the adapter TOML
  // under `[personas.*]`. The CLI's lending-era policy fallback only
  // resolves five hard-coded ids, so leaving this empty delegates
  // persona shape to the adapter where the scaffold already put it.
  return {
    agents: 10,
    ticks: 30,
    scenario: "baseline",
    seed: 42,
    personas: [],
    output_path: ".riptide/runs/baseline",
    validator_url: "http://localhost:8899"
  };
}

export function renderGettingStarted(programName: string): string {
  return `# Getting started with Riptide

Riptide just scaffolded a \`.riptide/\` directory in your repo. Here's what's in it and what to do next.

## Directory layout

- \`adapters/${programName}.toml\` — the bridge between your Anchor program and Riptide's engine. **This is the one file you need to edit.** Every section has a TODO comment explaining what belongs in it. Generic adapters declare personas inline under \`[personas.*]\`.
- \`personas/\` — reference agent archetypes (swapper, arbitrageur, whale). Copy their \`action_weights\` + \`triggers\` shape into your adapter's \`[personas.*]\` block; the files themselves are reference material, not live config.
- \`scenarios/baseline/run-config.json\` — a minimum-viable 10-agent, 30-tick scenario seeded at 42. Its \`personas\` array is empty by default — the engine reads the roster from your adapter's inline \`[personas.*]\` entries. Add more scenarios as subdirectories: \`.riptide/scenarios/<name>/run-config.json\`.

## Next steps

The install-first path is **doctor → edit adapter → lint → adapt → run**.

1. \`riptide doctor\` — static health check (no build, no network, no simulation). Confirms your toolchain (\`node\`, \`npm\`, \`rustc\`, \`cargo\`, \`solana\`, \`cargo-build-sbf\`), the \`riptide-engine\` binary, and any adapters it can discover. Exit \`0\` all-pass, \`1\` warnings only, \`2\` at least one failure — jest-style semantics so CI can gate on it.
2. Build your program so \`target/deploy/*.so\` and \`target/idl/*.json\` exist.
3. Open \`.riptide/adapters/${programName}.toml\` and fill in the TODO blocks: accounts, instructions, state_mapping, actions, observations, personas. The untouched stub is intentionally not lint-clean. If you add a \`[lineage]\` block pointing at your JSON IDL, the next step can machine-validate the wiring.
4. \`riptide lint ${programName}\` — static validation. When \`[lineage].idl_source\` is a JSON IDL, this cross-checks every mapped instruction, arg, account, and \`account.field\` reference against the IDL (positive mismatches exit 2 with a next-step hint). Non-JSON lineage sources WARN; missing \`[lineage]\` SKIPS — no false PASS.
5. \`riptide adapt --adapter .riptide/adapters/${programName}.toml\` — end-to-end smoke-test against the local engine. Runs the same linter as a preflight when machine-checkable lineage is present, then spawns the engine to assert the adapter round-trips with an observed state delta.
6. Run the baseline scenario:

   \`\`\`
   riptide run .riptide/scenarios/baseline/run-config.json --adapter .riptide/adapters/${programName}.toml
   \`\`\`

## Reference

- Shipping adapter examples: [riptidesim/riptide — fixtures/adapters/](https://github.com/riptidesim/riptide/tree/main/fixtures/adapters)
- Architecture deep-dive: [docs/architecture.md](https://github.com/riptidesim/riptide/blob/main/docs/architecture.md)

Problems? Drop the adapter file + the engine stderr tail into an issue at https://github.com/riptidesim/riptide/issues.
`;
}

export async function scaffold(options: ScaffoldOptions): Promise<ScaffoldResult> {
  const { cwd, force } = options;
  const riptideDir = path.join(cwd, ".riptide");

  if (existsSync(riptideDir)) {
    if (!force) {
      throw new RiptideDirExistsError(riptideDir);
    }
    await rm(riptideDir, { recursive: true, force: true });
  }

  const programName = inferProgramName(cwd);
  const personasSrc = options.personasSourceDir ?? resolveBundledPersonasDir();

  const created: string[] = [];

  // adapters/
  const adaptersDir = path.join(riptideDir, "adapters");
  await mkdir(adaptersDir, { recursive: true });
  const adapterRel = path.join(".riptide", "adapters", `${programName}.toml`);
  await writeFile(
    path.join(riptideDir, "adapters", `${programName}.toml`),
    renderAdapterStub(programName),
    "utf8"
  );
  created.push(adapterRel);

  // personas/
  const personasDir = path.join(riptideDir, "personas");
  await mkdir(personasDir, { recursive: true });
  for (const persona of STARTER_PERSONAS) {
    const srcPath = path.join(personasSrc, `${persona}.toml`);
    if (!existsSync(srcPath)) {
      throw new Error(
        `Could not locate starter persona "${persona}" at ${srcPath}. ` +
          `Your CLI install is missing bundled starter personas — ` +
          `reinstall the package, or set personasSourceDir explicitly.`
      );
    }
    const destPath = path.join(personasDir, `${persona}.toml`);
    await cp(srcPath, destPath);
    created.push(path.join(".riptide", "personas", `${persona}.toml`));
  }

  // scenarios/baseline/run-config.json
  const scenarioDir = path.join(riptideDir, "scenarios", "baseline");
  await mkdir(scenarioDir, { recursive: true });
  const runConfig = renderBaselineRunConfig();
  await writeFile(
    path.join(scenarioDir, "run-config.json"),
    JSON.stringify(runConfig, null, 2) + "\n",
    "utf8"
  );
  created.push(path.join(".riptide", "scenarios", "baseline", "run-config.json"));

  // GETTING-STARTED.md
  await writeFile(
    path.join(riptideDir, "GETTING-STARTED.md"),
    renderGettingStarted(programName),
    "utf8"
  );
  created.push(path.join(".riptide", "GETTING-STARTED.md"));

  // .gitignore entries for volatile run output (R11.2). Appends to
  // an existing .gitignore when present, creates a fresh one otherwise.
  // We match exact-line entries to avoid duplicating on re-run.
  const gitignoreResult = await ensureGitignoreEntries(cwd);
  if (gitignoreResult.touched) {
    created.push(".gitignore");
  }

  return { created, programName };
}

const GITIGNORE_ENTRIES = [".riptide/runs/", ".riptide/last-run.json"] as const;

async function ensureGitignoreEntries(cwd: string): Promise<{ touched: boolean }> {
  const gitignorePath = path.join(cwd, ".gitignore");
  let existing = "";
  try {
    existing = await readFile(gitignorePath, "utf8");
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code !== "ENOENT") {
      throw err;
    }
  }

  const existingLines = existing.split("\n").map((l) => l.trim());
  const toAppend: string[] = [];
  for (const entry of GITIGNORE_ENTRIES) {
    if (!existingLines.includes(entry)) {
      toAppend.push(entry);
    }
  }
  if (toAppend.length === 0) {
    return { touched: false };
  }

  const hasTrailingNewline = existing.length === 0 || existing.endsWith("\n");
  const prefix = hasTrailingNewline ? "" : "\n";
  const header = existing.length === 0 ? "# Riptide run state (auto-added by riptide init)\n" : "\n# Riptide run state (auto-added by riptide init)\n";
  const body = toAppend.join("\n") + "\n";
  await writeFile(gitignorePath, existing + prefix + header + body, "utf8");
  return { touched: true };
}

export class RiptideDirExistsError extends Error {
  readonly dir: string;
  constructor(dir: string) {
    super(
      `${dir} already exists. Use --force to overwrite, or delete it manually.`
    );
    this.dir = dir;
    this.name = "RiptideDirExistsError";
  }
}

// Starter personas ship under `cli/assets/init-personas/` and get mirrored
// into `cli/dist/assets/init-personas/` by the build's copy-personas
// step, so a packaged install has them next to the compiled JS. The
// resolver probes both layouts (dev + built), then falls back to the
// monorepo fixtures for repo-checkout developers who haven't built yet.
function resolveBundledPersonasDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // built: <cli>/dist/src/init/index.js → <cli>/dist/assets/init-personas
    path.resolve(here, "..", "..", "assets", "init-personas"),
    // built-alt layout: <cli>/dist/src/init/index.js → <cli>/assets/init-personas
    path.resolve(here, "..", "..", "..", "assets", "init-personas"),
    // dev ts-node: <cli>/src/init/index.ts → <cli>/assets/init-personas
    path.resolve(here, "..", "..", "assets", "init-personas")
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Repo-checkout fallback: monorepo fixtures are the authoritative
  // source before a build has populated the packaged bundle.
  const moduleRoot = monorepoRootFromModule();
  if (moduleRoot) {
    const monorepoPersonas = path.resolve(moduleRoot, "fixtures", "personas");
    if (existsSync(monorepoPersonas)) return monorepoPersonas;
  }
  return candidates[0]!;
}
