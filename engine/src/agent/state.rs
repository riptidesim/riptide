use crate::types::{AgentFinalState, AgentStatus, Policy};

const BALANCE_EPSILON: f64 = 1e-9;

#[derive(Debug, Clone, PartialEq, Default)]
pub struct AgentPosition {
    pub collateral: f64,
    pub debt: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BalanceUpdateError {
    attempted_balance: f64,
}

impl BalanceUpdateError {
    pub fn attempted_balance(&self) -> f64 {
        self.attempted_balance
    }
}

impl std::fmt::Display for BalanceUpdateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "balance update would make cash balance negative: {}",
            self.attempted_balance
        )
    }
}

impl std::error::Error for BalanceUpdateError {}

#[derive(Debug, Clone, PartialEq)]
pub struct Agent {
    pub agent_id: String,
    pub policy: Policy,
    pub starting_balance: f64,
    pub cash_balance: f64,
    pub position: AgentPosition,
    pub status: AgentStatus,
    pub peak_equity: f64,
    pub total_actions: u32,
    pub triggers_activated: u32,
    pub liquidated_at_tick: Option<u32>,
    /// Reference price used to normalize collateral MTM. Defaults to 1.0 so
    /// existing tests/callers see no behavior change. The sim loop sets this
    /// to the run's starting price so equity at t0 is invariant under the
    /// chain-seeded position (cash debit cancels collateral credit).
    pub starting_price: f64,
}

impl Agent {
    pub fn new(agent_id: impl Into<String>, policy: Policy, starting_balance: f64) -> Self {
        Self {
            agent_id: agent_id.into(),
            policy,
            starting_balance,
            cash_balance: starting_balance,
            position: AgentPosition::default(),
            status: AgentStatus::Active,
            peak_equity: starting_balance,
            total_actions: 0,
            triggers_activated: 0,
            liquidated_at_tick: None,
            starting_price: 1.0,
        }
    }

    pub fn with_starting_price(mut self, starting_price: f64) -> Self {
        self.starting_price = if starting_price > 0.0 {
            starting_price
        } else {
            1.0
        };
        self
    }

    pub fn equity(&self, oracle_price: f64) -> f64 {
        // Value one on-chain collateral unit at `oracle_price` dollars,
        // matching how the lending program computes collateral_value and
        // health. Previously this scaled collateral by `oracle_price /
        // starting_price` which implicitly treated 1 unit = $1 at
        // starting_price regardless of the on-chain price scheme, creating
        // a 100x mismatch vs the program's health check and preventing
        // liquidations from ever firing.
        self.cash_balance + (self.position.collateral * oracle_price) - self.position.debt
    }

    pub fn update_balance(&mut self, delta: f64) -> Result<(), BalanceUpdateError> {
        let next_balance = self.cash_balance + delta;
        if next_balance < -BALANCE_EPSILON {
            return Err(BalanceUpdateError {
                attempted_balance: next_balance,
            });
        }

        self.cash_balance = if next_balance.abs() <= BALANCE_EPSILON {
            0.0
        } else {
            next_balance
        };
        self.peak_equity = self.peak_equity.max(self.cash_balance);
        self.refresh_status();
        Ok(())
    }

    pub fn open_position(&mut self, collateral: f64, debt: f64, oracle_price: f64) {
        self.position.collateral += collateral.max(0.0);
        self.position.debt += debt.max(0.0);
        self.peak_equity = self.peak_equity.max(self.equity(oracle_price));
        self.refresh_status();
    }

    pub fn close_position(&mut self, collateral: f64, debt: f64, oracle_price: f64) {
        self.position.collateral = (self.position.collateral - collateral.max(0.0)).max(0.0);
        self.position.debt = (self.position.debt - debt.max(0.0)).max(0.0);
        self.peak_equity = self.peak_equity.max(self.equity(oracle_price));
        self.refresh_status();
    }

    pub fn mark_liquidated(&mut self, tick: u32) {
        self.status = AgentStatus::Liquidated;
        self.liquidated_at_tick = Some(tick);
    }

    pub fn is_active(&self) -> bool {
        matches!(self.status, AgentStatus::Active)
    }

