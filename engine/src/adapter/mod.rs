//! Adapter format.
//!
//! An **adapter** is a TOML file that tells the engine how to infer the
//! runtime and how its on-chain wiring maps to the engine's tick loop.
//! `program_so` + `idl_path` select the generic SBF/IDL runtime, while
//! `protocol` remains a backcompat hint for adapters that do not declare
//! program artifacts.
//!
//! ## Schema (v0)
//!
//! ```toml
//! # fixtures/adapters/lending.toml
//! protocol = "lending"
//!
//! [instructions]
//! deposit = { action = "deposit", amount = "amount" }
//! borrow = { action = "borrow", amount = "amount" }
//! repay = { action = "repay", amount = "amount" }
//! withdraw = { action = "withdraw", amount = "amount" }
//! liquidate = { action = "liquidate", amount = "repay_amount" }
//!
//! [state_mapping]
//! "pool.total_deposits" = "tvl"
//! "pool.total_borrows" = "debt"
//! "pool.bad_debt" = "bad_debt"
//! "position.collateral" = "collateral"
//! "position.debt" = "debt"
//! "position.liquidated" = "liquidated"
//! ```
//!
//! The generic path extends the schema with `[accounts]`, `program_so`,
//! and `idl_path`, which give the engine enough information to boot a
//! non-lending program honestly instead of hiding those details in code.

pub mod errors;
pub mod loader;
pub mod schema;

pub use errors::{
    decode_program_error, validate_error_entries, DecodedProgramError, ProgramErrorEntry,
};
pub use loader::{load_adapter, parse_adapter_str, AdapterError};
pub use schema::{
    AccountDecoder, AccountDefinition, AccountKind, AccountOwner, ActionDefinition, Adapter,
    AdapterLineage, ArgLiteral, CollectionDef, CollectionFormula, InstructionMapping, Invariant,
    InvariantOp, LayoutDecoder, LayoutField, LayoutFieldType, ObservationDefinition,
    ObservationType, OracleBinding, OracleDefinition, OracleKind, PdaDefinition, PersonaDefinition,
    PersonaTriggerDefinition, Protocol, ReplayBlock, ReplayStateSource, ScheduledAction,
    SemanticClassRef, SemanticExpression, SemanticFieldType, SemanticInvariant,
    SemanticInvariantSeverity, SemanticRole, SemanticSourceBinding, Semantics,
    ACCOUNT_DECODER_PRESETS, ACTION_NAMES, LENDING_ACTIONS, LENDING_OBSERVATIONS,
    LENDING_SNAPSHOT_METRICS, ORACLE_KINDS, SEMANTIC_CLASS_RE, SUPPORTED_SEMANTIC_CLASSES,
};
