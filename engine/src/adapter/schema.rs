//! Serde types for the adapter TOML v0.
//!
//! Keep the schema boring. No dynamic eval, no templating, no variable
//! substitution. The generic primitive (T05) will populate the
//! currently-reserved `[actions]`, `[observations]`, `[personas]`
//! blocks — they're parsed here but carry no behavior for
//! `protocol = "lending"`.

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
    /// Not yet wired (T05).
    Generic,
}

/// Mapping of an on-chain instruction name to a logical action + its
/// amount argument name.
///
/// `action` is the canonical action label the engine dispatches on
/// (`deposit`, `borrow`, `repay`, `withdraw`, `liquidate` for lending).
/// `amount` names the instruction argument that carries the numeric
/// amount the engine will pass in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstructionMapping {
    pub action: String,
    /// Optional because observation-only or zero-arg instructions may
    /// not need an amount parameter.
    #[serde(default)]
    pub amount: Option<String>,
}

/// Reserved action definition block for the generic primitive (T05).
/// Parsed but unused when `protocol = "lending"`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ActionDefinition {
    /// Logical action label, e.g. `"craft"` for a toy resource-grinder
    /// demo.
    #[serde(default)]
    pub label: Option<String>,
    /// Instruction name this action dispatches to. Cross-checked against
    /// the keys of `[instructions]`.
    #[serde(default)]
    pub instruction: Option<String>,
}

/// Reserved observation definition block for the generic primitive.
/// Parsed but unused when `protocol = "lending"`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ObservationDefinition {
    #[serde(default)]
    pub label: Option<String>,
    /// Dotted path into the account hierarchy
    /// (e.g. `"pool.total_deposits"`). Cross-checked against the keys
    /// of `[state_mapping]` when populated.
    #[serde(default)]
    pub path: Option<String>,
}

/// Reserved persona definition block for the generic primitive.
/// Parsed but unused when `protocol = "lending"`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PersonaDefinition {
    #[serde(default)]
    pub label: Option<String>,
    /// Per-action weights referenced by the agent runtime when the
    /// generic primitive is active.
    #[serde(default)]
    pub action_weights: BTreeMap<String, f64>,
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

    /// Map of on-chain instruction name → `{ action, amount }`. Required.
    pub instructions: BTreeMap<String, InstructionMapping>,

    /// Map of `"<account>.<field>"` dotted path → logical observation
    /// name. Required.
    pub state_mapping: BTreeMap<String, String>,

    /// Reserved for T05 (generic primitive). Empty by convention for
    /// lending adapters.
    #[serde(default)]
    pub actions: BTreeMap<String, ActionDefinition>,

    /// Reserved for T05. Empty by convention for lending adapters.
    #[serde(default)]
    pub observations: BTreeMap<String, ObservationDefinition>,

    /// Reserved for T05. Empty by convention for lending adapters.
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
/// generic-primitive path (T05) will fill in additional labels.
pub const ACTION_NAMES: &[&str] = LENDING_ACTIONS;
