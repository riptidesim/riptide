//! Primitive abstraction layer (Sprint 3 · T03).
//!
//! A **primitive** is a protocol-domain trait: the abstract surface the
//! engine calls for one class of on-chain programs (lending, AMM, etc.).
//! Concrete primitives (e.g. `SolendForkPrimitive`) hide protocol-specific
//! wiring — instruction selectors, account layouts, client builders —
//! behind the trait.
//!
//! The sim layer binds to the `Harness` trait from `sim::harness`, and each
//! primitive impl is also a `Harness` impl so the tick loop can drive it
//! without caring which primitive is underneath.
//!
//! ## Layering
//!
//! ```text
//!        ┌───────────────────────┐
//!        │   sim::run tick loop  │
//!        └──────────┬────────────┘
//!                   │ dyn Harness
//!        ┌──────────▼────────────┐
//!        │   Harness impl        │    ← sim/harness.rs
//!        │   (sim-layer trait)   │
//!        └──────────┬────────────┘
//!                   │ implements
//!        ┌──────────▼────────────┐
//!        │   LendingPrimitive    │    ← primitive/lending.rs
//!        │   (domain trait)      │
//!        └──────────┬────────────┘
//!                   │ implemented by
//!        ┌──────────▼────────────┐
//!        │   SolendForkPrimitive │    ← primitive/solend_fork.rs
//!        │   (concrete impl)     │
//!        └───────────────────────┘
//! ```

pub mod lending;
#[cfg(any(feature = "litesvm-backend", test))]
pub mod solend_fork;

pub use lending::{LendingPrimitive, PoolState, PositionHealth, PrimitiveError};
