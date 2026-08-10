// Build a runnable-by-default adapter from IDL-declared facts.
//
// The rule this module enforces: write down only what the IDL declares,
// and record everything else as a residual under `[lineage]` so the gap
// is machine-readable instead of a comment a human has to notice. A
// conservative "not derivable" always beats a plausible guess — the
// agent tier (`/riptide-config`) is the escape hatch for the rest.
//
// Deliberately program-agnostic: no protocol-family detection, no
// invented invariants, no semantics class. Those belong to the agent
// tier, not the deterministic one.

import {
  DEFAULT_DISCRIMINATOR_BYTES,
  fixedFieldsSize,
  isRuntimeAmountType,
  normalizeIdlName,
  observationTypeFor,
  type IdlAccountFacts,
  type IdlFacts,
  type IdlInstructionFacts
} from "./idl-facts.js";
import { DEFAULT_ACTOR_PERSONA } from "./personas-catalog.js";

export interface DefaultedAccount {
  /** Adapter key — the instruction account slot name. */
  name: string;
  kind: "agent" | "shared";
  space: number;
  /** IDL account type this slot resolved to. */
  idlAccount: string;
  observations: Array<{ field: string; type: "int" | "uint" | "bool" | "pubkey" }>;
}

export interface DefaultedInstruction {
  name: string;
  action: string;
  label: string;
  /** IDL arg bound to the runtime's per-decision amount, when there is one. */
  amount?: string;
  takes: string[];
}

export interface DefaultedPersona {
  slug: string;
  label: string;
  actionRateMultiplier: number;
  actionWeights: Record<string, number>;
}

export interface DefaultAdapterPlan {
  accounts: DefaultedAccount[];
  instructions: DefaultedInstruction[];
  personas: DefaultedPersona[];
  inferredAssumptions: string[];
  unsupportedFields: string[];
}

// Instruction account slots the generic runtime already satisfies without
// an `[accounts]` binding. Mirrors the linter's
// `isRecognizedGenericSigner` so a defaulted adapter and `riptide lint`
// agree on what counts as resolved.
const RECOGNIZED_GENERIC_SIGNERS = new Set([
  "admin",
  "adminauthority",
  "agent",
  "agentauthority",
  "authority",
  "managerauthority",
  "owner",
  "payer",
  "tokenauthority",
  "trader",
  "user",
  "userauthority"
]);

// Mirrors the linter's `isWellKnownGenericAccountAlias`.
const WELL_KNOWN_ACCOUNT_ALIASES = new Set([
  "system",
  "system_program",
  "spl_token",
  "token",
  "token_program",
  "spl_token_2022",
  "token_2022",
  "token_2022_program",
  "associated_token",
  "associated_token_program",
  "ata",
  "rent",
  "rent_sysvar",
  "sysvar_rent",
  "clock",
  "clock_sysvar",
  "sysvar_clock",
  "instructions_sysvar",
  "sysvar_instructions",
  "slot_hashes",
  "slot_hashes_sysvar",
  "sysvar_slot_hashes",
  "stake_history",
  "stake_history_sysvar",
  "sysvar_stake_history"
]);

// Field names that make an account per-actor rather than global. The
// signal is a declared `pubkey` field, not the account's name, so a
// `pool` that stores an `owner` is still read as an agent account.
const AGENT_OWNER_FIELDS = new Set([
  "owner",
  "authority",
  "user",
  "trader",
  "player",
  "wallet",
  "delegate"
]);

/**
 * Plan a defaulted adapter. Returns `undefined` when the IDL declares
 * nothing init can act on — the caller then keeps the thin scaffold.
 */
