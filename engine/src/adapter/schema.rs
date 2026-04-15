//! Serde types for the adapter TOML v0.
//!
//! Keep the schema boring. No dynamic eval, no templating, no variable
//! substitution. The generic blocks are load-bearing and add the minimum
//! extra metadata the engine needs to boot a non-lending program
//! honestly: program artifact path, IDL path, and account bindings.

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

/// Smallest trigger DSL that works for the generic primitive.
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

    /// Declarative invariant block (Sprint 5 T01). A flat list of
    /// `{ name?, field, op, value }` triples the tick loop checks against
    /// each tick's observation snapshot. Empty by default so every
    /// existing adapter continues to parse unchanged.
    #[serde(default)]
    pub invariants: Vec<Invariant>,
}

/// Supported comparison operators for declarative invariants.
///
/// Deliberately flat — no AND/OR, no math, no user functions. The task
/// note lives in the sprint doc: "keep it DUMB — no mini-language".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum InvariantOp {
    #[serde(rename = "==")]
    Eq,
    #[serde(rename = "!=")]
    NotEq,
    #[serde(rename = ">=")]
    Gte,
    #[serde(rename = "<=")]
    Lte,
    #[serde(rename = ">")]
    Gt,
    #[serde(rename = "<")]
    Lt,
}

impl InvariantOp {
    /// Round-trip string form used in summary emission and violation
    /// records so operator-visible output matches the adapter TOML.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Eq => "==",
            Self::NotEq => "!=",
            Self::Gte => ">=",
            Self::Lte => "<=",
            Self::Gt => ">",
            Self::Lt => "<",
        }
    }

    /// Apply the comparison with f64 coercion. Bool/string comparisons
    /// are out of scope for Sprint 5.
    pub fn apply(&self, observed: f64, expected: f64) -> bool {
        match self {
            Self::Eq => observed == expected,
            Self::NotEq => observed != expected,
            Self::Gte => observed >= expected,
            Self::Lte => observed <= expected,
            Self::Gt => observed > expected,
            Self::Lt => observed < expected,
        }
    }
}

/// Declarative invariant triple. Parsed verbatim from the adapter TOML's
/// `[[invariants]]` block. `name` is optional; the loader/runtime default
/// to `inv_<idx>` when absent. `value` is coerced to f64 for comparison.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Invariant {
    #[serde(default)]
    pub name: Option<String>,
    pub field: String,
    pub op: InvariantOp,
    pub value: f64,
}

impl Invariant {
    /// Resolve a stable display name for this invariant, falling back
    /// to `inv_<idx>` when the adapter did not supply one.
    pub fn display_name(&self, idx: usize) -> String {
        self.name
            .clone()
            .unwrap_or_else(|| format!("inv_{idx}"))
    }
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

/// Snapshot metric keys the lending primitive emits alongside the
/// logical observations declared in `state_mapping`. Used by the loader
/// when validating `[[invariants]]` so adapters can reference either
/// the engine-side metric names (e.g. `cumulative_bad_debt`) or the
/// canonical logical observations (e.g. `tvl`).
pub const LENDING_SNAPSHOT_METRICS: &[&str] = &[
    "tvl",
    "utilization",
    "oracle_price",
    "cumulative_bad_debt",
    "cumulative_liquidations",
    "active_agents",
    "tick",
];

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> Adapter {
        toml::from_str(s).expect("parse adapter")
    }

    #[test]
    fn parses_empty_invariants_block_when_absent() {
        let adapter = parse(
            r#"
protocol = "lending"

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "tvl"
"#,
        );
        assert!(adapter.invariants.is_empty());
    }

    #[test]
    fn parses_invariants_block_with_all_ops() {
        let adapter = parse(
            r#"
protocol = "lending"

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "tvl"

[[invariants]]
name = "bad_debt_never_accrues"
field = "cumulative_bad_debt"
op = "=="
value = 0

[[invariants]]
field = "tvl"
op = ">="
value = 0

[[invariants]]
field = "utilization"
op = "<"
value = 1.5

[[invariants]]
field = "tvl"
op = "!="
value = -1

[[invariants]]
field = "tvl"
op = ">"
value = 0

[[invariants]]
field = "tvl"
op = "<="
value = 9999999
"#,
        );
        assert_eq!(adapter.invariants.len(), 6);
        assert_eq!(
            adapter.invariants[0].name.as_deref(),
            Some("bad_debt_never_accrues")
        );
        assert_eq!(adapter.invariants[0].op, InvariantOp::Eq);
        assert_eq!(adapter.invariants[0].value, 0.0);
        assert!(adapter.invariants[1].name.is_none());
        assert_eq!(adapter.invariants[1].op, InvariantOp::Gte);
        assert_eq!(adapter.invariants[2].op, InvariantOp::Lt);
        assert_eq!(adapter.invariants[3].op, InvariantOp::NotEq);
        assert_eq!(adapter.invariants[4].op, InvariantOp::Gt);
        assert_eq!(adapter.invariants[5].op, InvariantOp::Lte);
    }

    #[test]
    fn invariant_op_apply_matches_semantics() {
        assert!(InvariantOp::Eq.apply(1.0, 1.0));
        assert!(!InvariantOp::Eq.apply(1.0, 2.0));
        assert!(InvariantOp::NotEq.apply(1.0, 2.0));
        assert!(InvariantOp::Gte.apply(2.0, 2.0));
        assert!(InvariantOp::Gt.apply(3.0, 2.0));
        assert!(!InvariantOp::Gt.apply(2.0, 2.0));
        assert!(InvariantOp::Lte.apply(2.0, 2.0));
        assert!(InvariantOp::Lt.apply(1.0, 2.0));
    }

    #[test]
    fn invariant_display_name_falls_back_to_index() {
        let inv = Invariant {
            name: None,
            field: "tvl".into(),
            op: InvariantOp::Gte,
            value: 0.0,
        };
        assert_eq!(inv.display_name(3), "inv_3");
    }

    #[test]
    fn invariant_value_accepts_integer_and_float_literals() {
        let adapter = parse(
            r#"
protocol = "lending"

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "tvl"

[[invariants]]
field = "tvl"
op = "=="
value = 42

[[invariants]]
field = "tvl"
op = "=="
value = 42.5
"#,
        );
        assert_eq!(adapter.invariants[0].value, 42.0);
        assert_eq!(adapter.invariants[1].value, 42.5);
    }

    #[test]
    fn invariant_op_roundtrips_through_json() {
        for op in [
            InvariantOp::Eq,
            InvariantOp::NotEq,
            InvariantOp::Gte,
            InvariantOp::Lte,
            InvariantOp::Gt,
            InvariantOp::Lt,
        ] {
            let s = serde_json::to_string(&op).unwrap();
            let back: InvariantOp = serde_json::from_str(&s).unwrap();
            assert_eq!(op, back);
            assert_eq!(s.trim_matches('"'), op.as_str());
        }
    }
}
