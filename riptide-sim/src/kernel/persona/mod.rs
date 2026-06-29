//! Persona decision brain: policies, triggers, per-agent state, and the
//! runtime that turns observations into action decisions. Pure decision logic
//! over an abstract agent model — the execution of a chosen action against the
//! real program is the caller's responsibility (see [`crate::reseat`]).

pub mod policy;
pub mod runtime;
pub mod state;
pub mod triggers;

pub use policy::{ActionScore, Decision, RuntimeAction};
pub use runtime::{AgentObservation, AgentRuntime};
pub use state::{Agent, AgentPosition};
