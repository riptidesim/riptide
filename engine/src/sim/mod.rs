//! Simulation loop plumbing.
//!
//! This module owns the tick loop and the `Harness` trait it drives. The loop
//! is generic over any backend that implements `Harness` — the default
//! in-process LiteSVM backend for the shipped CLI, a live
//! `ValidatorHarness` for parity reference testing, or an in-memory
//! `MockHarness` for unit tests.

pub mod harness;
#[cfg(any(feature = "litesvm-backend", test))]
pub mod litesvm;
pub mod mock;
pub mod run;
pub mod validator;

pub use harness::{Harness, HarnessError, PoolObservation, PositionObservation};
#[cfg(any(feature = "litesvm-backend", test))]
pub use self::litesvm::LiteSvmHarness;
pub use mock::{MockHarness, MockPosition};
pub use run::{build_agent_personas, run_simulation, SimulationAbort, SimulationParams};
pub use validator::ValidatorHarness;
