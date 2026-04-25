//! Primitive abstraction layer.
//!
//! A **primitive** is a protocol-neutral trait the engine dispatches
//! through. The trait is split in two:
//!
//! - [`Primitive`] — domain-neutral base trait every backend
//! implements. Owns `agent_count`, `advance_tick`,
//! `push_oracle_price`, `execute_action`, `observation_values`.
//! - [`LendingPrimitive`] — super-trait adding the five lending
//! actions and two lending observations.
//!
//! The lending tick loop (`run_simulation`) binds on
//! `LendingPrimitive`. The generic tick loop (`run_generic_simulation`)
//! binds on `Primitive` and has no lending vocabulary at all.

pub mod lending;
pub mod generic;
pub mod amm;
#[cfg(any(feature = "litesvm-backend", test))]
pub mod lending_pool;

#[allow(unused_imports)]
pub use amm::{AmmPrimitive, AmmReserves};

pub use generic::{
    build_generic_policies, generic_runtime_actions, parse_generic_idl_str, GenericIdl,
    GenericInstructionBuilder,
};
#[cfg(any(feature = "litesvm-backend", test))]
pub use generic::{GenericBootstrapConfig, GenericHarness};
pub use lending::{
    dispatch_lending_action, Harness, HarnessError, LendingPrimitive, PoolObservation, PoolState,
    PositionHealth, PositionObservation, Primitive, PrimitiveError,
};
