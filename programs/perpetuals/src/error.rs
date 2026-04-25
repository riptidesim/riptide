use solana_program::program_error::ProgramError;
use thiserror::Error;

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum PerpsError {
    #[error("invalid account owner")]
    InvalidAccountOwner,
    #[error("invalid account data")]
    InvalidAccountData,
    #[error("unauthorized")]
    Unauthorized,
    #[error("market is uninitialized")]
    UninitializedMarket,
    #[error("market is already initialized")]
    MarketAlreadyInitialized,
    #[error("oracle is uninitialized")]
    UninitializedOracle,
    #[error("oracle mismatch with market")]
    OracleMismatch,
    #[error("position already has an open order")]
    PositionAlreadyOpen,
    #[error("position has no open order")]
    PositionNotOpen,
    #[error("position is liquidated")]
    PositionLiquidated,
    #[error("position is healthy — liquidation rejected")]
    PositionHealthy,
    #[error("insufficient collateral for requested action")]
    InsufficientCollateral,
    #[error("leverage exceeds market cap")]
    LeverageTooHigh,
    #[error("invalid side tag (must be 0=long or 1=short)")]
    InvalidSide,
    #[error("math overflow")]
    MathOverflow,
    #[error("invalid notional")]
    InvalidNotional,
}

impl From<PerpsError> for ProgramError {
    fn from(error: PerpsError) -> Self {
        ProgramError::Custom(error as u32)
    }
}
