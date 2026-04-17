use crate::types::{ComparisonOp, ObservationValue, Trigger, TriggerCondition, TriggerValue};

use super::{runtime::AgentObservation, state::Agent};

#[derive(Debug, Clone, PartialEq)]
pub struct FiredTrigger {
    pub response: String,
    pub severity: u32,
    pub cooldown_ticks: u32,
    pub condition_label: String,
    pub score_boost: f64,
}

fn label(condition: &TriggerCondition) -> String {
    match condition {
        TriggerCondition::PortfolioDrawdown { .. } => "portfolio_drawdown",
        TriggerCondition::UtilizationAbove { .. } => "utilization_above",
        TriggerCondition::PriceDropPercent { .. } => "price_drop_percent",
        TriggerCondition::ExposureAbove { .. } => "exposure_above",
        TriggerCondition::HealthFactorBelow { .. } => "health_factor_below",
        TriggerCondition::ObservationCompare { .. } => "observation_compare",
    }
    .to_string()
}

fn matches_observation_value(
    observed: &ObservationValue,
    op: ComparisonOp,
    expected: &TriggerValue,
) -> bool {
    match (observed, expected) {
        (ObservationValue::Int(left), TriggerValue::Int(right)) => compare_i64(*left, op, *right),
        (ObservationValue::Int(left), TriggerValue::UInt(right)) => {
            compare_i64(*left, op, *right as i64)
        }
        (ObservationValue::UInt(left), TriggerValue::Int(right)) => {
            compare_i64(*left as i64, op, *right)
        }
        (ObservationValue::UInt(left), TriggerValue::UInt(right)) => {
            compare_i64(*left as i64, op, *right as i64)
        }
        (ObservationValue::Bool(left), TriggerValue::Bool(right)) => {
            matches!(op, ComparisonOp::Eq) && left == right
        }
        (ObservationValue::Pubkey(left), TriggerValue::String(right)) => {
            matches!(op, ComparisonOp::Eq) && left == right
        }
        _ => false,
    }
}

fn compare_i64(left: i64, op: ComparisonOp, right: i64) -> bool {
    match op {
        ComparisonOp::Lt => left < right,
        ComparisonOp::Gt => left > right,
        ComparisonOp::Eq => left == right,
    }
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
        TriggerCondition::ObservationCompare { ref key, op, ref value } => observation
            .custom_observations
            .get(key)
            .is_some_and(|observed| matches_observation_value(observed, op, value)),
    };

    fired.then(|| FiredTrigger {
        response: trigger.response.clone(),
        severity: trigger.severity,
        cooldown_ticks: trigger.cooldown_ticks,
        condition_label: label(&trigger.condition),
        score_boost: trigger
            .weight_boost
            .unwrap_or_else(|| trigger.severity as f64 * 0.1),
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
                action_rate_multiplier: 1.0,
                risk_tolerance: 0.3,
                action_weights: BTreeMap::new(),
                triggers: Vec::new(),
                position_sizing: PositionSizing {
                    strategy: PositionSizingStrategy::Fixed,
                    params: BTreeMap::from([("amount".into(), 100.0)]),
                },
                max_exposure: 0.4,
                persona_args: BTreeMap::new(),
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
            weight_boost: None,
        };
        let agent = sample_agent();
        let observation = AgentObservation::new(0, 100.0, 0.82, 0.05, 0.1, 1_000.0);

        let fired = evaluate_trigger(&trigger, &agent, &observation).unwrap();
        assert_eq!(fired.response, "hold");
        assert_eq!(fired.condition_label, "utilization_above");
        assert_eq!(fired.score_boost, 0.2);
    }

    #[test]
    fn observation_compare_trigger_uses_custom_observations() {
        let trigger = Trigger {
            condition: TriggerCondition::ObservationCompare {
                key: "player.wood".into(),
                op: ComparisonOp::Lt,
                value: TriggerValue::UInt(10),
            },
            response: "mine".into(),
            severity: 0,
            cooldown_ticks: 0,
            weight_boost: Some(2.0),
        };
        let agent = sample_agent();
        let mut observation = AgentObservation::new(0, 100.0, 0.82, 0.05, 0.1, 1_000.0);
        observation
            .custom_observations
            .insert("player.wood".into(), ObservationValue::UInt(4));

        let fired = evaluate_trigger(&trigger, &agent, &observation).unwrap();
        assert_eq!(fired.response, "mine");
        assert_eq!(fired.score_boost, 2.0);
    }
}
