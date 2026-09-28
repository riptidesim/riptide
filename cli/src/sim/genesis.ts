// Tick-0 genesis classification for `riptide sim generate`.
//
// `flows.rs::guided_flow` can only drive a program once tick-0 state exists:
// one funded signer per persona agent, and every `[accounts]` entry the mapped
// instructions touch present on-chain at an address the program will accept.
// This module decides, from adapter + IDL facts alone, whether that state is
// *derivable* — and when it is not, names each unresolved seam instead of
// emitting a genesis that guesses.
//
// The rule is deliberately one-sided. A false "not derivable" costs a routing
// hop to the agent skill. A false "derivable" ships a simulation whose tick-0
// state was invented, which is the one failure mode the evidence claim cannot
// survive. Every widening below is a *declared* fact (an adapter `space`, an
// adapter `pda` seed list, an IDL address), never an inference about bytes the
// program expects.

import type { AccountDefinition, Adapter, PdaDefinition } from "../schemas/adapter.js";
import type { GenericIdl, GenericInstruction, GenericInstructionAccount } from "./idl.js";

/** Stable seam identifiers consumed by the agent tier; do not rename in place. */
export type GenesisGapKind =
  | "no_mapped_actions"
  | "unresolved_account"
  | "additional_signer"
  | "program_constrained_address"
  | "literal_address"
  | "self_initializing_account"
  | "external_owner"
  | "decoded_account"
  | "agent_scope_mismatch"
  | "cyclic_pda_seeds";

export interface GenesisGap {
  /** Stable, sorted key: `accounts.<name>`, `instructions.<name>`, or `adapter`. */
  seam: string;
  kind: GenesisGapKind;
  /** Adapter/IDL account name when the seam is account-shaped. */
  account?: string;
  /** Mapped instructions blocked by this seam, sorted. */
  instructions: string[];
  reason: string;
  /** Generated file the agent tier must complete. */
  file: string;
  /** Marker to search for inside `file`. */
  marker: string;
}

/** One resolvable seed of an adapter-declared PDA. */
export type GenesisSeed =
  | { form: "literal"; value: string }
  | { form: "pubkey"; base58: string }
  | { form: "program"; base58: string }
  | { form: "adminSigner" }
  | { form: "agentSigner" }
  | { form: "account"; account: string; ident: string };

export interface GenesisAccountStep {
  /** `[accounts].<name>` key. */
  name: string;
  /** Rust ident used by `accounts.rs` / `flows.rs`. */
  ident: string;
  kind: "agent" | "shared";
  space: number;
  /**
   * `pda` derives the address from adapter-declared seeds; `synthetic` derives a
   * deterministic placeholder from the program id when nothing constrains the
   * address.
   */
  address:
    | { form: "pda"; seeds: GenesisSeed[]; programBase58?: string }
    | { form: "synthetic" };
  /** True when a seed makes the address per-agent (`signer:agent`). */
  perAgent: boolean;
}

export interface GenesisPlan {
  kind: "derived" | "gaps";
  /** Creation order; `account:` seeds resolve before their dependents. */
  accounts: GenesisAccountStep[];
  gaps: GenesisGap[];
}

const FLOWS_FILE = "src/flows.rs";

/** Every marker below is a literal string the generated `flows.rs` contains. */
const GENESIS_MARKER = "pub fn init";

