import { z } from "zod";

export const TriggerConditionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("portfolio_drawdown"),
    threshold: z.number()
  }),
  z.object({
    type: z.literal("utilization_above"),
    threshold: z.number()
  }),
  z.object({
    type: z.literal("price_drop_percent"),
    threshold: z.number()
  }),
  z.object({
    type: z.literal("exposure_above"),
    threshold: z.number()
  }),
  z.object({
    type: z.literal("health_factor_below"),
    threshold: z.number()
  })
]);

export const TriggerSchema = z.object({
  condition: TriggerConditionSchema,
  response: z.string().min(1),
  severity: z.number().int().nonnegative(),
  cooldown_ticks: z.number().int().nonnegative()
});

export const PositionSizingStrategySchema = z.enum(["fixed", "proportional"]);

export const PositionSizingSchema = z.object({
  strategy: PositionSizingStrategySchema,
  params: z.record(z.string(), z.number())
});

export const PolicySchema = z.object({
  persona_id: z.string().min(1),
  persona_label: z.string().min(1),
  risk_tolerance: z.number().min(0).max(1),
  action_weights: z.record(z.string(), z.number()),
  triggers: z.array(TriggerSchema),
  position_sizing: PositionSizingSchema,
  max_exposure: z.number().min(0).max(1)
});

// Persona ids become filesystem paths (`<id>.toml`) in the persona compiler,
// so they must be constrained to a safe character set. Without this, a value
// like `../../../../etc/passwd` would let the compiler read arbitrary files
// and — with --llm-url set — exfiltrate their contents to the LLM endpoint.
export const PersonaIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "persona id must be lowercase alphanumerics and dashes");

export const RunConfigSchema = z.object({
  agents: z.number().int().positive(),
  ticks: z.number().int().positive(),
  scenario: z.string().min(1),
  seed: z.number().int().nonnegative(),
  personas: z.array(PersonaIdSchema),
  validator_url: z.string().url(),
  output_path: z.string().min(1)
});

export const SimEventSchema = z.object({
  tick: z.number().int().nonnegative(),
  agent_id: z.string().min(1),
  persona_id: z.string().min(1),
  persona_label: z.string().min(1),
  action: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
  outcome: z.enum(["success", "failed", "skipped"]),
  outcome_detail: z.string().optional(),
  triggered_by: z.string().optional()
});

// `TickSnapshot` is a primitive-agnostic key/value map. The engine-side
// type is `BTreeMap<String, serde_json::Value>`, so on the CLI side we
// accept any record whose values are JSON primitives (number / bool /
// string / null). Required engine-owned counters (`tick`, `active_agents`)
// must still be nonnegative integers — downgrading that would let
// malformed payloads slip through.
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export const TickSnapshotSchema = z
  .record(
    z.string(),
    z.union([z.number(), z.boolean(), z.string(), z.null()])
  )
  .refine((entry) => isNonNegativeInteger(entry.tick), {
    message: "tick snapshot `tick` must be a nonnegative integer"
  })
  .refine((entry) => isNonNegativeInteger(entry.active_agents), {
    message: "tick snapshot `active_agents` must be a nonnegative integer"
  });

export const AgentFinalStateSchema = z.object({
  agent_id: z.string().min(1),
  persona_id: z.string().min(1),
  persona_label: z.string().min(1),
  status: z.enum(["active", "liquidated", "depleted"]),
  final_balance: z.number(),
  pnl: z.number(),
  total_actions: z.number().int().nonnegative(),
  triggers_activated: z.number().int().nonnegative(),
  liquidated_at_tick: z.number().int().nonnegative().optional()
});

// invariant rollup row. The engine's
// `build_invariants_summary` emits one object per declared adapter
// invariant, in declaration order, with `firings` counting how many
// ticks the invariant was violated during the run. Mirrors the shape
// pinned in `engine/src/sim/run.rs :: build_invariants_summary`.
export const InvariantFiredRowSchema = z.object({
  name: z.string(),
  field: z.string(),
  op: z.string(),
  // `value` is JSON-number-or-null — the engine emits `Value::Null`
  // when the invariant's threshold cannot be cleanly represented as a
  // finite f64 (NaN/Infinity collapse to null via serde_json).
  value: z.union([z.number(), z.null()]),
  firings: z
    .number()
    .int()
    .nonnegative()
});

// `SimulationSummary` is a primitive-agnostic key/value map. Lending
// runs emit `final_tvl`/`final_utilization`/`total_liquidations`/
// `total_bad_debt`/`largest_single_tick_drawdown`; generic runs emit
// adapter-declared observation aggregates (`<key>_avg`/`_max`/`_min` for
// numeric, `_true_count`/`_false_count` for bool, `_unique_count` for
// pubkey, `_entry_count_avg`/`_max` for map). All three engine-owned
// lifecycle counters (`agents_active`, `agents_liquidated`,
// `agents_depleted`) are required and must be nonnegative integers so
// malformed payloads can't slip through the CLI gate.
//
// Array-valued keys are allowed for the invariant
// rollup (`summary.invariants_fired`). Each element of such an array
// must match `InvariantFiredRowSchema`; extending the value union
// with a plain `z.array(z.unknown())` would let any shape through
// and defeat the schema gate.
export const SimulationSummarySchema = z
  .record(
    z.string(),
    z.union([
      z.number(),
      z.boolean(),
      z.string(),
      z.null(),
      z.array(InvariantFiredRowSchema)
    ])
  )
  .refine((summary) => isNonNegativeInteger(summary.agents_active), {
    message: "summary `agents_active` must be a nonnegative integer"
  })
  .refine((summary) => isNonNegativeInteger(summary.agents_liquidated), {
    message: "summary `agents_liquidated` must be a nonnegative integer"
  })
  .refine((summary) => isNonNegativeInteger(summary.agents_depleted), {
    message: "summary `agents_depleted` must be a nonnegative integer"
  });

export const SimulationResultSchema = z.object({
  run_config: RunConfigSchema,
  seed: z.number().int().nonnegative(),
  total_ticks: z.number().int().nonnegative(),
  timeseries: z.array(TickSnapshotSchema),
  events: z.array(SimEventSchema),
  agents: z.array(AgentFinalStateSchema),
  summary: SimulationSummarySchema,
  simulation_boundaries: z.array(z.string())
});

export type TriggerCondition = z.infer<typeof TriggerConditionSchema>;
export type Trigger = z.infer<typeof TriggerSchema>;
export type PositionSizing = z.infer<typeof PositionSizingSchema>;
export type Policy = z.infer<typeof PolicySchema>;
export type RunConfig = z.infer<typeof RunConfigSchema>;
export type SimEvent = z.infer<typeof SimEventSchema>;
export type TickSnapshot = z.infer<typeof TickSnapshotSchema>;
export type AgentFinalState = z.infer<typeof AgentFinalStateSchema>;
export type SimulationResult = z.infer<typeof SimulationResultSchema>;
export type InvariantFiredRow = z.infer<typeof InvariantFiredRowSchema>;

export function validatePolicy(input: unknown): Policy {
  return PolicySchema.parse(input);
}
