import { z } from "zod";
import { ProgramErrorInfoSchema } from "../schemas/errors.js";

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

export const PersonaSelectionSchema = z.union([
  z.array(PersonaIdSchema),
  z.record(PersonaIdSchema, z.number().int().nonnegative())
]);
export type PersonaSelection = z.input<typeof PersonaSelectionSchema>;

export function normalizePersonaSelection(
  value: PersonaSelection,
  agents?: number
): string[] {
  if (Array.isArray(value)) return [...value];

  const total = personaSelectionCount(value);
  const expanded: string[] = [];
  for (const [personaId, count] of Object.entries(value)) {
    for (let i = 0; i < count; i += 1) {
      expanded.push(personaId);
    }
  }
  if (agents !== undefined && total !== agents) {
    throw new Error(
      `run-config personas count map expands to ${total} agents, but agents is ${agents}`
    );
  }
  return expanded;
}

export function personaSelectionCount(value: Record<string, number>): number {
  return Object.values(value).reduce((sum, count) => sum + count, 0);
}

export function personaSelectionToCliString(
  value: PersonaSelection,
  agents?: number
): string {
  return normalizePersonaSelection(value, agents).join(",");
}

export const RunConfigSchema = z.object({
  agents: z.number().int().positive(),
  ticks: z.number().int().positive(),
  scenario: z.string().min(1),
  seed: z.number().int().nonnegative().optional(),
  seeds: z.number().int().positive().optional(),
  personas: PersonaSelectionSchema,
  // Serde on the engine side accepts any string here (LiteSVM runs ignore
  // the field; only the validator-parity path connects to the URL). The
  // CLI used to enforce `.url()`, but shipping run-configs authored before
  // Sprint 4 carry a `"unused"` placeholder — rejecting those would break
  // byte-stable rerun of every pre-Sprint-8 fixture via `riptide run`.
  // Keep the Zod layer in lockstep with serde: accept any non-empty string.
  validator_url: z.string().min(1),
  output_path: z.string().min(1),
  state_pack: z.string().min(1).optional()
})
  .superRefine((config, ctx) => {
    if (!Array.isArray(config.personas)) {
      const total = personaSelectionCount(config.personas);
      if (total !== config.agents) {
        ctx.addIssue({
          code: "custom",
          path: ["personas"],
          message: `persona count map expands to ${total} agents, but agents is ${config.agents}`
        });
      }
    }
  })
  .transform((config) => ({
    ...config,
    personas: normalizePersonaSelection(config.personas, config.agents)
  }));

export const SimEventSchema = z.object({
  tick: z.number().int().nonnegative(),
  agent_id: z.string().min(1),
  persona_id: z.string().min(1),
  persona_label: z.string().min(1),
  action: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
  outcome: z.enum(["success", "failed", "skipped"]),
  outcome_detail: z.string().optional(),
  program_error: ProgramErrorInfoSchema.optional(),
  triggered_by: z.string().optional()
});

const JsonPrimitiveSchema = z.union([z.number(), z.boolean(), z.string(), z.null()]);

export const DerivedObservationsSchema = z.record(z.string(), JsonPrimitiveSchema);
export const CollectionObservationErrorSchema = z.object({
  type: z.string().min(1),
  message: z.string().min(1)
});
export const CollectionObservationValueSchema = z.union([
  JsonPrimitiveSchema,
  z.object({
    evaluation_error: z.array(CollectionObservationErrorSchema).min(1)
  })
]);
export const CollectionObservationsSchema = z.record(z.string(), CollectionObservationValueSchema);

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
    z.union([JsonPrimitiveSchema, DerivedObservationsSchema, CollectionObservationsSchema])
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

export const ExpressionInvariantObservedSchema = z.object({
  tick: z.number().int().nonnegative(),
  values: z.record(z.string(), JsonPrimitiveSchema)
});

export const ExpressionInvariantRowSchema = z.object({
  name: z.string(),
  expr: z.string(),
  severity: z.enum(["error", "warn"]),
  first_tick: z.number().int().nonnegative().nullable(),
  firing_count: z.number().int().nonnegative(),
  observed: z.array(ExpressionInvariantObservedSchema).max(3),
  // Sprint 19 aliases remain accepted while Sprint 20 pins the clearer names.
  first_fired_tick: z.number().int().nonnegative().nullable().optional(),
  firings: z.number().int().nonnegative().optional()
});

export const RoleBindingSchema = z.object({
  role_name: z.string().min(1),
  source: z.string().min(1)
});

export const DerivedObservationDefinitionSchema = z.object({
  name: z.string().min(1),
  expr: z.string().min(1)
});

export const SemanticsSchema = z.object({
  class: z.string().min(1),
  roles_bound: z.array(RoleBindingSchema),
  derived_observation_definitions: z.array(DerivedObservationDefinitionSchema)
});

export const ReplayAccountProvenanceSchema = z.object({
  account_pubkey: z.string().min(1),
  account_pubkeys: z.array(z.string().min(1)).optional(),
  sha256_hash: z.string().regex(/^[a-f0-9]{64}$/)
});

export const ReplayProvenanceSchema = z.object({
  pack_path: z.string().min(1),
  slot: z.number().int().nonnegative(),
  accounts: z.record(z.string(), ReplayAccountProvenanceSchema)
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
      z.array(InvariantFiredRowSchema),
      z.array(ExpressionInvariantRowSchema)
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
  semantics: SemanticsSchema.optional(),
  replay_provenance: ReplayProvenanceSchema.optional(),
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
export type ExpressionInvariantRow = z.infer<typeof ExpressionInvariantRowSchema>;
export type Semantics = z.infer<typeof SemanticsSchema>;
export type ReplayProvenance = z.infer<typeof ReplayProvenanceSchema>;

export function validatePolicy(input: unknown): Policy {
  return PolicySchema.parse(input);
}
