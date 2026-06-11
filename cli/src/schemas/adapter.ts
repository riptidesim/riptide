// Zod schema for the adapter TOML.
//
// Must stay in lock-step with the serde schema in
// `engine/src/adapter/schema.rs` and the loader validation in
// `engine/src/adapter/loader.rs`.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";
import { ProgramErrorEntrySchema } from "./errors.js";

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

// Must remain byte-identical to
// `engine/src/adapter/schema.rs::SEMANTIC_CLASS_RE`.
export const SEMANTIC_CLASS_RE_SOURCE = "^[a-z][a-z0-9-]*\\.v[0-9]+$";
export const SEMANTIC_CLASS_RE = new RegExp(SEMANTIC_CLASS_RE_SOURCE);
export const SUPPORTED_SEMANTIC_CLASSES = [
  "lending.v1",
  "amm.v1",
  "perps-margin.v1",
  "lst.v1",
  "stablecoin.v1",
  "token.v1",
] as const;
export type SemanticClass = (typeof SUPPORTED_SEMANTIC_CLASSES)[number];
export const LENDING_V1_REQUIRED_ROLES = [
  "position",
  "reserve",
  "oracle",
  "liquidation_config",
] as const;
export const LENDING_V1_REQUIRED_DERIVED = [
  "collateral_value",
  "debt_value",
  "max_borrow_value",
  "health_factor",
] as const;
export const AMM_V1_REQUIRED_ROLES = [
  "pool",
  "reserve_a",
  "reserve_b",
  "lp_supply",
  "fee_config",
] as const;
export const AMM_V1_REQUIRED_DERIVED = [
  "spot_price",
  "liquidity_value",
  "lp_share_value",
  "reserve_ratio",
  "constant_product",
  "price_impact_bps",
] as const;
export const PERPS_MARGIN_V1_REQUIRED_ROLES = [
  "margin_account",
  "collateral",
  "perp_position",
  "oracle",
  "funding_config",
  "liquidation_config",
  "insurance_fund",
] as const;
export const PERPS_MARGIN_V1_REQUIRED_DERIVED = [
  "account_equity",
  "unrealized_pnl",
  "initial_margin_requirement",
  "maintenance_margin_requirement",
  "margin_ratio",
  "liquidation_buffer",
  "funding_payment",
  "insurance_coverage",
] as const;
export const LST_V1_REQUIRED_ROLES = [
  "pool",
  "underlying_reserve",
  "lst_mint",
  "exchange_rate_config",
  "withdrawal_queue",
] as const;
export const LST_V1_REQUIRED_DERIVED = [
  "total_assets",
  "lst_supply",
  "exchange_rate",
  "reserve_buffer",
  "withdrawal_queue_pressure",
  "claim_coverage_ratio",
  "slash_loss_bps",
] as const;
export const STABLECOIN_V1_REQUIRED_ROLES = [
  "collateral_pool",
  "liabilities",
  "oracle",
  "redemption_queue",
  "backing_module",
  "peg_config",
] as const;
export const STABLECOIN_V1_REQUIRED_DERIVED = [
  "collateral_value",
  "liability_value",
  "backing_ratio",
  "collateralization_ratio",
  "redemption_pressure",
  "redemption_coverage_ratio",
  "peg_deviation_bps",
  "hedge_gap_value",
] as const;
export const TOKEN_V1_REQUIRED_ROLES = [
  "source_account",
  "destination_account",
  "mint",
] as const;
export const TOKEN_V1_REQUIRED_DERIVED = [
  "source_balance",
  "destination_balance",
  "mint_supply",
] as const;
export type SemanticClassRequirements = {
  requiredRoles: readonly string[];
  requiredDerived: readonly string[];
};
export const SEMANTIC_CLASS_REQUIREMENTS = {
  "lending.v1": {
    requiredRoles: LENDING_V1_REQUIRED_ROLES,
    requiredDerived: LENDING_V1_REQUIRED_DERIVED,
  },
  "amm.v1": {
    requiredRoles: AMM_V1_REQUIRED_ROLES,
    requiredDerived: AMM_V1_REQUIRED_DERIVED,
  },
  "perps-margin.v1": {
    requiredRoles: PERPS_MARGIN_V1_REQUIRED_ROLES,
    requiredDerived: PERPS_MARGIN_V1_REQUIRED_DERIVED,
  },
  "lst.v1": {
    requiredRoles: LST_V1_REQUIRED_ROLES,
    requiredDerived: LST_V1_REQUIRED_DERIVED,
  },
  "stablecoin.v1": {
    requiredRoles: STABLECOIN_V1_REQUIRED_ROLES,
    requiredDerived: STABLECOIN_V1_REQUIRED_DERIVED,
  },
  "token.v1": {
    requiredRoles: TOKEN_V1_REQUIRED_ROLES,
    requiredDerived: TOKEN_V1_REQUIRED_DERIVED,
  },
} as const satisfies Record<SemanticClass, SemanticClassRequirements>;
export function isSupportedSemanticClass(value: string): value is SemanticClass {
  return (SUPPORTED_SEMANTIC_CLASSES as readonly string[]).includes(value);
}
export const COLLECTION_FORMULAS = ["sum", "min", "max", "worst"] as const;
export const REPLAY_STATE_SOURCES = ["fixture", "mainnet-rpc"] as const;

// Backcompat runtime hint: `generic` means the SBF/IDL runtime backed by
// `program_so` + `idl_path`; `lending` means the bundled lending
// harness. Economic interpretation lives in `[semantics].class`.
export const ProtocolSchema = z.enum(["lending", "generic"]);
export type Protocol = z.infer<typeof ProtocolSchema>;

export function adapterDeclaresSbfIdlRuntime(
  adapter: Pick<Adapter, "program_so" | "idl_path">
): boolean {
  return hasNonEmptyRuntimePath(adapter.program_so) && hasNonEmptyRuntimePath(adapter.idl_path);
}

export function inferAdapterRuntime(
  adapter: Pick<Adapter, "protocol" | "program_so" | "idl_path">
): Protocol | undefined {
  if (adapterDeclaresSbfIdlRuntime(adapter)) return "generic";
  return adapter.protocol;
}

export function resolveAdapterRuntime(
  adapter: Pick<Adapter, "protocol" | "program_so" | "idl_path">
): Protocol {
  const runtime = inferAdapterRuntime(adapter);
  if (runtime === undefined) {
    throw new Error(
      "adapter runtime could not be resolved; declare `program_so` + `idl_path` or set `protocol` as a backcompat runtime hint"
    );
  }
  return runtime;
}

function hasNonEmptyRuntimePath(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

// literal-bound IDL args for multi-arg dispatch.
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
  // literal constants for non-runtime IDL args of a
  // multi-arg instruction. Keys are IDL arg names; values are
  // Borsh-encodable literals (u128/i128/u64/i64/u32/u8 encoded as
  // integers; bool as boolean; pubkey as base58 string). Empty by default so
  // every single-arg adapter continues to parse byte-for-byte.
  args: z.record(z.string(), ArgLiteralSchema).default({}),
  bindings: z.record(z.string(), ArgLiteralSchema).optional()
});
type ParsedInstructionMapping = z.infer<typeof InstructionMappingSchema>;
export type InstructionMapping = Omit<ParsedInstructionMapping, "bindings"> & {
  bindings?: ParsedInstructionMapping["bindings"];
};

