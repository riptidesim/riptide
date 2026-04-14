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

export const InstructionMappingSchema = z.object({
  action: z.string().min(1),
  amount: z.string().min(1).optional(),
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
});

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

  return adapter;
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

  for (const [actionName, action] of Object.entries(adapter.actions)) {
    if (action.takes.length > 1) {
      throw new Error(
        `${path}: \`[actions].${actionName}.takes\`: generic actions support either zero args or one numeric arg`
      );
    }
    const expectedArg = action.takes[0];
    if (expectedArg) {
      const hasBinding = Object.values(adapter.instructions).some(
        (mapping) => mapping.action === actionName && mapping.amount === expectedArg
      );
      if (!hasBinding) {
        throw new Error(
          `${path}: \`[actions].${actionName}.takes\`: action \`${actionName}\` expects arg \`${expectedArg}\` but no matching \`[instructions].*.amount\` binding was found`
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
