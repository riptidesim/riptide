// Zod schema for the adapter TOML.
//
// Must stay in lock-step with the serde schema in
// `engine/src/adapter/schema.rs` and the loader validation in
// `engine/src/adapter/loader.rs`.

import { z } from "zod";

export const LENDING_ACTIONS = [
  "deposit",
  "borrow",
  "repay",
  "withdraw",
  "liquidate",
] as const;

export const LENDING_OBSERVATIONS = [
  "tvl",
  "debt",
  "bad_debt",
  "collateral",
  "liquidated",
] as const;

export const ProtocolSchema = z.enum(["lending", "generic"]);
export type Protocol = z.infer<typeof ProtocolSchema>;

// Sprint 6 T01 — literal-bound IDL args for multi-arg dispatch.
// Accepts natural TOML primitives: numbers (integer literals, no
// floats), booleans, and strings (used for base58-encoded pubkey
// literals). Mirrors `engine/src/adapter/schema.rs::ArgLiteral`.
export const ArgLiteralSchema = z.union([
  z.boolean(),
  z.number().int(),
  z.string()
]);
export type ArgLiteral = z.infer<typeof ArgLiteralSchema>;

export const InstructionMappingSchema = z.object({
  action: z.string().min(1),
  amount: z.string().min(1).optional(),
  // Sprint 6 T01 — literal constants for non-runtime IDL args of a
  // multi-arg instruction. Keys are IDL arg names; values are
  // Borsh-encodable literals (u64/i64/u32/u8 encoded as integers;
  // bool as boolean; pubkey as base58 string). Empty by default so
  // every Sprint 5 single-arg adapter continues to parse byte-for-byte.
  args: z.record(z.string(), ArgLiteralSchema).default({})
});
export type InstructionMapping = z.infer<typeof InstructionMappingSchema>;

export const AccountKindSchema = z.enum(["agent", "shared"]);
export const AccountDefinitionSchema = z.object({
  kind: AccountKindSchema,
  space: z.number().int().positive(),
});

export const ActionDefinitionSchema = z.object({
  label: z.string().min(1).optional(),
  takes: z.array(z.string().min(1)).default([]),
});

export const ObservationTypeSchema = z.enum(["int", "uint", "bool", "pubkey", "map"]);
const ObservationShapeSchema = z.object({
  label: z.string().min(1).optional(),
  type: ObservationTypeSchema,
});
export const ObservationDefinitionSchema = z.union([
  ObservationTypeSchema,
  ObservationShapeSchema,
]);

export const PersonaTriggerSchema = z.object({
  if: z.string().min(1),
  then: z.string().min(1),
  weight_boost: z.number().finite(),
});

export const PersonaDefinitionSchema = z.object({
  label: z.string().min(1).optional(),
  action_rate_multiplier: z.number().finite().nonnegative().default(1),
  action_weights: z.record(z.string(), z.number()).default({}),
  triggers: z.array(PersonaTriggerSchema).default([]),
  // Sprint 6 T01 — per-persona named values the generic encoder
  // substitutes into `args = { <ix-arg> = "@persona.<name>" }`
  // references. Each agent running under this persona supplies its
  // own side/leverage/etc. without forking into one action per
  // variant. Empty by default to preserve byte-stable parsing of
  // Sprint 4/5 adapters.
  persona_args: z.record(z.string(), ArgLiteralSchema).default({})
});

// Sprint 5 T01: declarative invariants block. Flat `{ name?, field, op,
// value }` triples evaluated by the engine after every tick snapshot.
// Intentionally tiny — no AND/OR, no math, no user functions.
export const InvariantOpSchema = z.enum(["==", "!=", ">=", "<=", ">", "<"]);
export type InvariantOp = z.infer<typeof InvariantOpSchema>;

export const InvariantSchema = z.object({
  name: z.string().min(1).optional(),
  field: z.string().min(1),
  op: InvariantOpSchema,
  value: z.number().finite(),
});
export type Invariant = z.infer<typeof InvariantSchema>;

// Sprint 5 T05: generic oracle injection. Adapters can declare
// `[[oracles]]` entries that the engine uses to dispatch price shocks
// through a typed account layout.
export const OracleKindSchema = z.enum(["admin-mock", "pyth"]);
export type OracleKind = z.infer<typeof OracleKindSchema>;

