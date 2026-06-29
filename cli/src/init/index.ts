// Scaffolding module for `riptide init`.
//
// Pure functions only — no CLI I/O, no process.exit. The command layer in
// `cli/src/commands/init.ts` handles argv parsing, user-facing output,
// and exit codes. Everything here is testable in isolation via `scaffold`.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import TOML from "toml";

import { FALLBACK_POLICIES } from "../compiler/fallback.js";
import { validatePolicy, type Policy } from "../compiler/schema.js";
import {
  personaPathCandidates,
  type Protocol
} from "./personas-catalog.js";
import {
  scenarioChoicesFor,
  type InitScenarioConfig,
  type ScenarioCatalogEntry
} from "./scenarios-catalog.js";
import {
  invariantChoicesFor,
  invariantConfigFromCatalog,
  type InitInvariantConfig
} from "./invariants-catalog.js";
import {
  resolveSeedCount,
  seedForSeedCount
} from "./options.js";
import { installBundledSkills } from "./skills.js";

export interface ScaffoldOptions {
  cwd: string;
  force: boolean;
  /** Minimal is the default product path; wizard keeps the legacy rich scaffold. */
  mode?: "minimal" | "wizard";
  /** Explicitly allow scaffolding without a detected Solana program. */
  blank?: boolean;
  /** Optional program name override for the adapter filename and artifact paths. */
  programName?: string;
  /** Adapter protocol field. Defaults to "custom" (rendered as `generic`). */
  protocol?: Protocol;
  /** Persona slugs to copy from the bundled catalog. */
  personas?: string[];
  /** Agent count for the baseline scenario. */
  agents?: number;
  /** Tick count for the baseline scenario. */
  ticks?: number;
  /** Scenario run-configs to scaffold under .riptide/scenarios/. */
  scenarios?: InitScenarioConfig[];
  /** Invariants to inline into the scaffolded adapter. */
  invariants?: InitInvariantConfig[];
  /** Number of seeds generated run-configs should request by default. */
  seeds?: number;
  /**
   * Install bundled Claude Code skills (e.g. `riptide-config`) into
   * `<cwd>/.claude/skills/`. Defaults to true so a freshly-scaffolded
   * project has the same agent UX as the developer's local setup,
   * regardless of whether they have user-level skills installed.
   */
  installSkills?: boolean;
}

export interface ScaffoldResult {
  created: string[];
  programName: string;
  warnings: string[];
  seeds: number;
  scenarios: string[];
  mode: "minimal" | "wizard";
}

const PLACEHOLDER_PROGRAM_NAME = "my-program";

export interface ProgramDetection {
  programName: string;
  source: "anchor" | "artifacts";
  warnings: string[];
}

interface PersonaArtifact {
  slug: string;
  source: string;
  adapterBlock: string;
}

export interface InitIdlField {
  name: string;
  type: unknown;
  observationType?: string;
}

export interface InitIdlAccount {
  name: string;
  size?: number;
  fields: InitIdlField[];
}

export interface InitIdlInstruction {
  name: string;
  args: InitIdlField[];
}

export interface InitIdlFacts {
  accounts: InitIdlAccount[];
  instructions: InitIdlInstruction[];
}

export function preflightScaffold(
  options: Pick<ScaffoldOptions, "cwd" | "force" | "blank">
): ProgramDetection | undefined {
  const riptideDir = path.join(options.cwd, ".riptide");
  if (existsSync(riptideDir) && !options.force) {
    throw new RiptideDirExistsError(riptideDir);
  }
  return options.blank ? undefined : detectProgram(options.cwd);
}

export function inferProgramName(cwd: string): string | null {
  const anchorPath = path.join(cwd, "Anchor.toml");
  if (!existsSync(anchorPath)) {
    return null;
  }
  let raw: string;
  try {
    // Sync read keeps the inference function synchronous to match the
    // task contract — the file is tiny (< 1 KiB typical) and we only
    // read it once at init time. Unreadable/malformed files return
    // null so the caller can fail with an explicit detection error.
    raw = readFileSync(anchorPath, "utf8");
  } catch {
    return null;
  }
  return parseAnchorTomlForProgramName(raw);
}

export function detectProgram(cwd: string): ProgramDetection {
  const anchorPath = path.join(cwd, "Anchor.toml");
  if (existsSync(anchorPath)) {
    const programName = inferProgramName(cwd);
    if (programName === null) {
      throw new ProgramDetectionError(
        "Anchor.toml found, but Riptide could not infer exactly one program name.\n" +
          "Expected one [programs.localnet] entry, one [programs.mainnet] entry, or a top-level name = \"...\".\n" +
          "Use `riptide init --blank --name <program-name>` if you want to scaffold manually."
      );
    }
    return {
      programName,
      source: "anchor",
      warnings: missingArtifactWarnings(cwd, programName)
    };
  }

  const fromArtifacts = detectProgramFromArtifacts(cwd);
  if (fromArtifacts !== null) return fromArtifacts;

  throw new ProgramDetectionError(
    "no Solana program detected in this directory.\n" +
      "Expected an Anchor.toml file or a matching target/deploy/<program>.so + target/idl/<program>.json pair.\n" +
      "Run this from your program repo, or use `riptide init --blank --name <program-name>` to create a manual stub."
  );
}

