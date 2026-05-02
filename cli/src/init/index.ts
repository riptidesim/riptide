// Scaffolding module for `riptide init`.
//
// Pure functions only — no CLI I/O, no process.exit. The command layer in
// `cli/src/commands/init.ts` handles argv parsing, user-facing output,
// and exit codes. Everything here is testable in isolation via `scaffold`.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import TOML from "toml";

import { cliPackageVersion } from "../banner.js";
import { FALLBACK_POLICIES } from "../compiler/fallback.js";
import { validatePolicy, type Policy } from "../compiler/schema.js";
import { monorepoRootFromModule } from "../orchestrator/index.js";
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
  seedForSeedCount,
  shouldScaffoldHarness,
  type InitHarnessMode
} from "./options.js";

export interface ScaffoldOptions {
  cwd: string;
  force: boolean;
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
  /** Whether to scaffold a Rust setup harness under .riptide/harness. */
  harnessMode?: InitHarnessMode;
  /** Number of seeds generated run-configs should request by default. */
  seeds?: number;
}

export interface ScaffoldResult {
  created: string[];
  programName: string;
  warnings: string[];
  harnessCreated: boolean;
  seeds: number;
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
}

export function renderAdapterStub(
  programName: string,
  protocol: Protocol = "custom",
  options: RenderAdapterStubOptions = {}
): string {
  const soName = programName.replace(/-/g, "_");
  // The engine's adapter loader recognizes "lending" as a first-class
  // protocol; everything else uses the "generic" path. The wizard's
  // protocol selection is preserved as a comment so `riptide-adapt`
  // and humans see the user's intent without guessing.
  const protocolValue = protocol === "lending" ? "lending" : "generic";
  const intentLine = protocol === "custom" ? "" : `# Selected adapter type: ${protocol}\n`;
  const genericRuntimeNote = protocol === "amm"
    ? "# AMM currently uses protocol = \"generic\" and Riptide's generic SBF/IDL runtime; amm.v1 semantics is future work.\n"
    : "";
  const runtimeSections = protocol === "lending"
    ? `# Lending uses Riptide's bundled lending primitive. Leave
# program_so/idl_path unset unless you are intentionally switching this
# adapter to the generic SBF/IDL runtime.
`
    : `program_so = "target/deploy/${soName}.so"
idl_path = "target/idl/${soName}.json"

# TODO: declare every account type the engine should track.
# - \`kind = "agent"\` for accounts owned by a single simulated user
#   (wallet, position, token account, etc.)
# - \`kind = "shared"\` for global / pool / config accounts
# - \`space\` is the account byte size — match your Rust \`#[account]\` layout
[accounts]
# [accounts.player]
# kind = "agent"
# space = 64
`;
  const coreSections = renderAdapterCoreSections(protocol);
  const personasSection = renderPersonasSection(options.personaBlocks ?? []);
  const invariantsSection = renderInvariantsSection(options.invariants ?? []);
  const semanticsSection = renderSemanticsSection(options.invariants ?? [], protocol);
  return `# Riptide adapter for ${programName}.
#
# This is a stub — fill in the sections below to wire your program into
# Riptide. Every block has a TODO comment explaining what goes in it.
# When TODOs are filled, run \`riptide lint ${programName}\`.
# For setup-dependent repos, smoke with \`riptide run --adapter .riptide/adapters/${programName}.toml --harness .riptide/harness --seeds 1 --seed-root 1337\`.
# \`riptide adapt --adapter .riptide/adapters/${programName}.toml\` remains the adapter-only smoke when zeroed setup is enough.
${intentLine}${genericRuntimeNote}
protocol = "${protocolValue}"
${runtimeSections}

${coreSections}
${personasSection}${invariantsSection}${semanticsSection}`;
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
`;
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

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
  harnessCreated?: boolean;
  seeds?: number;
  protocol?: Protocol;
}

export function renderGettingStarted(
  programName: string,
  options: GettingStartedOptions = {}
): string {
  const { hasBaselineScenario = false } = options;
  const harnessCreated = options.harnessCreated ?? false;
  const seeds = resolveSeedCount(options.seeds);
  const protocol = options.protocol ?? "custom";
  const scenarioNames = options.scenarios ?? (hasBaselineScenario ? ["baseline"] : []);
  const scenariosLine = scenarioNames.length > 0
    ? `- \`scenarios/\` — ready-to-run stress harness:\n${scenarioNames
        .map((name) => `  - \`scenarios/${name}/run-config.json\``)
        .join("\n")}\n`
    : `- \`scenarios/\` — create this yourself when you have a real experiment to run. Riptide discovers \`.riptide/scenarios/**/run-config.json\`.\n`;
  const firstRunCommand = `riptide run --adapter .riptide/adapters/${programName}.toml${harnessCreated ? " --harness .riptide/harness" : ""} --seeds 1 --seed-root 1337`;
  const runCommand = scenarioNames.length > 0
    ? `riptide run --adapter .riptide/adapters/${programName}.toml${harnessCreated ? " --harness .riptide/harness" : ""}`
    : `riptide run .riptide/scenarios/your-scenario/run-config.json --adapter .riptide/adapters/${programName}.toml`;
  const harnessLayoutLine = harnessCreated
    ? "- `harness/` — Rust setup crate for account bytes, sibling programs, SPL mints/vaults, PDAs, and other pre-tick-0 state.\n"
    : "";
  const harnessNextStep = harnessCreated
    ? "5. Edit `.riptide/harness/src/main.rs` and fill in setup for account bytes, SPL mints/vaults, PDAs, or sibling programs.\n6. Run the one-seed harness smoke:\n\n   ```\n   " + firstRunCommand + "\n   ```\n\n7. Optional after the harness smoke passes: `riptide adapt --adapter .riptide/adapters/" + programName + ".toml` — adapter-only engine smoke for repos that do not need setup.\n8. "
    : "5. `riptide harness generate --adapter .riptide/adapters/" + programName + ".toml` — Rust setup for custom account bytes, SPL mints/vaults, PDAs, or sibling programs.\n6. Run the one-seed smoke (`--harness .riptide/harness` once a harness exists):\n\n   ```\n   " + firstRunCommand + "\n   ```\n\n7. Optional after the smoke passes: `riptide adapt --adapter .riptide/adapters/" + programName + ".toml` — adapter-only engine smoke for repos that do not need setup.\n8. ";
  const seedCountNote = seeds === 1
    ? `Generated run-configs include \`"seed": ${seedForSeedCount(1)}\`, so the scaffolded scenario pins one deterministic seed. Pass \`--seeds <N>\` when you want a larger sweep.`
    : `Generated run-configs include \`"seeds": ${seeds}\`, so the full scenario battery is a ${seeds}-seed sweep. Start with \`--seeds 1 --seed-root 1337\` for the first smoke, then drop the override for the full sweep.`;
  const ammRuntimeLine = protocol === "amm"
    ? "- AMM currently uses `protocol = \"generic\"` and Riptide's generic SBF/IDL runtime; `amm.v1` semantics is future work.\n"
    : "";

  return `# Getting started with Riptide

Riptide just scaffolded a \`.riptide/\` directory in your repo. Here's what's in it and what to do next.

## Directory layout

- \`adapters/${programName}.toml\` — the bridge between your Solana program and Riptide's engine. Every section has a TODO comment explaining what belongs in it.
${ammRuntimeLine}- \`adapters/${programName}.toml\` \`[personas.*]\` — inline persona archetypes selected during init. Edit \`action_weights\` and \`triggers\` there.
- \`adapters/${programName}.toml\` \`[[invariants]]\` and \`[semantics]\` — declarative checks the engine evaluates after every tick. The default set fires real lending checks; uncomment template invariants once your \`[observations]\` are wired.
${scenariosLine}
${harnessLayoutLine}
## Next steps

1. \`riptide doctor\` — static health check; confirms toolchain + engine binary.
2. Build your program so \`target/deploy/*.so\` and \`target/idl/*.json\` exist.
3. Open \`.riptide/adapters/${programName}.toml\` and fill in the TODO blocks (accounts, instructions, state_mapping, actions, observations, personas, invariants, semantics). The untouched stub is intentionally not lint-clean.
4. \`riptide lint ${programName}\` — static validation against the JSON IDL named in \`[lineage].idl_source\`.
${harnessNextStep}Run the full scenario battery:

   \`\`\`
   ${runCommand}
   \`\`\`

## Seed count

${seedCountNote}

Pass \`--seed-root <N>\` when you want a reproducible sweep seed stream. When using \`--harness .riptide/harness\`, the first run may compile the release harness; warm runs reuse the built binary.

## Reference

- Shipping adapter examples: [riptidesim/riptide — fixtures/adapters/](https://github.com/riptidesim/riptide/tree/main/fixtures/adapters)
- Architecture deep-dive: [docs/architecture.md](https://github.com/riptidesim/riptide/blob/main/docs/architecture.md)

Problems? Drop the adapter file + the engine stderr tail into an issue at https://github.com/riptidesim/riptide/issues.
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
    personas: input.personas,
    output_path: input.outputPath
  };
  return JSON.stringify(config, null, 2) + "\n";
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

async function scaffoldHarness(input: {
  riptideDir: string;
  programName: string;
  adapterRel: string;
}): Promise<string[]> {
  const harnessDir = path.join(input.riptideDir, "harness");
  const srcDir = path.join(harnessDir, "src");
  await mkdir(srcDir, { recursive: true });
  await writeFile(
    path.join(harnessDir, "Cargo.toml"),
    renderInitHarnessCargoToml(`${input.programName}-harness`),
    "utf8"
  );
  await writeFile(
    path.join(srcDir, "main.rs"),
    renderInitHarnessMain(input.adapterRel),
    "utf8"
  );
  await writeFile(
    path.join(harnessDir, "README.md"),
    renderInitHarnessReadme(input.adapterRel),
    "utf8"
  );

  return [
    path.join(".riptide", "harness", "Cargo.toml"),
    path.join(".riptide", "harness", "src", "main.rs"),
    path.join(".riptide", "harness", "README.md")
  ];
}

function renderInitHarnessCargoToml(crateName: string): string {
  return `[package]
