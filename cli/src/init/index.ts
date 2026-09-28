// Scaffolding module for `riptide init`.
//
// Pure functions only — no CLI I/O, no process.exit. The command layer in
// `cli/src/commands/init.ts` handles argv parsing, output and exit codes.
// Everything here is testable in isolation via `scaffold`.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Protocol } from "./personas-catalog.js";
import { planDefaultAdapter, renderDefaultAdapter } from "./defaults.js";
import { readIdlFacts } from "./idl-facts.js";

export interface ScaffoldOptions {
  cwd: string;
  force: boolean;
  /** Explicitly allow scaffolding without a detected Solana program. */
  blank?: boolean;
  /** Optional program name override for the adapter filename and artifact paths. */
  programName?: string;
  /** Restrict a multi-program workspace to the one named program. */
  program?: string;
  /** Protocol hint recorded in a thin adapter. Defaults to "custom" (no hint). */
  protocol?: Protocol;
}

export interface ScaffoldedAdapter {
  programName: string;
  /** Workspace-relative path to the adapter TOML. */
  path: string;
  /** `defaults` means every entry came from the program's IDL. */
  kind: "defaults" | "thin";
  /** Instructions the adapter mapped; empty for thin scaffolds. */
  mappedInstructions: string[];
  /** Accounts the adapter declared; empty for thin scaffolds. */
  declaredAccounts: string[];
  /** Residual gaps recorded under `[lineage].unsupported_fields`. */
  gaps: number;
}

export interface ScaffoldResult {
  created: string[];
  /** First scaffolded program; the only one on the blank path. */
  programName: string;
  /** Every program that got an adapter, in adapter-write order. */
  programNames: string[];
  adapters: ScaffoldedAdapter[];
  warnings: string[];
}

const PLACEHOLDER_PROGRAM_NAME = "my-program";

export interface ProgramDetection {
  programName: string;
  source: "anchor" | "artifacts";
  warnings: string[];
}

/**
 * Fails fast on an existing `.riptide/`, then reports every program init
 * will scaffold. An explicit `--program` narrows the list here so an
 * unknown name fails before any file is written.
 */
export function preflightScaffoldPrograms(
  options: Pick<ScaffoldOptions, "cwd" | "force" | "blank" | "program">
): ProgramDetection[] | undefined {
  const riptideDir = path.join(options.cwd, ".riptide");
  if (existsSync(riptideDir) && !options.force) {
    throw new RiptideDirExistsError(riptideDir);
  }
  if (options.blank) return undefined;
  const detected = detectPrograms(options.cwd);
  return options.program === undefined
    ? detected
    : [selectProgram(detected, options.program)];
}

/** Every program name declared by Anchor.toml, sorted and deduped. */
export function inferProgramNames(cwd: string): string[] {
  const anchorPath = path.join(cwd, "Anchor.toml");
  if (!existsSync(anchorPath)) return [];
  let raw: string;
  try {
    // Sync read keeps inference synchronous to match the caller
    // contract — the file is tiny and read once at init time.
    // Unreadable/malformed files yield no names so the caller can fail
    // with an explicit detection error.
    raw = readFileSync(anchorPath, "utf8");
  } catch {
    return [];
  }
  return parseAnchorTomlForProgramNames(raw);
}

/**
 * Every program in the workspace, sorted by name. A single-program repo
 * is the N=1 case of the same path — `riptide init` never has to ask
 * which program it is looking at.
 */
export function detectPrograms(cwd: string): ProgramDetection[] {
  const anchorPath = path.join(cwd, "Anchor.toml");
  if (existsSync(anchorPath)) {
    const programNames = inferProgramNames(cwd);
    if (programNames.length === 0) {
      throw new ProgramDetectionError(
        "Anchor.toml found, but Riptide could not read any program name from it.\n" +
          "Expected [programs.localnet] entries, [programs.mainnet] entries, or a top-level name = \"...\".\n" +
          "Use `riptide init --blank --name <program-name>` if you want to scaffold manually.",
        "init_anchor_toml_unreadable",
        "add a [programs.localnet] entry naming the program to Anchor.toml, or rerun `riptide init --blank --name <program-name> --json`"
      );
    }
    return programNames.map((programName) => ({
      programName,
      source: "anchor" as const,
      warnings: missingArtifactWarnings(cwd, programName)
    }));
  }

  const fromArtifacts = detectProgramsFromArtifacts(cwd);
  if (fromArtifacts.length > 0) return fromArtifacts;

  throw new ProgramDetectionError(
    "no Solana program detected in this directory.\n" +
      "Expected an Anchor.toml file or a matching target/deploy/<program>.so + target/idl/<program>.json pair.\n" +
      "Run this from your program repo, or use `riptide init --blank --name <program-name>` to create a manual stub.",
    "init_no_program_detected",
    "rerun from the program repo root (where Anchor.toml lives), build the program so target/deploy/<program>.so and target/idl/<program>.json exist, or rerun `riptide init --blank --name <program-name> --json`"
  );
}

