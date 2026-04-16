//! On-chain account layouts for `perps-fork`.
//!
//! Sprint 5 T07 ships a **perps-lite** instruction set: init_market,
//! deposit/withdraw_collateral, open/close_position (long + short),
//! liquidate_position. Funding rate and the insurance fund are
//! deliberately out of scope — the T07 task note carries the scope-cut
//! rationale and Sprint 6 can add them without reshaping these types.
//!
//! The oracle account is read as the `admin-mock` layout shipped by
//! `programs/admin_mock_oracle`. The `OracleView` struct below is a
//! local mirror of that 50-byte account shape so perps-fork does not
//! have to depend on the oracle crate directly (same pattern
//! `lending_pool` uses for its bundled oracle).

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

use crate::error::PerpsError;

/// Side tag for a position. Widened to `u64` so the generic
/// observation decoder can read it without a u8 branch.
pub const SIDE_LONG: u64 = 0;
pub const SIDE_SHORT: u64 = 1;

/// Bps denominator for leverage / threshold math.
pub const BPS_DENOMINATOR: u128 = 10_000;

/// Serialized length of [`MarketState`]. Kept as a constant so the
/// engine harness can allocate the account with the exact space the
/// processor expects and so state-size drift surfaces as a test failure.
// All non-identity fields are widened to u64/bool so the generic
// primitive's observation decoder (which only speaks u64/i64/bool/
// pubkey) can walk the account byte layout without cursor
// misalignment. This makes the adapter state-mapping honest.
pub const MARKET_STATE_LEN: usize = 1   // is_initialized
    + 32                                 // admin
    + 32                                 // oracle
    + 8                                  // max_leverage_bps (u64)
    + 8                                  // liquidation_threshold_bps (u64)
    + 8                                  // total_oi_long
    + 8                                  // total_oi_short
    + 8                                  // total_collateral
    + 8;                                 // cumulative_socialized_loss
// = 113 bytes

/// Serialized length of [`PositionState`].
pub const POSITION_STATE_LEN: usize = 1 // is_initialized
    + 32                                 // owner
    + 32                                 // market
    + 8                                  // side (u64 — 0=long, 1=short)
    + 8                                  // collateral
    + 8                                  // notional
    + 8                                  // entry_price
    + 8                                  // leverage_bps (u64 — stored so it's observable)
    + 1;                                 // liquidated (bool)
// = 106 bytes

/// Serialized length of the admin-mock oracle layout perps-fork reads.
///
/// **SSOT note:** this must stay byte-for-byte in sync with
/// `admin_mock_oracle::OracleState` and
/// `lending_pool::state::OracleState`. The golden file at
/// `fixtures/oracle_state_golden.bin` pins the layout; the engine-side
/// mirror test catches drift.
pub const ORACLE_STATE_LEN: usize = 50;

/// Market config + aggregate state. One shared account per market.
#[derive(Debug, Clone, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct MarketState {
    pub is_initialized: bool,
    pub admin: [u8; 32],
    pub oracle: [u8; 32],
    /// Maximum leverage, expressed in bps of notional (e.g. `100_000` =
    /// 10x). `open_position` rejects requests above this cap.
    pub max_leverage_bps: u64,
    /// Maintenance margin expressed in bps of notional. A position is
    /// liquidatable when `equity * BPS_DENOMINATOR < notional * liquidation_threshold_bps`.
    pub liquidation_threshold_bps: u64,
    /// Sum of all open long notional in the market.
    pub total_oi_long: u64,
    /// Sum of all open short notional in the market.
    pub total_oi_short: u64,
    /// Sum of all free collateral currently held in position accounts
    /// across the market. Bookkeeping for the engine; positions are the
    /// authoritative owner.
    pub total_collateral: u64,
    /// Counter for losses that exceeded the liquidated position's
    /// deposited collateral. Sprint 5 perps-lite has no insurance fund,
    /// so "where did the missing value go" is tracked here and the
    /// engine can surface it as an observation for T12 invariants.
    pub cumulative_socialized_loss: u64,
}

/// One per agent per market. Tracks the agent's free margin balance and
/// the open position (if any).
#[derive(Debug, Clone, PartialEq, Eq, Default, BorshSerialize, BorshDeserialize)]
pub struct PositionState {
    pub is_initialized: bool,
    pub owner: [u8; 32],
    pub market: [u8; 32],
    /// `SIDE_LONG` / `SIDE_SHORT`. Meaningless while `notional == 0`.
    pub side: u64,
    /// Free margin balance held in this position account. Open
    /// positions are backed by this balance; `open_position` does not
    /// move value, it checks the constraint.
    pub collateral: u64,
    /// Open position size in quote units (e.g. USDC notional). Zero
    /// when no position is open.
    pub notional: u64,
    /// Price at which the open position was entered, in oracle quote
    /// units. Zero when no position is open.
    pub entry_price: u64,
    /// Leverage at which the position was opened, in bps. Stored on the
    /// position so the generic-primitive observation decoder can surface
    /// it as a per-agent metric for T12 invariants and T11 proposals.
    pub leverage_bps: u64,
    /// Once a position has been force-closed by `liquidate_position` it
    /// stays closed (`liquidated == true`). `open_position` rejects a
    /// liquidated account so a liquidator cascade does not re-open a
    /// victim's next tick.
    pub liquidated: bool,
}

impl MarketState {
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
    pub fn market_pubkey(&self) -> Pubkey {
        Pubkey::new_from_array(self.market)
    }
    pub fn is_open(&self) -> bool {
        self.notional > 0 && self.entry_price > 0
    }
}