export function planGenesis(adapter: Adapter, idl: GenericIdl): GenesisPlan {
  const mapped = mappedInstructions(adapter, idl);
  if (Object.keys(adapter.personas).length === 0 || mapped.length === 0) {
    return {
      kind: "gaps",
      accounts: [],
      gaps: sortGaps([
        {
          seam: "adapter",
          kind: "no_mapped_actions",
          instructions: [],
          reason:
            "the adapter declares no `[personas]` or no `[[instructions]]` mapping that resolves against the IDL, so there is no action space to drive and no genesis to derive",
          file: FLOWS_FILE,
          marker: "pub fn guided_flow"
        }
      ])
    };
  }

  const gaps = new Map<string, GenesisGap>();
  const addGap = (gap: Omit<GenesisGap, "instructions">, instruction?: string): void => {
    const existing = gaps.get(gap.seam);
    if (!existing) {
      gaps.set(gap.seam, { ...gap, instructions: instruction ? [instruction] : [] });
      return;
    }
    if (instruction && !existing.instructions.includes(instruction)) {
      existing.instructions.push(instruction);
      existing.instructions.sort();
    }
  };

  // Adapter accounts actually reached by a mapped instruction. Declared-but-
  // unreached accounts are not genesis blockers: nothing signs for them.
  const reached = new Map<string, AccountDefinition>();
  const reachedBy = new Map<string, string[]>();

  for (const entry of mapped) {
    let signerSeen = false;
    for (const account of entry.idl.accounts) {
      const classification = classifyInstructionAccount(account, adapter, signerSeen);
      if (classification.consumedSigner) signerSeen = true;
      if (classification.gap) {
        addGap(classification.gap, entry.ixName);
        continue;
      }
      const name = classification.adapterAccount;
      if (name === undefined) continue;
      reached.set(name, adapter.accounts[name]!);
      const callers = reachedBy.get(name) ?? [];
      if (!callers.includes(entry.ixName)) callers.push(entry.ixName);
      reachedBy.set(name, callers.sort());
    }
  }

  // A reached account whose PDA seeds name another adapter account drags that
  // account into genesis too: its address is needed to derive this one.
  addSeedReferencedAccounts(reached, adapter);

  for (const [name, definition] of [...reached.entries()].sort(byKey)) {
    const gap = classifyAdapterAccount(name, definition, idl);
    if (!gap) continue;
    for (const instruction of reachedBy.get(name) ?? [""]) {
      addGap(gap, instruction || undefined);
    }
  }

  if (gaps.size > 0) {
    return { kind: "gaps", accounts: [], gaps: sortGaps([...gaps.values()]) };
  }

  const ordered = orderAccountSteps(reached, adapter);
  if ("gap" in ordered) {
    return { kind: "gaps", accounts: [], gaps: sortGaps([ordered.gap]) };
  }
  return { kind: "derived", accounts: ordered.steps, gaps: [] };
}

interface MappedInstruction {
  ixName: string;
  idl: GenericInstruction;
}

function mappedInstructions(adapter: Adapter, idl: GenericIdl): MappedInstruction[] {
  const mapped: MappedInstruction[] = [];
  for (const ixName of Object.keys(adapter.instructions).sort()) {
    const idlInstruction = idl.instructions.find(
      (ix) => normalizeIdlName(ix.name) === normalizeIdlName(ixName)
    );
    if (idlInstruction) mapped.push({ ixName, idl: idlInstruction });
  }
  return mapped;
}

interface AccountClassification {
  consumedSigner: boolean;
  /** Set when the account resolves to an `[accounts]` entry that genesis must create. */
  adapterAccount?: string;
  gap?: Omit<GenesisGap, "instructions">;
}

/**
 * Mirrors `render-flows.ts::resolveOneAccount` resolution order so a "derivable"
 * verdict means every `AccountMeta` the executor emits points at an address
 * genesis actually produced.
 */
function classifyInstructionAccount(
  account: GenericInstructionAccount,
  adapter: Adapter,
  signerSeen: boolean
): AccountClassification {
  if (account.signer) {
    // The first signer seat is the persona's actor: created and funded by the
    // derived genesis. Any further signer would need a keypair genesis cannot
    // invent, and the transaction is signed by the actor alone.
    if (!signerSeen) return { consumedSigner: true };
    return {
      consumedSigner: false,
      gap: {
        seam: `accounts.${account.name}`,
        kind: "additional_signer",
        account: account.name,
        reason: `IDL account \`${account.name}\` is a second signer seat; the generated executor signs as the persona actor only, so this instruction needs a hand-authored signer set`,
        file: FLOWS_FILE,
        marker: "fn execute"
      }
    };
  }

  const definition = adapter.accounts[account.name];
  if (definition) {
    if (definition.address !== undefined) {
      if (wellKnownPubkey(definition.address) !== undefined) return { consumedSigner: false };
      return {
        consumedSigner: false,
        gap: literalAddressGap(account.name, definition.address)
      };
    }
    if (account.programConstrainedAddress && definition.pda === undefined) {
      return {
        consumedSigner: false,
        gap: {
          seam: `accounts.${account.name}`,
          kind: "program_constrained_address",
          account: account.name,
          reason: `the IDL constrains \`${account.name}\` to a program-derived address but the adapter declares no \`[accounts.${account.name}].pda\` seeds; genesis cannot reproduce the address the program will check`,
          file: FLOWS_FILE,
          marker: GENESIS_MARKER
        }
      };
    }
    return { consumedSigner: false, adapterAccount: account.name };
  }

  if (account.address !== undefined) {
    if (wellKnownPubkey(account.address) !== undefined) return { consumedSigner: false };
    return { consumedSigner: false, gap: literalAddressGap(account.name, account.address) };
  }

  if (wellKnownPubkey(account.name) !== undefined) return { consumedSigner: false };

  return {
    consumedSigner: false,
    gap: {
      seam: `accounts.${account.name}`,
      kind: "unresolved_account",
      account: account.name,
      reason: `IDL account \`${account.name}\` is not declared under \`[accounts]\`, is not the persona signer seat, and is not a well-known program or sysvar`,
      file: FLOWS_FILE,
      marker: `TODO(account): \`${account.name}\``
    }
  };
}

