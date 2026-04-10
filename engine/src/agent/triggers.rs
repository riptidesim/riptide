use crate::types::{Trigger, TriggerCondition};

use super::{runtime::AgentObservation, state::Agent};

#[derive(Debug, Clone, PartialEq)]
pub struct FiredTrigger {
    pub response: String,
    pub severity: u32,
    pub cooldown_ticks: u32,
    pub condition_label: String,
}

fn label(condition: &TriggerCondition) -> String {
    match condition {
        TriggerCondition::PortfolioDrawdown { .. } => "portfolio_drawdown",
        TriggerCondition::UtilizationAbove { .. } => "utilization_above",
        TriggerCondition::PriceDropPercent { .. } => "price_drop_percent",
        TriggerCondition::ExposureAbove { .. } => "exposure_above",
        TriggerCondition::HealthFactorBelow { .. } => "health_factor_below",
    }
    .to_string()
}

pub fn evaluate_trigger(
    trigger: &Trigger,
    agent: &Agent,
    observation: &AgentObservation,
) -> Option<FiredTrigger> {
    let fired = match trigger.condition {
        TriggerCondition::PortfolioDrawdown { threshold } => {
            observation.portfolio_drawdown >= threshold
        }
        TriggerCondition::UtilizationAbove { threshold } => observation.utilization >= threshold,
        TriggerCondition::PriceDropPercent { threshold } => {
            observation.price_drop_from_start >= threshold
        }
        TriggerCondition::ExposureAbove { threshold } => {
            observation.exposure_ratio(agent) >= threshold
        }
        TriggerCondition::HealthFactorBelow { threshold } => {
            observation.health_factor(agent) <= threshold
        }
    };

    fired.then(|| FiredTrigger {
        response: trigger.response.clone(),
        severity: trigger.severity,
        cooldown_ticks: trigger.cooldown_ticks,
        condition_label: label(&trigger.condition),
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use crate::types::{Policy, PositionSizing, PositionSizingStrategy, Trigger, TriggerCondition};

    use super::*;
    use crate::agent::{runtime::AgentObservation, state::Agent};

    fn sample_agent() -> Agent {
        Agent::new(
            "agent-1",
            Policy {
                persona_id: "panic-whale".into(),
                persona_label: "Panic Whale".into(),
                risk_tolerance: 0.3,
                action_weights: BTreeMap::new(),
                triggers: Vec::new(),
                position_sizing: PositionSizing {
                    strategy: PositionSizingStrategy::Fixed,
                    params: BTreeMap::from([("amount".into(), 100.0)]),
                },
                max_exposure: 0.4,
            },
            1_000.0,
        )
    }

    #[test]
    fn fires_when_condition_met() {
        let trigger = Trigger {
            condition: TriggerCondition::UtilizationAbove { threshold: 0.8 },
            response: "hold".into(),
            severity: 2,
            cooldown_ticks: 3,
        };
        let agent = sample_agent();
        let observation = AgentObservation::new(0, 100.0, 0.82, 0.05, 0.1, 1_000.0);

        let fired = evaluate_trigger(&trigger, &agent, &observation).unwrap();
        assert_eq!(fired.response, "hold");
        assert_eq!(fired.condition_label, "utilization_above");
    }
}
