//! Simulation loop plumbing.
//!
//! This module owns the tick loop and the `Harness` trait it drives. The loop
//! is generic over any backend that implements `Harness` — a live
//! solana-test-validator client (`ValidatorHarness`) in production, an
//! in-memory `MockHarness` for unit tests.

pub mod harness;
pub mod mock;
pub mod run;
pub mod validator;

pub use harness::{Harness, HarnessError, PoolObservation, PositionObservation};
pub use mock::{MockHarness, MockPosition};
pub use run::{build_agent_personas, run_simulation, SimulationAbort, SimulationParams};
pub use validator::ValidatorHarness;