export const AccountKindSchema = z.enum(["agent", "shared"]);

export const PdaDefinitionSchema = z.object({
  seeds: z.array(z.string().min(1)),
  program: z.string().min(1).optional(),
}).strict();
export type PdaDefinition = z.infer<typeof PdaDefinitionSchema>;

// Optional external-owner metadata for `kind = "shared"` accounts.
// Mirrors `engine/src/adapter/schema.rs::AccountOwner`. Exactly one of
// `program_so` or `pubkey` is expected at the engine side; the CLI
// keeps this as a passthrough so tools like `riptide lint` can tell
// that an account is sibling-owned and therefore legitimately outside
// the adapter's primary JSON IDL.
export const AccountOwnerSchema = z.object({
  program_so: z.string().min(1).optional(),
  pubkey: z.string().min(1).optional(),
});
export type AccountOwner = z.infer<typeof AccountOwnerSchema>;

export const ACCOUNT_DECODER_PRESETS = [
  "spl_token_account",
  "spl_mint",
] as const;
export const LAYOUT_FIELD_TYPES = [
  "u8",
  "u64",
  "u128",
  "i64",
  "i128",
  "bool",
  "pubkey",
] as const;
export type LayoutFieldType = (typeof LAYOUT_FIELD_TYPES)[number];

export const LayoutFieldSchema = z.object({
  type: z.string().min(1),
  offset: z.number().int().nonnegative(),
}).strict();
export type LayoutField = z.infer<typeof LayoutFieldSchema>;

export const LayoutDecoderSchema = z.object({
  kind: z.string().min(1),
  fields: z.record(z.string(), LayoutFieldSchema).default({}),
}).strict();
export type LayoutDecoder = z.infer<typeof LayoutDecoderSchema>;

export const AccountDecoderSchema = z.union([
  z.string().min(1),
  LayoutDecoderSchema,
]);
export type AccountDecoder = z.infer<typeof AccountDecoderSchema>;

export const AccountDefinitionSchema = z.object({
  kind: AccountKindSchema,
  space: z.union([z.number().int().nonnegative(), z.literal("auto")]).optional(),
  address: z.string().min(1).optional(),
  pda: PdaDefinitionSchema.optional(),
  owner: AccountOwnerSchema.optional(),
  decoder: AccountDecoderSchema.optional(),
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
const AutoObservationDefinitionSchema = z.object({
  accounts: z.array(z.string().min(1)).default([]),
}).strict();
export const ObservationDefinitionSchema = z.union([
  ObservationTypeSchema,
  ObservationShapeSchema,
  AutoObservationDefinitionSchema,
]);

export const PersonaTriggerSchema = z.object({
  if: z.string().min(1),
  then: z.string().min(1),
  weight_boost: z.number().finite(),
});

export const PersonaDefinitionSchema = z.object({
  label: z.string().min(1).optional(),
  action_rate_multiplier: z.number().finite().nonnegative().default(1),
  amount: z.number().finite().positive().default(1),
  action_weights: z.record(z.string(), z.number()).default({}),
  triggers: z.array(PersonaTriggerSchema).default([]),
  // per-persona named values the generic encoder
  // substitutes into `args = { <ix-arg> = "@persona.<name>" }`
  // references. Each agent running under this persona supplies its
  // own side/leverage/etc. without forking into one action per
  // variant. Empty by default to preserve byte-stable parsing of
  // adapters.
  persona_args: z.record(z.string(), ArgLiteralSchema).default({})
});

// declarative invariants block. Flat `{ name?, field, op,
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

// generic oracle injection. Adapters can declare
// `[[oracles]]` entries that the engine uses to dispatch price shocks
// through a typed account layout.
export const OracleKindSchema = z.enum([
  "admin-mock"
]);
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

// engine-triggered scheduled actions. Each entry tells
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

export const SemanticFieldTypeSchema = z.enum(["u64", "u128", "i64", "i128", "bool", "pubkey"]);
export type SemanticFieldType = z.infer<typeof SemanticFieldTypeSchema>;

export const SemanticRoleSchema = z.object({
  source: z.string().min(1),
  fields: z.record(z.string(), SemanticFieldTypeSchema),
}).strict();
export type SemanticRole = z.infer<typeof SemanticRoleSchema>;

export const SemanticInvariantSeveritySchema = z.enum(["error", "warn"]);
export type SemanticInvariantSeverity = z.infer<typeof SemanticInvariantSeveritySchema>;

export const SemanticInvariantSchema = z.object({
  name: z.string().min(1),
  expr: z.string().min(1),
  severity: SemanticInvariantSeveritySchema.default("error"),
  description: z.string().min(1).optional(),
}).strict();
export type SemanticInvariant = z.infer<typeof SemanticInvariantSchema>;

export const OracleBindingSchema = z.object({
  program_id: z.string().min(1),
  account: z.string().min(1),
  confidence: z.string().min(1),
  staleness: z.string().min(1),
  weight: z.number().int().nonnegative().optional(),
}).strict();
export type OracleBinding = z.infer<typeof OracleBindingSchema>;

export const CollectionDefSchema = z.object({
  over: z.string().min(1),
  formula: z.string().min(1),
  expr: z.string().min(1),
}).strict();
export type CollectionDef = z.infer<typeof CollectionDefSchema>;

export const ReplayBlockSchema = z.object({
  state_source: z.string().min(1).optional(),
  pack_path: z.string().min(1).optional(),
  slot: z.number().int().nonnegative().optional(),
  roles: z.record(z.string(), z.string().min(1)).default({}),
}).strict();
export type ReplayBlock = z.infer<typeof ReplayBlockSchema>;

export const SemanticsSchema = z.object({
  class: z.string().min(1).optional(),
  roles: z.record(z.string(), SemanticRoleSchema).default({}),
  derived: z.record(z.string(), z.string().min(1)).default({}),
  invariants: z.array(SemanticInvariantSchema).default([]),
  extensions: z.record(z.string(), z.unknown()).default({}),
  oracles: z.record(z.string(), z.array(OracleBindingSchema)).default({}),
  collections: z.record(z.string(), CollectionDefSchema).default({}),
  replay: ReplayBlockSchema.optional(),
}).strict();
export type Semantics = z.infer<typeof SemanticsSchema>;

// Optional `[lineage]` block. Inspection-only reviewer-facing metadata:
// which IDL the adapter was authored against, the generator, any
// inferred assumptions the author baked in, and IDL fields the adapter
// deliberately does not model. Every field is optional on parse so
// legacy adapters continue to validate byte-for-byte. Mirrors
// `engine/src/adapter/schema.rs::AdapterLineage`, including
// `#[serde(deny_unknown_fields)]`.
//
// `.strict()` is load-bearing here: a typoed key like
// `unsupported_field = [...]` (singular) must fail adapter
// validation, not silently render as "(none recorded)". Lineage is
// reviewer documentation, and a silently-dropped typo hides exactly
// the kind of omission the surface is supposed to catch.
export const AdapterLineageSchema = z.object({
  idl_source: z.string().min(1).optional(),
  generator: z.string().min(1).optional(),
  inferred_assumptions: z.array(z.string().min(1)).default([]),
  unsupported_fields: z.array(z.string().min(1)).default([]),
}).strict();
export type AdapterLineage = z.infer<typeof AdapterLineageSchema>;

export const AdapterSchema = z.object({
  protocol: ProtocolSchema.optional(),
  instructions: z.record(z.string(), InstructionMappingSchema),
  state_mapping: z.record(z.string(), z.string()),
  program_so: z.string().min(1).optional(),
  program_id: z.string().min(1).optional(),
  idl_path: z.string().min(1).optional(),
  accounts: z.record(z.string(), AccountDefinitionSchema).default({}),
  actions: z.record(z.string(), ActionDefinitionSchema).default({}),
  observations: z.record(z.string(), ObservationDefinitionSchema).default({}),
  personas: z.record(z.string(), PersonaDefinitionSchema).default({}),
  invariants: z.array(InvariantSchema).default([]),
  oracles: z.array(OracleDefinitionSchema).default([]),
  scheduled_actions: z.array(ScheduledActionSchema).default([]),
  semantics: SemanticsSchema.optional(),
  errors: z.array(ProgramErrorEntrySchema).default([]),
  lineage: AdapterLineageSchema.optional(),
});
export type RawAdapter = z.infer<typeof AdapterSchema>;
export type AccountDefinition = Omit<z.infer<typeof AccountDefinitionSchema>, "space"> & {
  space: number;
};
export type Adapter = Omit<RawAdapter, "accounts" | "observations" | "instructions"> & {
  accounts: Record<string, AccountDefinition>;
  instructions: Record<string, InstructionMapping>;
  observations: Record<string, z.infer<typeof ObservationDefinitionSchema>>;
};

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
// Lineage prose is reviewer documentation — inferred assumptions and
// unsupported-field explanations run longer than short labels. Mirror
// the engine's `ADAPTER_LINEAGE_TEXT_MAX_LEN` byte cap so CLI and
// engine reject/accept the same strings. 1024 bytes lets an author
// name a concrete IDL field AND explain why it is unsupported in one
// entry.
const ADAPTER_LINEAGE_TEXT_MAX_LEN = 1024;

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

function isSafeLineageText(value: string): boolean {
  // The engine measures lineage text with Rust `str.len()`, which is
  // UTF-8 byte length. JS `String.length` is UTF-16 code-unit count,
  // which diverges for any non-ASCII character. Using
  // `Buffer.byteLength(..., "utf8")` keeps the CLI + engine byte caps
  // byte-identical — an adapter that passes CLI validation lands on
  // the engine the same way.
  if (value.length === 0) return false;
  if (Buffer.byteLength(value, "utf8") > ADAPTER_LINEAGE_TEXT_MAX_LEN) return false;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code < 0x20) return false;
    if (code === 0x7f) return false;
    if (code >= 0x80 && code < 0xa0) return false;
  }
  return true;
}

