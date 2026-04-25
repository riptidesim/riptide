use solana_program::program_error::ProgramError;
use thiserror::Error;

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum AmmError {
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
    #[error("pool reserves cannot be zero at initialization")]
    EmptyInitialReserves,
    #[error("lp position is uninitialized")]
    UninitializedLpPosition,
    #[error("insufficient lp shares for requested withdrawal")]
    InsufficientLpShares,
    #[error("swap amount_in cannot be zero")]
    ZeroSwapInput,
    #[error("swap output below min_amount_out")]
    SlippageExceeded,
    #[error("swap direction tag must be 0 (a->b) or 1 (b->a)")]
    InvalidSwapDirection,
    #[error("pool has empty reserves on the requested swap side")]
    EmptyReserve,
    #[error("fee_bps exceeds 10_000 (100%)")]
    FeeTooHigh,
    #[error("math overflow")]
    MathOverflow,
}

impl From<AmmError> for ProgramError {
    fn from(error: AmmError) -> Self {
        ProgramError::Custom(error as u32)
    }
}
