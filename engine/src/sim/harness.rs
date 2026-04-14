//! Back-compat shim — the sim-layer `Harness` trait and its companion
//! observation / error types now live in `crate::primitive::lending`.
//!
//! The trait split:
//! - the lending-domain actions (`deposit`, `borrow`, `repay`,
//!   `withdraw`, `liquidate`) and observations (`pool_state`,
//!   `health_factor`) live on `LendingPrimitive`,
//! - the sim-layer concerns (`agent_count`, `push_oracle_price`,
//!   `advance_tick`) live on `Harness`, which super-traits
//!   `LendingPrimitive`.
//!
//! All re-exports preserved here so legacy imports keep resolving.
//! New code should import from `crate::primitive::*` directly.

pub use crate::primitive::{
    Harness, HarnessError, PoolObservation, PoolState, PositionHealth, PositionObservation,
    PrimitiveError,
};
