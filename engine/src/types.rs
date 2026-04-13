use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunConfig {
    pub agents: u32,
    pub ticks: u32,
    pub scenario: String,
    pub seed: u64,
    pub personas: Vec<String>,
    pub validator_url: String,
    pub output_path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Policy {
    pub persona_id: String,
    pub persona_label: String,
    #[serde(default = "default_action_rate_multiplier")]
    pub action_rate_multiplier: f64,
    pub risk_tolerance: f64,
    pub action_weights: BTreeMap<String, f64>,
    pub triggers: Vec<Trigger>,
    pub position_sizing: PositionSizing,
    pub max_exposure: f64,
}

fn default_action_rate_multiplier() -> f64 {
    1.0
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Trigger {
    pub condition: TriggerCondition,
    pub response: String,
    pub severity: u32,
    pub cooldown_ticks: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight_boost: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ComparisonOp {
    Lt,
    Gt,
    Eq,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TriggerValue {
    Int(i64),
    UInt(u64),
    Bool(bool),
    String(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ObservationValue {
    Int(i64),
    UInt(u64),
    Bool(bool),
    Pubkey(String),
    Map(BTreeMap<String, i64>),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TriggerCondition {
    PortfolioDrawdown { threshold: f64 },
    UtilizationAbove { threshold: f64 },
    PriceDropPercent { threshold: f64 },
    ExposureAbove { threshold: f64 },
    HealthFactorBelow { threshold: f64 },
    ObservationCompare {
        key: String,
        op: ComparisonOp,
        value: TriggerValue,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PositionSizing {
    pub strategy: PositionSizingStrategy,
    pub params: BTreeMap<String, f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PositionSizingStrategy {
    Fixed,
    Proportional,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SimulationResult {
    pub run_config: RunConfig,
    pub seed: u64,
    pub total_ticks: u32,
    pub timeseries: Vec<TickSnapshot>,
    pub events: Vec<SimEvent>,
    pub agents: Vec<AgentFinalState>,
    pub summary: SimulationSummary,
    pub simulation_boundaries: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TickSnapshot {
    pub tick: u32,
    pub tvl: f64,
    pub utilization: f64,
    pub oracle_price: f64,
    pub active_agents: u32,
    pub cumulative_liquidations: u32,
    pub cumulative_bad_debt: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SimEvent {
    pub tick: u32,
    pub agent_id: String,
    pub persona_id: String,
    pub persona_label: String,
    pub action: String,
    pub params: BTreeMap<String, Value>,
    pub outcome: SimOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome_detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub triggered_by: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SimOutcome {
    Success,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentFinalState {
    pub agent_id: String,
    pub persona_id: String,
    pub persona_label: String,
    pub status: AgentStatus,
    pub final_balance: f64,
    pub pnl: f64,
    pub total_actions: u32,
    pub triggers_activated: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub liquidated_at_tick: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Active,
    Liquidated,
    Depleted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SimulationSummary {
    pub final_tvl: f64,
    pub final_utilization: f64,
    pub total_liquidations: u32,
    pub total_bad_debt: f64,
    pub agents_active: u32,
    pub agents_liquidated: u32,
    pub agents_depleted: u32,
    pub largest_single_tick_drawdown: f64,
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use super::{Policy, RunConfig, SimulationResult};

    fn fixture_path(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("fixtures")
            .join(name)
    }

    #[test]
    fn deserializes_policy_fixture() {
        let raw = fs::read_to_string(fixture_path("policy.sample.json")).unwrap();
        let policy: Policy = serde_json::from_str(&raw).unwrap();

        assert_eq!(policy.persona_id, "cautious-yield-farmer");
        assert_eq!(policy.triggers.len(), 5);
    }

    #[test]
    fn deserializes_run_config_fixture() {
        let raw = fs::read_to_string(fixture_path("run-config.sample.json")).unwrap();
        let config: RunConfig = serde_json::from_str(&raw).unwrap();

        assert_eq!(config.agents, 5);
        assert_eq!(config.personas.len(), 2);
    }

    #[test]
    fn deserializes_simulation_result_fixture() {
        let raw = fs::read_to_string(fixture_path("simulation-result.sample.json")).unwrap();
        let result: SimulationResult = serde_json::from_str(&raw).unwrap();

        assert_eq!(result.total_ticks, 10);
        assert_eq!(result.events.len(), 2);
        assert_eq!(result.agents.len(), 1);
    }
}
