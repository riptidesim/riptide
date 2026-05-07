//! On-chain account layouts for `liquid-staking`.
//!
//! Pool state models the essential liquid-staking surface:
//!
//! - `total_assets` — pooled underlying stake (virtual u64)
//! - `lst_supply` — LST tokens outstanding across all stake accounts
//! - `reserve_buffer` — immediately-claimable liquidity (subset of
//!   `total_assets`). Claims settle from this; requests that exceed it
//!   fall to the queue.
//! - `pending_unstake_assets` — assets earmarked for unclaimed queue
//!   entries. Bookkeeping for the queue invariant — the pool has to
//!   reserve that much against future claims.
//! - `pending_unstake_count` — queue depth (entries waiting to clear)
//! - `exchange_rate_bps` — underlying-per-LST in bps of 10_000. A
//!   value < 10_000 means the LST depegged below 1:1.
//! - `cumulative_slashed` — accumulated slash magnitude in underlying
//!   units, monotonic for invariant use.
//!
//! Every non-identity field is widened to u64/bool so the generic
//! primitive's observation decoder (which only speaks u64/i64/bool/
//! pubkey) can walk the account byte layout without cursor
//! misalignment. Same pattern perpetuals and amm use.

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

use crate::error::LiquidStakingError;

/// Bps denominator for exchange-rate and slash math.
pub const BPS_DENOMINATOR: u128 = 10_000;

/// Default starting exchange rate: 1 LST : 1 underlying = 10_000 bps.
/// Used when `initialize_pool` is not called before the first stake
/// (lazy-init path for generic-harness bootstrap).
pub const DEFAULT_EXCHANGE_RATE_BPS: u64 = 10_000;

/// Fraction of every `stake` that lands in the liquid reserve buffer
/// immediately, expressed in bps of 10_000. The remainder is treated
/// as "delegated stake" — it grows `total_assets` but does not grow
/// `reserve_buffer`, so subsequent redemption claims beyond the
/// buffered fraction fall to the withdrawal queue.
///
/// 20% is a deliberately conservative default that mirrors how real
/// LSTs (Lido, Jito, Marinade) maintain an instant-liquidity buffer
/// below the full pool size. It is load-bearing for the bundle's
/// failure shape: without this split the queue branch of
/// `request_unstake` is unreachable from single-agent flows and the
/// "pending redemption claims" requirement is not honestly modeled.
pub const RESERVE_FRACTION_BPS: u64 = 2_000;

/// Serialized length of [`PoolState`]. Pinned so the harness allocates
/// the account with the exact space the processor expects and any
/// layout drift surfaces as a test failure.
pub const POOL_STATE_LEN: usize = 1   // is_initialized
    + 32                               // admin
    + 32                               // oracle
    + 8                                // total_assets
    + 8                                // lst_supply
    + 8                                // reserve_buffer
    + 8                                // pending_unstake_assets
    + 8                                // pending_unstake_count
    + 8                                // exchange_rate_bps
    + 8;                               // cumulative_slashed
// = 121 bytes

/// Serialized length of [`StakeAccountState`].
pub const STAKE_ACCOUNT_LEN: usize = 1 // is_initialized
    + 32                                 // owner
    + 32                                 // pool
    + 8                                  // lst_balance
    + 8                                  // pending_unstake_assets
    + 8                                  // claimable_assets
    + 8;                                 // cumulative_claimed
// = 97 bytes

/// Pool state. One shared account per pool.
#[derive(Debug, Clone, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct PoolState {
    pub is_initialized: bool,
    pub admin: [u8; 32],
    /// Bound oracle account pubkey. Stored for observability / future
    /// price-sanity hooks; the current instruction surface does not
    /// read it.
    pub oracle: [u8; 32],
    /// Pooled underlying assets. Grows by the full stake amount on
    /// `stake`, shrinks with a settled claim or an `apply_slash`.
    pub total_assets: u64,
    /// LST tokens outstanding across every stake account. Mints on
    /// `stake`, burns on `request_unstake`.
    pub lst_supply: u64,
    /// Liquid reserve buffer — the portion of `total_assets` that is
    /// immediately claimable. On `stake`, only
    /// `RESERVE_FRACTION_BPS` bps of the deposit lands here; the rest
    /// is treated as delegated stake (grows `total_assets` only). A
    /// redemption that exceeds `reserve_buffer` at request time falls
    /// to the withdrawal queue — that is the organic path that
    /// populates `pending_unstake_*`. `apply_slash` hits delegated
    /// stake (`total_assets - reserve_buffer`), preserving
    /// `reserve_buffer <= total_assets` as a natural invariant.
    pub reserve_buffer: u64,
    /// Sum of pending-unstake asset amounts across all stake accounts
    /// whose redemption request has not yet been satisfied. Monotonic
    /// during a run unless a claim clears it.
    pub pending_unstake_assets: u64,
    /// Number of stake accounts currently holding a non-zero pending
    /// redemption. Note: this counts *accounts with pending liability*,
    /// not individual `request_unstake` calls — multiple queued
    /// requests from the same account aggregate into one account-level
    /// pending balance and contribute a single unit to this counter.
    /// Observable so proposals and invariants can detect queue
    /// pressure directly.
    pub pending_unstake_count: u64,
    /// Underlying-per-LST exchange rate, in bps of 10_000. Starts at
    /// `DEFAULT_EXCHANGE_RATE_BPS` and drops when `apply_slash`
    /// shrinks `total_assets` while `lst_supply` and
    /// `pending_unstake_assets` are unchanged. The rate reflects
    /// backing *for remaining LST holders only*:
    /// `(total_assets - pending_unstake_assets) / lst_supply`. Queue
    /// entries are senior — their claim is locked at the assets owed
    /// when the request was posted — so a slash that lands while the
    /// queue is open is absorbed entirely by active LST, producing a
    /// sharper depeg signal than a naive `total_assets / lst_supply`
    /// ratio would show.
    pub exchange_rate_bps: u64,
    /// Cumulative slash magnitude in underlying units, monotonic.
    pub cumulative_slashed: u64,
}