function detectProgramFromArtifacts(cwd: string): ProgramDetection | null {
  const deployDir = path.join(cwd, "target", "deploy");
  const idlDir = path.join(cwd, "target", "idl");
  if (!existsSync(deployDir) || !existsSync(idlDir)) return null;

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
          "Build/regenerate the missing artifact, or use `riptide init --blank --name <program-name>` to scaffold manually."
      );
    }
    return null;
  }
  if (matches.length > 1) {
    throw new ProgramDetectionError(
      `found multiple program artifact pairs (${matches.join(", ")}); Riptide will not guess.\n` +
        "Use `riptide init --blank --name <program-name>` to choose one explicitly."
    );
  }

  return {
    programName: normalizeProgramName(matches[0]!),
    source: "artifacts",
    warnings: []
  };
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
    warnings.push(`target/deploy/${soName}.so not found yet; build your program before running adapt/run.`);
  }
  if (!existsSync(expectedIdl)) {
    warnings.push(`target/idl/${soName}.json not found yet; generate or commit an IDL before running adapt/run.`);
  }
  return warnings;
}

function loadInitIdlFacts(cwd: string, programName: string, warnings: string[]): InitIdlFacts | undefined {
  const soName = programName.replace(/-/g, "_");
  const idlPath = path.join(cwd, "target", "idl", `${soName}.json`);
  if (!existsSync(idlPath)) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(idlPath, "utf8"));
  } catch (err) {
    warnings.push(`target/idl/${soName}.json could not be parsed for init inference: ${errMessage(err)}.`);
    return undefined;
  }

  const root = objectRecord(parsed);
  if (!root) return undefined;

  const accounts = Array.isArray(root.accounts)
    ? root.accounts.flatMap((entry): InitIdlAccount[] => {
        const account = objectRecord(entry);
        const name = stringValue(account?.name);
        if (!account || !name) return [];
        return [{
          name,
          size: positiveIntegerValue(account.size) ?? undefined,
          fields: idlFields(account)
        }];
      })
    : [];

  const instructions = Array.isArray(root.instructions)
    ? root.instructions.flatMap((entry): InitIdlInstruction[] => {
        const instruction = objectRecord(entry);
        const name = stringValue(instruction?.name);
        if (!instruction || !name) return [];
        const args = Array.isArray(instruction.args)
          ? instruction.args.flatMap((arg): InitIdlField[] => {
              const record = objectRecord(arg);
              const argName = stringValue(record?.name);
              return record && argName ? [{ name: argName, type: record.type }] : [];
            })
          : [];
        return [{ name, args }];
      })
    : [];

  return accounts.length > 0 || instructions.length > 0
    ? { accounts, instructions }
    : undefined;
}

