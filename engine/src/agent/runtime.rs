use std::collections::HashMap;

use rand::{rngs::StdRng, SeedableRng};

use crate::types::Policy;

use super::{
    policy::{choose_best, score_actions, Decision},
    state::Agent,
    triggers::{evaluate_trigger, FiredTrigger},
};

pub const DEFAULT_LIQUIDATION_THRESHOLD: f64 = 0.8;

#[derive(Debug, Clone, PartialEq)]
pub struct AgentObservation {
    pub tick: u32,
    pub oracle_price: f64,
    pub utilization: f64,
    pub price_drop_from_start: f64,
    pub portfolio_drawdown: f64,
    pub available_liquidity: f64,
    pub liquidation_threshold: f64,
    pub can_liquidate: bool,
}

impl AgentObservation {
    pub fn new(
        tick: u32,
        oracle_price: f64,
        utilization: f64,
        price_drop_from_start: f64,
        portfolio_drawdown: f64,
        available_liquidity: f64,
    ) -> Self {
        Self {
            tick,
            oracle_price,
            utilization,
            price_drop_from_start,
            portfolio_drawdown,
            available_liquidity,
            liquidation_threshold: DEFAULT_LIQUIDATION_THRESHOLD,
            can_liquidate: false,
        }
    }

    pub fn exposure_ratio(&self, agent: &Agent) -> f64 {
        if agent.position.debt <= 0.0 {
            return 0.0;
        }

        let equity = agent.equity(self.oracle_price);
        if equity <= 0.0 {
            return f64::INFINITY;
        }

        agent.position.debt / equity
    }

    pub fn health_factor(&self, agent: &Agent) -> f64 {
        if agent.position.debt <= 0.0 {
            return f64::INFINITY;
        }
        (agent.position.collateral * self.oracle_price * self.liquidation_threshold)
            / agent.position.debt
    }
}

#[derive(Debug)]
pub struct AgentRuntime {
    rng: StdRng,
    cooldowns: HashMap<String, u32>,
}

impl AgentRuntime {
    /// Each runtime must receive a stable, per-agent derived seed to keep
    /// tie-breaking reproducible across agents and across runs.
    pub fn new(seed: u64) -> Self {
        Self {
            rng: StdRng::seed_from_u64(seed),
            cooldowns: HashMap::new(),
        }
    }

    pub fn observe(
        &self,
        tick: u32,
        policy: &Policy,
        agent: &Agent,
        oracle_price: f64,
        start_price: f64,
        utilization: f64,
        available_liquidity: f64,
    ) -> AgentObservation {
        let equity = agent.equity(oracle_price);
        let drawdown = if agent.peak_equity <= 0.0 {
            0.0
        } else {
            ((agent.peak_equity - equity) / agent.peak_equity).max(0.0)
        };
        let exposure_limit = policy.max_exposure.max(0.01);
        // TODO: Replace this market-wide liquidation proxy with target-specific
        // health-factor checks once the harness exposes counterparties.
        let can_liquidate = utilization > exposure_limit && oracle_price < start_price;

        AgentObservation {
            tick,
            oracle_price,
            utilization,
            price_drop_from_start: if start_price > 0.0 {
                ((start_price - oracle_price) / start_price).max(0.0)
            } else {
                0.0
            },
            portfolio_drawdown: drawdown,
            available_liquidity,
            liquidation_threshold: DEFAULT_LIQUIDATION_THRESHOLD,
            can_liquidate,
        }
    }

    pub fn evaluate_triggers(
        &mut self,
        agent: &mut Agent,
        observation: &AgentObservation,
    ) -> Vec<FiredTrigger> {
        let mut fired = Vec::new();

        for trigger in &agent.policy.triggers {
            if let Some(triggered) = evaluate_trigger(trigger, agent, observation) {
                if self
                    .cooldowns
                    .get(&triggered.condition_label)
                    .copied()
                    .is_some_and(|expires_at_tick| expires_at_tick >= observation.tick)
                {
                    continue;
                }
                self.cooldowns
                    .insert(
                        triggered.condition_label.clone(),
                        observation.tick.saturating_add(triggered.cooldown_ticks),
                    );
                agent.triggers_activated += 1;
                fired.push(triggered);
            }
        }

        fired.sort_by(|left, right| right.severity.cmp(&left.severity));
        fired
    }