function escapeDiagnostic(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, (char) => {
    const code = char.codePointAt(0)!;
    return `\\u{${code.toString(16)}}`;
  });
}

function rejectLineageText(path: string, key: string, value: string): never {
  throw new Error(
    `${path}: \`${key}\`: lineage text must be non-empty, at most ${ADAPTER_LINEAGE_TEXT_MAX_LEN} bytes, and free of C0/C1 control characters (got ${JSON.stringify(value)}) so adapter-supplied text cannot inject ANSI escape sequences into operator-visible CLI output`
  );
}

function checkLineageText(path: string, key: string, value: string): void {
  if (!isSafeLineageText(value)) rejectLineageText(path, key, value);
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
  for (const [accountName, account] of Object.entries(adapter.accounts)) {
    checkIdentifier(path, `[accounts].${accountName}`, accountName);
    if (account.decoder !== undefined) {
      if (typeof account.decoder === "string") {
        checkIdentifier(path, `[accounts].${accountName}.decoder`, account.decoder);
      } else {
        checkIdentifier(path, `[accounts].${accountName}.decoder.kind`, account.decoder.kind);
        for (const fieldName of Object.keys(account.decoder.fields)) {
          checkIdentifier(
            path,
            `[accounts].${accountName}.decoder.fields.${fieldName}`,
            fieldName
          );
        }
      }
    }
  }
  for (const [ixName, mapping] of Object.entries(adapter.instructions)) {
    checkIdentifier(path, `[instructions].${ixName}`, ixName);
    checkIdentifier(path, `[instructions].${ixName}.action`, mapping.action);
    if (mapping.amount !== undefined) {
      checkIdentifier(path, `[instructions].${ixName}.amount`, mapping.amount);
    }
    // literal-bound arg names go through the same
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
    if (isObservationShapeDefinition(definition) && definition.label !== undefined) {
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

  normalizeGenericInference(adapter, path);
  const normalized = adapter as Adapter;

  validateAdapterIdentifiers(normalized, path);
  validateLineage(normalized, path);
  validateSemantics(normalized, path);
  validateErrors(normalized, path);
  validateAccountBindings(normalized, path);
  validateAccountOwners(normalized, path);
  validateAccountDecoders(normalized, path);

  const runtime = validateRuntimeSelection(normalized, path);
  if (runtime === "lending") {
    validateLending(normalized, path);
  } else {
    validateGeneric(normalized, path);
  }

  validateOracles(normalized, path, runtime);
  validateScheduledActions(normalized, path, runtime);

  return normalized;
}

function validateRuntimeSelection(adapter: Adapter, path: string): Protocol {
  const runtime = inferAdapterRuntime(adapter);
  if (runtime !== undefined) return runtime;
  throw new Error(
    `${path}: \`protocol\`: missing runtime selection; declare \`program_so\` + \`idl_path\` for the generic SBF/IDL runtime, or set \`protocol = "lending"\` / \`protocol = "generic"\` as a backcompat runtime hint`
  );
}

interface IdlFieldFact {
  name: string;
  observationType?: z.infer<typeof ObservationTypeSchema>;
}

interface IdlFacts {
  accounts: Map<string, { size?: number; fields: IdlFieldFact[] }>;
  instructions: Map<string, { args: string[] }>;
}

function normalizeGenericInference(adapter: RawAdapter, adapterPath: string): void {
  if (inferAdapterRuntime(adapter) !== "generic") return;

  const needsIdl =
    Object.values(adapter.accounts).some((account) => account.space === undefined || account.space === "auto") ||
    Object.values(adapter.instructions).some((mapping) => Object.keys(mapping.bindings ?? {}).length > 0) ||
    hasAutoObservations(adapter) ||
    Object.keys(adapter.actions).length === 0;

  const idlFacts = loadIdlFacts(adapter, adapterPath, needsIdl);

  if (idlFacts) {
    normalizeAccountSpaces(adapter, adapterPath, idlFacts);
    normalizeInstructionBindings(adapter, adapterPath, idlFacts);
    normalizeAutoObservations(adapter, adapterPath, idlFacts);
  } else {
    const autoAccount = Object.entries(adapter.accounts).find(
      ([, account]) => account.space === undefined || account.space === "auto"
    );
    if (autoAccount) {
      throw new Error(
        `${adapterPath}: \`[accounts].${autoAccount[0]}.space\`: could not infer account space because \`idl_path\` is missing or unreadable; set \`space = <bytes>\` explicitly or provide a readable JSON IDL`
      );
    }
  }
}

function hasAutoObservations(adapter: RawAdapter): boolean {
  const auto = adapter.observations.auto;
  return isAutoObservationDefinition(auto);
}

function isAutoObservationDefinition(value: unknown): value is { accounts: string[] } {
  return value !== null && typeof value === "object" && !Array.isArray(value) && "accounts" in value && !("type" in value);
}

function isObservationShapeDefinition(
  value: unknown
): value is { type: z.infer<typeof ObservationTypeSchema>; label?: string } {
  return value !== null && typeof value === "object" && !Array.isArray(value) && "type" in value;
}

function loadIdlFacts(adapter: RawAdapter, adapterPath: string, required: boolean): IdlFacts | null {
  if (typeof adapter.idl_path !== "string" || adapter.idl_path.trim().length === 0) {
    if (required) {
      throw new Error(
        `${adapterPath}: \`idl_path\`: IDL-backed inference requires a readable JSON IDL path`
      );
    }
    return null;
  }
  const resolved = resolveRuntimePath(adapter.idl_path, adapterPath);
  if (!existsSync(resolved)) {
    if (required) {
      throw new Error(
        `${adapterPath}: \`idl_path\`: IDL-backed inference could not read ${resolved}; build/regenerate the IDL or use explicit adapter fields`
      );
    }
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, "utf8"));
  } catch (err) {
    throw new Error(
      `${adapterPath}: \`idl_path\`: failed to parse JSON IDL at ${resolved}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return collectIdlFacts(parsed);
}

// Canonical resolution for adapter-declared runtime files (`idl_path`,
// `program_so`): absolute paths pass through, adapter-dir-relative wins when
// the file exists there, and adapters under `.riptide/adapters/` fall back to
// the user repo root so `target/idl/x.json`-style paths resolve the same way
// everywhere (lint, generate, explain).
export function resolveRuntimePath(raw: string, adapterPath: string): string {
  if (path.isAbsolute(raw)) return raw;
  const adapterDir = path.dirname(path.resolve(adapterPath));
  const adapterRelative = path.resolve(adapterDir, raw);
  if (existsSync(adapterRelative)) return adapterRelative;
  const repoRoot = userRepoRootForRiptideAdapter(adapterPath);
  return repoRoot ? path.resolve(repoRoot, raw) : adapterRelative;
}

function userRepoRootForRiptideAdapter(adapterPath: string): string | null {
  const adapterDir = path.dirname(path.resolve(adapterPath));
  const riptideDir = path.dirname(adapterDir);
  if (path.basename(adapterDir) !== "adapters" || path.basename(riptideDir) !== ".riptide") {
    return null;
  }
  return path.dirname(riptideDir);
}

function collectIdlFacts(idl: unknown): IdlFacts {
  const root = asRecord(idl);
  const accounts = new Map<string, { size?: number; fields: IdlFieldFact[] }>();
  const instructions = new Map<string, { args: string[] }>();
  const rawAccounts = Array.isArray(root?.accounts) ? root.accounts : [];
  for (const entry of rawAccounts) {
    const account = asRecord(entry);
    if (!account) continue;
    const name = stringValue(account?.name);
    if (!name) continue;
    const fields = idlFields(account).map((field) => ({
      name: field.name,
      observationType: observationTypeForIdlType(field.type)
    }));
    accounts.set(normalizeIdlName(name), {
      size: numberValue(account?.size),
      fields
    });
  }
  const rawInstructions = Array.isArray(root?.instructions) ? root.instructions : [];
  for (const entry of rawInstructions) {
    const instruction = asRecord(entry);
    const name = stringValue(instruction?.name);
    if (!name) continue;
    const args = Array.isArray(instruction?.args)
      ? instruction.args
          .map((arg) => stringValue(asRecord(arg)?.name))
          .filter((arg): arg is string => Boolean(arg))
      : [];
    instructions.set(normalizeIdlName(name), { args });
  }
  return { accounts, instructions };
}

function normalizeAccountSpaces(adapter: RawAdapter, adapterPath: string, idlFacts: IdlFacts): void {
  for (const [name, account] of Object.entries(adapter.accounts)) {
    if (account.space !== undefined && account.space !== "auto") continue;
    const fact = idlFacts.accounts.get(normalizeIdlName(name));
    if (fact?.size === undefined) {
      throw new Error(
        `${adapterPath}: \`[accounts].${name}.space\`: could not infer account space from \`idl_path\`; set \`space = <bytes>\` explicitly for dynamic or non-Anchor accounts`
      );
    }
    account.space = fact.size;
  }
}