export function planDefaultAdapter(facts: IdlFacts): DefaultAdapterPlan | undefined {
  const inferredAssumptions: string[] = [];
  const unsupportedFields: string[] = [];

  const accounts = planAccounts(facts, unsupportedFields);
  const declared = new Map(accounts.map((account) => [account.name, account]));
  const instructions = planInstructions(facts, declared, unsupportedFields);

  if (accounts.length === 0 && instructions.length === 0) return undefined;

  // Only accounts an instruction actually touches stay in the adapter;
  // an unreferenced account would widen the observed surface without
  // anything ever writing to it.
  const touched = new Set(
    facts.instructions
      .filter((instruction) => instructions.some((mapped) => mapped.name === instruction.name))
      .flatMap((instruction) => instruction.accounts.map((slot) => slot.name))
  );
  const liveAccounts = accounts.filter((account) => touched.has(account.name));

  if (liveAccounts.length > 0) {
    inferredAssumptions.push(
      `Account byte sizes are derived from the IDL: ${liveAccounts
        .map((account) => `\`${account.name}\` = ${account.space}`)
        .join(", ")} (declared \`size\`, else discriminator + fixed-width Borsh fields).`
    );
    inferredAssumptions.push(
      "`kind` is read from the account's declared fields: an account carrying an owner/authority pubkey is treated as per-agent state, everything else as shared state."
    );
  }
  if (instructions.length > 0) {
    inferredAssumptions.push(
      "Every mapped instruction resolves all of its IDL account slots against `[accounts]`, a declared address, a recognized signer seat, or a well-known program/sysvar; nothing else was mapped."
    );
  }
  inferredAssumptions.push(
    "No invariants or `[semantics]` are declared: those need protocol meaning the IDL does not carry. Author them with `/riptide-config`."
  );

  const personas =
    instructions.length === 0
      ? []
      : [
          {
            slug: DEFAULT_ACTOR_PERSONA.slug,
            label: DEFAULT_ACTOR_PERSONA.label,
            actionRateMultiplier: DEFAULT_ACTOR_PERSONA.actionRateMultiplier,
            actionWeights: Object.fromEntries(
              instructions.map((instruction) => [instruction.action, 1])
            )
          }
        ];

  return {
    accounts: liveAccounts,
    instructions,
    personas,
    inferredAssumptions,
    unsupportedFields
  };
}

function planAccounts(facts: IdlFacts, unsupported: string[]): DefaultedAccount[] {
  const byNormalizedName = new Map(
    facts.accounts.map((account) => [normalizeIdlName(account.name), account])
  );
  const slotNames = new Set<string>();
  for (const instruction of facts.instructions) {
    for (const slot of instruction.accounts) slotNames.add(slot.name);
  }

  const planned: DefaultedAccount[] = [];
  const rejected = new Set<string>();
  for (const slot of [...slotNames].sort()) {
    const idlAccount = byNormalizedName.get(normalizeIdlName(slot));
    if (!idlAccount) continue;

    const space = accountSpace(idlAccount, facts);
    if (space === undefined) {
      if (!rejected.has(idlAccount.name)) {
        rejected.add(idlAccount.name);
        unsupported.push(
          `account \`${idlAccount.name}\` — byte size is not derivable from the IDL (dynamically sized or unresolved field types); declare \`[accounts.${slot}].space\` to model it`
        );
      }
      continue;
    }

    planned.push({
      name: slot,
      kind: accountKind(idlAccount),
      space,
      idlAccount: idlAccount.name,
      observations: idlAccount.fields.flatMap((field) => {
        const type = observationTypeFor(field.type);
        return type ? [{ field: field.name, type }] : [];
      })
    });
  }
  return planned;
}

function accountSpace(account: IdlAccountFacts, facts: IdlFacts): number | undefined {
  if (account.declaredSize !== undefined) return account.declaredSize;
  if (account.fields.length === 0) return undefined;
  const body = fixedFieldsSize(account.fields, facts.typeFields);
  if (body === undefined) return undefined;
  return (account.discriminatorLength ?? DEFAULT_DISCRIMINATOR_BYTES) + body;
}

function accountKind(account: IdlAccountFacts): "agent" | "shared" {
  const hasOwnerKey = account.fields.some(
    (field) =>
      observationTypeFor(field.type) === "pubkey" &&
      AGENT_OWNER_FIELDS.has(normalizeIdlName(field.name))
  );
  return hasOwnerKey ? "agent" : "shared";
}

