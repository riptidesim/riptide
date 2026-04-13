// Zod schema for the adapter TOML (Sprint 3 · T04).
//
// Must stay in lock-step with the serde schema in
// `engine/src/adapter/schema.rs`. The contract test in
// `cli/test/adapter.test.ts` parses the shipped
// `fixtures/adapters/solend-fork.toml` through both validators and
// asserts structural equivalence — any shape drift fails that test,
// not a demo run.

import { z } from "zod";

// Canonical action / observation lists mirror
// engine/src/adapter/schema.rs LENDING_ACTIONS / LENDING_OBSERVATIONS.
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
  // Optional in the serde schema — zero-arg or observation-only
  // instructions may omit it.
  amount: z.string().min(1).optional(),
});
export type InstructionMapping = z.infer<typeof InstructionMappingSchema>;

export const ActionDefinitionSchema = z.object({
  label: z.string().min(1).optional(),
  instruction: z.string().min(1).optional(),
});

export const ObservationDefinitionSchema = z.object({
  label: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
});

export const PersonaDefinitionSchema = z.object({
  label: z.string().min(1).optional(),
  action_weights: z.record(z.string(), z.number()).default({}),
});

export const AdapterSchema = z.object({
  protocol: ProtocolSchema,
  instructions: z.record(z.string(), InstructionMappingSchema),
  state_mapping: z.record(z.string(), z.string()),
  // Reserved for T05 (generic primitive). Lending adapters leave these
  // empty; both sides parse them as empty `{}` by default.
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

/**
 * Validate a parsed-TOML adapter object. Returns the validated
 * adapter on success, or throws an `Error` whose message carries the
 * virtual adapter path + the first violation.
 *
 * Lending-specific validation runs after the Zod parse:
 * - `[instructions]` must be non-empty.
 * - Every instruction `action` must be in LENDING_ACTIONS.
 * - `[state_mapping]` keys must be `<account>.<field>` shaped.
 * - `[state_mapping]` values must be in LENDING_OBSERVATIONS.
 */
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
    if (!LENDING_ACTIONS.includes(mapping.action as any)) {
      throw new Error(
        `${path}: \`[instructions].${ixName}.action\`: unknown lending action \`${mapping.action}\`; expected one of ${JSON.stringify(LENDING_ACTIONS)}`
      );
    }
  }
  for (const [key, logical] of Object.entries(adapter.state_mapping)) {
    const dot = key.indexOf(".");
    if (dot <= 0 || dot === key.length - 1) {
      throw new Error(
        `${path}: \`[state_mapping].${key}\`: state_mapping keys must be \`<account>.<field>\` (non-empty both sides)`
      );
    }
    if (!LENDING_OBSERVATIONS.includes(logical as any)) {
      throw new Error(
        `${path}: \`[state_mapping].${key}\`: unknown lending observation \`${logical}\`; expected one of ${JSON.stringify(LENDING_OBSERVATIONS)}`
      );
    }
  }
}
