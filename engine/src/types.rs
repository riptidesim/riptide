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
    /// per-persona named values the generic encoder
    /// substitutes into multi-runtime-arg instruction calls. Compiled
    /// from the adapter TOML's `[personas.<name>].persona_args` block.
    /// Empty for lending policies (which don't use multi-arg
    /// dispatch) and for generic policies that don't vary args by
    /// persona. `skip_serializing_if` keeps the policies.json shape
    /// byte-stable for hero grid callers that never set this.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub persona_args: BTreeMap<String, crate::adapter::ArgLiteral>,
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
    PortfolioDrawdown {
        threshold: f64,
    },
    UtilizationAbove {
        threshold: f64,
    },
    PriceDropPercent {
        threshold: f64,
    },
    ExposureAbove {
        threshold: f64,
    },
    HealthFactorBelow {
        threshold: f64,
    },
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semantics: Option<Semantics>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replay_provenance: Option<crate::replay::ReplayStateProvenance>,
    pub simulation_boundaries: Vec<String>,
}

/// Top-level semantic contract emitted for adapters carrying a
/// `[semantics]` block. This is adapter-load context only: the
/// per-tick computed values stay under `timeseries[].derived_observations`
/// and `timeseries[].collection_observations`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Semantics {
    pub class: String,
    pub roles_bound: Vec<RoleBinding>,
    pub derived_observation_definitions: Vec<DerivedObservationDefinition>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoleBinding {
    pub role_name: String,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DerivedObservationDefinition {
    pub name: String,
    pub expr: String,
}

impl Semantics {
    pub fn from_adapter(semantics: &crate::adapter::Semantics) -> Option<Self> {
        let class = semantics.class.clone()?;
        Some(Self {
            class,
            roles_bound: semantics
                .roles
                .iter()
                .map(|(role_name, role)| RoleBinding {
                    role_name: role_name.clone(),
                    source: role.source.clone(),
                })
                .collect(),
            derived_observation_definitions: semantics
                .derived
                .iter()
                .map(|(name, expr)| DerivedObservationDefinition {
                    name: name.clone(),
                    expr: expr.source.clone(),
                })
                .collect(),
        })
    }
}

/// A single invariant fire. Captured when the declared comparison is
/// falsified against an observation snapshot on a given tick. Ticks
/// where the declared field is missing from the snapshot, or where the
/// value fails numeric coercion, are skipped (logged to stderr but not
/// recorded as a violation). Not serialized directly on
/// `SimulationResult` — violations appear in the main `events` stream
/// as structured `SimEvent`s with `agent_id = "__engine__"` and
/// `action = "invariant_violation:<name>"`; this struct is kept as the
/// tick-loop-internal bookkeeping shape that drives the
/// `summary["invariants_fired"]` rollup.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InvariantViolation {
    pub tick: u32,
    pub index: usize,
    pub name: String,
    pub field: String,
    pub op: String,
    pub observed: f64,
    pub expected: f64,
}

/// Per-tick rollup, primitive-agnostic.
///
/// Untagged `BTreeMap<String, serde_json::Value>` so both lending and
/// generic primitives can emit their own keys. The tick loop
/// injects engine-side counters (`tick`, `active_agents`, and lending-
/// specific `cumulative_liquidations`) directly; the primitive contributes
/// its own metrics via `Primitive::snapshot_metrics`. Alphabetical key
/// order keeps serialization deterministic.
pub type TickSnapshot = BTreeMap<String, Value>;

/// Additive semantic observation surface. Values are JSON-native for
/// serialization, with oversized integers encoded as strings.
pub type DerivedObservations = BTreeMap<String, Value>;

/// Additive per-tick collection aggregation surface.
pub type CollectionObservations = BTreeMap<String, Value>;

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
    pub program_error: Option<ProgramErrorInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub triggered_by: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProgramErrorInfo {
    pub code: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interpretation: Option<String>,
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

/// End-of-run summary, primitive-agnostic.
///
/// Untagged `BTreeMap<String, serde_json::Value>` so both lending and
/// generic primitives can emit their own keys. The lending
/// primitive emits its historical keys (`final_tvl`, `final_utilization`,
/// `total_bad_debt`, `largest_single_tick_drawdown`) via
/// `Primitive::summarize_metrics`; the generic primitive emits
/// adapter-declared observation aggregates. The tick loop overlays
/// engine-side lifecycle counters (`agents_active`, `agents_liquidated`,
/// `agents_depleted`, `total_liquidations`) on top.
pub type SimulationSummary = BTreeMap<String, Value>;

/// Additive expression-invariant summary surface. The summary itself
/// remains an untagged JSON map, but this alias names the v1 payload
/// shape for callers/tests.
pub type ExpressionInvariantsSummary = Vec<Value>;

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
