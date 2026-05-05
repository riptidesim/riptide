//! On-chain account layouts for `amm`.
//!
//! This program ships an **AMM-lite** instruction set: initialize_pool,
//! add_liquidity, remove_liquidity, swap. Constant-product math
//! (`reserve_a * reserve_b = k`) over virtual u64 reserves — no real SPL
//! tokens, no LP mint, no oracle.
//!
//! Every non-identity field is widened to u64/bool so the generic
//! primitive's observation decoder (which only speaks u64/i64/bool/
//! pubkey) can walk the account byte layout without cursor misalignment.
//! This keeps the adapter state-mapping honest.

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

use crate::error::AmmError;

/// Bps denominator for fee math.
pub const BPS_DENOMINATOR: u128 = 10_000;

/// Price scale applied when writing `last_swap_price`. Gives `reserve_b/reserve_a`
/// four decimal digits of precision as a u64 without reaching for fixed-point
/// math. `last_swap_price = (reserve_b * PRICE_SCALE) / reserve_a`.
pub const PRICE_SCALE: u128 = 1_000_000;

/// Swap direction tags. Widened to `u64` so the generic observation
/// decoder + multi-arg dispatch can encode the arg as a plain u64 field.
pub const DIRECTION_A_TO_B: u64 = 0;
pub const DIRECTION_B_TO_A: u64 = 1;

/// Sane defaults used by the lazy-init path in `read_initialized_pool`.
/// The generic harness bootstraps program-owned accounts with zero-filled
/// buffers; the first instruction that reads the pool therefore sees an
/// uninitialized state and falls back on these so simulations can swap
/// immediately instead of requiring an explicit `initialize_pool` tick.
pub const DEFAULT_RESERVE_A: u64 = 1_000_000;
pub const DEFAULT_RESERVE_B: u64 = 1_000_000;
pub const DEFAULT_FEE_BPS: u64 = 30;

/// Serialized length of [`PoolState`]. Pinned as a constant so the harness
/// allocates the pool account with the exact space the processor expects
/// and any layout drift surfaces as a test failure.
pub const POOL_STATE_LEN: usize = 1   // is_initialized
    + 32                               // admin
    + 32                               // token_a_mint
    + 32                               // token_b_mint
    + 8                                // reserve_a
    + 8                                // reserve_b
    + 8                                // total_lp_supply
    + 8                                // last_swap_price
    + 8                                // cumulative_volume
    + 8                                // cumulative_fees
    + 8                                // fee_bps
    + 8;                               // k_last
// = 161 bytes

/// Serialized length of [`LpPositionState`].
pub const LP_POSITION_STATE_LEN: usize = 1 // is_initialized
    + 32                                     // owner
    + 32                                     // pool
    + 8;                                     // lp_shares
// = 73 bytes

/// Constant-product pool state. One shared account per pool.
#[derive(Debug, Clone, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct PoolState {
    pub is_initialized: bool,
    pub admin: [u8; 32],
    pub token_a_mint: [u8; 32],
    pub token_b_mint: [u8; 32],
    /// Virtual reserves of the base token. Updated on add/remove/swap.
    pub reserve_a: u64,
    /// Virtual reserves of the quote token.
    pub reserve_b: u64,
    /// Total LP shares outstanding across all `LpPositionState` accounts.
    /// add_liquidity mints; remove_liquidity burns.
    pub total_lp_supply: u64,
    /// Scaled spot price from the last swap: `(reserve_b * PRICE_SCALE) / reserve_a`
    /// computed after the swap settles. Zero until a swap executes.
    pub last_swap_price: u64,
    /// Sum of `amount_in` across every swap. Drives `reserve_depletion`
    /// and `jit_liquidity` category hooks.
    pub cumulative_volume: u64,
    /// Cumulative fees skimmed into reserves. Fee stays in the pool —
    /// this counter is bookkeeping for observability, not a separate
    /// balance.
    pub cumulative_fees: u64,
    /// Fee in bps of amount_in. 30 = 0.30% (Uniswap-v2 default).
    pub fee_bps: u64,
    /// `(reserve_a * reserve_b)` after the most recent state-changing
    /// instruction, clamped to u64::MAX on overflow. Exposed as a
    /// directly-readable observation for invariant + discovery hooks.
    pub k_last: u64,
}

/// One per agent per pool. Tracks the agent's LP share balance.
#[derive(Debug, Clone, PartialEq, Eq, Default, BorshSerialize, BorshDeserialize)]
pub struct LpPositionState {
    pub is_initialized: bool,
    pub owner: [u8; 32],
    pub pool: [u8; 32],
    /// LP shares held by this agent. add_liquidity mints new shares here;
    /// remove_liquidity burns from this balance. Swap-only agents leave
    /// it at zero — the account exists but does not participate in
    /// supply accounting.
    pub lp_shares: u64,
}