function normalizeInstructionBindings(adapter: RawAdapter, adapterPath: string, idlFacts: IdlFacts): void {
  for (const [ixName, mapping] of Object.entries(adapter.instructions)) {
    for (const [argName, binding] of Object.entries(mapping.bindings ?? {})) {
      if (binding === "@runtime.amount") {
        if (mapping.amount !== undefined && mapping.amount !== argName) {
          throw new Error(
            `${adapterPath}: \`[instructions].${ixName}.bindings.${argName}\`: mapping already binds runtime amount to \`${mapping.amount}\`; only one \`@runtime.amount\` binding is allowed`
          );
        }
        if (mapping.args[argName] !== undefined) {
          throw new Error(
            `${adapterPath}: \`[instructions].${ixName}.bindings.${argName}\`: arg is already bound as a literal in \`args\`; remove one binding`
          );
        }
        mapping.amount = argName;
      } else {
        if (typeof binding === "string" && binding.startsWith("@runtime.")) {
          throw new Error(
            `${adapterPath}: \`[instructions].${ixName}.bindings.${argName}\`: unsupported runtime binding \`${binding}\`; expected \`@runtime.amount\``
          );
        }
        if (typeof binding === "string" && binding.startsWith("@persona.")) {
          const personaKey = binding.slice("@persona.".length);
          if (!isSafeAdapterIdentifier(personaKey)) {
            throw new Error(
              `${adapterPath}: \`[instructions].${ixName}.bindings.${argName}\`: persona binding \`${binding}\` must reference a safe persona key matching \`[A-Za-z0-9_.-]+\``
            );
          }
        }
        if (mapping.amount === argName) {
          throw new Error(
            `${adapterPath}: \`[instructions].${ixName}.bindings.${argName}\`: arg is already bound to runtime amount; remove the literal binding`
          );
        }
        mapping.args[argName] = binding;
      }
    }
    delete mapping.bindings;

    const idlArgs = idlFacts.instructions.get(normalizeIdlName(ixName))?.args;
    if (idlArgs && idlArgs.length === 1 && mapping.amount === undefined && Object.keys(mapping.args).length === 0) {
      mapping.amount = idlArgs[0];
    }
    if (idlArgs) {
      const action = adapter.actions[mapping.action] ?? { takes: [] };
      if (action.takes.length === 0) {
        action.takes = [...idlArgs];
      }
      adapter.actions[mapping.action] = action;
      validateInstructionArgsAgainstIdl(adapter, adapterPath, ixName, mapping, idlArgs);
    }
  }
}