/// One per user per pool. Tracks LST balance + a single open
/// redemption request. `request_unstake` overlays a new queued request
/// onto any existing one by adding to the pending pool; `claim_unstake`
/// flushes claimable back to zero.
#[derive(Debug, Clone, PartialEq, Eq, Default, BorshSerialize, BorshDeserialize)]
pub struct StakeAccountState {
    pub is_initialized: bool,
    pub owner: [u8; 32],
    pub pool: [u8; 32],
    /// LST tokens the user currently holds. Mints on `stake`, burns on
    /// `request_unstake`.
    pub lst_balance: u64,
    /// Assets the user requested to redeem but which the pool has not
    /// yet been able to satisfy from the reserve buffer. Monotonic
    /// until a `claim_unstake` that routes through reserve liquidity
    /// clears it.
    pub pending_unstake_assets: u64,
    /// Assets immediately ready to claim (redemption was satisfied
    /// from the reserve buffer at request time). Cleared on
    /// `claim_unstake`.
    pub claimable_assets: u64,
    /// Monotonic counter of underlying successfully claimed. Exposed
    /// so a proof artifact can assert the user actually received
    /// something.
    pub cumulative_claimed: u64,
}

impl PoolState {
    pub fn admin_pubkey(&self) -> Pubkey {
        Pubkey::new_from_array(self.admin)
    }
    pub fn oracle_pubkey(&self) -> Pubkey {
        Pubkey::new_from_array(self.oracle)
    }
}

impl StakeAccountState {
    pub fn owner_pubkey(&self) -> Pubkey {
        Pubkey::new_from_array(self.owner)
    }
    pub fn pool_pubkey(&self) -> Pubkey {
        Pubkey::new_from_array(self.pool)
    }
}

/// Liquid-staking-fork instruction surface.
#[derive(Debug, Clone, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum LiquidStakingInstructionData {
    /// Initialize a pool. Signer becomes admin; `oracle` is recorded
    /// on the pool for observability. Explicit init is optional — the
    /// generic harness's lazy-init path seeds defaults on first touch.
    InitializePool {
        /// Starting underlying-per-LST exchange rate in bps. Zero
        /// falls back to `DEFAULT_EXCHANGE_RATE_BPS`.
        initial_exchange_rate_bps: u64,
    },
    /// Stake `amount` of underlying. Mints LST at the current exchange
    /// rate and pushes the `amount` into both `total_assets` and
    /// `reserve_buffer` so near-term redemptions can settle.
    Stake { amount: u64 },
    /// Burn `lst_amount` of LST and post a redemption claim. If
    /// `reserve_buffer` has enough liquidity to cover the asset value
    /// now, the claim is moved to `claimable_assets` immediately.
    /// Otherwise it lands on the queue in `pending_unstake_assets`.
    RequestUnstake { lst_amount: u64 },
    /// Settle claimable and, if reserve liquidity is now available,
    /// settle pending queue entries too. Non-blocking: returns
    /// `NothingToClaim` only when neither claimable nor pending is
    /// payable.
    ClaimUnstake,
    /// Admin-only stress mutation. Shrinks `total_assets` by
    /// `slash_bps`/10_000 against its current value and recomputes
    /// `exchange_rate_bps`. Reserve buffer is untouched; the slash
    /// lands in the staked-but-unliquid portion. This is the hook
    /// that drives depeg / exchange-rate-drop scenarios.
    ApplySlash { slash_bps: u64 },
    /// Admin-only stress mutation modeling the unbacked-LST geometry
    /// of the June 2024 KelpDAO / rsETH bridge-trust failure: mints
    /// `amount` of LST into circulation WITHOUT depositing
    /// underlying assets and WITHOUT recomputing `exchange_rate_bps`.
    /// `lst_supply` grows; `total_assets` and `exchange_rate_bps`
    /// stay put. The pool's `lst_supply * exchange_rate_bps` claim
    /// then exceeds `total_assets * 10000`, which is exactly the
    /// `full_backing` invariant the proof pack asserts on.
    AdminMintLst { amount: u64 },
}

