use solana_program::program_error::ProgramError;
use thiserror::Error;

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum ResourceGrinderError {
    #[error("invalid account owner")]
    InvalidAccountOwner,
    #[error("invalid account data")]
    InvalidAccountData,
    #[error("unauthorized")]
    Unauthorized,
    #[error("insufficient wood")]
    InsufficientWood,
}

impl From<ResourceGrinderError> for ProgramError {
    fn from(error: ResourceGrinderError) -> Self {
        ProgramError::Custom(error as u32)
    }
}