function validateInstructionArgsAgainstIdl(
  adapter: RawAdapter,
  adapterPath: string,
  ixName: string,
  mapping: ParsedInstructionMapping,
  idlArgs: string[]
): void {
  const idlArgSet = new Set(idlArgs);
  if (mapping.amount !== undefined && !idlArgSet.has(mapping.amount)) {
    throw new Error(
      `${adapterPath}: \`[instructions].${ixName}.amount\`: arg \`${mapping.amount}\` is not declared by the IDL instruction \`${ixName}\`; expected one of ${JSON.stringify(idlArgs)}`
    );
  }
  for (const argName of Object.keys(mapping.args)) {
    if (!idlArgSet.has(argName)) {
      throw new Error(
        `${adapterPath}: \`[instructions].${ixName}.args.${argName}\`: arg \`${argName}\` is not declared by the IDL instruction \`${ixName}\`; expected one of ${JSON.stringify(idlArgs)}`
      );
    }
  }
  for (const argName of idlArgs) {
    const inAmount = mapping.amount === argName;
    const inArgs = Object.prototype.hasOwnProperty.call(mapping.args, argName);
    if (!inAmount && !inArgs) {
      throw new Error(
        `${adapterPath}: \`[instructions].${ixName}\`: IDL arg \`${argName}\` is not bound; declare \`bindings.${argName}\`, \`amount = "${argName}"\`, or \`args.${argName}\``
      );
    }
    if (inAmount && inArgs) {
      throw new Error(
        `${adapterPath}: \`[instructions].${ixName}\`: IDL arg \`${argName}\` is bound both as runtime amount and as a literal/persona arg; remove one binding`
      );
    }
  }

  const action = adapter.actions[mapping.action];
  if (action !== undefined && action.takes.length > 0) {
    const takesSet = new Set(action.takes);
    for (const argName of idlArgs) {
      if (!takesSet.has(argName)) {
        throw new Error(
          `${adapterPath}: \`[actions].${mapping.action}.takes\`: action omits IDL arg \`${argName}\` required by \`[instructions].${ixName}\`; include every IDL arg or leave \`takes\` empty for IDL-backed inference`
        );
      }
    }
  }
}

function normalizeAutoObservations(adapter: RawAdapter, adapterPath: string, idlFacts: IdlFacts): void {
  const auto = adapter.observations.auto;
  if (!isAutoObservationDefinition(auto)) return;
  delete adapter.observations.auto;
  for (const accountName of auto.accounts) {
    const fact = idlFacts.accounts.get(normalizeIdlName(accountName));
    if (!fact) {
      throw new Error(
        `${adapterPath}: \`[observations.auto].accounts\`: unknown IDL account \`${accountName}\``
      );
    }
    for (const field of fact.fields) {
      if (!field.observationType) continue;
      const key = `${accountName}.${field.name}`;
      adapter.state_mapping[key] ??= key;
      adapter.observations[key] ??= field.observationType;
    }
  }
}

function normalizeIdlName(value: string): string {
  return value.replace(/-/g, "_").toLowerCase();
}

function idlFields(account: Record<string, unknown> | null): Array<{ name: string; type: unknown }> {
  const direct = account?.fields;
  if (Array.isArray(direct)) return fieldFacts(direct);
  const type = asRecord(account?.type);
  if (Array.isArray(type?.fields)) return fieldFacts(type.fields);
  return [];
}

function fieldFacts(fields: unknown[]): Array<{ name: string; type: unknown }> {
  return fields.flatMap((field) => {
    const record = asRecord(field);
    const name = stringValue(record?.name);
    return name ? [{ name, type: record?.type }] : [];
  });
}