/// Perps-fork instruction surface.
///
/// Sprint 5 T07 ships the minimum that supports an oracle-shock →
/// margin-cascade discovery story. No funding rate, no insurance fund,
/// no progressive liquidation. See the T07 task note for the full
/// scope-cut rationale.
#[derive(Debug, Clone, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum PerpsInstructionData {
    /// Initialize a market. Signer becomes the admin; `oracle` account
    /// is stored on the market for subsequent price reads.
    InitializeMarket {
        max_leverage_bps: u64,
        liquidation_threshold_bps: u64,
    },
    /// Credit `amount` to the signer's position account collateral
    /// balance. Creates the position account on the first deposit.
    DepositCollateral { amount: u64 },
    /// Debit `amount` from the signer's free collateral. Rejects if
    /// the position has an open leg (must close first in perps-lite).
    WithdrawCollateral { amount: u64 },
    /// Open a new position on an uninitialized (or previously-closed)
    /// position account. Fails if the position already holds an open
    /// leg or has been liquidated.
    OpenPosition {
        side: u64,
        leverage_bps: u64,
        notional: u64,
    },
    /// Close the signer's open position at the current oracle price,
    /// realizing PnL into the position's free collateral balance.
    ClosePosition,
    /// Force-close an underwater position. Callable by any signer; the
    /// victim's collateral is absorbed by the market and
    /// `cumulative_socialized_loss` grows if the loss exceeded the
    /// posted margin.
    LiquidatePosition,
}

/// Minimal view into an admin-mock oracle account. Matches the 50-byte
/// layout shipped by `programs/admin_mock_oracle` and
/// `lending_pool::state::OracleState`.
#[derive(Debug, Clone, BorshSerialize, BorshDeserialize)]
pub struct OracleView {
    pub is_initialized: bool,
    pub admin: [u8; 32],
    pub price: u64,
    pub exponent: i8,
    pub reserved: [u8; 8],
}

impl OracleView {
    /// Scaled integer price. Perps-fork treats exponent `0` as the
    /// canonical "whole-unit quote price" and uses the raw u64 for
    /// downstream math. Non-zero exponents are coerced to the whole-unit
    /// price via saturating u128 math and then clamped into a u64.
    pub fn scaled_price(&self) -> Result<u64, PerpsError> {
        if self.price == 0 {
            return Err(PerpsError::UninitializedOracle);
        }
        if self.exponent == 0 {
            return Ok(self.price);
        }
        if self.exponent > 0 {
            let scale: u128 = 10u128
                .checked_pow(self.exponent as u32)
                .ok_or(PerpsError::MathOverflow)?;
            let scaled = (self.price as u128)
                .checked_mul(scale)
                .ok_or(PerpsError::MathOverflow)?;
            Ok(scaled.min(u64::MAX as u128) as u64)
        } else {
            let scale: u128 = 10u128
                .checked_pow((-self.exponent) as u32)
                .ok_or(PerpsError::MathOverflow)?;
            Ok(((self.price as u128) / scale.max(1)) as u64)
        }
    }
}

/// Computes `equity_bps = collateral + profit - loss` for a position at
/// `current_price`. Returns 0 on underflow (loss exceeds collateral).
///
/// Shared between `liquidate_position`, `close_position` PnL, and the
/// internal processor tests so the liquidation gate and realization
/// math agree on the same denominator.
pub fn position_equity(
    position: &PositionState,
    current_price: u64,
) -> Result<u64, PerpsError> {
    if !position.is_open() {
        return Ok(position.collateral);
    }
    if position.entry_price == 0 || current_price == 0 {
        return Err(PerpsError::InvalidAccountData);
    }
    let entry = position.entry_price as u128;
    let cur = current_price as u128;
    let notional = position.notional as u128;

    let (profit, loss): (u128, u128) = match position.side {
        SIDE_LONG => {
            if cur >= entry {
                (notional
                    .checked_mul(cur - entry)
                    .ok_or(PerpsError::MathOverflow)?
                    / entry, 0)
            } else {
                (0, notional
                    .checked_mul(entry - cur)
                    .ok_or(PerpsError::MathOverflow)?
                    / entry)
            }
        }
        SIDE_SHORT => {
            if entry >= cur {
                (notional
                    .checked_mul(entry - cur)
                    .ok_or(PerpsError::MathOverflow)?
                    / entry, 0)
            } else {
                (0, notional
                    .checked_mul(cur - entry)
                    .ok_or(PerpsError::MathOverflow)?
                    / entry)
            }
        }
        _ => return Err(PerpsError::InvalidSide),
    };

    let coll = position.collateral as u128;
    let raw = coll.saturating_add(profit).saturating_sub(loss);
    Ok(raw.min(u64::MAX as u128) as u64)
}

/// Returns true if the position can be liquidated at `current_price`.
///
/// Liquidation gate: `equity * BPS_DENOMINATOR < notional * liquidation_threshold_bps`.
/// I.e. if the position's post-mark equity drops below the maintenance
/// margin floor, it is liquidatable. An empty position is never
/// liquidatable.
pub fn is_liquidatable(
    position: &PositionState,
    liquidation_threshold_bps: u64,
    current_price: u64,
) -> Result<bool, PerpsError> {
    if !position.is_open() {
        return Ok(false);
    }
    let equity = position_equity(position, current_price)? as u128;
    let notional = position.notional as u128;
    let threshold = liquidation_threshold_bps as u128;
    let maintenance = notional
        .checked_mul(threshold)
        .ok_or(PerpsError::MathOverflow)?;
    let scaled_equity = equity
        .checked_mul(BPS_DENOMINATOR)
        .ok_or(PerpsError::MathOverflow)?;
    Ok(scaled_equity < maintenance)
}
