//! Economic semantics.
//!
//! The bounded expression language (`error`, `expr`, `eval`) and its value
//! types now live in `riptide_sim::kernel::semantics` and are re-exported here
//! so existing `crate::semantics::*` references keep resolving. The
//! adapter-coupled context builders (`derived`, `roles`, `oracles`,
//! `collections`) and the invariant evaluator stay engine-side for the
//! generic path.

pub mod collections;
pub mod derived;
pub mod errors;
pub mod invariants;
pub mod oracles;
pub mod parser;
pub mod roles;
pub mod types;

pub use riptide_sim::kernel::semantics::{error, eval, expr, Context, Value, RATIO_SCALE};
