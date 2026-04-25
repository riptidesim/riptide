//! Minimal admin-settable oracle program.
//!
//! shipped as the first concrete target for
//! [`OracleKind::AdminMock`](../../../engine/src/adapter/schema.rs) so
//! non-lending adapters (perpetuals, AMM, …) can depend on a
//! standalone oracle program instead of reusing the lending pool's
//! bundled oracle account.
//!
//! Layout is byte-for-byte identical to
//! `lending_pool::state::OracleState` on purpose — this is the
//! "admin-mock" layout the rest of Riptide already consumes. The
//! engine-side encoder
//! ([`engine::scenario::oracle::AdminMockOracleLayout`]) writes the
//! same bytes this program's `SetPrice` instruction writes, so a
//! program built against this crate can boot against either
//! engine-encoded shock injections OR calls through this program's
//! own instruction surface.
//!
//! Instructions:
//! - `InitializeOracle { price, exponent }` — one-time bootstrap, sets
//! the admin to the signer.
//! - `SetPrice { price, exponent }` — admin-only price override. Used
//! by the engine when dispatching shocks declaratively.
//!
//! The program is intentionally tiny (no cross-program invocations, no
//! derived addresses, no extensions). Pyth-compatible layouts remain a
//! task per the scope call.

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    program_error::ProgramError,
    pubkey::Pubkey,
};

/// Serialized length of [`OracleState`] — must stay in lock-step with
/// `lending_pool::state::ORACLE_STATE_LEN` and
/// `engine::scenario::oracle::AdminMockOracleLayout::byte_len`.
pub const ORACLE_STATE_LEN: usize = 50;

/// Admin-settable price account. Byte-for-byte mirror of
/// `lending_pool::state::OracleState` and
/// `engine::scenario::OracleSnapshot`. If a field is added / removed /
/// reordered here, update all three mirrors and regenerate
/// `fixtures/oracle_state_golden.bin`.
#[derive(Debug, Clone, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct OracleState {
    pub is_initialized: bool,
    pub admin: [u8; 32],
    pub price: u64,
    pub exponent: i8,
    pub reserved: [u8; 8],
}

#[derive(Debug, Clone, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum OracleInstructionData {
    /// One-shot initializer. Stores the signer as the admin. Fails if
    /// already initialized.
    InitializeOracle { price: u64, exponent: i8 },
    /// Admin-only price override. Fails if the signer does not match
    /// the stored admin.
    SetPrice { price: u64, exponent: i8 },
}

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

pub fn process_instruction(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let ix = OracleInstructionData::try_from_slice(instruction_data)
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let account_iter = &mut accounts.iter();
    let oracle_account = next_account_info(account_iter)?;
    let admin_account = next_account_info(account_iter)?;

    if !admin_account.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let mut state = if oracle_account.data_len() >= ORACLE_STATE_LEN {
        OracleState::try_from_slice(&oracle_account.data.borrow()[..ORACLE_STATE_LEN])
            .unwrap_or(OracleState {
                is_initialized: false,
                admin: [0; 32],
                price: 0,
                exponent: 0,
                reserved: [0; 8],
            })
    } else {
        return Err(ProgramError::AccountDataTooSmall);
    };

    match ix {
        OracleInstructionData::InitializeOracle { price, exponent } => {
            if state.is_initialized {
                return Err(ProgramError::AccountAlreadyInitialized);
            }
            state = OracleState {
                is_initialized: true,
                admin: admin_account.key.to_bytes(),
                price,
                exponent,
                reserved: [0; 8],
            };
        }
        OracleInstructionData::SetPrice { price, exponent } => {
            if !state.is_initialized {
                return Err(ProgramError::UninitializedAccount);
            }
            if state.admin != admin_account.key.to_bytes() {
                return Err(ProgramError::IllegalOwner);
            }
            state.price = price;
            state.exponent = exponent;
        }
    }

    let encoded = state
        .try_to_vec()
        .map_err(|_| ProgramError::InvalidAccountData)?;
    oracle_account.data.borrow_mut()[..encoded.len()].copy_from_slice(&encoded);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use borsh::to_vec;

    /// SSOT enforcement — this program's `OracleState` round-trips
    /// against the same golden bytes used by
    /// `lending_pool::state::OracleState` and
    /// `engine::scenario::oracle::OracleSnapshot`.
    #[test]
    fn oracle_state_matches_golden_bytes() {
        const GOLDEN: &[u8] = include_bytes!("../../../fixtures/oracle_state_golden.bin");

        let state = OracleState {
            is_initialized: true,
            admin: [7; 32],
            price: 123,
            exponent: -2,
            reserved: [0; 8],
        };

        let encoded = to_vec(&state).expect("encode");
        assert_eq!(encoded.len(), ORACLE_STATE_LEN);
        assert_eq!(encoded.len(), GOLDEN.len());
        assert_eq!(encoded.as_slice(), GOLDEN);
    }
}