function observationTypeForIdlType(type: unknown): z.infer<typeof ObservationTypeSchema> | undefined {
  if (typeof type !== "string") return undefined;
  if (type === "bool") return "bool";
  if (type === "pubkey" || type === "publicKey") return "pubkey";
  if (type.startsWith("i")) return "int";
  if (type.startsWith("u")) return "uint";
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function validateErrors(adapter: Adapter, path: string): void {
  const codes = new Set<number>();
  const labels = new Set<string>();
  adapter.errors.forEach((entry, idx) => {
    if (codes.has(entry.code)) {
      throw new Error(
        `${path}: \`[[errors]][${idx}].code\`: duplicate program error code \`${entry.code}\`; each \`[[errors]]\` entry must have a unique u32 code`
      );
    }
    codes.add(entry.code);
    if (labels.has(entry.label)) {
      throw new Error(
        `${path}: \`[[errors]][${idx}].label\`: duplicate program error label \`${escapeDiagnostic(entry.label)}\`; each \`[[errors]]\` entry must have a unique snake_case label`
      );
    }
    labels.add(entry.label);
  });
}

function validateSemantics(adapter: Adapter, path: string): void {
  const semantics = adapter.semantics;
  if (semantics === undefined) return;

  if (semantics.class === undefined) {
    throw new Error(
      `${path}: \`[semantics].class\`: MissingSemanticClass(class); \`[semantics]\` blocks must declare an economic class such as \`class = "lending.v1"\``
    );
  }
  if (!SEMANTIC_CLASS_RE.test(semantics.class)) {
    throw new Error(
      `${path}: \`[semantics].class\`: malformed semantic class string \`${escapeDiagnostic(semantics.class)}\`; expected regex \`${SEMANTIC_CLASS_RE_SOURCE}\``
    );
  }
  if (!isSupportedSemanticClass(semantics.class)) {
    throw new Error(
      `${path}: \`[semantics].class\`: UnknownSemanticClass(${escapeDiagnostic(semantics.class)}); supported semantic classes: ${JSON.stringify(SUPPORTED_SEMANTIC_CLASSES)}`
    );
  }
  const requirements = SEMANTIC_CLASS_REQUIREMENTS[semantics.class];
  for (const role of requirements.requiredRoles) {
    if (!(role in semantics.roles)) {
      throw new Error(
        `${path}: \`[semantics.roles]\`: missing required role \`${role}\` for \`${semantics.class}\``
      );
    }
  }
  for (const name of requirements.requiredDerived) {
    if (!(name in semantics.derived)) {
      throw new Error(
        `${path}: \`[semantics.derived]\`: missing required derived observation \`${name}\` for \`${semantics.class}\``
      );
    }
  }

  for (const [roleName, role] of Object.entries(semantics.roles)) {
    checkSemanticName(path, `[semantics.roles].${roleName}`, roleName);
    validateSemanticSource(path, `[semantics.roles].${roleName}.source`, role.source);
    if (Object.keys(role.fields).length === 0) {
      throw new Error(
        `${path}: \`[semantics.roles].${roleName}.fields\`: semantic role must declare at least one typed field`
      );
    }
    for (const fieldName of Object.keys(role.fields)) {
      checkSemanticName(path, `[semantics.roles].${roleName}.fields.${fieldName}`, fieldName);
    }
  }

  for (const name of Object.keys(semantics.derived)) {
    checkSemanticName(path, `[semantics.derived].${name}`, name);
  }

  const invariantNames = new Set<string>();
  semantics.invariants.forEach((invariant, idx) => {
    const key = `[[semantics.invariants]][${idx}].name`;
    checkSemanticName(path, key, invariant.name);
    if (invariantNames.has(invariant.name)) {
      throw new Error(
        `${path}: \`${escapeDiagnostic(key)}\`: duplicate semantic name \`${escapeDiagnostic(invariant.name)}\``
      );
    }
    invariantNames.add(invariant.name);
    if (invariant.description !== undefined) {
      checkLabel(path, `[[semantics.invariants]][${idx}].description`, invariant.description);
    }
  });

  for (const [role, bindings] of Object.entries(semantics.oracles)) {
    checkSemanticName(path, `[semantics.oracles].${role}`, role);
    if (!(role in semantics.roles)) {
      throw new Error(
        `${path}: \`[semantics.oracles].${escapeDiagnostic(role)}\`: UnknownOracleRole(${escapeDiagnostic(role)}); declare \`[semantics.roles.${escapeDiagnostic(role)}]\` before binding \`[semantics.oracles.${escapeDiagnostic(role)}]\``
      );
    }
    if (bindings.length === 0) {
      throw new Error(
        `${path}: \`[semantics.oracles].${escapeDiagnostic(role)}\`: MultiOracleArityMismatch(role=${escapeDiagnostic(role)}); expected at least 1 oracle binding, found 0`
      );
    }
    let weightCount = 0;
    let weightSum = 0;
    bindings.forEach((binding, idx) => {
      const key = `[[semantics.oracles.${role}]][${idx}]`;
      validatePubkeyString(path, `${key}.program_id`, "program_id", binding.program_id);
      validatePubkeyString(path, `${key}.account`, "account", binding.account);
      checkIdentifier(path, `${key}.confidence`, binding.confidence);
      checkIdentifier(path, `${key}.staleness`, binding.staleness);
      if (binding.weight !== undefined) {
        weightCount += 1;
        weightSum += binding.weight;
      }
    });
    if (weightCount > 0 && weightCount !== bindings.length) {
      throw new Error(
        `${path}: \`[semantics.oracles].${escapeDiagnostic(role)}.weight\`: MultiOracleArityMismatch(role=${escapeDiagnostic(role)}); expected ${bindings.length} weight entries to match the oracle binding count, found ${weightCount}`
      );
    }
    if (weightCount > 0 && weightSum === 0) {
      throw new Error(
        `${path}: \`[semantics.oracles].${escapeDiagnostic(role)}.weight\`: MultiOracleWeightsAllZero(role=${escapeDiagnostic(role)}); weighted oracle bindings must have a positive total weight`
      );
    }
  }

  for (const [name, collection] of Object.entries(semantics.collections)) {
    checkSemanticName(path, `[semantics.collections].${name}`, name);
    checkSemanticName(path, `[semantics.collections].${name}.over`, collection.over);
    if (!isKnownCollectionOver(semantics, collection.over)) {
      throw new Error(
        `${path}: \`[semantics.collections].${escapeDiagnostic(name)}.over\`: UnknownCollectionRole(${escapeDiagnostic(collection.over)}); \`over\` must reference a declared semantic role, or one of \`reserves\`, \`markets\`, \`positions\` whose singular role is declared`
      );
    }
    if (!COLLECTION_FORMULAS.includes(collection.formula as (typeof COLLECTION_FORMULAS)[number])) {
      throw new Error(
        `${path}: \`[semantics.collections].${escapeDiagnostic(name)}.formula\`: UnknownCollectionFormula(${escapeDiagnostic(collection.formula)}); expected one of \`sum\`, \`min\`, \`max\`, \`worst\``
      );
    }
  }

  if (semantics.replay !== undefined) {
    const replay = semantics.replay;
    if (
      replay.state_source === undefined ||
      !REPLAY_STATE_SOURCES.includes(replay.state_source as (typeof REPLAY_STATE_SOURCES)[number])
    ) {
      throw new Error(
        `${path}: \`[semantics.replay].state_source\`: UnknownReplayStateSource(${escapeDiagnostic(replay.state_source ?? "<missing>")}); expected \`fixture\` or \`mainnet-rpc\``
      );
    }
    if (replay.state_source === "fixture") {
      if (replay.pack_path === undefined || replay.pack_path.trim().length === 0) {
        throw new Error(
          `${path}: \`[semantics.replay].pack_path\`: MissingReplayPackPath; fixture replay state import requires \`pack_path = "<relative-path>"\``
        );
      }
      validateRelativePath(path, "[semantics.replay].pack_path", replay.pack_path);
    } else if (replay.pack_path !== undefined) {
      validateRelativePath(path, "[semantics.replay].pack_path", replay.pack_path);
    }
    for (const [role, account] of Object.entries(replay.roles)) {
      checkSemanticName(path, `[semantics.replay.roles].${role}`, role);
      if (!(role in semantics.roles)) {
        throw new Error(
          `${path}: \`[semantics.replay.roles].${escapeDiagnostic(role)}\`: replay role \`${escapeDiagnostic(role)}\` references no \`[semantics.roles.${escapeDiagnostic(role)}]\` entry`
        );
      }
      validatePubkeyString(path, `[semantics.replay.roles].${role}`, "account pubkey", account);
    }
  }
}

function isKnownCollectionOver(semantics: Semantics, over: string): boolean {
  if (over in semantics.roles) return true;
  const singular = collectionPluralAlias(over);
  return singular !== null && singular in semantics.roles;
}

function collectionPluralAlias(over: string): string | null {
  switch (over) {
    case "reserves":
      return "reserve";
    case "markets":
      return "market";
    case "positions":
      return "position";
    default:
      return null;
  }
}

function validateSemanticSource(path: string, key: string, source: string): void {
  const instruction = source.startsWith("instruction.") ? source.slice("instruction.".length) : null;
  if (instruction !== null) {
    if (instruction.length === 0) {
      rejectUnknownSemanticSource(path, key, source);
    }
    checkIdentifier(path, key, instruction);
    return;
  }

  const account = source.startsWith("account.") ? source.slice("account.".length) : null;
  if (account !== null) {
    if (account.length === 0) {
      rejectUnknownSemanticSource(path, key, source);
    }
    for (const segment of account.split(".")) {
      checkIdentifier(path, key, segment);
    }
    return;
  }

  rejectUnknownSemanticSource(path, key, source);
}

function rejectUnknownSemanticSource(path: string, key: string, source: string): never {
  throw new Error(
    `${path}: \`${escapeDiagnostic(key)}\`: unknown source binding type \`${escapeDiagnostic(source)}\`; expected \`instruction.<name>\` or \`account.<path>\``
  );
}

function checkSemanticName(path: string, key: string, value: string): void {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new Error(
      `${path}: \`${escapeDiagnostic(key)}\`: semantic name \`${escapeDiagnostic(value)}\` must match \`[a-z][a-z0-9_]*\``
    );
  }
}

function validatePubkeyString(path: string, key: string, label: string, value: string): void {
  const reason = base58PubkeyError(value);
  if (reason !== null) {
    throw new Error(
      `${path}: \`${escapeDiagnostic(key)}\`: ${label} \`${escapeDiagnostic(value)}\` is not a valid base58-encoded 32-byte pubkey: ${reason}`
    );
  }
}

function validateRelativePath(path: string, key: string, value: string): void {
  if (value.trim().length === 0 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(
      `${path}: \`${escapeDiagnostic(key)}\`: path \`${escapeDiagnostic(value)}\` must be non-empty and free of control characters`
    );
  }
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) {
    throw new Error(
      `${path}: \`${escapeDiagnostic(key)}\`: path \`${escapeDiagnostic(value)}\` must be relative to the adapter or replay fixture root`
    );
  }
}

function validateLineage(adapter: Adapter, path: string): void {
  const lineage = adapter.lineage;
  if (lineage === undefined) return;
  if (lineage.idl_source !== undefined) {
    checkLineageText(path, "[lineage].idl_source", lineage.idl_source);
  }
  if (lineage.generator !== undefined) {
    checkLineageText(path, "[lineage].generator", lineage.generator);
  }
  lineage.inferred_assumptions.forEach((entry, idx) => {
    checkLineageText(path, `[lineage].inferred_assumptions[${idx}]`, entry);
  });
  lineage.unsupported_fields.forEach((entry, idx) => {
    checkLineageText(path, `[lineage].unsupported_fields[${idx}]`, entry);
  });
}

