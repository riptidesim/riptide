// Zod schema for the adapter TOML (Sprint 3 · T05).
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

export function validateAdapter(raw: unknown, path: string): Adapter {
  const parsed = AdapterSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const key = first.path.join(".");
    throw new Error(`${path}: \`${key || "(root)"}\`: ${first.message}`);
  }
  const adapter = parsed.data;

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
        `${path}: \`[actions].${actionName}.takes\`: T05 v0 supports either zero args or one numeric arg; expand only if T06 needs more`
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
  // T05 v0: expand if T06 fixture needs more.
  const parts = condition.trim().split(/\s+/);
  if (parts.length !== 3) {
    throw new Error(
      `${path}: \`[personas].${personaName}.triggers[${index}].if\`: generic trigger conditions must be \`<observation> <op> <constant>\` in T05 v0`
    );
  }
  if (!["<", ">", "=="].includes(parts[1]!)) {
    throw new Error(
      `${path}: \`[personas].${personaName}.triggers[${index}].if\`: unsupported generic trigger operator \`${parts[1]}\`; expected one of ["<", ">", "=="]`
    );
  }
}