function normalizeProgramName(value: string): string {
  const normalized = value.trim().replace(/_/g, "-");
  if (!/^[a-z][a-z0-9-]*$/.test(normalized)) {
    throw new ProgramDetectionError(
      `invalid program name ${JSON.stringify(value)}. Use lowercase letters, numbers, and dashes, starting with a letter.`
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
function parseAnchorTomlForProgramName(raw: string): string | null {
  // Multi-program workspaces are ambiguous: picking the first key would
  // quietly commit a user of a monorepo to the wrong adapter. Return
  // null so init can ask for an explicit --blank/--name choice.
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

export interface RenderAdapterStubOptions {
  personaBlocks?: string[];
  invariants?: InitInvariantConfig[];
  idlFacts?: InitIdlFacts;
  thin?: boolean;
}

export function renderAdapterStub(
  programName: string,
  protocol: Protocol = "custom",
  options: RenderAdapterStubOptions = {}
): string {
  const soName = programName.replace(/-/g, "_");
  const thin = options.thin ?? false;
  // The default init path is only a bootstrap placeholder, so protocol
  // and profile flags are recorded as hints while the adapter stays on
  // the generic SBF/IDL runtime for `/riptide-config` to finish.
  const protocolValue = !thin && protocol === "lending" ? "lending" : "generic";
  const intentLine = protocol === "custom"
    ? ""
    : thin
      ? `# Adapter profile hint: ${protocol}\n`
      : `# Selected adapter type: ${protocol}\n`;
  const genericRuntimeNote = protocol === "amm"
    ? "# AMM currently uses protocol = \"generic\" and Riptide's generic SBF/IDL runtime; amm.v1 semantics is future work.\n"
    : "";
  const runtimeSections = !thin && protocol === "lending"
    ? `# Lending uses Riptide's bundled lending primitive. Leave
# program_so/idl_path unset unless you are intentionally switching this
# adapter to the generic SBF/IDL runtime.
# If you do switch to generic runtime, remove or replace bundled-lending
# snapshot-metric [[invariants]] unless their fields are declared in
# [observations]; generic lint rejects undeclared invariant fields.
`
    : renderGenericRuntimeSections(soName, thin ? undefined : options.idlFacts);
  const coreSections = !thin && protocol === "lending"
    ? renderAdapterCoreSections(protocol)
    : renderGenericCoreSections(thin ? undefined : options.idlFacts);
  const personasSection = renderPersonasSection(thin ? [] : (options.personaBlocks ?? []));
  const invariantsSection = thin ? "" : renderInvariantsSection(options.invariants ?? []);
  const semanticsSection = thin ? "" : renderSemanticsSection(options.invariants ?? [], protocol);
  const intro = thin
    ? `# This is the thin default bootstrap. It records artifact paths and
# leaves simulation-shaping choices to /riptide-config.
# It intentionally does not select personas, scenarios, invariants,
# agent counts, tick counts, or seed counts.
`
    : `# This is a wizard scaffold — fill in the sections below to wire
# your program into Riptide. Every block has a TODO comment explaining
# what goes in it.
`;
  return `# Riptide adapter for ${programName}.
#
${intro}# Recommended next step: invoke \`/riptide-config\` to finish this adapter
# and author the guided simulation.
${thin ? "" : `# When TODOs are filled, generate the guided sim with
# \`riptide sim generate --adapter .riptide/adapters/${programName}.toml\`,
# then \`riptide sim run .riptide/sim --flows 8\`.
`}
${intentLine}${genericRuntimeNote}
protocol = "${protocolValue}"
${runtimeSections}

${coreSections}
${personasSection}${invariantsSection}${semanticsSection}`;
}

function renderGenericRuntimeSections(soName: string, idlFacts?: InitIdlFacts): string {
  return `program_so = "target/deploy/${soName}.so"
idl_path = "target/idl/${soName}.json"

${renderGenericAccountsSection(idlFacts)}`;
}

function renderGenericAccountsSection(idlFacts?: InitIdlFacts): string {
  const accounts = idlFacts?.accounts ?? [];
  const sized = accounts.filter((account) => account.size !== undefined);
  const unsized = accounts.filter((account) => account.size === undefined);
  if (sized.length === 0) {
    return `# TODO: declare every account type the engine should track.
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
`;
  }

  const liveBlocks = sized.map((account) => `[accounts.${tomlKey(account.name)}]
# TODO: confirm kind; init guessed from the IDL account name.
kind = "${guessAccountKind(account.name)}"
space = "auto"`).join("\n\n");

  const todoBlocks = unsized.length === 0
    ? ""
    : `\n\n# TODO: these IDL accounts do not declare accounts[].size, so Riptide
# cannot use space = "auto". Uncomment each account you need and set bytes.
${unsized.map((account) => `# [accounts.${tomlKey(account.name)}]
# kind = "${guessAccountKind(account.name)}"
# space = <bytes>`).join("\n\n")}`;

  return `# IDL-backed account candidates from target/idl. Confirm kind before running.
${liveBlocks}${todoBlocks}
`;
}

function renderAdapterCoreSections(protocol: Protocol): string {
  if (protocol === "lending") {
    return `# Lending starter mappings selected during \`riptide init\`.
# TODO: verify these instruction names and amount args match your IDL.
[instructions]
deposit   = { action = "deposit",   amount = "amount" }
borrow    = { action = "borrow",    amount = "amount" }
repay     = { action = "repay",     amount = "amount" }
withdraw  = { action = "withdraw",  amount = "amount" }
liquidate = { action = "liquidate", amount = "repay_amount" }

# TODO: update the LHS dotted paths to match your account layout.
[state_mapping]
"pool.total_deposits" = "tvl"
"pool.total_borrows"  = "debt"
"pool.bad_debt"       = "bad_debt"
"position.collateral" = "collateral"
"position.debt"       = "debt"
"position.liquidated" = "liquidated"

[actions.deposit]
label = "Deposit"
takes = ["amount"]

[actions.borrow]
label = "Borrow"
takes = ["amount"]

[actions.repay]
label = "Repay"
takes = ["amount"]

[actions.withdraw]
label = "Withdraw"
takes = ["amount"]

[actions.liquidate]
label = "Liquidate"
takes = ["repay_amount"]

[observations]
tvl = "uint"
debt = "uint"
bad_debt = "uint"
collateral = "uint"
liquidated = "bool"
`;
  }

  return `# TODO: map every instruction you want agents to invoke to a Riptide action.
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
`;
}

function renderGenericCoreSections(idlFacts?: InitIdlFacts): string {
  const instructions = idlFacts?.instructions ?? [];
  const runnableInstructions = instructions.filter((instruction) => instruction.args.length <= 1);
  const todoInstructions = instructions.filter((instruction) => instruction.args.length > 1);
  const autoAccounts = (idlFacts?.accounts ?? [])
    .filter((account) => account.size !== undefined && account.fields.some((field) => field.observationType !== undefined))
    .map((account) => account.name);

  if (runnableInstructions.length === 0 && autoAccounts.length === 0) {
    return renderAdapterCoreSections("custom");
  }

  const instructionSection = runnableInstructions.length === 0
    ? `# TODO: map IDL instructions you want agents to invoke.
[instructions]
`
    : runnableInstructions.map((instruction) => renderInferredInstruction(instruction)).join("\n\n");

  const todoInstructionSection = todoInstructions.length === 0
    ? ""
    : `\n\n# TODO: multi-arg IDL instructions need explicit non-runtime bindings.
${todoInstructions.map((instruction) => renderTodoInstruction(instruction)).join("\n\n")}`;

  const actionSection = runnableInstructions.length === 0
    ? `# TODO: define runtime-dispatchable actions after binding instructions.
[actions]
`
    : runnableInstructions.map((instruction) => `[actions.${tomlKey(instruction.name)}]
label = ${tomlString(titleizeAction(instruction.name))}
takes = [${instruction.args.map((arg) => tomlString(arg.name)).join(", ")}]`).join("\n\n");

  const observationSection = autoAccounts.length === 0
    ? `# TODO: map on-chain state fields to observation keys so invariants + the
# dashboard can read them. LHS is \`<account>.<field>\` from your program,
# RHS is the Riptide observation key.
[state_mapping]
# "state.value" = "state.value"

# TODO: declare observations for each state-mapping key. Types:
# "uint" / "int" / "bool" / "pubkey" / "map".
[observations]
# "state.value" = "uint"`
    : `[state_mapping]

# Opt-in IDL field observations. Remove accounts you do not want exposed.
[observations.auto]
accounts = [${autoAccounts.map(tomlString).join(", ")}]`;

  return `# IDL-backed instruction candidates from target/idl.
${instructionSection}${todoInstructionSection}

${actionSection}

${observationSection}
`;
}

function renderInferredInstruction(instruction: InitIdlInstruction): string {
  if (instruction.args.length === 0) {
    return `[instructions.${tomlKey(instruction.name)}]
action = ${tomlString(instruction.name)}`;
  }
  const arg = instruction.args[0]!;
  return `[instructions.${tomlKey(instruction.name)}]
action = ${tomlString(instruction.name)}

[instructions.${tomlKey(instruction.name)}.bindings]
${tomlKey(arg.name)} = "@runtime.amount"`;
}

function renderTodoInstruction(instruction: InitIdlInstruction): string {
  const lines = [
    `# [instructions.${tomlKey(instruction.name)}]`,
    `# action = ${tomlString(instruction.name)}`,
    `#`,
    `# [instructions.${tomlKey(instruction.name)}.bindings]`,
    ...instruction.args.map((arg, index) => {
      const value = index === 0 ? "\"@runtime.amount\"" : "\"TODO\"";
      return `# ${tomlKey(arg.name)} = ${value}`;
    }),
    `#`,
    `# [actions.${tomlKey(instruction.name)}]`,
    `# label = ${tomlString(titleizeAction(instruction.name))}`,
    `# takes = [${instruction.args.map((arg) => tomlString(arg.name)).join(", ")}]`
  ];
  return lines.join("\n");
}

function guessAccountKind(accountName: string): "agent" | "shared" {
  return /user|owner|authority|wallet|position|obligation|trader|player/i.test(accountName)
    ? "agent"
    : "shared";
}

function titleizeAction(name: string): string {
  return name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function renderPersonasSection(personaBlocks: string[]): string {
  if (personaBlocks.length === 0) {
    return `# TODO: declare personas intentionally. For generic adapters, personas
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

  return `# Personas selected during \`riptide init\`. Edit action_weights and
# triggers after you finish wiring the adapter actions above.
[personas]

${personaBlocks.map((block) => block.trim()).join("\n\n")}
`;
}

export function renderInvariantsSection(invariants: InitInvariantConfig[]): string {
  const blocks = invariants
    .filter((invariant) => invariant.form === "flat")
    .map((invariant) => invariant.toml.trim())
    .filter((block) => block.length > 0);
  return blocks.length === 0 ? "" : `\n${blocks.join("\n\n")}\n`;
}

export function renderSemanticsSection(
  invariants: InitInvariantConfig[],
  protocol: Protocol
): string {
  if (protocol !== "lending") return "";

  const semanticBlocks = invariants
    .filter((invariant) => invariant.form === "semantic")
    .map((invariant) => renderSemanticInvariantBlock(invariant))
    .filter((block) => block.length > 0);

  return `
[semantics]
class = "lending.v1"

[semantics.roles.position]
source = "instruction.deposit_or_borrow" # TODO: if you switch to generic-runtime, confirm the source binding for your IDL
fields.collateral_amount = "u128"
fields.debt_amount = "u128"

[semantics.roles.reserve]
source = "account.reserve" # TODO: if you switch to generic-runtime, name the [accounts.<name>] reserve account
fields.collateral_decimals = "u64"
fields.collateral_price = "u128"
fields.max_ltv_bps = "u64"

[semantics.roles.oracle]
source = "account.oracle" # TODO: if you switch to generic-runtime, name the [accounts.<name>] oracle account
fields.price = "u128"
fields.confidence = "u128"

[semantics.roles.liquidation_config]
source = "account.reserve" # TODO: if you switch to generic-runtime, bind this to your liquidation config account
fields.liquidation_threshold_bps = "u64"

[semantics.derived]
collateral_value = "position.collateral_amount * reserve.collateral_price"
debt_value = "position.debt_amount"
max_borrow_value = "collateral_value * reserve.max_ltv_bps / 10000"
liquidation_threshold_value = "collateral_value * liquidation_config.liquidation_threshold_bps / 10000"
health_factor = "liquidation_threshold_value / max(debt_value, 1)"
${semanticBlocks.length === 0 ? "" : `\n${semanticBlocks.join("\n\n")}\n`}`;
}

function renderSemanticInvariantBlock(invariant: InitInvariantConfig): string {
  if (invariant.expr === undefined) return "";
  const lines = [
    "[[semantics.invariants]]",
    `name = ${tomlString(invariant.name)}`,
    `expr = ${tomlString(invariant.expr)}`,
    `severity = ${tomlString(invariant.severity)}`,
    `description = ${tomlString(invariant.description)}`
  ];
  const body = lines.join("\n");
  return invariant.commented ? body.split("\n").map((line) => `# ${line}`).join("\n") : body;
}

function collectPersonaArtifacts(
  protocol: Protocol,
  personaSlugs: string[],
  warnings: string[]
): PersonaArtifact[] {
  const artifacts: PersonaArtifact[] = [];
  for (const slug of personaSlugs) {
    const source = personaPathCandidates(protocol, slug).find((candidate) => existsSync(candidate));
    if (!source) {
      warnings.push(
        `persona "${slug}" not found in bundled catalog for protocol "${protocol}"; skipped`
      );
      continue;
    }

    let raw: string;
    try {
      raw = readFileSync(source, "utf8");
    } catch (err) {
      warnings.push(`persona "${slug}" could not be read from ${source}: ${errMessage(err)}; skipped`);
      continue;
    }

    let adapterBlock: string;
    try {
      adapterBlock = renderPersonaAdapterBlock(slug, raw);
    } catch (err) {
      warnings.push(`persona "${slug}" could not be embedded in the adapter: ${errMessage(err)}; skipped`);
      continue;
    }

    artifacts.push({ slug, source, adapterBlock });
  }
  return artifacts;
}

function renderPersonaAdapterBlock(slug: string, raw: string): string {
  const parsed = TOML.parse(raw) as Record<string, unknown>;
  const personas = objectRecord(parsed.personas);
  if (personas && Object.keys(personas).length > 0) {
    return raw.trim() + "\n";
  }

  const policy = parsePolicyLikePersona(parsed) ?? FALLBACK_POLICIES[slug];
  if (policy) {
    return renderPolicyAsAdapterPersona(slug, policy, parsed);
  }

  const label = stringValue(parsed.persona_label) ?? titleizePersona(slug);
  return renderAdapterPersonaBlock({
    slug,
    label,
    actionRateMultiplier: numberValue(parsed.action_rate_multiplier) ?? 1,
    actionWeights: {}
  });
}

function parsePolicyLikePersona(parsed: Record<string, unknown>): Policy | null {
  try {
    return validatePolicy(parsed);
  } catch {
    return null;
  }
}

function renderPolicyAsAdapterPersona(
  slug: string,
  policy: Policy,
  raw: Record<string, unknown>
): string {
  return renderAdapterPersonaBlock({
    slug,
    label: policy.persona_label,
    actionRateMultiplier: numberValue(raw.action_rate_multiplier) ?? 1,
    actionWeights: policy.action_weights
  });
}

function renderAdapterPersonaBlock(input: {
  slug: string;
  label: string;
  actionRateMultiplier: number;
  actionWeights: Record<string, number>;
}): string {
  return `[personas.${input.slug}]
label = ${tomlString(input.label)}
action_rate_multiplier = ${formatTomlNumber(input.actionRateMultiplier)}
action_weights = { ${Object.entries(input.actionWeights)
    .map(([key, value]) => `${tomlKey(key)} = ${formatTomlNumber(value)}`)
    .join(", ")} }
triggers = []
`;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function idlFields(account: Record<string, unknown>): InitIdlField[] {
  const direct = Array.isArray(account.fields) ? account.fields : undefined;
  const type = objectRecord(account.type);
  const nested = Array.isArray(type?.fields) ? type.fields : undefined;
  return (direct ?? nested ?? []).flatMap((field): InitIdlField[] => {
    const record = objectRecord(field);
    const name = stringValue(record?.name);
    if (!record || !name) return [];
    return [{
      name,
      type: record.type,
      observationType: observationTypeForInitType(record.type)
    }];
  });
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveIntegerValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function observationTypeForInitType(type: unknown): string | undefined {
  if (typeof type !== "string") return undefined;
  if (type === "bool") return "bool";
  if (type === "pubkey" || type === "publicKey") return "pubkey";
  if (type.startsWith("i")) return "int";
  if (type.startsWith("u")) return "uint";
  return undefined;
}

function titleizePersona(slug: string): string {
  return slug
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlString(value);
}

function formatTomlNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(value);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface GettingStartedOptions {
  scenarios?: string[];
  hasBaselineScenario?: boolean;
  seeds?: number;
  protocol?: Protocol;
  mode?: "minimal" | "wizard";
}

export function renderGettingStarted(
  programName: string,
  options: GettingStartedOptions = {}
): string {
  const { hasBaselineScenario = false } = options;
  const protocol = options.protocol ?? "custom";
  const mode = options.mode ?? "minimal";
  const scenarioNames = options.scenarios ?? (hasBaselineScenario ? ["baseline"] : []);
  const adapterRel = `.riptide/adapters/${programName}.toml`;
  const scenariosLine = scenarioNames.length > 0
    ? `- \`scenarios/\` — advanced questionnaire run-configs created by \`riptide init --wizard\`:\n${scenarioNames
        .map((name) => `  - \`scenarios/${name}/run-config.json\``)
        .join("\n")}\n`
    : "";
  const ammRuntimeLine = protocol === "amm"
    ? "- AMM currently uses `protocol = \"generic\"` and Riptide's generic SBF/IDL runtime; `amm.v1` semantics is future work.\n"
    : "";
  const wizardLayoutLine = mode === "wizard"
    ? `- \`adapters/${programName}.toml\` \`[personas.*]\` — inline persona archetypes selected during the advanced wizard.
- \`adapters/${programName}.toml\` \`[[invariants]]\` and \`[semantics]\` — advanced wizard checks to validate or edit before authoring the simulation.
`
    : "";

  return `# Getting Started With Riptide

Riptide just created a thin \`.riptide/\` workspace. The guided-sim path is:

\`\`\`bash
riptide readiness .
riptide doctor
riptide sim generate --adapter ${adapterRel}
riptide sim run .riptide/sim --flows 8
riptide sim surface .riptide/sim/artifacts/<dir> --sim .riptide/sim
riptide review <guided-sim-root>
riptide assess <guided-sim-root>
\`\`\`

\`/riptide-config\` is the recommended way to finish the adapter and author the guided simulation. \`riptide assess\` is the headline outcome.

## Directory layout

- \`adapters/${programName}.toml\` — placeholder adapter with program artifact paths and TODO blocks for the config skill or a manual author.
${ammRuntimeLine}${wizardLayoutLine}
${scenariosLine}
## Skill-First Setup

\`riptide init\` also dropped the bundled \`riptide-config\` skill into \`.claude/skills/riptide-config/\` so any coding agent run from this repo picks it up automatically — even on a fresh clone or a machine that doesn't have it installed under \`~/.claude/skills/\`. Pass \`--no-skills\` if you want to opt out.

Invoke \`/riptide-config\` from your coding agent at the repo root. It treats this thin scaffold as normal input and owns:

- adapter TOML repair and validation
- personas, invariants, and guided-simulation authoring
- bounded smoke runs and validation
- final next commands for \`riptide sim run\` and \`riptide assess\`

It preserves existing \`.riptide\` files when they are user-authored. If this repo was initialized with \`riptide init --wizard\`, it should preserve those persona and scenario choices unless validation proves they are invalid.

## Manual / Advanced Path

Use this path if you are not using the config skill. To replace this thin scaffold with questionnaire-selected starter files, rerun \`riptide init --wizard --force\`.

1. \`riptide readiness .\` — confirm the repo is ready for a guided sim.
2. \`riptide doctor\` — static health check for the toolchain.
3. Build your program so \`target/deploy/*.so\` and \`target/idl/*.json\` exist.
4. Open \`${adapterRel}\` and fill in the TODO blocks for accounts, instructions, state mapping, actions, observations, personas, invariants, semantics, oracle bindings, and lineage. The untouched placeholder is intentionally incomplete.
5. \`riptide sim generate --adapter ${adapterRel}\` — scaffold the guided simulation under \`.riptide/sim\`.
6. \`riptide sim run .riptide/sim --flows 8\` — run the guided simulation.
7. \`riptide sim surface .riptide/sim/artifacts/<dir> --sim .riptide/sim\` — surface the run's findings.
8. \`riptide assess <guided-sim-root>\` — the headline assessment outcome.

After a guided sim finishes, \`riptide-narrative\` can turn a completed run's result and report into \`report-narrative.md\`.

## Reference

- Shipping adapter examples: [riptidesim/riptide — fixtures/adapters/](https://github.com/riptidesim/riptide/tree/main/fixtures/adapters)
- Architecture deep-dive: [docs/architecture.md](https://github.com/riptidesim/riptide/blob/main/docs/architecture.md)

Problems? Drop the adapter file + the command output into an issue at https://github.com/riptidesim/riptide/issues.
`;
}

export interface RunConfigInput {
  agents: number;
  ticks: number;
  seed?: number;
  seeds?: number;
  scenario: string;
  personas: string[];
  outputPath: string;
}

export function renderRunConfig(input: RunConfigInput): string {
  const seeds = input.seeds === undefined ? undefined : resolveSeedCount(input.seeds);
  const seed = input.seed ?? seedForSeedCount(seeds);
  const config = {
    agents: input.agents,
    ticks: input.ticks,
    ...(seed === undefined ? {} : { seed }),
    ...(seed === undefined && seeds !== undefined ? { seeds } : {}),
    scenario: input.scenario,
    personas: renderPersonaSelection(input.personas, input.agents),
    output_path: input.outputPath
  };
  return JSON.stringify(config, null, 2) + "\n";
}

function renderPersonaSelection(personas: string[], agents: number): string[] | Record<string, number> {
  if (personas.length === 0) return [];
  const counts: Record<string, number> = {};
  for (const persona of personas) counts[persona] = 0;
  for (let i = 0; i < agents; i += 1) {
    const persona = personas[i % personas.length]!;
    counts[persona] = (counts[persona] ?? 0) + 1;
  }
  return counts;
}

function resolveScaffoldScenarios(
  protocol: Protocol,
  requested: InitScenarioConfig[] | undefined,
  defaults: { agents: number; ticks: number; personas: string[]; seeds: number; seed?: number }
): InitScenarioConfig[] {
  const byName = new Map<string, InitScenarioConfig>();
  const ordered: InitScenarioConfig[] = [];
  for (const scenario of requested ?? []) {
    if (byName.has(scenario.name)) continue;
    const seed = scenario.seed ?? defaults.seed;
    const resolved = {
      ...scenario,
      seed,
      seeds: seed === undefined ? (scenario.seeds ?? defaults.seeds) : undefined
    };
    byName.set(scenario.name, resolved);
    ordered.push(resolved);
  }

  const required = scenarioChoicesFor(protocol).filter((entry) => entry.required);
  for (const entry of [...required].reverse()) {
    if (byName.has(entry.name)) continue;
    const scenario = scenarioFromCatalog(entry, defaults);
    byName.set(scenario.name, scenario);
    ordered.unshift(scenario);
  }

  if (ordered.length === 0) {
    ordered.push({
      name: "baseline",
      scenario: "baseline",
      agents: defaults.agents,
      ticks: defaults.ticks,
      seed: defaults.seed,
      seeds: defaults.seed === undefined ? defaults.seeds : undefined,
      personas: defaults.personas
    });
  }

  return ordered;
}

function scenarioFromCatalog(
  entry: ScenarioCatalogEntry,
  defaults: { agents: number; ticks: number; personas: string[]; seeds: number; seed?: number }
): InitScenarioConfig {
  const isBaseline = entry.name === "baseline" || entry.scenario === "baseline";
  return {
    name: entry.name,
    scenario: entry.scenario,
    agents: isBaseline ? defaults.agents : (entry.agents ?? defaults.agents),
    ticks: isBaseline ? defaults.ticks : (entry.ticks ?? defaults.ticks),
    seed: defaults.seed,
    seeds: defaults.seed === undefined ? defaults.seeds : undefined,
    personas: entry.defaultPersonas ?? defaults.personas
  };
}

function resolveScaffoldInvariants(
  protocol: Protocol,
  requested: InitInvariantConfig[] | undefined
): InitInvariantConfig[] {
  const byName = new Map<string, InitInvariantConfig>();
  const ordered: InitInvariantConfig[] = [];
  for (const invariant of requested ?? []) {
    if (byName.has(invariant.name)) continue;
    byName.set(invariant.name, invariant);
    ordered.push(invariant);
  }

  const required = invariantChoicesFor(protocol).filter((entry) => entry.required);
  for (const entry of [...required].reverse()) {
    if (byName.has(entry.name)) continue;
    const invariant = invariantConfigFromCatalog(entry);
    byName.set(invariant.name, invariant);
    ordered.unshift(invariant);
  }

  return ordered;
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

function scenarioNameSegments(name: string): string[] {
  const segments = name.split("/").filter((segment) => segment.length > 0);
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        segment.includes("\\") ||
        !/^[a-z0-9][a-z0-9-]*$/.test(segment)
    )
  ) {
    throw new ProgramDetectionError(
      `invalid scenario name ${JSON.stringify(name)}. Use slash-separated lowercase slugs.`
    );
  }
  return segments;
}

export async function scaffold(options: ScaffoldOptions): Promise<ScaffoldResult> {
  const { cwd, force } = options;
  const mode = options.mode ?? "minimal";
  const richScaffold = mode === "wizard";
  const riptideDir = path.join(cwd, ".riptide");

  if (existsSync(riptideDir)) {
    if (!force) {
      throw new RiptideDirExistsError(riptideDir);
    }
    await rm(riptideDir, { recursive: true, force: true });
  }

  const detection = options.blank
    ? {
        programName: normalizeProgramName(options.programName ?? PLACEHOLDER_PROGRAM_NAME),
        warnings: [
          "blank scaffold requested; Riptide did not verify this directory contains a Solana program."
        ]
      }
    : detectProgram(cwd);
  const programName = normalizeProgramName(options.programName ?? detection.programName);
  const warnings = options.blank ? detection.warnings : missingArtifactWarnings(cwd, programName);
  const protocol: Protocol = options.protocol ?? "custom";
  const idlFacts = !richScaffold
    ? undefined
    : protocol === "lending"
    ? undefined
    : loadInitIdlFacts(cwd, programName, warnings);
  const personaSlugs = richScaffold ? (options.personas ?? []) : [];
  const agents = options.agents ?? 100;
  const ticks = options.ticks ?? 30;
  const seeds = resolveSeedCount(options.seeds);
  const runSeed = seedForSeedCount(seeds);
  const scenarios = richScaffold
    ? resolveScaffoldScenarios(protocol, options.scenarios, {
        agents,
        ticks,
        seeds,
        seed: runSeed,
        personas: personaSlugs
      })
    : [];
  const invariants = richScaffold ? resolveScaffoldInvariants(protocol, options.invariants) : [];
  const personaSlugsToInline = uniqueStrings([
    ...personaSlugs,
    ...scenarios.flatMap((scenario) => scenario.personas)
  ]);
  const personaArtifacts = richScaffold
    ? collectPersonaArtifacts(protocol, personaSlugsToInline, warnings)
    : [];
  const resolvedPersonaSlugs = personaArtifacts.map((artifact) => artifact.slug);
  const resolvedPersonaSet = new Set(resolvedPersonaSlugs);
  const resolvedScenarios = scenarios.map((scenario) => ({
    ...scenario,
    personas: scenario.personas.filter((slug) => resolvedPersonaSet.has(slug))
  }));

  const created: string[] = [];

  // adapters/
  const adaptersDir = path.join(riptideDir, "adapters");
  await mkdir(adaptersDir, { recursive: true });
  const adapterRel = path.join(".riptide", "adapters", `${programName}.toml`);
  await writeFile(
    path.join(riptideDir, "adapters", `${programName}.toml`),
    renderAdapterStub(programName, protocol, {
      personaBlocks: personaArtifacts.map((artifact) => artifact.adapterBlock),
      invariants,
      idlFacts,
      thin: !richScaffold
    }),
    "utf8"
  );
  created.push(adapterRel);

  // scenarios/<name>/run-config.json — only the explicit advanced wizard path
  // creates scenario sizing/seed/persona choices during init.
  for (const scenario of resolvedScenarios) {
    const scenarioSegments = scenarioNameSegments(scenario.name);
    const scenarioDir = path.join(riptideDir, "scenarios", ...scenarioSegments);
    await mkdir(scenarioDir, { recursive: true });
    const scenarioRel = path.join(".riptide", "scenarios", ...scenarioSegments, "run-config.json");
    await writeFile(
      path.join(scenarioDir, "run-config.json"),
      renderRunConfig({
        agents: scenario.agents,
        ticks: scenario.ticks,
        seed: scenario.seed,
        seeds: scenario.seeds,
        scenario: scenario.scenario,
        personas: scenario.personas,
        outputPath: [".riptide", "runs", ...scenarioSegments].join("/")
      }),
      "utf8"
    );
    created.push(scenarioRel);
  }

  // GETTING-STARTED.md (after we know what was actually scaffolded).
  await writeFile(
    path.join(riptideDir, "GETTING-STARTED.md"),
    renderGettingStarted(programName, {
      scenarios: resolvedScenarios.map((scenario) => scenario.name),
      seeds,
      protocol,
      mode
    }),
    "utf8"
  );
  created.push(path.join(".riptide", "GETTING-STARTED.md"));

  // .gitignore entries for volatile run output. Appends to
  // an existing .gitignore when present, creates a fresh one otherwise.
  // We match exact-line entries to avoid duplicating on re-run.
  const gitignoreResult = await ensureGitignoreEntries(cwd);
  if (gitignoreResult.touched) {
    created.push(".gitignore");
  }

  // Install bundled Claude Code skills under .claude/skills/. Existing
  // skill directories are preserved unless --force is set, so a user
  // who has customized their riptide-config skill won't lose their edits
  // by re-running init.
  if (options.installSkills !== false) {
    try {
      const skillResult = await installBundledSkills({ cwd, force });
      created.push(...skillResult.installed);
    } catch (err) {
      warnings.push(`failed to install bundled skills: ${(err as Error).message}`);
    }
  }

  return {
    created,
    programName,
    warnings,
    seeds,
    scenarios: resolvedScenarios.map((scenario) => scenario.name),
    mode
  };
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

export class ProgramDetectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramDetectionError";
  }
}
