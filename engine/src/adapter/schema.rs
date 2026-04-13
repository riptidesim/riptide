//! Serde types for the adapter TOML v0.
//!
//! Keep the schema boring. No dynamic eval, no templating, no variable
//! substitution. Sprint 3 T05 makes the generic blocks load-bearing and
//! adds the minimum extra metadata the engine needs to boot a non-lending
//! program honestly: program artifact path, IDL path, and account bindings.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// The protocol class this adapter describes. Selects which primitive
/// impl the engine boots at runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    /// Lending primitive (deposit/borrow/repay/withdraw/liquidate +
    /// pool_state/health_factor). First concrete impl:
    /// `crate::primitive::solend_fork::LiteSvmHarness`.
    Lending,
    /// Generic primitive driven entirely by inline adapter definitions.
    Generic,
}

/// Mapping of an on-chain instruction name to a logical action + its
/// amount argument name.
///
/// `action` is the canonical action label the engine dispatches on.
/// `amount` names the instruction argument that carries the numeric
/// amount the engine will pass in when the action is sized dynamically.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstructionMapping {
    pub action: String,
    /// Optional because zero-arg instructions may omit it.
    #[serde(default)]
    pub amount: Option<String>,
}

/// How a generic adapter account is instantiated at bootstrap time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AccountKind {
    /// One program-owned account per simulated agent.
    Agent,
    /// One shared program-owned account for the whole simulation.
    Shared,
}

/// Bootstrap metadata for a generic adapter account binding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountDefinition {
    pub kind: AccountKind,
    pub space: usize,
}

/// Generic action definition.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ActionDefinition {
    /// Optional human-readable label for reports/debugging.
    #[serde(default)]
    pub label: Option<String>,
    /// Ordered list of instruction args the action supplies. v0 supports
    /// either zero args or a single numeric arg bound via
    /// `[instructions].<ix>.amount`.
    #[serde(default)]
    pub takes: Vec<String>,
}

/// Supported observation types for the generic primitive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ObservationType {
    Int,
    UInt,
    Bool,
    Pubkey,
    Map,
}

/// Detailed observation definition form.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObservationShape {
    #[serde(default)]
    pub label: Option<String>,
    #[serde(rename = "type")]
    pub kind: ObservationType,
}

/// Generic observation definition.
///
/// The compact TOML form is:
///
/// ```toml
/// [observations]
/// "player.wood" = "uint"
/// ```
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ObservationDefinition {
    Type(ObservationType),
    Detailed(ObservationShape),
}

impl ObservationDefinition {
    pub fn kind(&self) -> ObservationType {
        match self {
            Self::Type(kind) => *kind,
            Self::Detailed(shape) => shape.kind,
        }
    }
}

/// Smallest trigger DSL that works for T05/T06.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PersonaTriggerDefinition {
    #[serde(rename = "if")]
    pub condition: String,
    #[serde(rename = "then")]
    pub action: String,
    pub weight_boost: f64,
}

fn default_action_rate_multiplier() -> f64 {
    1.0
}

/// Generic persona definition block.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PersonaDefinition {
    #[serde(default)]
    pub label: Option<String>,
    /// Multiplies all non-noop action scores. Higher => acts more often.
    #[serde(default = "default_action_rate_multiplier")]
    pub action_rate_multiplier: f64,
    /// Per-action weights referenced by the agent runtime when the
    /// generic primitive is active.
    #[serde(default)]
    pub action_weights: BTreeMap<String, f64>,
    /// Trigger DSL. Parsed into runtime triggers by the generic primitive.
    #[serde(default)]
    pub triggers: Vec<PersonaTriggerDefinition>,
}

/// Parsed adapter TOML.
///
/// Field order matters for serde: it shapes what a stringified roundtrip
/// of the struct looks like. Keep parse-order documented in the fixture
/// file instead of relying on field declaration order here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Adapter {
    /// Which primitive impl to boot. Selects at runtime from the adapter
    /// file instead of a compile-time switch.
    pub protocol: Protocol,

    /// Optional path to the program artifact. Generic adapters use this to
    /// point the engine at a non-lending `.so` without extra CLI flags.
    #[serde(default)]
    pub program_so: Option<String>,

    /// Optional path to the IDL / instruction catalog JSON. Required by
    /// the generic primitive.
    #[serde(default)]
    pub idl_path: Option<String>,

    /// Generic account bootstrap bindings. Empty by convention for
    /// lending adapters.
    #[serde(default)]
    pub accounts: BTreeMap<String, AccountDefinition>,

    /// Map of on-chain instruction name → `{ action, amount }`. Required.
    pub instructions: BTreeMap<String, InstructionMapping>,

    /// Map of `"<account>.<field>"` dotted path → logical observation
    /// name. Required.
    pub state_mapping: BTreeMap<String, String>,

    /// Generic action definitions. Empty by convention for lending
    /// adapters.
    #[serde(default)]
    pub actions: BTreeMap<String, ActionDefinition>,

    /// Generic observation definitions. Empty by convention for lending
    /// adapters.
    #[serde(default)]
    pub observations: BTreeMap<String, ObservationDefinition>,

    /// Generic persona definitions. Empty by convention for lending
    /// adapters.
    #[serde(default)]
    pub personas: BTreeMap<String, PersonaDefinition>,
}

// ---------------------------------------------------------------------------
// Canonical name sets used by the loader for lending-protocol validation.
// ---------------------------------------------------------------------------

/// Canonical set of lending action labels the engine dispatches on.
pub const LENDING_ACTIONS: &[&str] = &["deposit", "borrow", "repay", "withdraw", "liquidate"];

/// Canonical set of logical observation names the lending tick loop
/// consumes from `state_mapping` values.
pub const LENDING_OBSERVATIONS: &[&str] = &[
    "tvl",
    "debt",
    "bad_debt",
    "collateral",
    "liquidated",
];

/// Super-set of `LENDING_ACTIONS` used for error-message guidance. The
/// generic-primitive path extends this at runtime with adapter-defined
/// custom actions.
pub const ACTION_NAMES: &[&str] = LENDING_ACTIONS;
