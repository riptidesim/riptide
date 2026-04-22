//! On-chain account layouts for `stablecoin-fork`.
//!
//! Pool state models the essential UXD-style stablecoin surface:
//!
//! - `collateral_assets` — pooled collateral backing (virtual u64)
//! - `stable_supply` — stablecoins outstanding across every position
//! - `reserve_buffer_assets` — the subset of `collateral_assets` that
//!   is immediately claimable by a redeemer. Redemptions larger than
//!   the buffer fall to the queue.
//! - `pending_redemption_assets` — assets earmarked for unclaimed
//!   redemption entries. Bookkeeping for the queue invariant.
//! - `pending_redemption_count` — queue depth (positions with a
//!   non-zero pending redemption, NOT request calls — same semantics
//!   liquid-staking-fork uses).
//! - `effective_collateral_ratio_bps` — backing available to remaining
//!   stablecoin holders, in bps of 10_000. Pinned to 10_000 on an
//!   empty pool. Drops below 10_000 when `apply_hedge_loss` shrinks
//!   collateral without touching supply.
//! - `cumulative_hedge_loss_bps` — monotonic sum of `loss_bps` values
//!   applied through `apply_hedge_loss`. Used by the shipping adapter
//!   to check "no hedge loss during healthy runs".
//!
//! Every non-identity field is u64/bool so the generic primitive's
//! observation decoder can walk the byte layout without cursor
//! misalignment. Same pattern liquid-staking-fork uses.

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

use crate::error::StablecoinError;

/// Bps denominator for ratio and haircut math.
pub const BPS_DENOMINATOR: u128 = 10_000;

/// Default effective collateral ratio reported on an empty pool
/// (`stable_supply == 0`). Keeps `apply_hedge_loss` idempotent on a
/// cold pool and keeps the shipping adapter's tick-0 smoke clean.
pub const DEFAULT_COLLATERAL_RATIO_BPS: u64 = 10_000;

/// Fraction of every `deposit_collateral` call that lands in the
/// immediately-claimable liquid reserve buffer, in bps of 10_000. The
/// remainder is treated as delegated / hedge-engaged collateral — it
/// grows `collateral_assets` but not `reserve_buffer_assets`, so
/// redemptions beyond the buffered fraction cannot settle from the
/// buffer and fall to the queue.
///
/// 20% mirrors the conservative liquidity-reserve stance real delta-
/// neutral stablecoin designs (UXD, Ethena's USDe mechanics) maintain
/// below the full collateral pool. It is load-bearing for the
/// bundle's failure shape: without this split, panic-redemption
/// pressure could be absorbed by raw reserve and the "queue fires /
/// reserve exhausts / under-backed state holds" pressure geometry
/// would not be honestly modeled in single-agent flows.
pub const RESERVE_FRACTION_BPS: u64 = 2_000;

/// Serialized length of [`PoolState`]. Pinned so the harness
/// allocates the account with the exact space the processor expects
/// and any layout drift surfaces as a test failure.
pub const POOL_STATE_LEN: usize = 1   // is_initialized
    + 32                               // admin
    + 32                               // oracle
    + 8                                // collateral_assets
    + 8                                // stable_supply
    + 8                                // reserve_buffer_assets
    + 8                                // pending_redemption_assets
    + 8                                // pending_redemption_count
    + 8                                // effective_collateral_ratio_bps
    + 8;                               // cumulative_hedge_loss_bps
// = 121 bytes

/// Serialized length of [`PositionState`].
pub const POSITION_STATE_LEN: usize = 1 // is_initialized
    + 32                                 // owner
    + 32                                 // pool
    + 8                                  // collateral_deposited
    + 8                                  // stable_minted
    + 8                                  // pending_redeem_assets
    + 8                                  // claimable_collateral
    + 8;                                 // cumulative_claimed
// = 105 bytes