export const OracleDefinitionSchema = z.object({
  name: z.string().min(1),
  kind: OracleKindSchema,
  account: z.string().min(1).optional(),
  base_price: z.number().finite().default(100),
  exponent: z.number().int().min(-128).max(127).default(0),
  confidence: z.number().int().nonnegative().optional(),
});
export type OracleDefinition = z.infer<typeof OracleDefinitionSchema>;

// Sprint 5 T06: engine-triggered scheduled actions. Each entry tells
// the engine to fire an instruction at a fixed cadence (declaration
// order is the tie-break for same-tick firings). Empty by default.
export const ScheduledActionSchema = z.object({
  name: z.string().min(1).optional(),
  instruction: z.string().min(1),
  interval_ticks: z.number().int().positive(),
  accounts: z.array(z.string().min(1)).default([]),
  args: z.record(z.string(), z.unknown()).default({}),
});
export type ScheduledAction = z.infer<typeof ScheduledActionSchema>;

export const AdapterSchema = z.object({
  protocol: ProtocolSchema,
  instructions: z.record(z.string(), InstructionMappingSchema),
  state_mapping: z.record(z.string(), z.string()),
  program_so: z.string().min(1).optional(),
  idl_path: z.string().min(1).optional(),
  accounts: z.record(z.string(), AccountDefinitionSchema).default({}),
  actions: z.record(z.string(), ActionDefinitionSchema).default({}),
  observations: z.record(z.string(), ObservationDefinitionSchema).default({}),
  personas: z.record(z.string(), PersonaDefinitionSchema).default({}),
  invariants: z.array(InvariantSchema).default([]),
  oracles: z.array(OracleDefinitionSchema).default([]),
  scheduled_actions: z.array(ScheduledActionSchema).default([]),
});
export type Adapter = z.infer<typeof AdapterSchema>;

export interface AdapterValidationError {
  path: string;
  key: string;
  reason: string;
}

// Adapter-supplied identifiers flow
// into `snapshot_metrics`/`summarize_metrics` output and are rendered
// raw in the CLI summary's fallback metrics table. Without a character
// allow-list a malicious adapter could smuggle ANSI escape sequences
// through an observation key like `"line\u001bbreak"`. The allow-list
// matches the engine-side `is_safe_adapter_identifier` in
// `engine/src/adapter/loader.rs` so adapter validation is consistent
// on both ends.
const ADAPTER_IDENT_RE = /^[A-Za-z0-9_.-]+$/;
const ADAPTER_IDENT_MAX_LEN = 128;
const ADAPTER_LABEL_MAX_LEN = 256;

function isSafeAdapterIdentifier(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= ADAPTER_IDENT_MAX_LEN &&
    ADAPTER_IDENT_RE.test(value)
  );
}

function isSafeAdapterLabel(value: string): boolean {
  if (value.length === 0 || value.length > ADAPTER_LABEL_MAX_LEN) return false;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code < 0x20) return false;
    if (code === 0x7f) return false;
    if (code >= 0x80 && code < 0xa0) return false;
  }
  return true;
}

function rejectIdentifier(path: string, key: string, value: string): never {
  throw new Error(
    `${path}: \`${key}\`: adapter identifier \`${JSON.stringify(value)}\` must match \`[A-Za-z0-9_.-]+\` (1..=${ADAPTER_IDENT_MAX_LEN} chars); control characters and whitespace are rejected so adapter-supplied names cannot inject ANSI escape sequences into operator-visible CLI output`
  );
}

function rejectLabel(path: string, key: string, value: string): never {
  throw new Error(
    `${path}: \`${key}\`: adapter label must be non-empty and free of control characters (got ${JSON.stringify(value)}) so adapter-supplied text cannot inject ANSI escape sequences into operator-visible CLI output`
  );
}

function checkIdentifier(path: string, key: string, value: string): void {
  if (!isSafeAdapterIdentifier(value)) rejectIdentifier(path, key, value);
}

function checkLabel(path: string, key: string, value: string): void {
  if (!isSafeAdapterLabel(value)) rejectLabel(path, key, value);
}