name = "${sanitizeCrateName(crateName)}"
version = "0.1.0"
edition = "2021"
publish = false

[workspace]

[dependencies]
anyhow = "1.0"
riptide-engine = ${engineDependency()}
`;
}

function engineDependency(): string {
  const root = monorepoRootFromModule();
  if (root) {
    const engineDir = path.join(root, "engine");
    if (existsSync(path.join(engineDir, "Cargo.toml"))) {
      return `{ path = ${JSON.stringify(engineDir)} }`;
    }
  }
  return JSON.stringify(cliPackageVersion());
}

function renderInitHarnessMain(adapterRel: string): string {
  return `use riptide_engine::harness::{run_harness_cli, HarnessContext, RiptideHarness};

struct ProjectHarness;

impl RiptideHarness for ProjectHarness {
    fn setup(&self, ctx: &mut HarnessContext<'_>) -> anyhow::Result<()> {
        // TODO: replace zeroed bootstrap accounts with the concrete bytes
        // your adapter expects before tick 0.
        //
        // Common helpers:
        //   let mint = ctx.spl_mint("mint", ctx.admin_pubkey(), 1_000_000_000, 6)?;
        //   let authority = ctx.admin_pubkey();
        //   ctx.spl_token_account("vault", mint, authority, 500_000)?;
        //   ctx.agent_spl_token_account("user_ata", 0, mint, ctx.agent_pubkey(0)?, 100_000)?;
        //   ctx.load_program_from_so("../target/deploy/dependency.so")?;
        //
        // Adapter: ${adapterRel}
        let _ = ctx;
        Ok(())
    }
}