/// Pool state. One shared account per stablecoin pool.
#[derive(Debug, Clone, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct PoolState {
    pub is_initialized: bool,
    pub admin: [u8; 32],
    /// Bound oracle account pubkey. Stored for observability / future
    /// price-sanity hooks; the current instruction surface does not
    /// read it.
    pub oracle: [u8; 32],
    /// Pooled collateral. Grows by the full amount on
    /// `deposit_collateral`, shrinks on a settled redemption or an
    /// `apply_hedge_loss`.
    pub collateral_assets: u64,
    /// Stablecoins outstanding across every position. Mints on
    /// `mint_stable`, burns on `request_redeem`.
    pub stable_supply: u64,
    /// Liquid reserve buffer — the subset of `collateral_assets` that
    /// is immediately claimable. On `deposit_collateral`, only
    /// `RESERVE_FRACTION_BPS` bps of the deposit lands here; the rest
    /// is treated as delegated / hedge-engaged collateral that can
    /// only be recovered by draining the queue over time. A redemption
    /// that exceeds `reserve_buffer_assets` at request time falls to
    /// the queue — that is the organic path that populates
    /// `pending_redemption_*`. `apply_hedge_loss` hits delegated
    /// collateral only (`collateral_assets - reserve_buffer_assets`),
    /// preserving `reserve_buffer_assets <= collateral_assets` as a
    /// natural invariant.
    pub reserve_buffer_assets: u64,
    /// Sum of pending-redemption asset amounts across all positions
    /// whose redemption request has not yet been satisfied. Monotonic
    /// during a run unless a claim clears it.
    pub pending_redemption_assets: u64,
    /// Number of positions currently holding a non-zero pending
    /// redemption. Note: this counts *positions with pending
    /// liability*, not individual `request_redeem` calls — multiple
    /// queued requests from the same position aggregate into one
    /// position-level pending balance and contribute a single unit
    /// here.
    pub pending_redemption_count: u64,
    /// Effective collateral ratio in bps of 10_000. Reflects backing
    /// available to remaining stablecoin holders after the queue
    /// obligations are carved out:
    /// `(collateral_assets - pending_redemption_assets) * BPS /
    /// stable_supply`. Pinned to `DEFAULT_COLLATERAL_RATIO_BPS` on an
    /// empty pool. Drops below 10_000 when `apply_hedge_loss` shrinks
    /// collateral without touching supply — the UXD-style
    /// under-backed state.
    pub effective_collateral_ratio_bps: u64,
    /// Cumulative hedge-loss magnitude as the sum of applied
    /// `loss_bps` values, monotonic. Used by the shipping adapter to
    /// check no haircut fires during a healthy smoke run. (We sum
    /// bps rather than asset magnitudes so a later proof can assert
    /// "a 25% haircut landed at tick N" against a stable observable
    /// even if the pool shrank between haircuts.)
    pub cumulative_hedge_loss_bps: u64,
}