    pub fn final_state(&self, oracle_price: f64) -> AgentFinalState {
        let final_balance = self.equity(oracle_price);
        AgentFinalState {
            agent_id: self.agent_id.clone(),
            persona_id: self.policy.persona_id.clone(),
            persona_label: self.policy.persona_label.clone(),
            status: self.status.clone(),
            final_balance,
            pnl: final_balance - self.starting_balance,
            total_actions: self.total_actions,
            triggers_activated: self.triggers_activated,
            liquidated_at_tick: self.liquidated_at_tick,
        }
    }

    fn refresh_status(&mut self) {
        if matches!(self.status, AgentStatus::Liquidated) {
            return;
        }

        let cash_empty = self.cash_balance.abs() <= BALANCE_EPSILON;
        let collateral_empty = self.position.collateral.abs() <= BALANCE_EPSILON;
        let debt_empty = self.position.debt.abs() <= BALANCE_EPSILON;

        self.status = if cash_empty && collateral_empty {
            if debt_empty {
                AgentStatus::Depleted
            } else {
                AgentStatus::Liquidated
            }
        } else {
            AgentStatus::Active
        };
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use crate::types::{AgentStatus, Policy, PositionSizing, PositionSizingStrategy, Trigger};

    use super::{Agent, BalanceUpdateError};

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
            triggers: Vec::<Trigger>::new(),
            position_sizing: PositionSizing {
                strategy: PositionSizingStrategy::Fixed,
                params: BTreeMap::from([("amount".into(), 100.0)]),
            },
            max_exposure: 0.5,
            persona_args: BTreeMap::new(),
        }
    }

    #[test]
    fn tracks_balance_and_position_changes() {
        let mut agent = Agent::new("agent-1", sample_policy(), 1_000.0);
        agent.update_balance(-250.0).unwrap();
        agent.open_position(300.0, 100.0, 1.0);
        agent.close_position(150.0, 25.0, 1.0);

        assert_eq!(agent.cash_balance, 750.0);
        assert_eq!(agent.position.collateral, 150.0);
        assert_eq!(agent.position.debt, 75.0);
        assert!(agent.is_active());
    }

    #[test]
    fn becomes_inactive_when_fully_depleted() {
        let mut agent = Agent::new("agent-2", sample_policy(), 100.0);
        agent.update_balance(-100.0).unwrap();

        assert!(!agent.is_active());
    }

    #[test]
    fn final_state_reflects_agent_status() {
        let mut agent = Agent::new("agent-3", sample_policy(), 500.0);
        agent.open_position(50.0, 10.0, 1.0);
        agent.total_actions = 3;
        agent.triggers_activated = 2;

        let state = agent.final_state(1.0);
        assert_eq!(state.agent_id, "agent-3");
        assert_eq!(state.total_actions, 3);
        assert_eq!(state.triggers_activated, 2);
    }

    #[test]
    fn final_state_reports_negative_pnl() {
        let mut agent = Agent::new("agent-4", sample_policy(), 500.0);
        agent.update_balance(-200.0).unwrap();

        let state = agent.final_state(1.0);
        assert_eq!(state.pnl, -200.0);
    }

    #[test]
    fn equity_treats_debt_as_quote_denominated() {
        let mut agent = Agent::new("agent-5", sample_policy(), 500.0);
        agent.open_position(100.0, 100.0, 10.0);

        assert_eq!(agent.equity(10.0), 1_400.0);
    }

    #[test]
    fn debt_only_agents_are_marked_liquidated() {
        let mut agent = Agent::new("agent-6", sample_policy(), 0.0);
        agent.open_position(0.0, 50.0, 1.0);

        assert_eq!(agent.status, AgentStatus::Liquidated);
        assert!(!agent.is_active());
    }

    #[test]
    fn update_balance_rejects_negative_results() {
        let mut agent = Agent::new("agent-7", sample_policy(), 100.0);
        let error = agent.update_balance(-200.0).unwrap_err();

        assert_eq!(
            error,
            BalanceUpdateError {
                attempted_balance: -100.0
            }
        );
        assert_eq!(agent.cash_balance, 100.0);
        assert_eq!(error.attempted_balance(), -100.0);
    }
}
