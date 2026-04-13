use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

use crate::error::LendingError;

pub const POOL_STATE_LEN: usize = 113;
pub const POSITION_STATE_LEN: usize = 49;
pub const ORACLE_STATE_LEN: usize = 50;
pub const BPS_DENOMINATOR: u128 = 10_000;

#[derive(Debug, Clone, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct LendingPoolConfig {
    pub ltv_bps: u16,
    pub liquidation_threshold_bps: u16,
    pub liquidation_bonus_bps: u16,
    pub interest_bps: u16,
    pub deposit_limit: u64,
    pub borrow_limit: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct LendingPoolState {
    pub is_initialized: bool,
    pub admin: [u8; 32],
    pub oracle: [u8; 32],
    pub total_deposits: u64,
    pub total_borrows: u64,
    pub bad_debt: u64,
    pub ltv_bps: u16,
    pub liquidation_threshold_bps: u16,
    pub liquidation_bonus_bps: u16,
    pub interest_bps: u16,
    pub deposit_limit: u64,
    pub borrow_limit: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, BorshSerialize, BorshDeserialize)]
pub struct PositionState {
    pub owner: [u8; 32],
    pub collateral: u64,
    pub debt: u64,
    pub liquidated: bool,
}

/// On-chain oracle account layout.
///
/// **SSOT note (T01 / PAU-01):** this struct is byte-for-byte mirrored by
/// `engine::scenario::OracleSnapshot` in a separate Cargo workspace. Both
/// sides round-trip against `fixtures/oracle_state_golden.bin`; see the
/// mirror test in `engine/src/scenario/oracle.rs`. If the layout changes
/// here, regenerate the golden file and update both tests.
#[derive(Debug, Clone, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct OracleState {
    pub is_initialized: bool,
    pub admin: [u8; 32],
    pub price: u64,
    pub exponent: i8,
    pub reserved: [u8; 8],
}

#[derive(Debug, Clone, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum LendingInstructionData {
    InitializeOracle { price: u64, exponent: i8 },
    SetOraclePrice { price: u64, exponent: i8 },
    InitializePool { config: LendingPoolConfig },
    Deposit { amount: u64 },
    Withdraw { amount: u64 },
    Borrow { amount: u64 },
    Repay { amount: u64 },
    Liquidate { repay_amount: u64 },
}

impl LendingPoolState {
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

    pub fn is_uninitialized(&self) -> bool {
        self.owner == [0; 32] && self.collateral == 0 && self.debt == 0 && !self.liquidated
    }
}

impl OracleState {
    pub fn admin_pubkey(&self) -> Pubkey {
        Pubkey::new_from_array(self.admin)
    }

    pub fn price_multiplier(&self) -> Result<u128, LendingError> {
        if self.price == 0 {
            return Err(LendingError::InvalidAccountData);
        }

        if self.exponent >= 0 {
            let scale = 10u128
                .checked_pow(self.exponent as u32)
                .ok_or(LendingError::MathOverflow)?;
            (self.price as u128)
                .checked_mul(scale)
                .ok_or(LendingError::MathOverflow)
        } else {
            let scale = 10u128
                .checked_pow((-self.exponent) as u32)
                .ok_or(LendingError::MathOverflow)?;
            Ok((self.price as u128) / scale.max(1))
        }
    }
}

pub fn collateral_value(collateral: u64, oracle: &OracleState) -> Result<u128, LendingError> {
    (collateral as u128)
        .checked_mul(oracle.price_multiplier()?)
        .ok_or(LendingError::MathOverflow)
}

pub fn max_borrow_value(
    collateral: u64,
    ltv_bps: u16,
    oracle: &OracleState,
) -> Result<u128, LendingError> {
    collateral_value(collateral, oracle)?
        .checked_mul(ltv_bps as u128)
        .ok_or(LendingError::MathOverflow)?
        .checked_div(BPS_DENOMINATOR)
        .ok_or(LendingError::MathOverflow)
}

pub fn liquidation_value(
    collateral: u64,
    threshold_bps: u16,
    oracle: &OracleState,
) -> Result<u128, LendingError> {
    collateral_value(collateral, oracle)?
        .checked_mul(threshold_bps as u128)
        .ok_or(LendingError::MathOverflow)?
        .checked_div(BPS_DENOMINATOR)
        .ok_or(LendingError::MathOverflow)
}

pub fn health_factor_bps(
    position: &PositionState,
    pool: &LendingPoolState,
    oracle: &OracleState,
) -> Result<u128, LendingError> {
    if position.debt == 0 {
        return Ok(u128::MAX);
    }

    liquidation_value(position.collateral, pool.liquidation_threshold_bps, oracle)?
        .checked_mul(BPS_DENOMINATOR)
        .ok_or(LendingError::MathOverflow)?
        .checked_div(position.debt as u128)
        .ok_or(LendingError::MathOverflow)
}

#[cfg(test)]
mod tests {
    use super::*;
    use borsh::to_vec;

    /// SSOT enforcement for `OracleState` (PAU-01).
    ///
    /// Mirror of `engine::scenario::oracle::oracle_snapshot_matches_golden_bytes`.
    /// Both tests round-trip the same `fixtures/oracle_state_golden.bin` blob.
    /// A field change here must be matched by an equivalent change to
    /// `engine::scenario::OracleSnapshot` and a regenerated golden file.
    #[test]
    fn oracle_state_matches_golden_bytes() {
        const GOLDEN: &[u8] =
            include_bytes!("../../../fixtures/oracle_state_golden.bin");

        let state = OracleState {
            is_initialized: true,
            admin: [7; 32],
            price: 123,
            exponent: -2,
            reserved: [0; 8],
        };

        let encoded = to_vec(&state).expect("encode oracle state");
        assert_eq!(
            encoded.len(),
            ORACLE_STATE_LEN,
            "OracleState length drifted from ORACLE_STATE_LEN constant",
        );
        assert_eq!(
            encoded.len(),
            GOLDEN.len(),
            "OracleState serialized length drifted from the golden file. \
             If intentional, regenerate fixtures/oracle_state_golden.bin AND \
             update the mirror test in engine/src/scenario/oracle.rs.",
        );
        assert_eq!(
            encoded.as_slice(),
            GOLDEN,
            "OracleState layout drifted from fixtures/oracle_state_golden.bin. \
             Update both sides (lending_pool::state::OracleState and \
             engine::scenario::OracleSnapshot) in lock-step."
        );
    }
}
