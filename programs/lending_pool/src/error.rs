use solana_program::program_error::ProgramError;
use thiserror::Error;

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum LendingError {
    #[error("invalid account owner")]
    InvalidAccountOwner,
    #[error("invalid account data")]
    InvalidAccountData,
    #[error("missing oracle account")]
    MissingOracleAccount,
    #[error("unauthorized")]
    Unauthorized,
    #[error("pool is uninitialized")]
    UninitializedPool,
    #[error("oracle is uninitialized")]
    UninitializedOracle,
    #[error("position is liquidated")]
    PositionLiquidated,
    #[error("position is healthy")]
    PositionHealthy,
    #[error("insufficient collateral")]
    InsufficientCollateral,
    #[error("insufficient liquidity")]
    InsufficientLiquidity,
    #[error("deposit limit exceeded")]
    DepositLimitExceeded,
    #[error("borrow limit exceeded")]
    BorrowLimitExceeded,
    #[error("math overflow")]
    MathOverflow,
}

impl From<LendingError> for ProgramError {
    fn from(error: LendingError) -> Self {
        ProgramError::Custom(error as u32)
    }
}