function literalAddressGap(name: string, address: string): Omit<GenesisGap, "instructions"> {
  return {
    seam: `accounts.${name}`,
    kind: "literal_address",
    account: name,
    reason: `account \`${name}\` is pinned to the literal address \`${address}\`; genesis can reproduce the address but not its on-chain contents — supply a \`[[sim.accounts]]\` snapshot in Riptide.toml or author the account bytes`,
    file: FLOWS_FILE,
    marker: GENESIS_MARKER
  };
}

/**
 * Genesis allocates an `[accounts]` entry as a program-owned, zero-initialized
 * account of its declared `space` — the same tick-0 shape the adapter model
 * already promises. These are the cases where those zero bytes would be a guess
 * rather than the declared starting state.
 */
function classifyAdapterAccount(
  name: string,
  definition: AccountDefinition,
  idl: GenericIdl
): Omit<GenesisGap, "instructions"> | undefined {
  if (definition.owner !== undefined) {
    return {
      seam: `accounts.${name}`,
      kind: "external_owner",
      account: name,
      reason: `account \`${name}\` declares an external \`owner\`; its bytes belong to a sibling program, so genesis cannot allocate it as state of the program under test`,
      file: FLOWS_FILE,
      marker: GENESIS_MARKER
    };
  }
  if (definition.decoder !== undefined) {
    return {
      seam: `accounts.${name}`,
      kind: "decoded_account",
      account: name,
      reason: `account \`${name}\` declares a \`decoder\` (SPL preset or explicit layout), so it carries a foreign layout whose tick-0 field values — mint, authority, balance — are a scenario choice, not a derivable fact`,
      file: FLOWS_FILE,
      marker: GENESIS_MARKER
    };
  }
  // The executor reads a `kind = "agent"` account with `.agent(idx)` and a shared
  // one by name, so the address's scope has to match its declared kind. A
  // mismatch would either collapse the per-agent roster onto one address or look
  // up a name genesis never inserted.
  if (definition.pda !== undefined) {
    const seedPerAgent = definition.pda.seeds.includes("signer:agent");
    if (definition.kind === "agent" && !seedPerAgent) {
      return {
        seam: `accounts.${name}`,
        kind: "agent_scope_mismatch",
        account: name,
        reason: `account \`${name}\` is \`kind = "agent"\` but its \`pda\` seeds contain no \`signer:agent\`, so every agent would resolve to the same address; genesis will not silently collapse the per-agent roster`,
        file: FLOWS_FILE,
        marker: GENESIS_MARKER
      };
    }
    if (definition.kind === "shared" && seedPerAgent) {
      return {
        seam: `accounts.${name}`,
        kind: "agent_scope_mismatch",
        account: name,
        reason: `account \`${name}\` is \`kind = "shared"\` but its \`pda\` seeds include \`signer:agent\`, so the address is per-agent while the executor looks it up as one shared address`,
        file: FLOWS_FILE,
        marker: GENESIS_MARKER
      };
    }
  }
  if (hasAccountDiscriminator(idl, name)) {
    return {
      seam: `accounts.${name}`,
      kind: "self_initializing_account",
      account: name,
      reason: `the IDL declares an 8-byte account discriminator for \`${name}\`, so the program initializes it itself; a zero-filled allocation would fail its own discriminator check`,
      file: FLOWS_FILE,
      marker: GENESIS_MARKER
    };
  }
  return undefined;
}

function hasAccountDiscriminator(idl: GenericIdl, name: string): boolean {
  const target = normalizeIdlName(name);
  const account = idl.accounts.find((entry) => normalizeIdlName(entry.name) === target);
  return account?.discriminator !== undefined && account.discriminator.length > 0;
}