/// One per user per pool. Tracks collateral deposited, stable minted,
/// and a single open redemption request (which may aggregate multiple
/// `request_redeem` calls before `claim_redeem` fires).
#[derive(Debug, Clone, PartialEq, Eq, Default, BorshSerialize, BorshDeserialize)]
pub struct PositionState {
    pub is_initialized: bool,
    pub owner: [u8; 32],
    pub pool: [u8; 32],
    /// Collateral the user has contributed. Mints on
    /// `deposit_collateral`, shrinks on a settled redemption. The
    /// portion of this not yet locked against a mint is the "free"
    /// collateral that further mints can draw against.
    pub collateral_deposited: u64,
    /// Stablecoins the user has minted. Burns on `request_redeem`.
    /// Must never exceed `collateral_deposited` at rest.
    pub stable_minted: u64,
    /// Assets the user has requested to redeem but which the pool has
    /// not yet been able to satisfy from the reserve buffer.
    /// Monotonic until a `claim_redeem` that routes through reserve
    /// liquidity clears it.
    pub pending_redeem_assets: u64,
    /// Collateral immediately ready to claim (redemption was
    /// satisfied from the reserve buffer at request time). Cleared on
    /// `claim_redeem`.
    pub claimable_collateral: u64,
    /// Monotonic counter of collateral successfully claimed through
    /// redemption. Exposed so a proof artifact can assert the user
    /// actually received something.
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

impl PositionState {
    pub fn owner_pubkey(&self) -> Pubkey {
        Pubkey::new_from_array(self.owner)
    }
    pub fn pool_pubkey(&self) -> Pubkey {
        Pubkey::new_from_array(self.pool)
    }
    /// Collateral not already locked against an outstanding mint or
    /// an open queued redemption. Queued redemptions earmark
    /// collateral: the stablecoin has been burned but the claim on
    /// collateral has not yet settled (reserve didn't cover at
    /// request time), so those units of `collateral_deposited` stay
    /// on the position pending `claim_redeem` and must NOT be
    /// available to back a fresh mint.
    ///
    /// Load-bearing — without the `pending_redeem_assets` subtraction,
    /// `request_redeem` on the queued path burns stable up front but
    /// does not reduce `collateral_deposited`, so
    /// `free_collateral = collateral_deposited - stable_minted` grows
    /// by the burned amount. The user can then mint again against
    /// collateral already earmarked for the queued redeem — a real
    /// double-spend of backing.
    ///
    /// Saturating so a corrupted state cannot silently panic-abort
    /// the processor through underflow.
    pub fn free_collateral(&self) -> u64 {
        self.collateral_deposited
            .saturating_sub(self.stable_minted)
            .saturating_sub(self.pending_redeem_assets)
    }
}

/// Stablecoin-fork instruction surface.
#[derive(Debug, Clone, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum StablecoinInstructionData {
    /// Initialize a pool. Signer becomes admin; `oracle` is recorded
    /// on the pool for observability. Explicit init is optional — the
    /// processor's lazy-init path seeds defaults on first touch.
    InitializePool,
    /// Deposit `amount` collateral into the pool. Grows both
    /// `collateral_assets` and the depositor's `collateral_deposited`.
    /// `RESERVE_FRACTION_BPS` bps of `amount` lands in
    /// `reserve_buffer_assets` so near-term redemptions can settle.
    DepositCollateral { amount: u64 },
    /// Mint `amount` stablecoins. Requires at least `amount` of free
    /// collateral (`collateral_deposited - stable_minted`) already
    /// sitting in the depositor's position. Does not move pool-level
    /// collateral — just issues the stable liability against
    /// already-deposited backing.
    MintStable { amount: u64 },
    /// Burn `stable_amount` stablecoins and post a redemption claim
    /// worth `stable_amount` collateral (1:1). If `reserve_buffer_assets`
    /// covers it now, the claim is moved to `claimable_collateral`
    /// immediately. Otherwise it lands in `pending_redeem_assets`.
    RequestRedeem { stable_amount: u64 },
    /// Settle `claimable_collateral` and, if reserve has caught up,
    /// settle the queued portion too. Non-blocking: returns
    /// `NothingToClaim` only when neither claimable nor pending is
    /// payable.
    ClaimRedeem,
    /// Admin-only stress mutation. Shrinks `collateral_assets` by
    /// `loss_bps / 10_000` of the delegated portion
    /// (`collateral_assets - reserve_buffer_assets`) and recomputes
    /// `effective_collateral_ratio_bps`. Reserve buffer is untouched.
    /// This is the UXD-style hedge-gap mutation that drives the
    /// under-backed proof path — the program-local substitute for a
    /// live hedge-venue failure.
    ApplyHedgeLoss { loss_bps: u64 },
}

/// Recompute `effective_collateral_ratio_bps`.
///
/// The ratio is backing available to *remaining* stablecoin holders,
/// not the raw `collateral_assets / stable_supply`. Queue entries are
/// senior (their collateral claim is locked at the rate that applied
/// when the request was posted) so their earmarked assets must come
/// out of the numerator.
///
/// Formula:
/// `(collateral_assets - pending_redemption_assets) * BPS / stable_supply`.
///
/// Zero stable supply pins the ratio to `DEFAULT_COLLATERAL_RATIO_BPS`
/// so `apply_hedge_loss` on a cold or fully-redeemed pool is
/// idempotent at the observable level.
pub fn recompute_collateral_ratio(
    collateral_assets: u64,
    stable_supply: u64,
    pending_redemption_assets: u64,
) -> u64 {
    if stable_supply == 0 {
        return DEFAULT_COLLATERAL_RATIO_BPS;
    }
    let backing = collateral_assets.saturating_sub(pending_redemption_assets);
    let ratio = (backing as u128)
        .checked_mul(BPS_DENOMINATOR)
        .unwrap_or(u128::MAX)
        / stable_supply as u128;
    ratio.min(u64::MAX as u128) as u64
}

