//! Minimal perps-lite fork.
//!
//! Sprint 5 T07 ships the first non-lending protocol-class target for
//! the 6-layer stack growth rhythm. **Perps-lite** scope: 5 instructions
//! (init_market, deposit/withdraw_collateral, open/close_position, and
//! liquidate_position) against a long OR short leg, reading the
//! admin-mock oracle shipped by `programs/admin_mock_oracle`.
//!
//! Deliberately cut from the R3.1 max-spec (see the T07 task note for
//! the rationale):
//!
//! - **No funding rate.** The engine's scheduled-actions machinery
//!   (T06) still wires through — the shipping `perps-fork.toml` leaves
//!   `[[scheduled_actions]]` empty so the primitive's default no-op
//!   `on_scheduled_action` hook handles the path. A Sprint 6 drop can
//!   add `update_funding_rate` without reshaping any engine surface.
//! - **No insurance fund.** Losses that exceed the liquidated position's
//!   posted collateral land in `MarketState.cumulative_socialized_loss`
//!   as a plain counter. T12's invariants can assert bounds on the
//!   counter so downstream discovery still sees the economic failure.
//! - **Single-shot liquidation only.** No progressive / partial.
//! - **No cross-CPI.** The oracle account is read directly by Borsh.
//!
//! The remaining surface is enough to produce the "oracle shock +
//! leveraged open interest ⇒ margin cascade ⇒ socialized loss" failure
//! mode the Sprint 5 validation story needs.

pub mod error;
pub mod processor;
pub mod state;

use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, pubkey::Pubkey,
};

use crate::processor::Processor;

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    Processor::process(program_id, accounts, instruction_data)
}