/** Filter a detection list to a single named program. */
export function selectProgram(
  detected: ProgramDetection[],
  requested: string
): ProgramDetection {
  const wanted = normalizeProgramName(requested);
  const match = detected.find((entry) => entry.programName === wanted);
  if (match) return match;
  throw new ProgramDetectionError(
    `program ${JSON.stringify(requested)} was not detected in this directory.\n` +
      `Detected programs: ${detected.map((entry) => entry.programName).join(", ")}.`,
    "init_program_not_found",
    `rerun with --program set to one of: ${detected.map((entry) => entry.programName).join(", ")}`
  );
}

function detectProgramsFromArtifacts(cwd: string): ProgramDetection[] {
  const deployDir = path.join(cwd, "target", "deploy");
  const idlDir = path.join(cwd, "target", "idl");
  if (!existsSync(deployDir) || !existsSync(idlDir)) return [];

  const soStems = new Set(
    safeReaddir(deployDir)
      .filter((entry) => entry.endsWith(".so"))
      .map((entry) => entry.slice(0, -".so".length))
  );
  const idlStems = new Set(
    safeReaddir(idlDir)
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => entry.slice(0, -".json".length))
  );

  const matches = [...soStems].filter((stem) => idlStems.has(stem)).sort();
  if (matches.length === 0) {
    if (soStems.size > 0 || idlStems.size > 0) {
      throw new ProgramDetectionError(
        "found target/deploy or target/idl artifacts, but no matching <program>.so + <program>.json pair.\n" +
          "Build/regenerate the missing artifact, or use `riptide init --blank --name <program-name>` to scaffold manually.",
        "init_artifacts_unpaired",
        "run `anchor build` (or `cargo build-sbf` plus the IDL) so each target/deploy/<program>.so has a matching target/idl/<program>.json, then rerun `riptide init --json`"
      );
    }
    return [];
  }

  return matches
    .map((stem) => ({
      programName: normalizeProgramName(stem),
      source: "artifacts" as const,
      warnings: [] as string[]
    }))
    .sort((a, b) => a.programName.localeCompare(b.programName, "en-US"));
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function missingArtifactWarnings(cwd: string, programName: string): string[] {
  const soName = programName.replace(/-/g, "_");
  const expectedSo = path.join(cwd, "target", "deploy", `${soName}.so`);
  const expectedIdl = path.join(cwd, "target", "idl", `${soName}.json`);
  const warnings: string[] = [];
  if (!existsSync(expectedSo)) {
    warnings.push(
      `target/deploy/${soName}.so not found yet; run \`anchor build\` (or \`cargo build-sbf\`) before generating a simulation.`
    );
  }
  if (!existsSync(expectedIdl)) {
    warnings.push(
      `target/idl/${soName}.json not found yet; run \`anchor build\` or commit the IDL — without it Riptide can only write a thin bootstrap adapter.`
    );
  }
  return warnings;
}

function normalizeProgramName(value: string): string {
  const normalized = value.trim().replace(/_/g, "-");
  if (!/^[a-z][a-z0-9-]*$/.test(normalized)) {
    throw new ProgramDetectionError(
      `invalid program name ${JSON.stringify(value)}. Use lowercase letters, numbers, and dashes, starting with a letter.`,
      "init_invalid_program_name",
      "rerun with a program name of lowercase letters, numbers and dashes that starts with a letter"
    );
  }
  return normalized;
}

