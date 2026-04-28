//! Parser policy notes for the semantics breadth substrate.
//!
//! The load-time parser accepts the additive Sprint 21 sub-blocks
//! under `[semantics]`: `oracles.<role>`, `collections.<name>`, and
//! `replay`. Multi-oracle weights are intentionally fail-closed: if a
//! role declares any `weight`, every oracle binding for that role must
//! declare one, and a zero total weight returns the typed
//! `MultiOracleWeightsAllZero` error. Treating zero-weight feeds as
//! silent exclusions would make weighted-price behavior depend on an
//! implicit fallback. The adapter author must either omit weights for
//! median semantics or declare a positive total weight.

pub use crate::adapter::{parse_adapter_str, AdapterError};

pub type ParsedAdapter = crate::adapter::Adapter;
