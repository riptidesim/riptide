//! Primitive abstraction layer (Sprint 3 · T03).
//!
//! A **primitive** is a protocol-domain trait: the abstract surface the
//! engine calls for one class of on-chain programs (lending, AMM, etc.).
//! Concrete primitives (e.g. `SolendForkPrimitive`) hide protocol-specific
//! wiring — instruction selectors, account layouts, client builders —
//! behind the trait.
//!
//! ## Layering
//!
//! ```text
//!        ┌───────────────────────┐
//!        │   sim::run tick loop  │
//!        └──────────┬────────────┘
//!                   │ generic over H: Harness
//!        ┌──────────▼────────────┐
//!        │  Harness (sim layer)  │    agent_count / advance_tick /
//!        │                       │    push_oracle_price
//!        └──────────┬────────────┘
//!                   │ super-trait: Harness: LendingPrimitive
//!        ┌──────────▼────────────┐
//!        │   LendingPrimitive    │    deposit / borrow / repay /
//!        │   (domain trait)      │    withdraw / liquidate /
//!        │                       │    pool_state / health_factor
//!        └──────────┬────────────┘
//!                   │ implemented by
//!        ┌──────────▼────────────┐
//!        │   LiteSvmHarness      │    ← primitive/solend_fork.rs
//!        │   (Solend-fork impl)  │
//!        └───────────────────────┘
//! ```

pub mod lending;
#[cfg(any(feature = "litesvm-backend", test))]
pub mod solend_fork;

pub use lending::{
    Harness, HarnessError, LendingPrimitive, PoolObservation, PoolState, PositionHealth,
    PositionObservation, PrimitiveError,
};
