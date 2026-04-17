use rand::{rngs::StdRng, RngExt};

use crate::types::Policy;

use super::{runtime::AgentObservation, state::Agent, triggers::FiredTrigger};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum RuntimeAction {
    Deposit,
    Withdraw,
    Borrow,
    Repay,
    Liquidate,
    Custom(String),
    NoOp,
}

impl RuntimeAction {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Deposit => "deposit",
            Self::Withdraw => "withdraw",
            Self::Borrow => "borrow",
            Self::Repay => "repay",
            Self::Liquidate => "liquidate",
            Self::Custom(name) => name.as_str(),
            Self::NoOp => "no_op",
        }
    }
}

pub const LENDING_RUNTIME_ACTIONS: &[RuntimeAction] = &[
    RuntimeAction::Deposit,
    RuntimeAction::Withdraw,
    RuntimeAction::Borrow,
    RuntimeAction::Repay,
    RuntimeAction::Liquidate,
];

#[derive(Debug, Clone, PartialEq)]
pub struct ActionScore {
    pub action: RuntimeAction,
    pub score: f64,
    pub amount: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Decision {
    pub chosen: RuntimeAction,
    pub amount: f64,
    pub fired_triggers: Vec<FiredTrigger>,
}

fn sizing_amount(policy: &Policy, agent: &Agent) -> f64 {
    match policy.position_sizing.strategy {
        crate::types::PositionSizingStrategy::Fixed => policy
            .position_sizing
            .params
            .get("amount")
            .copied()
            .unwrap_or(0.0),
        crate::types::PositionSizingStrategy::Proportional => {
            let percent = policy
                .position_sizing
                .params
                .get("percent")
                .copied()
                .unwrap_or(0.0);
            (agent.cash_balance * percent).max(0.0)
        }
    }
}

fn response_matches_action(response: &str, action: &RuntimeAction) -> bool {
    let normalized = response.trim().to_ascii_lowercase();
    if let RuntimeAction::Custom(name) = action {
        return normalized == *name || normalized.contains(name);
    }

    match normalized.as_str() {
        "deposit" => action == &RuntimeAction::Deposit,
        "withdraw" => action == &RuntimeAction::Withdraw,
        "borrow" => action == &RuntimeAction::Borrow,
        "repay" => action == &RuntimeAction::Repay,
        "liquidate" => action == &RuntimeAction::Liquidate,
        "hold" | "wait" | "no_op" | "noop" => action == &RuntimeAction::NoOp,
        "panic_exit" | "reduce_exposure" => {
            action == &RuntimeAction::Withdraw || action == &RuntimeAction::Repay
        }
        "rotate_capital" => {
            action == &RuntimeAction::Withdraw || action == &RuntimeAction::Deposit
        }
        _ => normalized.contains(action.as_str()),
    }
}

pub fn score_actions(
    policy: &Policy,
    available_actions: &[RuntimeAction],
    agent: &Agent,
    observation: &AgentObservation,
    fired_triggers: &[FiredTrigger],
    rng: &mut StdRng,
) -> Vec<ActionScore> {
    let amount = sizing_amount(policy, agent);
    let mut actions = available_actions.to_vec();
    if !actions.contains(&RuntimeAction::NoOp) {
        actions.push(RuntimeAction::NoOp);
    }

    actions
        .into_iter()
        .map(|action| {
            let mut score = policy
                .action_weights
                .get(action.as_str())
                .copied()
                .unwrap_or_default();
            let trigger_modifier = fired_triggers
                .iter()
                .filter(|trigger| response_matches_action(&trigger.response, &action))
                .map(|trigger| trigger.score_boost)
                .sum::<f64>();
            if action != RuntimeAction::NoOp {
                score *= policy.action_rate_multiplier.max(0.0);
            }
            score += trigger_modifier;

            match action {
                RuntimeAction::Deposit if amount > agent.cash_balance => score = 0.0,
                RuntimeAction::Withdraw if agent.position.collateral <= 0.0 => score = 0.0,
                RuntimeAction::Borrow
                    if observation.exposure_ratio(agent) >= policy.max_exposure =>
                {
                    score = 0.0
                }
                RuntimeAction::Borrow
                    if amount <= 0.0 || amount > observation.available_liquidity =>
                {
                    score = 0.0
                }
                RuntimeAction::Repay
                    if agent.position.debt <= 0.0 || amount > agent.cash_balance =>
                {
                    score = 0.0
                }
                RuntimeAction::Liquidate if !observation.can_liquidate => score = 0.0,
                RuntimeAction::Custom(_) => {}
                RuntimeAction::NoOp => score = score.max(0.001),
                _ => {}
            }

            if !score.is_finite() {
                score = 0.0;
            }
            if score > 0.0 {
                score += rng.random_range(0.0..0.01);
            }

            ActionScore {
                action,
                score,
                amount,
            }
        })
        .collect()
}

pub fn choose_best(scores: &[ActionScore], fired_triggers: Vec<FiredTrigger>) -> Decision {
    let normalized_score = |score: f64| if score.is_finite() { score } else { 0.0 };
    let best = scores
        .iter()
        .max_by(|left, right| {
            normalized_score(left.score).total_cmp(&normalized_score(right.score))
        })
        .cloned()
        .unwrap_or(ActionScore {
            action: RuntimeAction::NoOp,
            score: 0.0,
            amount: 0.0,
        });
    let best_score = normalized_score(best.score);

    Decision {
        chosen: if best_score <= 0.0 {
            RuntimeAction::NoOp
        } else {
            best.action
        },
        amount: best.amount,
        fired_triggers,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::{
        agent::{runtime::AgentObservation, state::Agent},
        types::{Policy, PositionSizing, PositionSizingStrategy},
    };

    fn sample_policy() -> Policy {
        Policy {
            persona_id: "steady-lp".into(),
            persona_label: "Steady LP".into(),
            action_rate_multiplier: 1.0,
            risk_tolerance: 0.4,
            action_weights: BTreeMap::from([
                ("deposit".into(), 0.8),
                ("borrow".into(), 0.2),
                ("withdraw".into(), 0.3),
                ("repay".into(), 0.6),
                ("liquidate".into(), 0.1),
            ]),
            triggers: Vec::new(),
            position_sizing: PositionSizing {
                strategy: PositionSizingStrategy::Fixed,
                params: BTreeMap::from([("amount".into(), 100.0)]),
            },
            max_exposure: 0.5,
            persona_args: BTreeMap::new(),
        }
    }

    #[test]
    fn choose_best_handles_nan_scores() {
        let decision = choose_best(
            &[
                ActionScore {
                    action: RuntimeAction::Deposit,
                    score: f64::NAN,
                    amount: 100.0,
                },
                ActionScore {
                    action: RuntimeAction::Repay,
                    score: 0.5,
                    amount: 100.0,
                },
            ],
            Vec::new(),
        );

        assert_eq!(decision.chosen, RuntimeAction::Repay);
    }

    #[test]
    fn score_actions_zeroes_non_finite_values() {
        let mut policy = sample_policy();
        policy.action_weights.insert("deposit".into(), f64::NAN);
        let agent = Agent::new("agent", policy.clone(), 1_000.0);
        let observation = AgentObservation::new(1, 100.0, 0.3, 0.0, 0.0, 1_000.0);
        let mut rng = rand::SeedableRng::seed_from_u64(7);

        let scores = score_actions(
            &policy,
            LENDING_RUNTIME_ACTIONS,
            &agent,
            &observation,
            &[],
            &mut rng,
        );
        let deposit_score = scores
            .iter()
            .find(|score| score.action == RuntimeAction::Deposit)
            .unwrap();

        assert_eq!(deposit_score.score, 0.0);
    }

    #[test]
    fn trigger_bonus_only_applies_to_matching_actions() {
        let policy = sample_policy();
        let mut agent = Agent::new("agent", policy.clone(), 1_000.0);
        agent.open_position(500.0, 200.0, 1.0);
        let observation = AgentObservation::new(1, 1.0, 0.3, 0.0, 0.0, 1_000.0);
        let fired_triggers = vec![FiredTrigger {
            response: "panic_exit".into(),
            severity: 9,
            cooldown_ticks: 3,
            condition_label: "price_drop_percent".into(),
            score_boost: 0.9,
        }];
        let mut rng = rand::SeedableRng::seed_from_u64(7);

        let scores = score_actions(
            &policy,
            LENDING_RUNTIME_ACTIONS,
            &agent,
            &observation,
            &fired_triggers,
            &mut rng,
        );
        let deposit_score = scores
            .iter()
            .find(|score| score.action == RuntimeAction::Deposit)
            .unwrap()
            .score;
        let withdraw_score = scores
            .iter()
            .find(|score| score.action == RuntimeAction::Withdraw)
            .unwrap()
            .score;
        let repay_score = scores
            .iter()
            .find(|score| score.action == RuntimeAction::Repay)
            .unwrap()
            .score;

        assert!(withdraw_score > deposit_score);
        assert!(repay_score > deposit_score);
    }

    #[test]
    fn choose_best_prefers_trigger_matching_action() {
        let policy = sample_policy();
        let mut agent = Agent::new("agent", policy.clone(), 1_000.0);
        agent.open_position(500.0, 200.0, 1.0);
        let observation = AgentObservation::new(1, 1.0, 0.3, 0.0, 0.0, 1_000.0);
        let fired_triggers = vec![FiredTrigger {
            response: "panic_exit".into(),
            severity: 10,
            cooldown_ticks: 3,
            condition_label: "price_drop_percent".into(),
            score_boost: 1.0,
        }];
        let mut rng = rand::SeedableRng::seed_from_u64(11);

        let decision = choose_best(
            &score_actions(
                &policy,
                LENDING_RUNTIME_ACTIONS,
                &agent,
                &observation,
                &fired_triggers,
                &mut rng,
            ),
            fired_triggers,
        );

        assert_eq!(decision.chosen, RuntimeAction::Repay);
    }
}