fn main() -> std::process::ExitCode {
    run_harness_cli(ProjectHarness)
}
`;
}

function renderInitHarnessReadme(adapterRel: string): string {
  return `# Riptide Rust Harness

This crate owns protocol-specific setup for the adapter:

\`${adapterRel}\`

Use it when your program needs real account bytes, sibling programs, SPL mints,
token accounts, PDAs, or other setup that should not become Riptide core code.

Run it through the CLI:

\`\`\`sh
riptide run --adapter ${adapterRel} --harness .riptide/harness --seeds 1 --seed-root 1337
\`\`\`

After the one-seed smoke passes, drop \`--seeds 1 --seed-root 1337\` for the
full scenario sweep.
`;
}

function sanitizeCrateName(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "riptide-harness";
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
  const personaSlugs = options.personas ?? [];
  const agents = options.agents ?? 100;
  const ticks = options.ticks ?? 30;
  const seeds = resolveSeedCount(options.seeds);
  const runSeed = seedForSeedCount(seeds);
  const harnessCreated = shouldScaffoldHarness(options.harnessMode);
  const scenarios = resolveScaffoldScenarios(protocol, options.scenarios, {
    agents,
    ticks,
    seeds,
    seed: runSeed,
    personas: personaSlugs
  });
  const invariants = resolveScaffoldInvariants(protocol, options.invariants);
  const personaSlugsToInline = uniqueStrings([
    ...personaSlugs,
    ...scenarios.flatMap((scenario) => scenario.personas)
  ]);
  const personaArtifacts = collectPersonaArtifacts(protocol, personaSlugsToInline, warnings);
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
      invariants
    }),
    "utf8"
  );
  created.push(adapterRel);

  // scenarios/<name>/run-config.json — ready-to-run scenario battery.
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
      harnessCreated,
      seeds,
      protocol
    }),
    "utf8"
  );
  created.push(path.join(".riptide", "GETTING-STARTED.md"));

  if (harnessCreated) {
    const harnessCreatedPaths = await scaffoldHarness({
      riptideDir,
      programName,
      adapterRel
    });
    created.push(...harnessCreatedPaths);
  }

  // .gitignore entries for volatile run output (R11.2). Appends to
  // an existing .gitignore when present, creates a fresh one otherwise.
  // We match exact-line entries to avoid duplicating on re-run.
  const gitignoreResult = await ensureGitignoreEntries(cwd);
  if (gitignoreResult.touched) {
    created.push(".gitignore");
  }

  return { created, programName, warnings, harnessCreated, seeds };
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