function validateAdapterIdentifiers(adapter: Adapter, path: string): void {
  for (const accountName of Object.keys(adapter.accounts)) {
    checkIdentifier(path, `[accounts].${accountName}`, accountName);
  }
  for (const [ixName, mapping] of Object.entries(adapter.instructions)) {
    checkIdentifier(path, `[instructions].${ixName}`, ixName);
    checkIdentifier(path, `[instructions].${ixName}.action`, mapping.action);
    if (mapping.amount !== undefined) {
      checkIdentifier(path, `[instructions].${ixName}.amount`, mapping.amount);
    }
    // Sprint 6 T01 — literal-bound arg names go through the same
    // identifier allow-list as every other adapter-supplied name.
    for (const argName of Object.keys(mapping.args)) {
      checkIdentifier(path, `[instructions].${ixName}.args`, argName);
    }
  }
  for (const [key, logical] of Object.entries(adapter.state_mapping)) {
    const scope = `[state_mapping].${key}`;
    for (const segment of key.split(".")) {
      checkIdentifier(path, scope, segment);
    }
    for (const segment of logical.split(".")) {
      checkIdentifier(path, `${scope} (value)`, segment);
    }
  }
  for (const [actionName, action] of Object.entries(adapter.actions)) {
    checkIdentifier(path, `[actions].${actionName}`, actionName);
    if (action.label !== undefined) {
      checkLabel(path, `[actions].${actionName}.label`, action.label);
    }
    for (const arg of action.takes) {
      checkIdentifier(path, `[actions].${actionName}.takes`, arg);
    }
  }
  for (const [obsName, definition] of Object.entries(adapter.observations)) {
    const scope = `[observations].${obsName}`;
    for (const segment of obsName.split(".")) {
      checkIdentifier(path, scope, segment);
    }
    if (typeof definition === "object" && definition.label !== undefined) {
      checkLabel(path, `${scope}.label`, definition.label);
    }
  }
  for (const [personaName, persona] of Object.entries(adapter.personas)) {
    checkIdentifier(path, `[personas].${personaName}`, personaName);
    if (persona.label !== undefined) {
      checkLabel(path, `[personas].${personaName}.label`, persona.label);
    }
    for (const actionName of Object.keys(persona.action_weights)) {
      checkIdentifier(
        path,
        `[personas].${personaName}.action_weights`,
        actionName
      );
    }
  }
}

export function validateAdapter(raw: unknown, path: string): Adapter {
  const parsed = AdapterSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const key = first.path.join(".");
    throw new Error(`${path}: \`${key || "(root)"}\`: ${first.message}`);
  }
  const adapter = parsed.data;

  validateAdapterIdentifiers(adapter, path);

  if (adapter.protocol === "lending") {
    validateLending(adapter, path);
  } else {
    validateGeneric(adapter, path);
  }

  validateOracles(adapter, path);
  validateScheduledActions(adapter, path);

  return adapter;
}

function validateOracles(adapter: Adapter, path: string): void {
  const seen = new Set<string>();
  adapter.oracles.forEach((oracle, idx) => {
    const nameKey = `[[oracles]][${idx}].name`;
    if (!isSafeAdapterIdentifier(oracle.name)) rejectIdentifier(path, nameKey, oracle.name);
    if (seen.has(oracle.name)) {
      throw new Error(
        `${path}: \`${nameKey}\`: duplicate oracle name \`${oracle.name}\``
      );
    }
    seen.add(oracle.name);
    if (adapter.protocol === "generic" && oracle.account !== undefined) {
      if (!(oracle.account in adapter.accounts)) {
        throw new Error(
          `${path}: \`[[oracles]][${idx}].account\`: unknown account \`${oracle.account}\`; declare it under \`[accounts]\``
        );
      }
    }
  });
}

