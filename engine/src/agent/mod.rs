//! Persona brain facade.
//!
//! The implementation now lives in `riptide_sim::kernel::persona`; this module
//! re-exports it so existing `crate::agent::*` references keep resolving.

pub use riptide_sim::kernel::persona::{policy, runtime, state, triggers};
pub use riptide_sim::kernel::persona::{
    ActionScore, Agent, AgentObservation, AgentPosition, AgentRuntime, Decision, RuntimeAction,
};