/// Compute the LST amount minted for `assets` at the current exchange
/// rate. `lst_minted = assets * BPS / exchange_rate_bps`.
///
/// Callers must guarantee `exchange_rate_bps > 0`.
pub fn assets_to_lst(assets: u64, exchange_rate_bps: u64) -> Result<u64, LiquidStakingError> {
    if exchange_rate_bps == 0 {
        return Err(LiquidStakingError::ZeroExchangeRate);
    }
    let minted = (assets as u128)
        .checked_mul(BPS_DENOMINATOR)
        .ok_or(LiquidStakingError::MathOverflow)?
        / exchange_rate_bps as u128;
    Ok(minted.min(u64::MAX as u128) as u64)
}

/// Compute the underlying assets owed for `lst_amount` at the current
/// exchange rate. `assets = lst_amount * exchange_rate_bps / BPS`.
///
/// Rejects `exchange_rate_bps == 0` — that's the post-full-slash state
/// where the pool's `total_assets` went to zero while `lst_supply`
/// stayed positive. Without this check, `request_unstake` would burn
/// LST for zero underlying and create neither claimable nor pending
/// liability — an honesty hole in the redemption accounting.
pub fn lst_to_assets(lst_amount: u64, exchange_rate_bps: u64) -> Result<u64, LiquidStakingError> {
    if exchange_rate_bps == 0 {
        return Err(LiquidStakingError::ZeroExchangeRate);
    }
    let owed = (lst_amount as u128)
        .checked_mul(exchange_rate_bps as u128)
        .ok_or(LiquidStakingError::MathOverflow)?
        / BPS_DENOMINATOR;
    Ok(owed.min(u64::MAX as u128) as u64)
}

/// Recompute `exchange_rate_bps` after a slash.
///
/// The rate is the backing available to *remaining* LST holders, not
/// the raw `total_assets / lst_supply` ratio. Queue entries are senior:
/// `pending_unstake_assets` is a fixed-asset liability the pool already
/// owes at the rate that applied when the request was posted, so those
/// units of `total_assets` are not available to back live LST and must
/// be excluded from the ratio.
///
/// Formula: `(total_assets - pending_unstake_assets) * BPS / lst_supply`.
///
/// Without this subtraction, a slash that lands while the queue is open
/// *raises* the reported rate — the scenario exactly inverted. Example:
/// stake 1_000, queue 500, then slash 50% of delegated stake. The raw
/// ratio gives 600/500 = 12_000 bps (peg appears to strengthen). The
/// honest ratio gives (600 - 500)/500 = 2_000 bps — an 80% depeg, which
/// is what the pending-redemption pressure case is modeling.
///
/// With zero LST supply the rate is pinned to `DEFAULT_EXCHANGE_RATE_BPS`
/// so a slash on a cold pool is idempotent.
pub fn recompute_exchange_rate(
    total_assets: u64,
    lst_supply: u64,
    pending_unstake_assets: u64,
) -> u64 {
    if lst_supply == 0 {
        return DEFAULT_EXCHANGE_RATE_BPS;
    }
    let backing = total_assets.saturating_sub(pending_unstake_assets);
    let rate = (backing as u128)
        .checked_mul(BPS_DENOMINATOR)
        .unwrap_or(u128::MAX)
        / lst_supply as u128;
    rate.min(u64::MAX as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_queue_matches_raw_ratio() {
        // With no queue entries, the rate is the plain total/lst ratio.
        // This is the regime the existing replay fixture exercises
        // (slash lands before any request_unstake).
        assert_eq!(recompute_exchange_rate(1_000, 1_000, 0), 10_000);
        assert_eq!(recompute_exchange_rate(600, 1_000, 0), 6_000);
    }

    #[test]
    fn slash_while_queue_open_depegs_active_lst() {
        // The pending-redemption pressure regime. Pool state mirrors the
        // trace in the bug writeup: stake 1_000 → queue 500 LST (pending=500,
        // lst=500, total unchanged at 1_000) → slash 50% of delegated
        // (total 1_000 → 600). Pre-fix this returned 12_000 bps (peg
        // *strengthened*). The honest signal is 2_000 bps — an 80%
        // depeg absorbed entirely by the remaining 500 LST.
        assert_eq!(recompute_exchange_rate(600, 500, 500), 2_000);
    }

    #[test]
    fn zero_lst_supply_pins_to_default() {
        // Slash on a cold pool must be idempotent even if pending is
        // somehow non-zero — no live LST means no meaningful ratio.
        assert_eq!(
            recompute_exchange_rate(0, 0, 0),
            DEFAULT_EXCHANGE_RATE_BPS
        );
        assert_eq!(
            recompute_exchange_rate(1_000, 0, 500),
            DEFAULT_EXCHANGE_RATE_BPS
        );
    }

    #[test]
    fn pending_above_total_saturates_to_zero() {
        // Defensive: the invariant is pending <= total, but if a future
        // code path breaks it we want a "fully depegged" reading (0),
        // not an underflow-driven huge number from wrapping subtraction.
        assert_eq!(recompute_exchange_rate(100, 500, 600), 0);
    }
}
