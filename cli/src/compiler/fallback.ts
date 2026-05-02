import { validatePolicy, type Policy } from "./schema.js";

export const FALLBACK_POLICIES: Record<string, Policy> = {
  "cautious-yield-farmer": validatePolicy({
    persona_id: "cautious-yield-farmer",
    persona_label: "Cautious Yield Farmer",
    risk_tolerance: 0.2,
    action_weights: { deposit: 0.9, borrow: 0.1, withdraw: 0.5, repay: 0.7, liquidate: 0.1 },
    triggers: [
      { condition: { type: "portfolio_drawdown", threshold: 0.1 }, response: "reduce_exposure", severity: 6, cooldown_ticks: 3 },
      { condition: { type: "price_drop_percent", threshold: 0.15 }, response: "panic_exit", severity: 9, cooldown_ticks: 5 }
    ],
    position_sizing: { strategy: "proportional", params: { percent: 0.08 } },
    max_exposure: 0.3
  }),
  "aggressive-arb-bot": validatePolicy({
    persona_id: "aggressive-arb-bot",
    persona_label: "Aggressive Arb Bot",
    risk_tolerance: 0.8,
    action_weights: { deposit: 0.4, borrow: 0.9, withdraw: 0.2, repay: 0.3, liquidate: 0.8 },
    triggers: [
      { condition: { type: "utilization_above", threshold: 0.92 }, response: "rotate_capital", severity: 4, cooldown_ticks: 2 }
    ],
    position_sizing: { strategy: "proportional", params: { percent: 0.18 } },
    max_exposure: 0.85
  }),
  "panic-whale": validatePolicy({
    persona_id: "panic-whale",
    persona_label: "Panic Whale",
    risk_tolerance: 0.3,
    action_weights: { deposit: 0.7, borrow: 0.3, withdraw: 0.8, repay: 0.6, liquidate: 0.2 },
    triggers: [
      { condition: { type: "price_drop_percent", threshold: 0.08 }, response: "panic_exit", severity: 10, cooldown_ticks: 5 }
    ],
    position_sizing: { strategy: "fixed", params: { amount: 5_000 } },
    max_exposure: 0.45
  }),
  "whale": validatePolicy({
    persona_id: "whale",
    persona_label: "Whale",
    risk_tolerance: 0.9,
    action_weights: { deposit: 0.3, borrow: 1, withdraw: 0, repay: 0, liquidate: 0 },
    triggers: [],
    position_sizing: { strategy: "fixed", params: { amount: 25_000 } },
    max_exposure: 0.95
  }),
  "steady-lp": validatePolicy({
    persona_id: "steady-lp",
    persona_label: "Steady LP",
    risk_tolerance: 0.4,
    action_weights: { deposit: 0.8, borrow: 0.2, withdraw: 0.2, repay: 0.4, liquidate: 0.1 },
    triggers: [
      { condition: { type: "health_factor_below", threshold: 1.25 }, response: "repay", severity: 7, cooldown_ticks: 4 }
    ],
    position_sizing: { strategy: "proportional", params: { percent: 0.1 } },
    max_exposure: 0.4
  }),
  "degen-borrower": validatePolicy({
    persona_id: "degen-borrower",
    persona_label: "Degen Borrower",
    risk_tolerance: 0.95,
    action_weights: { deposit: 0.3, borrow: 1, withdraw: 0.1, repay: 0.05, liquidate: 0.4 },
    triggers: [],
    position_sizing: { strategy: "proportional", params: { percent: 0.25 } },
    max_exposure: 0.98
  })
};

export function getFallbackPolicy(personaId: string): Policy {
  const policy = FALLBACK_POLICIES[personaId];
  if (!policy) {
    throw new Error(`No fallback policy registered for ${personaId}`);
  }
  return policy;
}