/// Bps-safe multiplication helper for hedge-loss math.
pub fn apply_bps(amount: u64, bps: u64) -> Result<u64, StablecoinError> {
    let scaled = (amount as u128)
        .checked_mul(bps as u128)
        .ok_or(StablecoinError::MathOverflow)?
        / BPS_DENOMINATOR;
    Ok(scaled.min(u64::MAX as u128) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_pool_pins_ratio_to_default() {
        assert_eq!(
            recompute_collateral_ratio(0, 0, 0),
            DEFAULT_COLLATERAL_RATIO_BPS
        );
        assert_eq!(
            recompute_collateral_ratio(1_000, 0, 0),
            DEFAULT_COLLATERAL_RATIO_BPS
        );
    }

    #[test]
    fn full_backing_reports_10000_bps() {
        assert_eq!(recompute_collateral_ratio(1_000, 1_000, 0), 10_000);
    }

    #[test]
    fn hedge_loss_surfaces_under_backing() {
        // Stable supply 1_000 against 600 collateral = 60% backing.
        // The load-bearing UXD-style pressure signal.
        assert_eq!(recompute_collateral_ratio(600, 1_000, 0), 6_000);
    }

    #[test]
    fn queue_obligations_are_senior() {
        // 1_000 collateral, 1_000 supply nominal, 500 already queued
        // (still counted against collateral). Remaining holders have
        // (1_000 - 500) / 1_000 = 5_000 bps backing — the queue is a
        // senior claim and its earmarked collateral is not available
        // to back live stable.
        assert_eq!(recompute_collateral_ratio(1_000, 1_000, 500), 5_000);
    }

    #[test]
    fn pending_above_collateral_saturates_to_zero() {
        // Defensive: the invariant is pending <= collateral, but if a
        // future code path breaks it we want a fully-underwater
        // reading (0) rather than a wrap-around.
        assert_eq!(recompute_collateral_ratio(100, 1_000, 500), 0);
    }

    #[test]
    fn apply_bps_truncates_below_half_unit() {
        assert_eq!(apply_bps(1_000, 1_000).unwrap(), 100); // 10%
        assert_eq!(apply_bps(999, 10_000).unwrap(), 999); // 100%
        assert_eq!(apply_bps(0, 5_000).unwrap(), 0);
    }

    #[test]
    fn free_collateral_subtracts_queued_redemption_earmark() {
        // Regression: a queued redeem burns stable but leaves
        // collateral_deposited in place until claim settles. The
        // gate must therefore carve out `pending_redeem_assets` or
        // the same collateral can back a fresh mint AND the queued
        // redeem — a double-spend of backing.
        let pos = PositionState {
            is_initialized: true,
            owner: [0u8; 32],
            pool: [0u8; 32],
            collateral_deposited: 1_000,
            stable_minted: 300,         // 800 minted, 500 burned at queue
            pending_redeem_assets: 500, // queued, collateral earmarked
            claimable_collateral: 0,
            cumulative_claimed: 0,
        };
        // Without the fix this reads 700 (1_000 - 300) and permits a
        // fresh 400-mint against the earmarked 500 of pending
        // collateral. With the fix it correctly reads 200.
        assert_eq!(pos.free_collateral(), 200);
    }

    #[test]
    fn free_collateral_saturates_on_corrupt_state() {
        // Defensive: a hypothetical corrupt state with
        // stable_minted + pending_redeem > collateral must not
        // panic-abort the processor through underflow. The
        // saturating chain returns 0 (fully underwater) instead.
        let pos = PositionState {
            is_initialized: true,
            owner: [0u8; 32],
            pool: [0u8; 32],
            collateral_deposited: 100,
            stable_minted: 200,
            pending_redeem_assets: 50,
            claimable_collateral: 0,
            cumulative_claimed: 0,
        };
        assert_eq!(pos.free_collateral(), 0);
    }
}