    pub fn decide(&mut self, agent: &mut Agent, observation: &AgentObservation) -> Decision {
        let fired = self.evaluate_triggers(agent, observation);
        let scores = score_actions(&agent.policy, agent, observation, &fired, &mut self.rng);
        choose_best(&scores, fired)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use crate::types::{Policy, PositionSizing, PositionSizingStrategy, Trigger, TriggerCondition};

    use super::*;
    use crate::agent::state::Agent;

    fn policy(id: &str, deposit: f64, borrow: f64) -> Policy {
        Policy {
            persona_id: id.into(),
            persona_label: id.into(),
            risk_tolerance: 0.5,
            action_weights: BTreeMap::from([
                ("deposit".into(), deposit),
                ("borrow".into(), borrow),
                ("withdraw".into(), 0.2),
                ("repay".into(), 0.3),
                ("liquidate".into(), 0.1),
            ]),
            triggers: vec![Trigger {
                condition: TriggerCondition::PriceDropPercent { threshold: 0.2 },
                response: "panic_exit".into(),
                severity: 9,
                cooldown_ticks: 2,
            }],
            position_sizing: PositionSizing {
                strategy: PositionSizingStrategy::Fixed,
                params: BTreeMap::from([("amount".into(), 100.0)]),
            },
            max_exposure: 0.8,
        }
    }

    #[test]
    fn different_policies_choose_different_actions() {
        let mut runtime_a = AgentRuntime::new(42);
        let mut runtime_b = AgentRuntime::new(42);
        let mut agent_a = Agent::new("a", policy("cautious", 0.9, 0.1), 1_000.0);
        let mut agent_b = Agent::new("b", policy("aggressive", 0.1, 0.9), 1_000.0);
        let observation = AgentObservation::new(1, 100.0, 0.4, 0.0, 0.0, 10_000.0);

        let decision_a = runtime_a.decide(&mut agent_a, &observation);
        let decision_b = runtime_b.decide(&mut agent_b, &observation);

        assert_ne!(decision_a.chosen, decision_b.chosen);
    }

    #[test]
    fn trigger_respects_cooldown() {
        let mut runtime = AgentRuntime::new(7);
        let mut agent = Agent::new("agent", policy("panic", 0.4, 0.4), 1_000.0);
        let observation = |tick| AgentObservation::new(tick, 80.0, 0.9, 0.25, 0.3, 10_000.0);

        let first = runtime.evaluate_triggers(&mut agent, &observation(1));
        let second = runtime.evaluate_triggers(&mut agent, &observation(2));
        let third = runtime.evaluate_triggers(&mut agent, &observation(3));
        let fourth = runtime.evaluate_triggers(&mut agent, &observation(4));

        assert_eq!(first.len(), 1);
        assert!(second.is_empty());
        assert!(third.is_empty());
        assert_eq!(fourth.len(), 1);
    }

    #[test]
    fn returns_noop_when_agent_cannot_afford_actions() {
        let mut runtime = AgentRuntime::new(5);
        let mut agent = Agent::new("agent", policy("empty", 0.9, 0.9), 0.0);
        let observation = AgentObservation::new(1, 100.0, 0.4, 0.0, 0.0, 0.0);

        let decision = runtime.decide(&mut agent, &observation);
        assert_eq!(decision.chosen, super::super::policy::RuntimeAction::NoOp);
    }

    #[test]
    fn health_factor_reacts_to_price_moves() {
        let agent = Agent::new("agent", policy("panic", 0.4, 0.4), 1_000.0);
        let mut leveraged = agent.clone();
        leveraged.open_position(100.0, 60.0, 1.0);

        let healthy = AgentObservation::new(1, 1.0, 0.4, 0.0, 0.0, 1_000.0);
        let stressed = AgentObservation::new(2, 0.5, 0.4, 0.5, 0.0, 1_000.0);

        assert!(healthy.health_factor(&leveraged) > stressed.health_factor(&leveraged));
    }

    #[test]
    fn exposure_and_health_move_together_when_price_recovers() {
        let mut leveraged = Agent::new("agent", policy("panic", 0.4, 0.4), 500.0);
        leveraged.open_position(100.0, 600.0, 5.0);

        let stressed = AgentObservation::new(1, 5.0, 0.4, 0.5, 0.0, 1_000.0);
        let recovered = AgentObservation::new(2, 10.0, 0.4, 0.0, 0.0, 1_000.0);

        assert!(recovered.health_factor(&leveraged) > stressed.health_factor(&leveraged));
        assert!(recovered.exposure_ratio(&leveraged) < stressed.exposure_ratio(&leveraged));
    }

    #[test]
    fn exposure_ratio_is_infinite_when_equity_is_non_positive() {
        let mut agent = Agent::new("agent", policy("panic", 0.4, 0.4), 100.0);
        agent.open_position(10.0, 200.0, 5.0);
        let observation = AgentObservation::new(1, 5.0, 0.4, 0.0, 0.0, 1_000.0);

        assert_eq!(observation.exposure_ratio(&agent), f64::INFINITY);
    }

    #[test]
    fn price_drop_from_start_uses_actual_start_price() {
        let runtime = AgentRuntime::new(11);
        let agent = Agent::new("agent", policy("panic", 0.4, 0.4), 500.0);
        let observation = runtime.observe(1, &agent.policy, &agent, 0.25, 0.5, 0.4, 1_000.0);

        assert_eq!(observation.price_drop_from_start, 0.5);
    }
}
