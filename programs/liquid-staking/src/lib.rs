//! Minimal liquid-staking fork.
//!
//! Fourth protocol-class bundle after lending / perps / AMM. Captures
//! the failure shape a Kelp-style / rsETH-style depeg + redemption-run
//! proof needs:
//!
//! - pooled underlying stake (single asset, virtual balance)
//! - LST supply + exchange rate (underlying-per-LST in bps)
//! - withdrawal queue + pending redemption claims
//! - reserve buffer for immediately-claimable liquidity
//! - one authority-gated stress mutation path (`apply_slash`) that
//!   materially changes redeemability by shrinking pooled stake
//!
//! Deliberately out of scope (documented so a later bundle can extend
//! without reshaping these types):
//!
//! - **No real SPL token transfers.** Pool balances are virtual u64
//!   counters on the pool account, same convention as perpetuals /
//!   amm.
//! - **No validator delegation, no cranker rewards.** The exchange rate
//!   moves only through `apply_slash`; a later bundle can add a
//!   scheduled `sync_exchange_rate` that grows it.
//! - **No epoch accounting.** `claim_unstake` can settle any time the
//!   reserve buffer has enough liquidity to cover the queued request.
//! - **No oracle reads inside the program.** The adapter still binds
//!   one externally-owned oracle through `[[oracles]]` — honest
//!   generic path — but the program's instruction surface
//!   does not read it. A later bundle can add a price-sanity hook.
//! - **Single-shot slash.** `apply_slash` takes a bps and applies it
//!   once; no progressive liquidation of validators.

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
