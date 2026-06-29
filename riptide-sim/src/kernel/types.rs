//! Kernel data types shared by the persona brain and the generic encoder.
//!
//! Extracted from the engine's `types.rs`; the engine now re-exports these so
//! existing `crate::types::*` references keep resolving. Generic-engine result
//! shapes (`RunConfig`, `SimulationResult`, `SimEvent`, …) stay in the engine.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// A per-persona argument literal substituted into multi-arg instruction calls
/// by the generic encoder. Untagged so a TOML entry like `min_out = 0` parses
/// as `Int(0)`, `direction = false` as `Bool(false)`, and a base58 string as
/// `String(..)`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ArgLiteral {
    Bool(bool),
    Int(i64),
    String(String),
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
    pub persona_args: BTreeMap<String, ArgLiteral>,
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
