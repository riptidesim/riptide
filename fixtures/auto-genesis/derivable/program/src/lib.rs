//! Contribution pool — the derivable-genesis fixture program.
//!
//! Deliberately the *smallest* protocol whose tick-0 state a generated
//! simulation can stand up from adapter facts alone:
//!
//! - Raw Borsh state, no Anchor account discriminators, so a zero-initialized
//!   allocation at the declared size is a valid starting state.
//! - `ledger` is a PDA the program re-derives and checks, so the address the
//!   generated genesis derives from the adapter's `pda` seeds is the address this
//!   program demands. A genesis that guessed that address would fail here rather
//!   than pass quietly.
//! - `treasury` is address-agnostic (owner and length only), which is the other
//!   half of the derivable class: nothing constrains the address, so genesis
//!   picks a stable one of its own.
//! - Every account is pre-created by the caller: the program asserts owner and
//!   data length instead of CPI-ing `system_program::create_account`.
//! - Both instructions carry real failure modes (zero amount, overdraw) so a run
//!   that exercises them produces honest error outcomes, not a flat pass.
//!
//! This is fixture material for the generator's genesis classifier. It is not a
//! model of any real protocol and it is not part of the shipped runtime.

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    program_error::ProgramError,
    pubkey::Pubkey,
};

/// `Ledger`: 32-byte owner + 8-byte contributed.
pub const LEDGER_LEN: usize = 40;
/// `Treasury`: 8-byte total + 8-byte contributor count.
pub const TREASURY_LEN: usize = 16;

pub const LEDGER_SEED: &[u8] = b"ledger";
pub const TREASURY_SEED: &[u8] = b"treasury";

#[derive(BorshSerialize, BorshDeserialize, Debug, Default, PartialEq, Eq)]
pub struct Ledger {
    pub owner: Pubkey,
    pub contributed: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Default, PartialEq, Eq)]
pub struct Treasury {
    pub total: u64,
    pub contributors: u64,
}

/// Instruction data. The discriminator is the Borsh enum tag, which is what the
/// IDL's single-byte `discriminator` values mirror.
#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub enum PoolInstruction {
    Contribute { amount: u64 },
    Withdraw { amount: u64 },
}

/// Program errors, offset so they are distinguishable from builtin codes.
#[derive(Debug, Clone, Copy)]
pub enum PoolError {
    ZeroAmount = 0,
    InsufficientContribution = 1,
    MathOverflow = 2,
    AccountAddressMismatch = 3,
}

impl From<PoolError> for ProgramError {
    fn from(value: PoolError) -> Self {
        ProgramError::Custom(value as u32)
    }
}

entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let instruction = PoolInstruction::try_from_slice(instruction_data)
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let accounts_iter = &mut accounts.iter();
    let authority = next_account_info(accounts_iter)?;
    let ledger_info = next_account_info(accounts_iter)?;
    let treasury_info = next_account_info(accounts_iter)?;

    if !authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    expect_pda(
        ledger_info,
        &[LEDGER_SEED, authority.key.as_ref()],
        program_id,
        LEDGER_LEN,
    )?;
    expect_program_account(treasury_info, program_id, TREASURY_LEN)?;

    let mut ledger: Ledger = read_state(ledger_info)?;
    let mut treasury: Treasury = read_state(treasury_info)?;

    match instruction {
        PoolInstruction::Contribute { amount } => {
            if amount == 0 {
                return Err(PoolError::ZeroAmount.into());
            }
            // First touch binds the ledger to its signer. A zero-initialized
            // allocation is therefore a legitimate tick-0 state.
            if ledger.owner == Pubkey::default() {
                ledger.owner = *authority.key;
                treasury.contributors = treasury
                    .contributors
                    .checked_add(1)
                    .ok_or(PoolError::MathOverflow)?;
            } else if ledger.owner != *authority.key {
                return Err(ProgramError::IllegalOwner);
            }
            ledger.contributed = ledger
                .contributed
                .checked_add(amount)
                .ok_or(PoolError::MathOverflow)?;
            treasury.total = treasury
                .total
                .checked_add(amount)
                .ok_or(PoolError::MathOverflow)?;
        }
        PoolInstruction::Withdraw { amount } => {
            if amount == 0 {
                return Err(PoolError::ZeroAmount.into());
            }
            if ledger.owner != *authority.key {
                return Err(ProgramError::IllegalOwner);
            }
            ledger.contributed = ledger
                .contributed
                .checked_sub(amount)
                .ok_or(PoolError::InsufficientContribution)?;
            treasury.total = treasury
                .total
                .checked_sub(amount)
                .ok_or(PoolError::InsufficientContribution)?;
        }
    }

    write_state(ledger_info, &ledger)?;
    write_state(treasury_info, &treasury)?;
    Ok(())
}

fn expect_pda(
    account: &AccountInfo,
    seeds: &[&[u8]],
    program_id: &Pubkey,
    len: usize,
) -> ProgramResult {
    let (expected, _bump) = Pubkey::find_program_address(seeds, program_id);
    if account.key != &expected {
        return Err(PoolError::AccountAddressMismatch.into());
    }
    expect_program_account(account, program_id, len)
}

/// Owner and length only — the address is the caller's choice.
fn expect_program_account(account: &AccountInfo, program_id: &Pubkey, len: usize) -> ProgramResult {
    if account.owner != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    if account.data_len() != len {
        return Err(ProgramError::InvalidAccountData);
    }
    if !account.is_writable {
        return Err(ProgramError::InvalidArgument);
    }
    Ok(())
}

fn read_state<T: BorshDeserialize>(account: &AccountInfo) -> Result<T, ProgramError> {
    let data = account.try_borrow_data()?;
    T::try_from_slice(&data).map_err(|_| ProgramError::InvalidAccountData)
}

fn write_state<T: BorshSerialize>(account: &AccountInfo, state: &T) -> ProgramResult {
    let mut data = account.try_borrow_mut_data()?;
    let encoded = borsh::to_vec(state).map_err(|_| ProgramError::InvalidAccountData)?;
    if encoded.len() != data.len() {
        return Err(ProgramError::InvalidAccountData);
    }
    data.copy_from_slice(&encoded);
    Ok(())
}
