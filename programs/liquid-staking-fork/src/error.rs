use solana_program::program_error::ProgramError;
use thiserror::Error;

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum LiquidStakingError {
    #[error("invalid account owner")]
    InvalidAccountOwner,
    #[error("invalid account data")]
    InvalidAccountData,
    #[error("unauthorized")]
    Unauthorized,
    #[error("pool is uninitialized")]
    UninitializedPool,
    #[error("pool is already initialized")]
    PoolAlreadyInitialized,
    #[error("stake account is uninitialized")]
    UninitializedStakeAccount,
    #[error("amount must be non-zero")]
    ZeroAmount,
    #[error("insufficient lst balance for requested unstake")]
    InsufficientLstBalance,
    #[error("nothing claimable on this stake account")]
    NothingToClaim,
    #[error("insufficient reserve buffer to settle claim")]
    InsufficientReserveBuffer,
    #[error("slash_bps must be non-zero and <= 10000")]
    InvalidSlashBps,
    #[error("exchange rate is zero — no lst supply to unstake against")]
    ZeroExchangeRate,
    #[error("math overflow")]
    MathOverflow,
}

impl From<LiquidStakingError> for ProgramError {
    fn from(error: LiquidStakingError) -> Self {
        ProgramError::Custom(error as u32)
    }
}
