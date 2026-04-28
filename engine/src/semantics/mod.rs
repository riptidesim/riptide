//! Economic semantics primitives.
//!
//! Sprint 19 phase 1 ships the bounded expression language used by
//! `[semantics.derived]` and `[[semantics.invariants]]`. The evaluator
//! deliberately has no I/O, no time access, no user functions, and no
//! loops.

pub mod derived;
pub mod error;
pub mod errors;
pub mod eval;
pub mod expr;
pub mod invariants;
pub mod parser;
pub mod roles;
pub mod types;

pub use eval::Context;

/// Implicit fixed-point scale used for decimal literals and
/// `bps_to_ratio`. A ratio of `1.0` is represented as `10^18`.
pub const RATIO_SCALE: u128 = 1_000_000_000_000_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Value {
    U128(u128),
    I128(i128),
    Bool(bool),
}

impl Value {
    pub fn kind_name(&self) -> &'static str {
        match self {
            Self::U128(_) => "u128",
            Self::I128(_) => "i128",
            Self::Bool(_) => "bool",
        }
    }

    pub fn to_json(self) -> serde_json::Value {
        match self {
            Self::U128(value) if value <= u64::MAX as u128 => serde_json::Value::from(value as u64),
            Self::U128(value) => serde_json::Value::from(value.to_string()),
            Self::I128(value) if value >= i64::MIN as i128 && value <= i64::MAX as i128 => {
                serde_json::Value::from(value as i64)
            }
            Self::I128(value) => serde_json::Value::from(value.to_string()),
            Self::Bool(value) => serde_json::Value::Bool(value),
        }
    }
}