function validateScheduledActions(adapter: Adapter, path: string): void {
  adapter.scheduled_actions.forEach((sa, idx) => {
    const instrKey = `[[scheduled_actions]][${idx}].instruction`;
    if (!isSafeAdapterIdentifier(sa.instruction)) rejectIdentifier(path, instrKey, sa.instruction);
    if (!(sa.instruction in adapter.instructions)) {
      throw new Error(
        `${path}: \`${instrKey}\`: unknown instruction \`${sa.instruction}\`; scheduled actions must reference a key of \`[instructions]\``
      );
    }
    if (sa.interval_ticks <= 0) {
      throw new Error(
        `${path}: \`[[scheduled_actions]][${idx}].interval_ticks\`: must be a positive integer`
      );
    }
    if (sa.name !== undefined && !isSafeAdapterIdentifier(sa.name)) {
      rejectIdentifier(path, `[[scheduled_actions]][${idx}].name`, sa.name);
    }
    sa.accounts.forEach((account, accIdx) => {
      const key = `[[scheduled_actions]][${idx}].accounts[${accIdx}]`;
      if (!isSafeAdapterIdentifier(account)) rejectIdentifier(path, key, account);
      if (adapter.protocol === "generic" && !(account in adapter.accounts)) {
        throw new Error(
          `${path}: \`${key}\`: unknown account \`${account}\`; declare it under \`[accounts]\``
        );
      }
    });
  });
}

function validateLending(adapter: Adapter, path: string): void {
  if (Object.keys(adapter.instructions).length === 0) {
    throw new Error(
      `${path}: \`[instructions]\`: lending adapters must declare at least one instruction mapping`
    );
  }
  for (const [ixName, mapping] of Object.entries(adapter.instructions)) {
    if (!LENDING_ACTIONS.includes(mapping.action as (typeof LENDING_ACTIONS)[number])) {
      throw new Error(
        `${path}: \`[instructions].${ixName}.action\`: unknown lending action \`${mapping.action}\`; expected one of ${JSON.stringify(LENDING_ACTIONS)}`
      );
    }
  }
  for (const [key, logical] of Object.entries(adapter.state_mapping)) {
    validateDottedPath(path, key);
    if (!LENDING_OBSERVATIONS.includes(logical as (typeof LENDING_OBSERVATIONS)[number])) {
      throw new Error(
        `${path}: \`[state_mapping].${key}\`: unknown lending observation \`${logical}\`; expected one of ${JSON.stringify(LENDING_OBSERVATIONS)}`
      );
    }
  }
}