impl PoolState {
    pub fn admin_pubkey(&self) -> Pubkey {
        Pubkey::new_from_array(self.admin)
    }
    pub fn token_a_pubkey(&self) -> Pubkey {
        Pubkey::new_from_array(self.token_a_mint)
    }
    pub fn token_b_pubkey(&self) -> Pubkey {
        Pubkey::new_from_array(self.token_b_mint)
    }
}

impl LpPositionState {
    pub fn owner_pubkey(&self) -> Pubkey {
        Pubkey::new_from_array(self.owner)
    }
    pub fn pool_pubkey(&self) -> Pubkey {
        Pubkey::new_from_array(self.pool)
    }
}

/// `(reserve_a * reserve_b)` clamped to u64::MAX on overflow. Stored on
/// `PoolState.k_last` after every state-changing instruction so discovery
/// hooks and invariants can read it as a plain observation.
pub fn compute_k_last(reserve_a: u64, reserve_b: u64) -> u64 {
    let prod = (reserve_a as u128).saturating_mul(reserve_b as u128);
    prod.min(u64::MAX as u128) as u64
}

/// Scaled spot price after a state-changing instruction. Returns 0 when
/// `reserve_a == 0` (pool drained on the quote side) so the observation
/// stays honest instead of panicking.
pub fn compute_last_swap_price(reserve_a: u64, reserve_b: u64) -> u64 {
    if reserve_a == 0 {
        return 0;
    }
    let scaled = (reserve_b as u128)
        .saturating_mul(PRICE_SCALE)
        .checked_div(reserve_a as u128)
        .unwrap_or(0);
    scaled.min(u64::MAX as u128) as u64
}

/// Constant-product swap output under the Uniswap-v2 fee model.
///
/// - `amount_in_after_fee = amount_in * (BPS_DENOMINATOR - fee_bps) / BPS_DENOMINATOR`
/// - `amount_out = reserve_out * amount_in_after_fee / (reserve_in + amount_in_after_fee)`
///
/// Fee is NOT transferred elsewhere — it stays inside `reserve_in`, which
/// grows by the full `amount_in`. Over many swaps this compounds into
/// the pool's share value, matching real UniV2 behavior.
pub fn compute_swap_output(
    amount_in: u64,
    reserve_in: u64,
    reserve_out: u64,
    fee_bps: u64,
) -> Result<u64, AmmError> {
    if amount_in == 0 {
        return Err(AmmError::ZeroSwapInput);
    }
    if reserve_in == 0 || reserve_out == 0 {
        return Err(AmmError::EmptyReserve);
    }
    if fee_bps as u128 >= BPS_DENOMINATOR {
        return Err(AmmError::FeeTooHigh);
    }
    let fee_mul = BPS_DENOMINATOR
        .checked_sub(fee_bps as u128)
        .ok_or(AmmError::FeeTooHigh)?;
    let amount_in_after_fee = (amount_in as u128)
        .checked_mul(fee_mul)
        .ok_or(AmmError::MathOverflow)?
        / BPS_DENOMINATOR;
    if amount_in_after_fee == 0 {
        return Err(AmmError::ZeroSwapInput);
    }
    let numerator = (reserve_out as u128)
        .checked_mul(amount_in_after_fee)
        .ok_or(AmmError::MathOverflow)?;
    let denominator = (reserve_in as u128)
        .checked_add(amount_in_after_fee)
        .ok_or(AmmError::MathOverflow)?;
    if denominator == 0 {
        return Err(AmmError::MathOverflow);
    }
    let out = numerator / denominator;
    if out >= reserve_out as u128 {
        return Err(AmmError::EmptyReserve);
    }
    Ok(out.min(u64::MAX as u128) as u64)
}

/// AMM-fork instruction surface.
///
/// Ships the minimum that supports the four AMM failure
/// mode targets (price manipulation via swap, impermanent
/// loss spike, jit liquidity, reserve depletion).
#[derive(Debug, Clone, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum AmmInstructionData {
    /// Initialize a pool. Signer becomes the admin. Seeds reserves to
    /// `initial_a`/`initial_b` and mints `initial_a + initial_b` LP
    /// shares to the admin's `LpPositionState`.
    InitializePool {
        initial_a: u64,
        initial_b: u64,
        fee_bps: u64,
    },
    /// Add liquidity in proportion to the current reserves. Mints new LP
    /// shares to the signer's position. First add into an
    /// already-initialized pool rejects if `amount_a` and `amount_b` do
    /// not match the current reserve ratio (within 1 bps tolerance).
    AddLiquidity { amount_a: u64, amount_b: u64 },
    /// Burn `shares` from the signer's position and withdraw the
    /// pro-rata share of both reserves.
    RemoveLiquidity { shares: u64 },
    /// Swap `amount_in` of one side for the other, returning the output
    /// into `reserve_out` (no real token move). `direction == 0` means
    /// a→b, `direction == 1` means b→a. Rejects if the computed output
    /// falls below `min_amount_out`.
    Swap {
        amount_in: u64,
        min_amount_out: u64,
        direction: u64,
    },
}