function validateAccountBindings(adapter: Adapter, path: string): void {
  for (const [name, account] of Object.entries(adapter.accounts)) {
    if (account.address !== undefined && account.pda !== undefined) {
      throw new Error(
        `${path}: \`[accounts].${name}\`: account \`${name}\` declares both \`address\` and \`pda\`; choose a literal/well-known address OR a deterministic PDA binding`
      );
    }

    if (account.address !== undefined) {
      if (account.kind !== "shared") {
        throw new Error(
          `${path}: \`[accounts].${name}.address\`: account \`${name}\` declares a literal \`address\` but \`kind = "agent"\`. Literal addresses are shared by definition; use \`kind = "shared"\` or declare a per-agent \`pda\`.`
        );
      }
      validateAccountAddress(path, `[accounts].${name}.address`, account.address);
    }

    if (account.pda !== undefined) {
      if (account.pda.seeds.length === 0) {
        throw new Error(
          `${path}: \`[accounts].${name}.pda.seeds\`: account \`${name}\` declares \`pda\` but no seeds. Add at least one \`literal:...\`, \`account:...\`, \`signer:...\`, \`program:...\`, or \`pubkey:...\` seed.`
        );
      }
      account.pda.seeds.forEach((seed, idx) => {
        validatePdaSeed(adapter, path, `[accounts].${name}.pda.seeds[${idx}]`, seed);
      });
      if (account.pda.program !== undefined) {
        validatePdaProgram(path, `[accounts].${name}.pda.program`, account.pda.program);
      }
    }
  }
}

function validateAccountAddress(path: string, key: string, value: string): void {
  if (value.trim().length === 0 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(
      `${path}: \`${key}\`: account address must be a non-empty well-known alias or base58 pubkey`
    );
  }
  if (isWellKnownAccountAlias(value)) return;
  validatePubkeyString(path, key, "account address", value);
}

function validatePdaSeed(adapter: Adapter, path: string, key: string, seed: string): void {
  if (seed.trim().length === 0 || /[\u0000-\u001f\u007f-\u009f]/u.test(seed)) {
    throw new Error(`${path}: \`${key}\`: PDA seed must be non-empty and free of control characters`);
  }
  const sep = seed.indexOf(":");
  if (sep <= 0) {
    throw new Error(
      `${path}: \`${key}\`: PDA seed \`${escapeDiagnostic(seed)}\` must use one of \`literal:<bytes>\`, \`account:<name>\`, \`signer:agent\`, \`signer:admin\`, \`program:<alias-or-self>\`, or \`pubkey:<base58>\``
    );
  }
  const kind = seed.slice(0, sep);
  const value = seed.slice(sep + 1);
  switch (kind) {
    case "literal":
      if (value.length === 0) {
        throw new Error(`${path}: \`${key}\`: literal PDA seed cannot be empty`);
      }
      return;
    case "account":
      checkIdentifier(path, key, value);
      if (!(value in adapter.accounts) && !isWellKnownAccountAlias(value)) {
        throw new Error(
          `${path}: \`${key}\`: PDA seed \`account:${value}\` references no \`[accounts.${value}]\` binding and is not a well-known program/sysvar alias. Declared accounts: ${JSON.stringify(Object.keys(adapter.accounts).sort())}.`
        );
      }
      return;
    case "signer":
      if (value !== "agent" && value !== "admin") {
        throw new Error(
          `${path}: \`${key}\`: PDA signer seed \`${value}\` is not supported; expected \`signer:agent\` or \`signer:admin\``
        );
      }
      return;
    case "program":
      validatePdaProgram(path, key, value);
      return;
    case "pubkey":
      validatePubkeyString(path, key, "PDA seed pubkey", value);
      return;
    default:
      throw new Error(
        `${path}: \`${key}\`: unknown PDA seed prefix \`${kind}\`; expected \`literal\`, \`account\`, \`signer\`, \`program\`, or \`pubkey\``
      );
  }
}

function validatePdaProgram(path: string, key: string, value: string): void {
  if (value === "self" || isWellKnownAccountAlias(value)) return;
  validatePubkeyString(path, key, "PDA program", value);
}

function isWellKnownAccountAlias(value: string): boolean {
  return [
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
    "sysvar_stake_history",
  ].includes(value);
}

// Mirrors `engine/src/adapter/loader.rs::validate_account_owners`:
// exactly one of `owner.program_so` / `owner.pubkey` must be set, and
// both must be non-empty after trimming. Keeping the CLI and engine
// contracts aligned matters for downstream tools (lint, doctor) that
// need to treat a present `owner` block as a trustworthy signal.
function validateAccountOwners(adapter: Adapter, path: string): void {
  for (const [name, account] of Object.entries(adapter.accounts)) {
    const owner = account.owner;
    if (owner === undefined) continue;

    const programSo = owner.program_so?.trim() ?? "";
    const pubkey = owner.pubkey?.trim() ?? "";
    const hasProgramSo = owner.program_so !== undefined && programSo.length > 0;
    const hasPubkey = owner.pubkey !== undefined && pubkey.length > 0;

    if (owner.program_so !== undefined && owner.pubkey !== undefined) {
      throw new Error(
        `${path}: \`[accounts].${name}.owner\`: account \`${name}\` declares both \`owner.program_so\` and \`owner.pubkey\`; exactly one owner source is accepted. Pick the local sibling-program path OR the literal base58 pubkey and remove the other.`
      );
    }
    if (!hasProgramSo && !hasPubkey) {
      throw new Error(
        `${path}: \`[accounts].${name}.owner\`: account \`${name}\` declares an empty \`owner\` block. Set either \`owner.program_so = "<path to .so>"\` for a local sibling program, or \`owner.pubkey = "<base58>"\` for a literal external program.`
      );
    }
    if (owner.program_so !== undefined && !hasProgramSo) {
      throw new Error(
        `${path}: \`[accounts].${name}.owner.program_so\`: account \`${name}\`: \`owner.program_so\` must be a non-empty path to the sibling program's compiled \`.so\` artifact.`
      );
    }
    if (owner.pubkey !== undefined && !hasPubkey) {
      throw new Error(
        `${path}: \`[accounts].${name}.owner.pubkey\`: account \`${name}\`: \`owner.pubkey\` must be a non-empty base58-encoded 32-byte pubkey.`
      );
    }
    if (hasPubkey) {
      const reason = base58PubkeyError(pubkey);
      if (reason !== null) {
        throw new Error(
          `${path}: \`[accounts].${name}.owner.pubkey\`: account \`${name}\`: \`owner.pubkey\` \`${pubkey}\` is not a valid base58-encoded 32-byte pubkey: ${reason}`
        );
      }
    }
  }
}

