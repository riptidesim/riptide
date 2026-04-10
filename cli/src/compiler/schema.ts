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

export const TickSnapshotSchema = z.object({
  tick: z.number().int().nonnegative(),
  tvl: z.number(),
  utilization: z.number(),
  oracle_price: z.number(),
  active_agents: z.number().int().nonnegative(),
  cumulative_liquidations: z.number().int().nonnegative(),
  cumulative_bad_debt: z.number().nonnegative()
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

export const SimulationSummarySchema = z.object({
  final_tvl: z.number(),
  final_utilization: z.number(),
  total_liquidations: z.number().int().nonnegative(),
  total_bad_debt: z.number().nonnegative(),
  agents_active: z.number().int().nonnegative(),
  agents_liquidated: z.number().int().nonnegative(),
  agents_depleted: z.number().int().nonnegative(),
  largest_single_tick_drawdown: z.number()
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

export function validatePolicy(input: unknown): Policy {
  return PolicySchema.parse(input);
}
