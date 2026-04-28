//! Compatibility exports for typed semantics parser errors.
//!
//! This branch routes adapter TOML parsing through
//! `crate::adapter::loader`, so the typed parser errors are surfaced as
//! `AdapterError` variants there.

pub use crate::adapter::AdapterError as SemanticsParserError;