function validateAccountDecoders(adapter: Adapter, path: string): void {
  for (const [name, account] of Object.entries(adapter.accounts)) {
    const decoder = account.decoder;
    if (decoder === undefined) continue;

    let fields: Record<string, LayoutField>;
    if (typeof decoder === "string") {
      const preset = accountDecoderPresetFields(decoder);
      if (preset === undefined) {
        throw new Error(
          `${path}: \`[accounts].${name}.decoder\`: unknown account decoder preset \`${decoder}\`; expected one of ${JSON.stringify(ACCOUNT_DECODER_PRESETS)}`
        );
      }
      fields = preset;
    } else {
      if (decoder.kind !== "layout") {
        throw new Error(
          `${path}: \`[accounts].${name}.decoder.kind\`: unknown account decoder kind \`${decoder.kind}\`; expected \`layout\``
        );
      }
      if (Object.keys(decoder.fields).length === 0) {
        throw new Error(
          `${path}: \`[accounts].${name}.decoder.fields\`: layout decoder must declare at least one field`
        );
      }
      fields = decoder.fields;
    }

    for (const [fieldName, field] of Object.entries(fields)) {
      const size = layoutFieldTypeSize(field.type);
      if (size === undefined) {
        throw new Error(
          `${path}: \`[accounts].${name}.decoder.fields.${fieldName}.type\`: unknown layout field type \`${field.type}\`; expected one of ${JSON.stringify(LAYOUT_FIELD_TYPES)}`
        );
      }
      const end = field.offset + size;
      if (!Number.isSafeInteger(end) || end > account.space) {
        throw new Error(
          `${path}: \`[accounts].${name}.decoder.fields.${fieldName}.offset\`: layout field \`${fieldName}\` at offset ${field.offset} with size ${size} exceeds declared account space ${account.space}`
        );
      }
    }
  }
}

function accountDecoderFields(decoder: AccountDecoder): Record<string, LayoutField> | undefined {
  if (typeof decoder === "string") return accountDecoderPresetFields(decoder);
  if (decoder.kind !== "layout") return undefined;
  return decoder.fields;
}

function accountDecoderPresetFields(name: string): Record<string, LayoutField> | undefined {
  switch (name) {
    case "spl_token_account":
      return {
        mint: { type: "pubkey", offset: 0 },
        owner: { type: "pubkey", offset: 32 },
        amount: { type: "u64", offset: 64 },
        state: { type: "u8", offset: 108 },
        delegated_amount: { type: "u64", offset: 121 },
      };
    case "spl_mint":
      return {
        supply: { type: "u64", offset: 36 },
        decimals: { type: "u8", offset: 44 },
        is_initialized: { type: "bool", offset: 45 },
      };
    default:
      return undefined;
  }
}

function layoutFieldTypeSize(type: string): number | undefined {
  switch (type) {
    case "u8":
    case "bool":
      return 1;
    case "u64":
    case "i64":
      return 8;
    case "u128":
    case "i128":
      return 16;
    case "pubkey":
      return 32;
    default:
      return undefined;
  }
}

// Base58 alphabet (Bitcoin / Solana flavor — no "0", "O", "I", "l").
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_MAP: Record<string, number> = Object.fromEntries(
  Array.from(BASE58_ALPHABET, (ch, i) => [ch, i])
);

/**
 * Mirrors the engine-side `Pubkey::from_str` contract: a valid Solana
 * pubkey is base58-decodable to exactly 32 bytes. Returns `null` on
 * success or a short reason string on failure — suitable for direct
 * inclusion in a diagnostic message.
 *
 * Implemented inline to avoid adding a runtime dependency for one call
 * site. The naive O(n²) decode is fine for ≤44-char inputs.
 */
function base58PubkeyError(s: string): string | null {
  if (s.length === 0) return "empty string";
  // Reject whitespace inside — Solana pubkeys never have internal
  // whitespace, and `Pubkey::from_str` rejects it too.
  for (let i = 0; i < s.length; i += 1) {
    const ch = s.charAt(i);
    if (BASE58_MAP[ch] === undefined) {
      return `invalid base58 character \`${ch}\` at position ${i}`;
    }
  }
  // Count leading-'1' characters, each of which decodes to a zero byte.
  let leadingZeros = 0;
  while (leadingZeros < s.length && s.charAt(leadingZeros) === "1") {
    leadingZeros += 1;
  }
  // Big-integer decode over an expanding little-endian byte buffer.
  const bytes: number[] = [];
  for (let i = leadingZeros; i < s.length; i += 1) {
    let carry = BASE58_MAP[s.charAt(i)]!;
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>>= 8;
    }
  }
  const totalLen = leadingZeros + bytes.length;
  if (totalLen !== 32) {
    return `decoded to ${totalLen} bytes (expected 32)`;
  }
  return null;
}

function validateOracles(adapter: Adapter, path: string, runtime: Protocol): void {
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
    if (runtime === "generic") {
      if (oracle.account === undefined) {
        throw new Error(
          `${path}: \`[[oracles]][${idx}].account\`: generic oracle \`${oracle.name}\` must bind \`account = "<shared account>"\``
        );
      }
      if (!(oracle.account in adapter.accounts)) {
        throw new Error(
          `${path}: \`[[oracles]][${idx}].account\`: unknown account \`${oracle.account}\`; declare it under \`[accounts]\``
        );
      }
      if (adapter.accounts[oracle.account]?.kind !== "shared") {
        throw new Error(
          `${path}: \`[[oracles]][${idx}].account\`: oracle account \`${oracle.account}\` must be declared with \`kind = "shared"\``
        );
      }
    }
  });
}

function validateScheduledActions(adapter: Adapter, path: string, runtime: Protocol): void {
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
      if (runtime === "generic" && !(account in adapter.accounts)) {
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
  if (adapter.program_id !== undefined) {
    validatePubkeyString(path, "program_id", "program id", adapter.program_id);
  }

  requireNonEmptyBlock(path, "[accounts]", adapter.accounts, "generic adapters must declare at least one account binding");
  requireNonEmptyBlock(path, "[instructions]", adapter.instructions, "generic adapters must declare at least one instruction mapping");
  requireNonEmptyBlock(path, "[actions]", adapter.actions, "generic adapters must declare at least one action");
  requireNonEmptyBlock(path, "[observations]", adapter.observations, "generic adapters must declare at least one observation");
  requireNonEmptyBlock(path, "[personas]", adapter.personas, "generic adapters must declare at least one persona");
  for (const [accountName, account] of Object.entries(adapter.accounts)) {
    if (typeof account.space !== "number" || !Number.isInteger(account.space) || account.space <= 0) {
      throw new Error(
        `${path}: \`[accounts].${accountName}.space\`: account space could not be resolved; set \`space = <bytes>\` or \`space = "auto"\` with a readable \`idl_path\``
      );
    }
  }

  for (const [ixName, mapping] of Object.entries(adapter.instructions)) {
    if (!(mapping.action in adapter.actions)) {
      throw new Error(
        `${path}: \`[instructions].${ixName}.action\`: unknown generic action \`${mapping.action}\`; expected one of ${JSON.stringify(Object.keys(adapter.actions))}`
      );
    }
  }

  // multi-arg validation mirrors
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
    const [account, field] = validateDottedPath(path, key);
    if (!(account in adapter.accounts)) {
      throw new Error(
        `${path}: \`[state_mapping].${key}\`: unknown generic account binding \`${account}\`; declare it under \`[accounts]\``
      );
    }
    const decoder = adapter.accounts[account]?.decoder;
    if (decoder !== undefined) {
      const fields = accountDecoderFields(decoder);
      if (fields === undefined || !(field in fields)) {
        throw new Error(
          `${path}: \`[state_mapping].${key}\`: state mapping references decoder field \`${field}\` on account \`${account}\`, but the decoder declares only ${JSON.stringify(Object.keys(fields ?? {}).sort())}`
        );
      }
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