// Minimal Anchor.toml parser targeting just the two keys we need. We
// avoid a full TOML dependency pull here because Anchor.toml malformed
// shapes are common (hand-edited files, partial workspaces) and the
// full-parse path would throw on the first stray character. Regex-based
// extraction gives us the same "best-effort infer, fall through
// cleanly" behavior the task contract demands.
// Program keys come from the first `[programs.*]` table that declares
// any, falling back to a top-level `name = "..."`. Localnet wins over
// mainnet because that is the artifact set a local sim runs against.
function parseAnchorTomlForProgramNames(raw: string): string[] {
  const localnetKeys = extractProgramKeys(raw, "programs.localnet");
  if (localnetKeys.length > 0) return toProgramNames(localnetKeys);

  const mainnetKeys = extractProgramKeys(raw, "programs.mainnet");
  if (mainnetKeys.length > 0) return toProgramNames(mainnetKeys);

  const nameMatch = raw.match(/^\s*name\s*=\s*"([a-z][a-z0-9_-]*)"\s*$/m);
  if (nameMatch && nameMatch[1]) {
    return toProgramNames([nameMatch[1]]);
  }
  return [];
}

function toProgramNames(keys: string[]): string[] {
  return uniqueStrings(keys.map((key) => key.replace(/_/g, "-"))).sort((a, b) =>
    a.localeCompare(b, "en-US")
  );
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

export function renderAdapterStub(programName: string, protocol: Protocol = "custom"): string {
  const soName = programName.replace(/-/g, "_");
  // Protocol flags are recorded as hints; the adapter stays on the generic
  // SBF/IDL runtime for the `/riptide-assess` Skill to finish.
  const intentLine = protocol === "custom" ? "" : `# Adapter profile hint: ${protocol}\n`;
  const genericRuntimeNote = protocol === "amm"
    ? "# AMM currently uses protocol = \"generic\" and Riptide's generic SBF/IDL runtime; amm.v1 semantics is future work.\n"
    : "";
  return `# Riptide adapter for ${programName}.
#
# This is the thin default bootstrap. It records artifact paths and
# leaves simulation-shaping choices to the /riptide-assess Skill.
# It intentionally does not select personas, scenarios, invariants,
# agent counts, tick counts, or seed counts.
# The \`/riptide-assess\` Skill finishes this adapter and authors the
# guided simulation.

${intentLine}${genericRuntimeNote}
protocol = "generic"
program_so = "target/deploy/${soName}.so"
idl_path = "target/idl/${soName}.json"

# TODO: declare every account type the engine should track.
# - \`kind = "agent"\` for accounts owned by a single simulated user
#   (wallet, position, token account, etc.)
# - \`kind = "shared"\` for global / pool / config accounts
# - \`space\` is the account byte size. Use \`space = "auto"\` only when
#   target/idl declares accounts[].size; otherwise set explicit bytes.
[accounts]
# [accounts.position]
# kind = "agent"
# space = 64
#
# [accounts.state]
# kind = "shared"
# space = 128


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
# "state.value" = "state.value"

# TODO: define each runtime-dispatchable action. \`label\` is the dashboard
# display name; \`takes\` lists the numeric args the runtime provides.
[actions]
# [actions.example]
# label = "Example action"
# takes = ["amount"]

# TODO: declare observations for each state-mapping key. Types:
# "uint" / "int" / "bool" / "pubkey" / "map".
[observations]
# "state.value" = "uint"

# TODO: declare personas intentionally. For generic adapters, personas
# live inline here and scenario run-configs usually leave their
# \`personas\` array empty so the engine reads this roster.
[personas]
# [personas.example]
# label = "Example persona"
# action_rate_multiplier = 1.0
# action_weights = { example = 1.0 }
# triggers = []
`;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
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

  // The blank path scaffolds exactly one adapter; the default path
  // scaffolds every detected program, optionally narrowed by `--program`.
  const blankName = normalizeProgramName(options.programName ?? PLACEHOLDER_PROGRAM_NAME);
  const programNames = options.blank
    ? [blankName]
    : selectDetectedPrograms(cwd, options.program).map((entry) => entry.programName);
  const programName = programNames[0]!;
  const warnings = options.blank
    ? ["blank scaffold requested; Riptide did not verify this directory contains a Solana program."]
    : programNames.flatMap((name) => missingArtifactWarnings(cwd, name));
  const protocol: Protocol = options.protocol ?? "custom";

  const created: string[] = [];

  // adapters/ — one per detected program.
  const adaptersDir = path.join(riptideDir, "adapters");
  await mkdir(adaptersDir, { recursive: true });
  const adapters: ScaffoldedAdapter[] = [];
  for (const name of programNames) {
    const adapterRel = path.join(".riptide", "adapters", `${name}.toml`);
    const rendered = renderScaffoldAdapter({
      cwd,
      programName: name,
      protocol,
      blank: Boolean(options.blank),
      warnings
    });
    await writeFile(path.join(adaptersDir, `${name}.toml`), rendered.body, "utf8");
    adapters.push({ programName: name, path: adapterRel, ...rendered.summary });
    created.push(adapterRel);
  }

  await writeFile(path.join(riptideDir, ".gitignore"), WORKSPACE_IGNORE, "utf8");
  created.push(path.join(".riptide", ".gitignore"));

  return { created, programName, programNames, adapters, warnings };
}

function selectDetectedPrograms(cwd: string, program: string | undefined): ProgramDetection[] {
  const detected = detectPrograms(cwd);
  return program === undefined ? detected : [selectProgram(detected, program)];
}

interface ScaffoldAdapterInput {
  cwd: string;
  programName: string;
  protocol: Protocol;
  blank: boolean;
  warnings: string[];
}

type AdapterSummary = Omit<ScaffoldedAdapter, "programName" | "path">;

/**
 * The default path writes a defaulted adapter whenever the program's IDL
 * is readable and declares something to act on. Everything else gets the
 * thin bootstrap, and a warning states which artifact is missing.
 */
function renderScaffoldAdapter(
  input: ScaffoldAdapterInput
): { body: string; summary: AdapterSummary } {
  if (!input.blank) {
    const defaulted = renderDefaultedAdapterFor(input.cwd, input.programName, input.warnings);
    if (defaulted !== undefined) return defaulted;
  }
  return {
    body: renderAdapterStub(input.programName, input.protocol),
    summary: { kind: "thin", mappedInstructions: [], declaredAccounts: [], gaps: 0 }
  };
}

function renderDefaultedAdapterFor(
  cwd: string,
  programName: string,
  warnings: string[]
): { body: string; summary: AdapterSummary } | undefined {
  const soName = programName.replace(/-/g, "_");
  const idlRelPath = `target/idl/${soName}.json`;
  const idlPath = path.join(cwd, "target", "idl", `${soName}.json`);
  if (!existsSync(idlPath)) return undefined;

  const facts = readIdlFacts(idlPath);
  if (!facts) {
    warnings.push(
      `${idlRelPath} could not be parsed as a JSON IDL; wrote the thin bootstrap adapter for ${programName} instead.`
    );
    return undefined;
  }

  const plan = planDefaultAdapter(facts);
  if (!plan) {
    warnings.push(
      `${idlRelPath} declares no instructions Riptide can map by itself; wrote the thin bootstrap adapter for ${programName} instead.`
    );
    return undefined;
  }
  if (plan.instructions.length === 0) {
    warnings.push(
      `${programName}: no IDL instruction resolved without invented values; the adapter records why under [lineage] — the \`/riptide-assess\` Skill finishes it.`
    );
  }

  return {
    body: renderDefaultAdapter({ programName, soName, idlRelPath, plan }),
    summary: {
      kind: "defaults",
      mappedInstructions: plan.instructions.map((instruction) => instruction.name),
      declaredAccounts: plan.accounts.map((account) => account.name),
      gaps: plan.unsupportedFields.length
    }
  };
}

// Build output and run scratch stay out of git; the sim crate, run
// configuration and Assessments stay committable so anyone can rerun them.
// sim/artifacts/ is not scratch: `assess` ingests and hashes the
// guided-sim runs there as evidence.
const WORKSPACE_IGNORE = `# Riptide Workspace: build output and run scratch.
target/
runs/
last-run.json
`;

export class RiptideDirExistsError extends Error {
  readonly dir: string;
  readonly code = "init_workspace_exists";
  readonly next =
    "reuse the existing Workspace instead of scaffolding again, or rerun `riptide init --force --json` to replace it";
  constructor(dir: string) {
    super(
      `${dir} already exists. Use --force to overwrite, or delete it manually.`
    );
    this.dir = dir;
    this.name = "RiptideDirExistsError";
  }
}

export type ProgramDetectionErrorCode =
  | "init_no_program_detected"
  | "init_anchor_toml_unreadable"
  | "init_artifacts_unpaired"
  | "init_program_not_found"
  | "init_invalid_program_name"
  | "init_invalid_option";

export class ProgramDetectionError extends Error {
  readonly code: ProgramDetectionErrorCode;
  /** The recommended next action, for the command error shape. */
  readonly next: string;
  constructor(message: string, code: ProgramDetectionErrorCode, next: string) {
    super(message);
    this.name = "ProgramDetectionError";
    this.code = code;
    this.next = next;
  }
}
