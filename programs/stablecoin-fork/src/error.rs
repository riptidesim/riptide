use solana_program::program_error::ProgramError;
use thiserror::Error;

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum StablecoinError {
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
    #[error("position account is uninitialized")]
    UninitializedPosition,
    #[error("amount must be non-zero")]
    ZeroAmount,
    #[error("insufficient free collateral to back the requested mint")]
    InsufficientFreeCollateral,
    #[error("insufficient stable balance for requested redemption")]
    InsufficientStableBalance,
    #[error("nothing claimable on this position")]
    NothingToClaim,
    #[error("loss_bps must be non-zero and <= 10000")]
    InvalidHedgeLossBps,
    #[error("math overflow")]
    MathOverflow,
}

impl From<StablecoinError> for ProgramError {
    fn from(error: StablecoinError) -> Self {
        ProgramError::Custom(error as u32)
    }
}
