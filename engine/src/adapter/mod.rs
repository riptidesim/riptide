//! Adapter format (Sprint 3 · T04).
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
//! deposit   = { action = "deposit",   amount = "amount" }
//! borrow    = { action = "borrow",    amount = "amount" }
//! repay     = { action = "repay",     amount = "amount" }
//! withdraw  = { action = "withdraw",  amount = "amount" }
//! liquidate = { action = "liquidate", amount = "repay_amount" }
//!
//! [state_mapping]
//! "pool.total_deposits" = "tvl"
//! "pool.total_borrows"  = "debt"
//! "pool.bad_debt"       = "bad_debt"
//! "position.collateral" = "collateral"
//! "position.debt"       = "debt"
//! "position.liquidated" = "liquidated"
//! ```
//!
//! Sprint 3 T05 extends the generic path with `[accounts]`, `program_so`,
//! and `idl_path`, which give the engine enough information to boot a
//! non-lending program honestly instead of hiding those details in code.

pub mod loader;
pub mod schema;

pub use loader::{load_adapter, AdapterError};
pub use schema::{
    AccountDefinition, AccountKind, ActionDefinition, Adapter, InstructionMapping,
    ObservationDefinition, ObservationType, PersonaDefinition, PersonaTriggerDefinition, Protocol,
    ACTION_NAMES, LENDING_ACTIONS, LENDING_OBSERVATIONS,
};