/**
 * Order the creation steps so an `account:<name>` PDA seed resolves after the
 * account it names. A cycle is unresolvable and reported as one seam.
 */
function orderAccountSteps(
  reached: Map<string, AccountDefinition>,
  adapter: Adapter
): { steps: GenesisAccountStep[] } | { gap: GenesisGap } {
  const pending = new Map<string, GenesisAccountStep>();
  for (const [name, definition] of [...reached.entries()].sort(byKey)) {
    pending.set(name, accountStep(name, definition, adapter));
  }

  const steps: GenesisAccountStep[] = [];
  const placed = new Set<string>();
  while (pending.size > 0) {
    const ready = [...pending.values()].filter((step) =>
      accountSeedDependencies(step).every((dep) => placed.has(dep) || !pending.has(dep))
    );
    if (ready.length === 0) {
      const stuck = [...pending.keys()].sort();
      return {
        gap: {
          seam: `accounts.${stuck[0]}`,
          kind: "cyclic_pda_seeds",
          account: stuck[0],
          instructions: [],
          reason: `PDA seeds form a cycle across ${JSON.stringify(stuck)}; no creation order derives every address`,
          file: FLOWS_FILE,
          marker: GENESIS_MARKER
        }
      };
    }
    for (const step of ready) {
      pending.delete(step.name);
      placed.add(step.name);
      steps.push(step);
    }
  }

  // A shared address cannot be derived from a per-agent one: genesis emits every
  // shared account before the per-agent loop, so the dependency has no single
  // value at that point.
  const byName = new Map(steps.map((step) => [step.name, step]));
  for (const step of steps) {
    if (step.perAgent) continue;
    for (const dep of accountSeedDependencies(step)) {
      if (byName.get(dep)?.perAgent !== true) continue;
      return {
        gap: {
          seam: `accounts.${step.name}`,
          kind: "agent_scope_mismatch",
          account: step.name,
          instructions: [],
          reason: `shared account \`${step.name}\` derives its PDA from per-agent account \`${dep}\`, so it has one address per agent rather than one shared address`,
          file: FLOWS_FILE,
          marker: GENESIS_MARKER
        }
      };
    }
  }
  return { steps };
}

function addSeedReferencedAccounts(
  reached: Map<string, AccountDefinition>,
  adapter: Adapter
): void {
  const queue = [...reached.keys()];
  while (queue.length > 0) {
    const definition = adapter.accounts[queue.pop()!];
    for (const seed of definition?.pda?.seeds ?? []) {
      if (!seed.startsWith("account:")) continue;
      const referenced = seed.slice("account:".length);
      const referencedDefinition = adapter.accounts[referenced];
      if (referencedDefinition === undefined || reached.has(referenced)) continue;
      reached.set(referenced, referencedDefinition);
      queue.push(referenced);
    }
  }
}

function accountSeedDependencies(step: GenesisAccountStep): string[] {
  if (step.address.form !== "pda") return [];
  return step.address.seeds
    .filter((seed): seed is Extract<GenesisSeed, { form: "account" }> => seed.form === "account")
    .map((seed) => seed.account);
}

function accountStep(
  name: string,
  definition: AccountDefinition,
  adapter: Adapter
): GenesisAccountStep {
  return {
    name,
    ident: rustIdent(name),
    kind: definition.kind,
    space: definition.space,
    address: definition.pda
      ? pdaAddress(definition.pda, adapter)
      : ({ form: "synthetic" } as const),
    // `classifyAdapterAccount` already rejected any account whose seed scope
    // disagrees with its declared kind, so kind is the scope.
    perAgent: definition.kind === "agent"
  };
}

function pdaAddress(
  pda: PdaDefinition,
  adapter: Adapter
): { form: "pda"; seeds: GenesisSeed[]; programBase58?: string } {
  const seeds = pda.seeds.map((seed) => parseSeed(seed, adapter));
  const program = pda.program;
  const programBase58 =
    program === undefined || program === "self"
      ? undefined
      : (wellKnownPubkey(program) ?? program);
  return { form: "pda", seeds, programBase58 };
}

