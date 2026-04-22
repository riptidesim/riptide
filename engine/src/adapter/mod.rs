//! Adapter format.
//!
//! An **adapter** is a TOML file that tells the engine which primitive
//! impl to boot and how its on-chain wiring maps to the engine's tick
//! loop. The engine boots from the adapter instead of a hardcoded
//! compile-time switch.
//!
//! ## Schema (v0)
//!
//! ```toml
//! # fixtures/adapters/solend-fork.toml
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

pub mod loader;
pub mod schema;

pub use loader::{load_adapter, parse_adapter_str, AdapterError};
pub use schema::{
    AccountDefinition, AccountKind, AccountOwner, ActionDefinition, Adapter, AdapterLineage,
    ArgLiteral, InstructionMapping, Invariant, InvariantOp, ObservationDefinition,
    ObservationType, OracleDefinition, OracleKind, PersonaDefinition, PersonaTriggerDefinition,
    Protocol, ScheduledAction, ACTION_NAMES, LENDING_ACTIONS, LENDING_OBSERVATIONS,
    LENDING_SNAPSHOT_METRICS, ORACLE_KINDS,
};