function planInstructions(
  facts: IdlFacts,
  declared: Map<string, DefaultedAccount>,
  unsupported: string[]
): DefaultedInstruction[] {
  const mapped: DefaultedInstruction[] = [];

  for (const instruction of facts.instructions) {
    const unresolved = instruction.accounts
      .filter((slot) => !slotIsSatisfied(slot, declared))
      .map((slot) => slot.name);
    if (unresolved.length > 0) {
      unsupported.push(
        `instruction \`${instruction.name}\` — account slot(s) ${unresolved
          .map((name) => `\`${name}\``)
          .join(", ")} could not be resolved from the IDL`
      );
      continue;
    }

    const binding = amountBinding(instruction);
    if (binding === "unsupported") {
      unsupported.push(
        `instruction \`${instruction.name}\` — takes ${instruction.args.length} args (${instruction.args
          .map((arg) => `\`${arg.name}\``)
          .join(", ")}); Riptide would have to invent the non-runtime values`
      );
      continue;
    }

    mapped.push({
      name: instruction.name,
      action: instruction.name,
      label: titleize(instruction.name),
      amount: binding,
      takes: binding === undefined ? [] : [binding]
    });
  }

  return mapped;
}

/**
 * The IDL arg the runtime binds its per-decision amount to. `undefined`
 * for a no-arg instruction, `"unsupported"` when binding would require
 * inventing a literal for a second arg or for a non-numeric one.
 */
function amountBinding(instruction: IdlInstructionFacts): string | undefined | "unsupported" {
  if (instruction.args.length === 0) return undefined;
  if (instruction.args.length > 1) return "unsupported";
  const arg = instruction.args[0]!;
  return isRuntimeAmountType(arg.type) ? arg.name : "unsupported";
}

function slotIsSatisfied(
  slot: { name: string; signer: boolean; optional: boolean; address?: string },
  declared: Map<string, DefaultedAccount>
): boolean {
  if (slot.optional) return true;
  if (declared.has(slot.name)) return true;
  if (slot.address !== undefined) return true;
  if (slot.signer && RECOGNIZED_GENERIC_SIGNERS.has(normalizeIdlName(slot.name))) return true;
  return WELL_KNOWN_ACCOUNT_ALIASES.has(slot.name);
}

function titleize(name: string): string {
  return name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export interface RenderDefaultAdapterInput {
  programName: string;
  soName: string;
  idlRelPath: string;
  plan: DefaultAdapterPlan;
}

export function renderDefaultAdapter(input: RenderDefaultAdapterInput): string {
  const { plan, programName, soName, idlRelPath } = input;

  const accountBlocks = plan.accounts
    .map(
      (account) => `[accounts.${tomlKey(account.name)}]
kind = "${account.kind}"
space = ${account.space}`
    )
    .join("\n\n");

  const instructionLines = plan.instructions
    .map((instruction) => {
      const amount =
        instruction.amount === undefined ? "" : `, amount = ${tomlString(instruction.amount)}`;
      return `${tomlKey(instruction.name)} = { action = ${tomlString(instruction.action)}${amount} }`;
    })
    .join("\n");

  const actionBlocks = plan.instructions
    .map(
      (instruction) => `[actions.${tomlKey(instruction.action)}]
label = ${tomlString(instruction.label)}
takes = [${instruction.takes.map(tomlString).join(", ")}]`
    )
    .join("\n\n");

  const observedAccounts = plan.accounts.filter((account) => account.observations.length > 0);
  const observationsSection =
    observedAccounts.length === 0
      ? `[observations]`
      : `# Every observation below is an IDL-declared field on an account the
# mapped instructions touch. Remove any you do not want the dashboard and
# invariants to read.
[observations.auto]
accounts = [${observedAccounts.map((account) => tomlString(account.name)).join(", ")}]`;

  const personaBlocks = plan.personas
    .map(
      (persona) => `[personas.${tomlKey(persona.slug)}]
label = ${tomlString(persona.label)}
action_rate_multiplier = ${persona.actionRateMultiplier}
action_weights = { ${Object.entries(persona.actionWeights)
        .map(([action, weight]) => `${tomlKey(action)} = ${weight}`)
        .join(", ")} }
triggers = []`
    )
    .join("\n\n");

  return `# Riptide adapter for ${programName}.
#
# Generated by \`riptide init\` from ${idlRelPath}. Every entry below is
# derived from a fact the IDL declares; anything Riptide could not derive
# is recorded under [lineage] rather than left as a comment to notice.
#
# What a run over this adapter produces is simulation evidence over the
# inputs declared here — a bounded result, not a safety conclusion.
#
# It is runnable as generated: see .riptide/GETTING-STARTED.md for the
# commands. To sharpen it (personas, invariants, protocol semantics),
# invoke \`/riptide-config\`.

protocol = "generic"
program_so = "target/deploy/${soName}.so"
idl_path = "${idlRelPath}"

${accountBlocks}${accountBlocks.length > 0 ? "\n\n" : ""}[instructions]
${instructionLines}

# Populated from [observations.auto] when the adapter is loaded.
[state_mapping]

${actionBlocks}${actionBlocks.length > 0 ? "\n\n" : ""}${observationsSection}

# One program-agnostic actor spread evenly across the mapped actions.
# Behavioral archetypes need protocol meaning; \`/riptide-config\` owns them.
${personaBlocks}${personaBlocks.length > 0 ? "\n\n" : ""}[lineage]
idl_source = ${tomlString(idlRelPath)}
generator = "riptide init (IDL defaults)"
inferred_assumptions = [
${plan.inferredAssumptions.map((line) => `  ${tomlString(line)},`).join("\n")}
]
unsupported_fields = [
${plan.unsupportedFields.map((line) => `  ${tomlString(line)},`).join("\n")}
]
`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlString(value);
}
