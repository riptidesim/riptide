//! Minimal constant-product AMM fork.
//!
//! Sprint 6 T11 ships the third protocol-class target for the 6-layer
//! stack growth rhythm after lending_pool (Sprint 4) and perps-fork
//! (Sprint 5). **AMM-lite** scope: 4 instructions (initialize_pool,
//! add_liquidity, remove_liquidity, swap) implementing the Uniswap-v2
//! constant-product invariant `x*y=k` against virtual token reserves.
//!
//! Deliberately cut from a full AMM implementation:
//!
//! - **No real SPL token transfers.** Reserves are virtual u64 counters
//!   on the pool account. add_liquidity / swap bump reserves without
//!   moving real tokens, matching how lending_pool and perps-fork
//!   handle balances — this is a simulation target, not a production AMM.
//! - **No LP token mint.** LP shares are tracked as a per-agent counter
//!   on `LpPositionState`, not an SPL mint. Same rationale.
//! - **No routing / multi-hop swaps.** Single pool, single pair.
//! - **No oracle dependency.** Price derives from reserves. The adapter
//!   declaring this program has an empty `[[oracles]]` block — AMM is
//!   the first Riptide target whose discovery story works without a
//!   mocked oracle, which widens the 6-layer stack claim.
//! - **Single-shot liquidity ops.** No progressive/partial add+remove
//!   within one instruction.
//!
//! The remaining surface is enough to reproduce the AMM failure modes
//! the Sprint 6 T14 taxonomy targets: price manipulation via swap,
//! impermanent loss spike, JIT liquidity, reserve depletion.

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
