//! Backward-compatibility shim for legacy imports.
//!
//! The LiteSVM-backed Solend-fork primitive lives at
//! `crate::primitive::solend_fork`. This module re-exports the public
//! types so existing tests, benchmarks, and external callers that
//! imported from `sim::litesvm::*` keep compiling without churn.
//!
//! New code should import from `crate::primitive::solend_fork` (or the
//! short re-export `crate::primitive::LendingPrimitive` for the trait)
//! directly.

#[cfg(any(feature = "litesvm-backend", test))]
pub use crate::primitive::solend_fork::{LiteSvmBootstrapConfig, LiteSvmHarness};
