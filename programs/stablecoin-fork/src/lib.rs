//! Minimal stablecoin fork.
//!
//! Fifth protocol-class bundle after lending / perps / AMM /
//! liquid-staking. Captures the failure shape a UXD-style collateral
//! cascade proof needs:
//!
//! - pooled collateral backing (single asset, virtual balance)
//! - stablecoin supply (virtual u64)
//! - pending-redemption queue (assets owed out of band)
//! - reserve buffer for immediately-claimable redemptions
//! - one authority-gated stress mutation (`apply_hedge_loss`) that
//!   materially shrinks pool collateral without touching stable supply,
//!   driving the effective collateral ratio below full backing
//!
//! Deliberately out of scope (documented so a later bundle can extend
//! without reshaping these types):
//!
//! - **No literal UXD / Perena / Parrot protocol coverage.** This is a
//!   minimal fork that captures pressure geometry, not a line-for-line
//!   reimplementation of any real protocol.
//! - **No live hedge-venue integration.** Real UXD carried its delta
//!   hedge on Mango / a perps venue off-program. Here the hedge loss
//!   is internalized as a narrow program-local mutation path. The
//!   effect on backing is economically faithful; the plumbing is not.
//! - **No SPL token transfers.** Collateral and stable balances are
//!   virtual u64 counters on the pool + position accounts, same
//!   convention perps-fork / amm-fork / liquid-staking-fork use.
//! - **No peg-defense bot, no rebalancing crank, no treasury fund.**
//!   `apply_hedge_loss` is strictly authority-gated and not persona-
//!   dispatchable; the shipping adapter leaves `[[scheduled_actions]]`
//!   empty and the named proof artifact dispatches it via replay
//!   trajectory.
//! - **No oracle-gated mint/redeem.** The adapter binds an external
//!   oracle through the owner-aware external-oracle path for
//!   forward-compat, but this processor does not read it — a later
//!   bundle can add a price-sanity hook without reshaping this file.
//! - **1:1 mint accounting.** Minting requires a unit of collateral per
//!   unit of stable inside the agent's position; redemption pays back
//!   1:1 before hedge-loss haircuts land on collateral. The
//!   "under-backed" regime therefore manifests at the pool level
//!   (`collateral_assets < stable_supply`) rather than through a
//!   dynamic mint-price.

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