// Seed grammar validated by `schemas/adapter.ts::validatePdaSeed`, so every
// branch below is reachable only for a seed that already passed validation.
function parseSeed(seed: string, adapter: Adapter): GenesisSeed {
  const sep = seed.indexOf(":");
  const kind = seed.slice(0, sep);
  const value = seed.slice(sep + 1);
  switch (kind) {
    case "literal":
      return { form: "literal", value };
    case "pubkey":
      return { form: "pubkey", base58: value };
    case "program":
      return { form: "program", base58: value === "self" ? "self" : (wellKnownPubkey(value) ?? value) };
    case "signer":
      return value === "admin" ? { form: "adminSigner" } : { form: "agentSigner" };
    default: {
      // `account:<name>`; validation allows a well-known alias here too.
      const wellKnown = wellKnownPubkey(value);
      if (wellKnown !== undefined && adapter.accounts[value] === undefined) {
        return { form: "pubkey", base58: wellKnown };
      }
      return { form: "account", account: value, ident: rustIdent(value) };
    }
  }
}

/** Sorted by seam and re-keyed in declaration order so the JSON bytes are stable. */
function sortGaps(gaps: GenesisGap[]): GenesisGap[] {
  return [...gaps]
    .sort((a, b) => (a.seam < b.seam ? -1 : a.seam > b.seam ? 1 : 0))
    .map((gap) => normalizeGap(gap));
}

export function normalizeGap(gap: GenesisGap): GenesisGap {
  const normalized: GenesisGap = {
    seam: gap.seam,
    kind: gap.kind,
    instructions: [...gap.instructions].sort(),
    reason: gap.reason,
    file: gap.file,
    marker: gap.marker
  };
  if (gap.account !== undefined) {
    return {
      seam: normalized.seam,
      kind: normalized.kind,
      account: gap.account,
      instructions: normalized.instructions,
      reason: normalized.reason,
      file: normalized.file,
      marker: normalized.marker
    };
  }
  return normalized;
}

function byKey(a: [string, unknown], b: [string, unknown]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

function normalizeIdlName(value: string): string {
  return value.replace(/-/g, "_").toLowerCase();
}

// Mirrors `render-flows.ts::WELL_KNOWN_PUBKEYS`.
const WELL_KNOWN_PUBKEYS: Record<string, string> = {
  system: "11111111111111111111111111111111",
  system_program: "11111111111111111111111111111111",
  spl_token: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token_program: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  spl_token_2022: "TokenzQdBNbLqP5VEhdkAS6EPFNH4QFMM8erqD8J1x",
  token_2022: "TokenzQdBNbLqP5VEhdkAS6EPFNH4QFMM8erqD8J1x",
  token_2022_program: "TokenzQdBNbLqP5VEhdkAS6EPFNH4QFMM8erqD8J1x",
  associated_token: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  associated_token_program: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  ata: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  rent: "SysvarRent111111111111111111111111111111111",
  rent_sysvar: "SysvarRent111111111111111111111111111111111",
  sysvar_rent: "SysvarRent111111111111111111111111111111111",
  clock: "SysvarC1ock11111111111111111111111111111111",
  clock_sysvar: "SysvarC1ock11111111111111111111111111111111",
  sysvar_clock: "SysvarC1ock11111111111111111111111111111111",
  instructions_sysvar: "Sysvar1nstructions1111111111111111111111111",
  sysvar_instructions: "Sysvar1nstructions1111111111111111111111111",
  slot_hashes: "SysvarS1otHashes111111111111111111111111111",
  slot_hashes_sysvar: "SysvarS1otHashes111111111111111111111111111",
  sysvar_slot_hashes: "SysvarS1otHashes111111111111111111111111111",
  stake_history: "SysvarStakeHistory1111111111111111111111111",
  stake_history_sysvar: "SysvarStakeHistory1111111111111111111111111",
  sysvar_stake_history: "SysvarStakeHistory1111111111111111111111111"
};

function wellKnownPubkey(value: string): string | undefined {
  return WELL_KNOWN_PUBKEYS[value];
}

function rustIdent(value: string): string {
  const ident = value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  const safe = ident.length > 0 ? ident : "field";
  return RUST_KEYWORDS.has(safe) ? `${safe}_` : safe;
}

const RUST_KEYWORDS = new Set([
  "as", "break", "const", "continue", "crate", "else", "enum", "extern", "false", "fn",
  "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub",
  "ref", "return", "self", "Self", "static", "struct", "super", "trait", "true",
  "type", "unsafe", "use", "where", "while", "async", "await", "dyn"
]);