function validateGeneric(adapter: Adapter, path: string): void {
  requireNonEmptyOption(path, "program_so", adapter.program_so, "generic adapters must declare `program_so`");
  requireNonEmptyOption(path, "idl_path", adapter.idl_path, "generic adapters must declare `idl_path`");

  requireNonEmptyBlock(path, "[accounts]", adapter.accounts, "generic adapters must declare at least one account binding");
  requireNonEmptyBlock(path, "[instructions]", adapter.instructions, "generic adapters must declare at least one instruction mapping");
  requireNonEmptyBlock(path, "[actions]", adapter.actions, "generic adapters must declare at least one action");
  requireNonEmptyBlock(path, "[observations]", adapter.observations, "generic adapters must declare at least one observation");
  requireNonEmptyBlock(path, "[personas]", adapter.personas, "generic adapters must declare at least one persona");

  for (const [ixName, mapping] of Object.entries(adapter.instructions)) {
    if (!(mapping.action in adapter.actions)) {
      throw new Error(
        `${path}: \`[instructions].${ixName}.action\`: unknown generic action \`${mapping.action}\`; expected one of ${JSON.stringify(Object.keys(adapter.actions))}`
      );
    }
  }

  // Sprint 6 T01 — multi-arg validation mirrors
  // `engine/src/adapter/loader.rs::validate_generic`. Every `takes`
  // entry must be bound via runtime `amount` or a literal in `args`
  // (but not both) on a SINGLE instruction mapping. Round 4 enforces
  // exactly-one mapping per action to close the split-binding
  // loophole where the old union-across-mappings logic silently
  // accepted amount_in on one mapping + min_out/direction on another
  // while the runtime only dispatches through the first match.
  for (const [actionName, action] of Object.entries(adapter.actions)) {
    const mappingsForAction = Object.entries(adapter.instructions).filter(
      ([, mapping]) => mapping.action === actionName
    );
    if (mappingsForAction.length > 1) {
      const names = mappingsForAction.map(([name]) => name);
      throw new Error(
        `${path}: \`[actions].${actionName}\`: action \`${actionName}\` is targeted by multiple \`[instructions]\` entries (${JSON.stringify(names)}); only one mapping per action is allowed because the runtime resolves by first match and any later mappings become dead code. If two on-chain instructions genuinely implement the same behavior, expose them as two separate adapter actions.`
      );
    }
    const mapping = mappingsForAction[0]?.[1];
    const boundViaAmount = new Set<string>();
    if (mapping?.amount !== undefined) boundViaAmount.add(mapping.amount);
    const boundViaLiterals = new Set<string>(
      mapping ? Object.keys(mapping.args) : []
    );
    for (const expectedArg of action.takes) {
      const inAmount = boundViaAmount.has(expectedArg);
      const inLiterals = boundViaLiterals.has(expectedArg);
      if (!inAmount && !inLiterals) {
        throw new Error(
          `${path}: \`[actions].${actionName}.takes\`: action \`${actionName}\` declares arg \`${expectedArg}\` but no matching \`[instructions].*.amount\` or \`[instructions].*.args.${expectedArg}\` binding was found`
        );
      }
      if (inAmount && inLiterals) {
        throw new Error(
          `${path}: \`[actions].${actionName}.takes\`: action \`${actionName}\` arg \`${expectedArg}\` is bound both as the runtime amount AND as a literal constant in \`args\` — pick one`
        );
      }
    }
  }

  for (const [key, logical] of Object.entries(adapter.state_mapping)) {
    const [account] = validateDottedPath(path, key);
    if (!(account in adapter.accounts)) {
      throw new Error(
        `${path}: \`[state_mapping].${key}\`: unknown generic account binding \`${account}\`; declare it under \`[accounts]\``
      );
    }
    if (!(logical in adapter.observations)) {
      throw new Error(
        `${path}: \`[state_mapping].${key}\`: unknown generic observation \`${logical}\`; declare it under \`[observations]\``
      );
    }
  }

  for (const [personaName, persona] of Object.entries(adapter.personas)) {
    for (const actionName of Object.keys(persona.action_weights)) {
      if (!(actionName in adapter.actions)) {
        throw new Error(
          `${path}: \`[personas].${personaName}.action_weights.${actionName}\`: unknown generic action \`${actionName}\`; expected one of ${JSON.stringify(Object.keys(adapter.actions))}`
        );
      }
    }
    persona.triggers.forEach((trigger, index) => {
      if (!(trigger.then in adapter.actions)) {
        throw new Error(
          `${path}: \`[personas].${personaName}.triggers[${index}].then\`: unknown generic action \`${trigger.then}\`; expected one of ${JSON.stringify(Object.keys(adapter.actions))}`
        );
      }
      validateTriggerCondition(path, personaName, index, trigger.if);
    });
  }
}

function requireNonEmptyOption(
  path: string,
  key: string,
  value: string | undefined,
  reason: string
): void {
  if (!value || value.trim() === "") {
    throw new Error(`${path}: \`${key}\`: ${reason}`);
  }
}

function requireNonEmptyBlock(
  path: string,
  key: string,
  value: Record<string, unknown>,
  reason: string
): void {
  if (Object.keys(value).length === 0) {
    throw new Error(`${path}: \`${key}\`: ${reason}`);
  }
}

function validateDottedPath(path: string, key: string): [string, string] {
  const dot = key.indexOf(".");
  if (dot <= 0 || dot === key.length - 1) {
    throw new Error(
      `${path}: \`[state_mapping].${key}\`: state_mapping keys must be \`<account>.<field>\` (non-empty both sides)`
    );
  }
  return [key.slice(0, dot), key.slice(dot + 1)];
}

function validateTriggerCondition(
  path: string,
  personaName: string,
  index: number,
  condition: string
): void {
  const parts = condition.trim().split(/\s+/);
  if (parts.length !== 3) {
    throw new Error(
      `${path}: \`[personas].${personaName}.triggers[${index}].if\`: generic trigger conditions must be \`<observation> <op> <constant>\``
    );
  }
  if (!["<", ">", "=="].includes(parts[1]!)) {
    throw new Error(
      `${path}: \`[personas].${personaName}.triggers[${index}].if\`: unsupported generic trigger operator \`${parts[1]}\`; expected one of ["<", ">", "=="]`
    );
  }
}
